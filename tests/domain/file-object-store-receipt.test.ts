import {afterEach,expect,it,vi} from 'vitest';
import {mkdir,mkdtemp,readFile,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FileObjectStore} from '../../packages/storage/src/objects.js';

type ReadTrace={bufferLengths:number[];requested:number[];returned:number[];closeCalls:number;statCalls:number};
const io=vi.hoisted(()=>({traces:[] as ReadTrace[],shortRead:0,growBeforeRead:'',growAtEof:'',readError:null as string|null,closeError:null as string|null,statError:false,identityDrift:false}));
vi.mock('node:fs/promises',async()=>{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
    const handle=await actual.open(...args),file=String(args[0]);
    if(!file.endsWith('.receipt.json')||(args[1]!=='r'&&args[1]!==0))return handle;
    const trace:ReadTrace={bufferLengths:[],requested:[],returned:[],closeCalls:0,statCalls:0};io.traces.push(trace);let grew=false,eofGrew=false;
    return {
      stat:async()=>{trace.statCalls++;if(io.statError)throw Error('OWNED_FSTAT_FAILURE');const value=await handle.stat();if(io.identityDrift)value.ino=value.ino===0?1:0;return value;},
      read:async(buffer:Buffer,offset:number,length:number,position:number)=>{
        trace.bufferLengths.push(buffer.length);trace.requested.push(length);
        if(io.readError)throw Object.assign(Error('OWNED_READ_FAILURE'),{code:io.readError});
        if(io.growBeforeRead&&!grew){grew=true;await actual.appendFile(file,io.growBeforeRead);}
        const value=await handle.read(buffer,offset,io.shortRead?Math.min(io.shortRead,length):length,position);trace.returned.push(value.bytesRead);
        if(value.bytesRead===0&&io.growAtEof&&!eofGrew){eofGrew=true;await actual.appendFile(file,io.growAtEof);}return value;
      },
      close:async()=>{trace.closeCalls++;await handle.close();if(io.closeError)throw Object.assign(Error('OWNED_CLOSE_FAILURE'),{code:io.closeError});}
    };
  }};
});
afterEach(()=>{io.traces=[];io.shortRead=0;io.growBeforeRead='';io.growAtEof='';io.readError=null;io.closeError=null;io.statError=false;io.identityDrift=false;vi.restoreAllMocks();});

const key='01000000-0000-4000-8000-000000000001/11000000-0000-4000-8000-000000000001';
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'trio-file-receipt-')),store=new FileObjectStore(root,1024,()=>new Date('2026-10-04T00:00:00.123Z')),bytes=Buffer.from('owned-local-fixture');
  const receipt=await store.put(key,bytes),file=await store.file(key),receiptFile=file+'.receipt.json',original=await readFile(receiptFile,'utf8');io.traces=[];
  return {root,store,bytes,receipt,file,receiptFile,original};
}
function closedHandles(){expect(io.traces.length).toBeGreaterThan(0);expect(io.traces.every(value=>value.closeCalls===1)).toBe(true);}
it('keeps current writer bytes, local read and same-byte idempotent put unchanged',async()=>{
  const f=await fixture();expect(Buffer.byteLength(f.original)).toBeLessThan(512);expect(await f.store.receipt(key)).toEqual(f.receipt);expect(await f.store.read(key)).toEqual(f.bytes);expect(await f.store.put(key,Buffer.from(f.bytes))).toEqual(f.receipt);
  expect(await readFile(f.file)).toEqual(f.bytes);expect(await readFile(f.receiptFile,'utf8')).toBe(f.original);
});
it('keeps precision-omitting legacy receipts and small extra metadata',async()=>{
  const f=await fixture(),legacy={...f.receipt,note:'owned legacy metadata'} as Partial<typeof f.receipt>&{note:string};delete legacy.completedAtPrecisionMilliseconds;const encoded=JSON.stringify(legacy);await writeFile(f.receiptFile,encoded);
  expect(await f.store.receipt(key)).toEqual({...legacy,completedAtPrecisionMilliseconds:1});expect(await f.store.read(key)).toEqual(f.bytes);expect(await f.store.put(key,f.bytes)).toEqual({...legacy,completedAtPrecisionMilliseconds:1});expect(await readFile(f.receiptFile,'utf8')).toBe(encoded);
});
it('accepts exactly 4096 encoded receipt bytes with actual EOF',async()=>{
  const f=await fixture(),encoded=f.original+' '.repeat(4096-Buffer.byteLength(f.original));await writeFile(f.receiptFile,encoded);expect(await f.store.receipt(key)).toEqual(f.receipt);expect(await readFile(f.receiptFile,'utf8')).toBe(encoded);
});
it('rejects a semantically valid 4097-byte receipt without returning a healthy receipt',async()=>{
  const f=await fixture(),encoded=f.original+' '.repeat(4097-Buffer.byteLength(f.original));await writeFile(f.receiptFile,encoded);expect(JSON.parse(encoded)).toEqual(f.receipt);
  await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(await readFile(f.receiptFile,'utf8')).toBe(encoded);expect(await readFile(f.file)).toEqual(f.bytes);
});
it('bounds encoded bytes rather than UTF-8 character count',async()=>{
  const f=await fixture(),encoded=JSON.stringify({...f.receipt,note:'가'.repeat(1500)});expect(encoded.length).toBeLessThan(4096);expect(Buffer.byteLength(encoded)).toBeGreaterThan(4096);await writeFile(f.receiptFile,encoded);
  await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(await readFile(f.receiptFile,'utf8')).toBe(encoded);
});
it('caps an actual file that grows between opened-fd stat and first read',async()=>{
  const f=await fixture();io.growBeforeRead=' '.repeat(4097-Buffer.byteLength(f.original));await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
  expect((await readFile(f.receiptFile)).length).toBe(4097);expect(io.traces).toHaveLength(1);const trace=io.traces[0];expect(Math.max(...trace.bufferLengths)).toBeLessThanOrEqual(4097);expect(trace.returned.reduce((sum,value)=>sum+value,0)).toBe(4097);closedHandles();
});
it('continues short fd reads to real EOF within the fixed allocation',async()=>{
  const f=await fixture();io.shortRead=7;expect(await f.store.receipt(key)).toEqual(f.receipt);expect(io.traces).toHaveLength(1);const trace=io.traces[0];expect(trace.returned.length).toBeGreaterThan(2);expect(trace.returned.at(-1)).toBe(0);expect(trace.returned.reduce((sum,value)=>sum+value,0)).toBe(Buffer.byteLength(f.original));expect(Math.max(...trace.bufferLengths)).toBeLessThanOrEqual(4097);closedHandles();
});
it('rejects growth observed after EOF before completing the receipt read',async()=>{
  const f=await fixture();io.growAtEof=' ';await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(await readFile(f.receiptFile,'utf8')).toBe(f.original+' ');closedHandles();
});
it('rejects an opened-fd identity mismatch and closes its handle',async()=>{
  const f=await fixture();io.identityDrift=true;await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(io.traces[0].requested).toEqual([]);closedHandles();
});
it('closes an opened handle when fstat fails',async()=>{
  const f=await fixture();io.statError=true;await expect(f.store.receipt(key)).rejects.toThrow('OWNED_FSTAT_FAILURE');closedHandles();
});
it.each(['EIO','ENOENT'])('propagates %s fd read failure after opening rather than treating it as path absence',async code=>{
  const f=await fixture();io.readError=code;await expect(f.store.receipt(key)).rejects.toThrow('OWNED_READ_FAILURE');closedHandles();
});
it.each(['EIO','ENOENT'])('propagates %s close failure rather than reporting healthy or absent receipt',async code=>{
  const f=await fixture();io.closeError=code;await expect(f.store.receipt(key)).rejects.toThrow('OWNED_CLOSE_FAILURE');closedHandles();
});
it('closes the handle on malformed JSON and preserves that parsing failure',async()=>{
  const f=await fixture();await writeFile(f.receiptFile,'{owned-invalid-json');await expect(f.store.receipt(key)).rejects.toBeInstanceOf(SyntaxError);closedHandles();
});
it('keeps key, SHA, byte length, date and precision semantic rejection',async()=>{
  const f=await fixture();for(const drift of [{key:key+'0'},{sha256:'owned-invalid'},{bytesLength:'-1'},{completedAt:'2026-10-04'},{completedAtPrecisionMilliseconds:1000}]){await writeFile(f.receiptFile,JSON.stringify({...f.receipt,...drift}));await expect(f.store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});}expect(await readFile(f.file)).toEqual(f.bytes);
});
it('rejects symlink and non-file receipts under a fresh NTFS fixture',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'trio-receipt-link-')),store=new FileObjectStore(root,1024),file=await store.file(key,true),target=path.join(root,'owned-receipt-target');await mkdir(target);await symlink(target,file+'.receipt.json',process.platform==='win32'?'junction':'dir');await expect(store.receipt(key)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
  const other='01000000-0000-4000-8000-000000000001/11000000-0000-4000-8000-000000000002',nonfile=await store.file(other,true);await mkdir(nonfile+'.receipt.json');await expect(store.receipt(other)).rejects.toThrow();
});
it('returns null only for actual path or receipt absence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'trio-receipt-absent-')),store=new FileObjectStore(root,1024);expect(await store.receipt(key)).toBeNull();await store.file(key,true);expect(await store.receipt(key)).toBeNull();expect(io.traces).toEqual([]);
});
