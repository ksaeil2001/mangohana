import {afterEach,expect,it,vi} from 'vitest';
import {appendFile,lstat,mkdir,mkdtemp,readFile,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FileObjectStore} from '../../packages/storage/src/objects.js';

type Trace={bufferLengths:number[];requested:number[];returned:number[];statCalls:number;closeCalls:number};
const io=vi.hoisted(()=>({file:'',enabled:false,traces:[] as Trace[],readFileCalls:0,shortRead:0,growBeforeRead:'',growAtEof:'',readError:null as string|null,closeError:null as string|null,statError:false,identityDrift:false,openedSizeDelta:0,truncateBeforeRead:false}));
vi.mock('node:fs/promises',async()=>{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {...actual,
    readFile:async(...args:Parameters<typeof actual.readFile>)=>{
      if(io.enabled&&String(args[0])===io.file){io.readFileCalls++;if(io.growBeforeRead)await actual.appendFile(io.file,io.growBeforeRead);}
      return actual.readFile(...args);
    },
    open:async(...args:Parameters<typeof actual.open>)=>{
      const handle=await actual.open(...args),file=String(args[0]);
      if(!io.enabled||file!==io.file||(args[1]!=='r'&&args[1]!==0))return handle;
      const trace:Trace={bufferLengths:[],requested:[],returned:[],statCalls:0,closeCalls:0};io.traces.push(trace);let grew=false,eofGrew=false,shrunk=false;
      return {
        stat:async()=>{trace.statCalls++;if(io.statError)throw Error('OWNED_OBJECT_FSTAT_FAILURE');const stat=await handle.stat();if(io.identityDrift)stat.ino=stat.ino===0?1:0;if(io.openedSizeDelta)stat.size+=io.openedSizeDelta;return stat;},
        read:async(buffer:Buffer,offset:number,length:number,position:number)=>{
          trace.bufferLengths.push(buffer.length);trace.requested.push(length);
          if(io.readError)throw Object.assign(Error('OWNED_OBJECT_READ_FAILURE'),{code:io.readError});
          if(io.growBeforeRead&&!grew){grew=true;await actual.appendFile(file,io.growBeforeRead);}
          if(io.truncateBeforeRead&&!shrunk){shrunk=true;await actual.truncate(file,0);}
          const result=await handle.read(buffer,offset,io.shortRead?Math.min(io.shortRead,length):length,position);trace.returned.push(result.bytesRead);
          if(result.bytesRead===0&&io.growAtEof&&!eofGrew){eofGrew=true;await actual.appendFile(file,io.growAtEof);}return result;
        },
        close:async()=>{trace.closeCalls++;await handle.close();if(io.closeError)throw Object.assign(Error('OWNED_OBJECT_CLOSE_FAILURE'),{code:io.closeError});}
      };
    }
  };
});
afterEach(()=>{io.file='';io.enabled=false;io.traces=[];io.readFileCalls=0;io.shortRead=0;io.growBeforeRead='';io.growAtEof='';io.readError=null;io.closeError=null;io.statError=false;io.identityDrift=false;io.openedSizeDelta=0;io.truncateBeforeRead=false;vi.restoreAllMocks();});
const key='02000000-0000-4000-8000-000000000001/12000000-0000-4000-8000-000000000001';
async function fresh(maxBytes=32){const root=await mkdtemp(path.join(tmpdir(),'trio-file-object-read-')),clock=vi.fn(()=>new Date('2026-10-04T00:00:00.123Z')),store=new FileObjectStore(root,maxBytes,clock),file=await store.file(key,true);return {root,clock,store,file};}
async function fixture(bytes=Buffer.from('owned-binary-fixture'),maxBytes=32){const f=await fresh(maxBytes),receipt=await f.store.put(key,bytes);io.file=f.file;io.enabled=true;return {...f,bytes,receipt};}
function bounded(length:number){expect(io.readFileCalls).toBe(0);expect(io.traces).toHaveLength(1);const trace=io.traces[0];expect(Math.max(0,...trace.bufferLengths)).toBeLessThanOrEqual(Math.max(length,1));expect(trace.returned.reduce((sum,n)=>sum+n,0)).toBeLessThanOrEqual(length+1);expect(trace.closeCalls).toBe(1);return trace;}

it.each([Buffer.from('normal bytes'),Buffer.alloc(0),Buffer.alloc(32,7)])('preserves actual bytes, empty and exact maxBytes objects %#',async bytes=>{
  const f=await fixture(bytes);expect(await f.store.read(key)).toEqual(bytes);const trace=bounded(bytes.length);expect(trace.returned.at(-1)).toBe(0);io.traces=[];
  expect(await f.store.put(key,Buffer.from(bytes))).toEqual(f.receipt);bounded(bytes.length);expect(f.clock).toHaveBeenCalledTimes(1);
});
it('keeps short reads going to the exact expected length and an observed EOF',async()=>{
  const f=await fixture();io.shortRead=3;expect(await f.store.read(key)).toEqual(f.bytes);const trace=bounded(f.bytes.length);expect(trace.returned.filter(n=>n>0).length).toBeGreaterThan(1);expect(trace.returned.at(-1)).toBe(0);
});
it('bounds actual allocation and reading when the object grows after stat, before SHA rejection',async()=>{
  const f=await fixture();io.growBeforeRead='x'.repeat(512);await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});bounded(f.bytes.length);
  io.enabled=false;expect((await lstat(f.file)).size).toBe(f.bytes.length+512);expect(await readFile(f.file)).toEqual(Buffer.concat([f.bytes,Buffer.from(io.growBeforeRead)]));
});
it('rejects a short object after opened stat without treating it as absence',async()=>{
  const f=await fixture();io.truncateBeforeRead=true;await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});bounded(f.bytes.length);
});
it('rejects object growth observed immediately after EOF before final stat',async()=>{
  const f=await fixture();io.growAtEof='late';await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});const trace=bounded(f.bytes.length);expect(trace.returned.at(-1)).toBe(0);expect(trace.statCalls).toBe(2);
});
it('rejects same-length contents with a different SHA',async()=>{
  const f=await fixture();await writeFile(f.file,Buffer.alloc(f.bytes.length,5));await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});bounded(f.bytes.length);
});
it('rejects opened identity drift and closes without reading',async()=>{
  const f=await fixture();io.identityDrift=true;await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});const trace=bounded(f.bytes.length);expect(trace.requested).toEqual([]);
});
it('rejects opened length drift and closes before allocating a read Buffer',async()=>{
  const f=await fixture();io.openedSizeDelta=1;await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});const trace=bounded(f.bytes.length);expect(trace.bufferLengths).toEqual([]);
});
it('propagates fd stat failure and closes the original reader',async()=>{
  const f=await fixture();io.statError=true;await expect(f.store.read(key)).rejects.toThrow('OWNED_OBJECT_FSTAT_FAILURE');bounded(f.bytes.length);
});
it('propagates fd read ENOENT rather than returning absence',async()=>{
  const f=await fixture();io.readError='ENOENT';await expect(f.store.read(key)).rejects.toMatchObject({code:'ENOENT',message:'OWNED_OBJECT_READ_FAILURE'});bounded(f.bytes.length);
});
it('propagates fd close failure rather than returning verified bytes',async()=>{
  const f=await fixture();io.closeError='ENOENT';await expect(f.store.read(key)).rejects.toMatchObject({code:'ENOENT',message:'OWNED_OBJECT_CLOSE_FAILURE'});bounded(f.bytes.length);
});
it('rejects huge receipt lengths before numeric allocation or object open',async()=>{
  const f=await fixture();await writeFile(f.file+'.receipt.json',JSON.stringify({...f.receipt,bytesLength:'9007199254740993'}));await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});expect(io.readFileCalls).toBe(0);expect(io.traces).toEqual([]);
});
it('preserves missing receipt dependency and pre-open length mismatch behavior',async()=>{
  const f=await fresh();io.file=f.file;io.enabled=true;await expect(f.store.read(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(io.traces).toEqual([]);
  io.enabled=false;const receipt=await f.store.put(key,Buffer.from('original'));io.enabled=true;await truncate(f.file,1);await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});expect(io.traces).toEqual([]);expect(receipt.bytesLength).toBe('8');
});
it('bounds final PUT verification before receipt creation and preserves uncertainty artifacts',async()=>{
  const f=await fresh(),bytes=Buffer.from('owned first put');io.file=f.file;io.enabled=true;io.growBeforeRead='x'.repeat(512);await expect(f.store.put(key,bytes)).rejects.toMatchObject({code:'STORAGE_FAILED'});bounded(bytes.length);
  io.enabled=false;expect(f.clock).not.toHaveBeenCalled();await expect(lstat(f.file+'.receipt.json')).rejects.toMatchObject({code:'ENOENT'});expect((await lstat(f.file+'.put-start.json')).isFile()).toBe(true);const preserved=await readFile(f.file);expect(preserved).toEqual(Buffer.concat([bytes,Buffer.from(io.growBeforeRead)]));
  await expect(f.store.put(key,bytes)).rejects.toMatchObject({code:'STORAGE_UNCONFIRMED',nextAction:'WAIT'});expect(await readFile(f.file)).toEqual(preserved);expect(f.clock).not.toHaveBeenCalled();
});
it('waits for PUT verification reader close before sampling clock or writing receipt',async()=>{
  const f=await fresh(),bytes=Buffer.from('owned close fault');io.file=f.file;io.enabled=true;io.closeError='EIO';await expect(f.store.put(key,bytes)).rejects.toMatchObject({code:'EIO',message:'OWNED_OBJECT_CLOSE_FAILURE'});bounded(bytes.length);
  io.enabled=false;expect(f.clock).not.toHaveBeenCalled();expect(await readFile(f.file)).toEqual(bytes);expect((await lstat(f.file+'.put-start.json')).isFile()).toBe(true);await expect(lstat(f.file+'.receipt.json')).rejects.toMatchObject({code:'ENOENT'});
});
it('bounds original PUT verification with short reads then emits the unchanged receipt',async()=>{
  const f=await fresh(),bytes=Buffer.from('owned first put');io.file=f.file;io.enabled=true;io.shortRead=2;const receipt=await f.store.put(key,bytes);const trace=bounded(bytes.length);expect(trace.returned.at(-1)).toBe(0);expect(f.clock).toHaveBeenCalledTimes(1);
  io.enabled=false;expect(JSON.parse(await readFile(f.file+'.receipt.json','utf8'))).toEqual(receipt);expect(await readFile(f.file)).toEqual(bytes);expect((await lstat(f.file+'.put-start.json')).isFile()).toBe(true);
});
it.each([Buffer.alloc(0),Buffer.alloc(32,8)])('preserves first PUT empty/exact maxBytes verification %#',async bytes=>{
  const f=await fresh();io.file=f.file;io.enabled=true;const receipt=await f.store.put(key,bytes);const trace=bounded(bytes.length);expect(trace.returned.at(-1)).toBe(0);expect(receipt.bytesLength).toBe(String(bytes.length));expect(f.clock).toHaveBeenCalledTimes(1);
  io.enabled=false;expect(JSON.parse(await readFile(f.file+'.receipt.json','utf8'))).toEqual(receipt);expect(await readFile(f.file)).toEqual(bytes);
});
it.each(['directory','symlink'] as const)('preserves pre-open non-file rejection for %s',async kind=>{
  const f=await fresh();await writeFile(f.file+'.receipt.json',JSON.stringify({key,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',bytesLength:'0',completedAt:'2026-10-04T00:00:00.123Z',completedAtPrecisionMilliseconds:1}));
  if(kind==='directory')await mkdir(f.file);else{const target=path.join(f.root,'owned-empty-object-target');await mkdir(target);await symlink(target,f.file,process.platform==='win32'?'junction':'dir');}
  io.file=f.file;io.enabled=true;await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});expect(io.traces).toEqual([]);expect(io.readFileCalls).toBe(0);
});
it('rejects initial over-limit objects before fd opening',async()=>{
  const f=await fixture(Buffer.from('initial'));await appendFile(f.file,Buffer.alloc(64,8));await expect(f.store.read(key)).rejects.toMatchObject({code:'FILE_INVALID',status:422});expect(io.readFileCalls).toBe(0);expect(io.traces).toEqual([]);
});
