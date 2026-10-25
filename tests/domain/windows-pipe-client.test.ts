
import {afterAll,describe,expect,it,vi} from 'vitest';
import {Duplex} from 'node:stream';
import {digest} from '../../packages/contracts/src/intent.js';
import {createNativeJob} from '../../packages/native/src/dto.js';
import type {OriginalCapture} from '../../packages/native/src/windows-job-backend.js';
import type {WindowsBrokerRegistration,WindowsBrokerBounds} from '../../packages/native/src/windows-job-broker.js';
import type {WindowsPipeClientNativeBinding,WindowsPipeClientChannel,WindowsPipeClientOpenInput} from '../../packages/native/src/windows-pipe-client.js';

const nativeGuard=vi.hoisted(()=>vi.spyOn(process,'dlopen').mockImplementation(()=>{throw Error('FORBIDDEN_NATIVE_ADDON');}));
const forbidden=vi.hoisted(()=>vi.fn(()=>{throw Error('FORBIDDEN_PROCESS_OR_NETWORK');}));
vi.mock('node:child_process',()=>({spawn:forbidden,spawnSync:forbidden,exec:forbidden,execSync:forbidden,execFile:forbidden,execFileSync:forbidden,fork:forbidden}));
vi.mock('node:net',()=>({Socket:forbidden,connect:forbidden,createConnection:forbidden,createServer:forbidden,default:{connect:forbidden}}));
vi.mock('node:tls',()=>({connect:forbidden,TLSSocket:forbidden,createServer:forbidden}));
afterAll(()=>{expect(forbidden).not.toHaveBeenCalled();expect(nativeGuard).not.toHaveBeenCalled();nativeGuard.mockRestore();});

const modulePath='../../packages/native/src/windows-pipe-client.js';
const client=await import(modulePath).catch(()=>({})) as typeof import('../../packages/native/src/windows-pipe-client.js');
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}` as const;
const base='\\\\.\\pipe\\trio-w5a-'+id(1)+'-'+id(2);
const name=(lane:'CONTROL'|'IN'|'OUT'|'ERR',c:OriginalCapture)=>base+(lane==='CONTROL'?'-ctl':'-'+c.origin.authority.sessionId+'-'+c.origin.authority.launchId+'-'+c.originDigest.slice(0,16)+'-'+lane.toLowerCase());
function deferred<T>(){
 let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;
 const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});
 return {promise,resolve,reject};
}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();await new Promise<void>(r=>setImmediate(r));}
async function until(check:()=>boolean){for(let i=0;i<30&&!check();i++)await flush();expect(check(),'가짜 완료 경계').toBe(true);}
function fixture(){
 const limits={maxMetadataBytes:4096,maxInputBytes:16384,maxOutputBytes:16384,maxItems:8,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:1048576};
 const job=createNativeJob('DECODE_IMAGE',digest('profile'),{},new Map([['source',Buffer.from('synthetic')]]),{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8},id(21));
 const identity={binding:{accountId:id(22),capacityReservationId:id(23),jobId:id(21),parentInstanceId:id(24),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:digest('kernel')},intentDigest:digest('intent'),sourceInput:{executionId:id(25),inputEvidenceId:id(26),stageInputDigest:digest('stage')},inputEvidenceDigest:digest('record'),inputFingerprint:digest('input'),basisRef:{evidenceId:id(27),evidenceDigest:digest('basis')}};
 const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
 const authority={attemptId:id(28),controllerInstanceId:id(29),controllerId:'controller',keyVersion:'key-v1',environmentDigest:digest('environment'),hostEpochId:id(2),sessionId:id(3),launchId:id(4),policyDigest:digest(policy),controllerSidDigest:digest('controller-sid'),childSidDigest:digest('child-sid'),appContainerSidDigest:digest('container-sid')};
 const pins={executableDigest:digest('exe'),bootstrapDigest:digest('bootstrap'),helperRuntimeDigest:digest('runtime'),helperScriptDigest:digest('helper'),runtimeFilesDigest:digest('files'),nativeLimitsDigest:digest(limits)};
 const origin={identity,authority,pins,policy,limits};
 const capture:OriginalCapture={origin,originDigest:digest({identity,authority,pins,policy,nativeLimitsDigest:digest(limits),frameInputDigest:job.inputDigest}),frameInputDigest:job.inputDigest,launchRef:id(30)};
 const registration:WindowsBrokerRegistration={version:1,endpointId:id(1),hostEpochId:id(2),environmentDigest:authority.environmentDigest,controllerInstanceId:id(29),hostSidDigest:digest('host-sid'),controllerSidDigest:authority.controllerSidDigest,hostProcess:{pid:100,creationFileTime100ns:'1000',windowsSessionId:1},controllerProcess:{pid:200,creationFileTime100ns:'2000',windowsSessionId:1},key:Buffer.alloc(32,7)};
 const bounds:WindowsBrokerBounds={maxControlBytes:131072,maxChunkBytes:1024,streamHighWaterMarkBytes:64,maxQueuedBytes:8192,maxInFlightBytes:131072,maxRetainedRecords:8,handshakeMilliseconds:1000,closeMilliseconds:1000,maxPendingOperations:32};
 return {capture,registration,bounds};
}
function memory(maxBytes=1048576){
 let held=0;const holds:number[]=[];
 return {holds,get held(){return held;},port:{maxBytes,available:vi.fn(()=>maxBytes-held),hold:vi.fn((n:number)=>{if(n<0||held+n>maxBytes)throw Error('OWNER_CAPACITY');held+=n;holds.push(n);let active=true;return ()=>{if(active){active=false;held-=n;}};})}};
}
type ReadResult={bytesRead:number;eof:boolean};
class FakeNative{
 inputs:WindowsPipeClientOpenInput[]=[];
 peers:{input:WindowsPipeClientOpenInput;channel:WindowsPipeClientChannel;ready:ReturnType<typeof deferred<WindowsPipeClientChannel>>;closed:ReturnType<typeof deferred<void>>;reads:{buffer:Buffer;done:ReturnType<typeof deferred<ReadResult>>}[];writes:{buffer:Buffer;done:ReturnType<typeof deferred<number>>}[];closes:string[];cancels:string[]}[]=[];
 delayedOpen=false;autoClose=true;autoReadCancel=true;autoWrite=true;part=Infinity;
 openFailure:Error|null=null;closeFailure:Error|null=null;cancelFailure:Error|null=null;readFailure:Error|null=null;writeFailure:Error|null=null;
 binding:WindowsPipeClientNativeBinding={open:input=>{
  this.inputs.push(input);if(this.openFailure)throw this.openFailure;
  const ready=deferred<WindowsPipeClientChannel>(),closed=deferred<void>(),reads:FakeNative['peers'][number]['reads']=[],writes:FakeNative['peers'][number]['writes']=[],closes:string[]=[],cancels:string[]=[];
  const channel:WindowsPipeClientChannel={
   closed:closed.promise,
   readInto:buffer=>{if(this.readFailure)throw this.readFailure;const done=deferred<ReadResult>();reads.push({buffer,done});return done.promise;},
   write:buffer=>{if(this.writeFailure)throw this.writeFailure;const done=deferred<number>();writes.push({buffer,done});if(this.autoWrite)done.resolve(Math.min(buffer.length,this.part));return done.promise;},
   close:reason=>{closes.push(reason);if(this.closeFailure)throw this.closeFailure;if(this.autoReadCancel)for(const read of reads.splice(0))read.done.resolve({bytesRead:0,eof:false});if(this.autoClose)closed.resolve();}
  };
  this.peers.push({input,channel,ready,closed,reads,writes,closes,cancels});if(!this.delayedOpen)ready.resolve(channel);
  return {ready:ready.promise,closed:closed.promise,cancel:reason=>{cancels.push(reason);if(this.cancelFailure)throw this.cancelFailure;channel.close(reason);}};
 }};
}
function setup(){
 const f=fixture(),owner=memory(),native=new FakeNative();
 let resolved:{capture:OriginalCapture;pipeAclDigest:string}|null={capture:f.capture,pipeAclDigest:'ab'.repeat(32)};
 const authority={resolve:vi.fn(async(_name:string)=>resolved),current:vi.fn(async(_capture:OriginalCapture)=>true)};
 const options={registration:f.registration,bounds:f.bounds,clientBudgetBytes:524288,memory:owner.port,authority,binding:native.binding};
 return {...f,owner,native,authority,options,set resolved(v:typeof resolved){resolved=v;},get resolved(){return resolved;},make:()=>client.createWindowsPipeClientPorts(options)};
}
function observe(stream:Duplex){const errors:Error[]=[];stream.on('error',e=>errors.push(e));return errors;}
async function opened(s:ReturnType<typeof setup>,lane:'CONTROL'|'IN'|'OUT'|'ERR'='IN',hwm=64){
 const op=s.make().connect(name(lane,s.capture),hwm),stream=await op.ready;observe(stream);
 return {op,stream,peer:s.native.peers[0]};
}
async function end(stream:Duplex){return new Promise<void>((resolve,reject)=>stream.end((error?:Error|null)=>error?reject(error):resolve()));}

describe('Windows pipe client 가짜 접점',()=>{
 it('제품 factory가 실제 함수로 존재해야 한다',()=>{
  expect(client.createWindowsPipeClientPorts,'모듈 부재도 setup 오류 대신 제품 factory assertion으로 남긴다').toBeTypeOf('function');
 });
 it('factory는 함수와 snapshot만 만들며 외부 함수를 실행하지 않는다',()=>{
  const s=setup(),timer=vi.spyOn(globalThis,'setTimeout'),ports=s.make();
  expect(Object.keys(ports).sort()).toEqual(['connect','nonce','nowMs','startWait']);
  expect(s.authority.resolve).not.toHaveBeenCalled();expect(s.authority.current).not.toHaveBeenCalled();
  expect(s.owner.port.available).not.toHaveBeenCalled();expect(s.owner.port.hold).not.toHaveBeenCalled();expect(s.native.inputs).toEqual([]);expect(timer).not.toHaveBeenCalled();timer.mockRestore();
 });
 it.each(['remote','alias','nul','epoch','legacy','hwm'] as const)('%s는 native open 전에 거부한다',async bad=>{
  const s=setup(),ports=s.make();
  const wrong=bad==='remote'?name('IN',s.capture).replace('\\\\.','\\\\remote'):bad==='alias'?name('IN',s.capture).replaceAll('\\','/'):bad==='nul'?name('IN',s.capture)+'\0':bad==='epoch'?name('IN',s.capture).replace(id(2),id(99)):bad==='legacy'?base+'-in':name('IN',s.capture);
  const op=ports.connect(wrong,bad==='hwm'?65:64);await expect(op.ready).rejects.toBeInstanceOf(Error);await op.closed;
  expect(s.native.inputs).toHaveLength(0);expect(s.owner.held).toBe(0);
 });
 it.each(['missing','digest','pins','registration'] as const)('%s 원 capture를 native 전에 거부한다',async bad=>{
  const s=setup();if(bad==='missing')s.resolved=null;else if(bad==='digest')s.capture.originDigest='aa'.repeat(32);else if(bad==='pins')s.resolved={capture:{...s.capture,origin:{...s.capture.origin,pins:{...s.capture.origin.pins,nativeLimitsDigest:'cc'.repeat(32)}}},pipeAclDigest:'ab'.repeat(32)};else s.resolved={capture:{...s.capture,origin:{...s.capture.origin,authority:{...s.capture.origin.authority,hostEpochId:id(77)}}},pipeAclDigest:'ab'.repeat(32)};
  const op=s.make().connect(name('CONTROL',s.capture),64);await expect(op.ready).rejects.toBeInstanceOf(Error);await op.closed;expect(s.native.inputs).toHaveLength(0);
 });
 it('네 lane 이름과 고정 권한만 native 입력의 정확 12키로 넘긴다',async()=>{
  const s=setup(),ports=s.make(),ops=[];
  for(const lane of ['CONTROL','IN','OUT','ERR'] as const){
   const op=ports.connect(name(lane,s.capture),32);const stream=await op.ready;observe(stream);expect(stream.isPaused()).toBe(true);ops.push(op);
   expect(s.native.inputs.at(-1)).toEqual({name:name(lane,s.capture),lane,hostProcess:s.registration.hostProcess,controllerProcess:s.registration.controllerProcess,hostSidDigest:s.registration.hostSidDigest,controllerSidDigest:s.registration.controllerSidDigest,pipeAclDigest:'ab'.repeat(32),desiredAccess:0x12008b,shareMode:0,creationDisposition:3,flags:0x40110000,inheritHandle:false});
  }
  expect(s.owner.holds.slice(0,3)).toEqual([16384,65536,196608]);expect(s.owner.held).toBe(278528);
  for(const op of ops)op.cancel('TEST_DONE');await Promise.all(ops.map(op=>op.closed));expect(s.owner.held).toBe(0);
 });
 it('동일 factory의 capture 변경과 동일 lane 재시도를 거부한다',async()=>{
  const s=setup(),ports=s.make(),op=ports.connect(name('CONTROL',s.capture),64);observe(await op.ready);
  const replay=ports.connect(name('CONTROL',s.capture),64);await expect(replay.ready).rejects.toBeInstanceOf(Error);await replay.closed;
  const next=structuredClone(s.capture);next.launchRef=id(99);s.resolved={capture:next,pipeAclDigest:'ab'.repeat(32)};
  const changed=ports.connect(name('IN',next),64);await expect(changed.ready).rejects.toBeInstanceOf(Error);await changed.closed;
  expect(s.native.inputs).toHaveLength(1);op.cancel('TEST_DONE');await op.closed;
 });
 it('metadata 조회는 네 lane 동시 connect에도 한 번에 하나다',async()=>{
  const s=setup();s.native.delayedOpen=true;const ports=s.make(),ops=(['CONTROL','IN','OUT','ERR'] as const).map(lane=>ports.connect(name(lane,s.capture),64));
  await until(()=>s.native.peers.length===1);
  for(let i=0;i<4;i++){expect(s.native.peers).toHaveLength(i+1);s.native.peers[i].ready.resolve(s.native.peers[i].channel);observe(await ops[i].ready);if(i<3)await until(()=>s.native.peers.length===i+2);}
  for(const op of ops)op.cancel('TEST_DONE');await Promise.all(ops.map(op=>op.closed));expect(s.owner.held).toBe(0);
 });
 it('connect 직후 취소는 authority와 메모리와 native를 호출하지 않는다',async()=>{
  const s=setup(),op=s.make().connect(name('IN',s.capture),64);op.cancel('EARLY');await expect(op.ready).rejects.toBeInstanceOf(Error);await op.closed;
  expect(s.authority.resolve).not.toHaveBeenCalled();expect(s.owner.holds).toEqual([]);expect(s.native.inputs).toHaveLength(0);
 });
 it('늦은 open 성공은 ready로 새지 않고 원 handle과 pool을 끝까지 회수한다',async()=>{
  const s=setup();s.native.delayedOpen=true;s.native.autoClose=false;const op=s.make().connect(name('IN',s.capture),64);await until(()=>s.native.peers.length===1);
  const p=s.native.peers[0];op.cancel('LATE');await expect(op.ready).rejects.toBeInstanceOf(Error);let closed=false;void op.closed.then(()=>{closed=true;});p.closed.resolve();await flush();expect(closed).toBe(false);expect(s.owner.held).toBe(278528);
  p.ready.resolve(p.channel);await op.closed;expect(p.closes.length).toBeGreaterThan(0);expect(s.owner.held).toBe(0);
 });
 it.each(['before','after','mutate','acl'] as const)('%s current 권한 변경을 대조한다',async stage=>{
  const s=setup();let current=0;s.authority.current.mockImplementation(async()=>{current++;if(stage==='before')return false;if(stage==='after'&&current===2)return false;if(stage==='mutate'&&current===1)s.capture.launchRef=id(99);if(stage==='acl'&&current===1)s.resolved!.pipeAclDigest='cd'.repeat(32);return true;});
  const op=s.make().connect(name('IN',s.capture),64);await expect(op.ready).rejects.toBeInstanceOf(Error);await op.closed;
  expect(s.native.inputs).toHaveLength(stage==='after'?1:0);expect(s.owner.held).toBe(0);
 });
 it('clientBudget과 broker cap은 owner 상한 안에서 별개로 검증한다',()=>{
  const s=setup();s.options.clientBudgetBytes=278527;expect(()=>s.make()).toThrow();
  s.options.clientBudgetBytes=s.owner.port.maxBytes;expect(()=>s.make()).toThrow();
 });
 it('공동 owner의 기본 pool 예약이 부족하면 native open은 없다',async()=>{
  const s=setup(),other=s.owner.port.hold(s.owner.port.maxBytes-278527),op=s.make().connect(name('IN',s.capture),64);await expect(op.ready).rejects.toBeInstanceOf(Error);await op.closed;expect(s.native.inputs).toHaveLength(0);other();expect(s.owner.held).toBe(0);
 });
});

describe('Windows pipe client 원 buffer와 정리',()=>{
 it('유효 최대 HWM의 CONTROL read 중 owner 가용0이어도 작은 STOP을 쓴다',async()=>{
  const s=setup();s.options.bounds.maxChunkBytes=65536;s.options.bounds.streamHighWaterMarkBytes=65536;
  const {op,stream,peer}=await opened(s,'CONTROL',65536);stream.read(0);await until(()=>peer.reads.length===1);
  const other=s.owner.port.hold(s.owner.port.available());expect(s.owner.port.available()).toBe(0);let written=false;
  stream.write(Buffer.from('STOP'),reason=>{if(!reason)written=true;});await until(()=>written);
  expect(peer.writes[0].buffer.toString()).toBe('STOP');expect(peer.reads[0].buffer.length).toBeLessThan(65536);
  other();op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);
 });
 it('큰 CONTROL snapshot은 pool 잔여와 같은 cap의 direct credit을 callback까지 보유한다',async()=>{
  const s=setup();s.options.bounds.maxChunkBytes=65536;s.options.bounds.streamHighWaterMarkBytes=65536;s.options.bounds.maxQueuedBytes=131076;s.native.autoWrite=false;
  const {op,stream,peer}=await opened(s,'CONTROL',65536);stream.read(0);await until(()=>peer.reads.length===1);
  const source=Buffer.alloc(65537,0x61);let callbackHeld=0;stream.write(source,()=>{callbackHeld=s.owner.held;});source.fill(0);
  const direct=2*65537-(65536-2*peer.reads[0].buffer.length);expect(s.owner.held).toBe(278528+direct);
  expect(peer.writes[0].buffer).toEqual(Buffer.alloc(65536,0x61));peer.writes[0].done.resolve(65536);await until(()=>peer.writes.length===2);
  expect(peer.writes[1].buffer.toString()).toBe('a');expect(s.owner.held).toBe(278528+direct);peer.writes[1].done.resolve(1);
  await until(()=>callbackHeld!==0);expect(callbackHeld).toBe(278528+direct);expect(s.owner.held).toBe(278528);
  op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);
 });
 it('CONTROL의 direct credit도 client cap 밖으로 확대하지 않는다',async()=>{
  const s=setup();s.options.clientBudgetBytes=278528;s.options.bounds.maxQueuedBytes=131076;const {op,stream}=await opened(s,'CONTROL');
  expect(()=>stream.write(Buffer.alloc(65537))).toThrow();expect(s.owner.held).toBe(278528);op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);
 });
 it.each(['CONTROL','OUT','ERR'] as const)('%s의 실제 EOF 뒤 end는 native close를 기다리고 IN proof를 만들지 않는다',async lane=>{
  const s=setup();s.native.autoClose=false;const {op,stream,peer}=await opened(s,lane),errors=observe(stream);
  stream.read(0);await until(()=>peer.reads.length===1);peer.reads.shift()!.done.resolve({bytesRead:0,eof:true});
  stream.resume();await until(()=>stream.readableEnded);let ended=false,closed=false;
  const ending=end(stream).then(()=>{ended=true;});void ending.catch(()=>{});void op.closed.then(()=>{closed=true;});
  await flush();expect(ended).toBe(false);expect(closed).toBe(false);expect(peer.closes).toHaveLength(1);
  peer.closed.resolve();await ending;await op.closed;
  expect(errors).toEqual([]);expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();expect(s.owner.held).toBe(0);
 });
 it.each(['CONTROL','OUT','ERR'] as const)('%s의 조기 end는 peer EOF나 IN proof를 합성하지 않는다',async lane=>{
  const s=setup(),{op,stream}=await opened(s,lane);const ending=end(stream);await expect(ending).rejects.toBeInstanceOf(Error);await op.closed;
  expect(stream.readableEnded).toBe(false);expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();expect(s.owner.held).toBe(0);
 });
 it('대기 write 세 개와 end는 순서대로 원 완료와 callback을 합류한다',async()=>{
  const s=setup();s.native.autoWrite=false;const {op,stream,peer}=await opened(s),errors=observe(stream),callbacks:{text:string;reason:Error|null|undefined}[]=[];
  for(const text of ['ab','cde','fghi'])stream.write(Buffer.from(text),reason=>{callbacks.push({text,reason});});
  const ending=end(stream);void ending.catch(()=>{});expect(s.owner.held).toBe(278546);
  for(const [i,text] of ['ab','cde','fghi'].entries()){
   await until(()=>peer.writes.length===i+1);expect(peer.writes[i].buffer.toString()).toBe(text);peer.writes[i].done.resolve(text.length);
  }
  await ending;await op.closed;expect(callbacks.map(v=>v.text)).toEqual(['ab','cde','fghi']);expect(callbacks.every(v=>!v.reason)).toBe(true);expect(errors).toEqual([]);
  expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeInstanceOf(Error);expect(s.owner.held).toBe(0);
 });
 it('부분 write는 원 snapshot의 offset을 진행하고 마지막 callback까지 credit을 유지한다',async()=>{
  const s=setup();s.native.autoWrite=false;const {op,stream,peer}=await opened(s);const source=Buffer.from('abcdef'),before=s.owner.held;let done=false;
  stream.write(source,()=>{expect(s.owner.held).toBe(before+12);done=true;});source.fill(0);
  await until(()=>peer.writes.length===1);expect(peer.writes[0].buffer.toString()).toBe('abcdef');expect(peer.writes[0].buffer.buffer.byteLength).toBe(6);
  peer.writes[0].done.resolve(2);await until(()=>peer.writes.length===2);expect(peer.writes[1].buffer.toString()).toBe('cdef');expect(done).toBe(false);expect(peer.writes[1].buffer.buffer).toBe(peer.writes[0].buffer.buffer);
  peer.writes[1].done.resolve(4);await until(()=>done);expect(s.owner.held).toBe(before);op.cancel('TEST_DONE');await op.closed;
 });
 it('write queue에 넣기 전 snapshot을 예약하고 넘친 queue는 복사하지 않는다',async()=>{
  const s=setup();s.native.autoWrite=false;s.options.bounds.maxQueuedBytes=8;
  const {op,stream,peer}=await opened(s);stream.write(Buffer.from('1234'),()=>{});stream.write(Buffer.from('5678'),()=>{});
  expect(()=>stream.write(Buffer.from('9'))).toThrow();await until(()=>peer.writes.length===1);
  expect(s.owner.held).toBe(278544);op.cancel('TEST_DONE');peer.writes[0].done.reject(Error('CANCELLED_WRITE'));await op.closed;expect(s.owner.held).toBe(0);
 });
 it('native close 뒤에도 pending write와 상위 callback 전에는 credit과 closed를 반환하지 않는다',async()=>{
  const s=setup();s.native.autoWrite=false;const {op,stream,peer}=await opened(s);let callback=false;stream.write(Buffer.from('ticket'),()=>{callback=true;});await until(()=>peer.writes.length===1);
  let closed=false;void op.closed.then(()=>{closed=true;});op.cancel('TEST_DONE');await flush();expect(closed).toBe(false);expect(s.owner.held).toBe(278540);expect(callback).toBe(false);
  peer.writes[0].done.resolve(6);await op.closed;expect(callback).toBe(true);expect(s.owner.held).toBe(0);
 });
 it('작은 HWM의 read buffer backing은 소비한 뒤에만 반환한다',async()=>{
  const s=setup(),{op,stream,peer}=await opened(s,'OUT',4);stream.read(0);await until(()=>peer.reads.length===1);
  const read=peer.reads.shift()!;expect(read.buffer.length).toBe(4);expect(read.buffer.buffer.byteLength).toBe(4);read.buffer.write('ABCD');read.done.resolve({bytesRead:4,eof:false});await flush();
  expect(stream.readableLength).toBe(4);expect(s.owner.held).toBe(278536);expect(stream.read(2).toString()).toBe('AB');expect(s.owner.held).toBeGreaterThanOrEqual(278536);
  expect(stream.read(2).toString()).toBe('CD');await flush();expect(s.owner.held).toBe(278536);
  op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);
 });
 it('read 수요 없이 native read를 시작하지 않는다',async()=>{
  const s=setup(),{op,peer}=await opened(s,'OUT');await flush();expect(peer.reads).toEqual([]);op.cancel('TEST_DONE');await op.closed;
 });
 it('native EOF를 받더라도 아직 queued read의 소유는 남는다',async()=>{
  const s=setup(),{op,stream,peer}=await opened(s,'OUT',8);stream.read(0);await until(()=>peer.reads.length===1);const r=peer.reads.shift()!;r.buffer.write('ok');r.done.resolve({bytesRead:2,eof:true});await flush();expect(s.owner.held).toBe(278544);expect(stream.read().toString()).toBe('ok');
  op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);
 });
 it('공동 owner 가용0에서도 작은 CONTROL write는 전용 pool로 진행한다',async()=>{
  const s=setup(),ports=s.make(),control=ports.connect(name('CONTROL',s.capture),64),socket=await control.ready;observe(socket);const input=ports.connect(name('IN',s.capture),64),stdin=await input.ready;observe(stdin);
  const other=s.owner.port.hold(s.owner.port.available());expect(s.owner.port.available()).toBe(0);let done=false;
  socket.write(Buffer.from('STOP'),()=>{done=true;});await until(()=>done);
  expect(()=>stdin.write(Buffer.from('DATA'))).toThrow();other();control.cancel('TEST_DONE');input.cancel('TEST_DONE');await Promise.all([control.closed,input.closed]);expect(s.owner.held).toBe(0);
 });
 it('client cap을 넘는 data는 공동 owner 여유와 무관하게 거부한다',async()=>{
  const s=setup();s.options.clientBudgetBytes=278530;const {op,stream}=await opened(s);expect(()=>stream.write(Buffer.alloc(3))).toThrow();op.cancel('TEST_DONE');await op.closed;
 });
 it('IN end는 원 read0과 실제 close 뒤 final-null→destroy-null→close를 진행한다',async()=>{
  const s=setup();s.native.autoClose=false;s.native.autoReadCancel=false;const {op,stream,peer}=await opened(s);const errors=observe(stream),sequence:string[]=[];
  stream.read(0);await until(()=>peer.reads.length===1);const read=peer.reads.shift()!;let ended=false,closed=false;
  const endResult=new Promise<void>((resolve,reject)=>stream.end((error?:Error|null)=>{if(error){reject(error);return;}ended=true;sequence.push('final');resolve();}));
  stream.on('close',()=>sequence.push('close'));void op.closed.then(()=>{closed=true;});await until(()=>peer.closes.includes('INPUT_END'));
  expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();peer.closed.resolve();await flush();expect(ended).toBe(false);expect(closed).toBe(false);expect(s.owner.held).toBe(278656);
  read.done.resolve({bytesRead:0,eof:false});await endResult;await op.closed;
  const proof=client.readWindowsPipeClientLocalInputClose(stream);expect(proof).toMatchObject({code:'WINDOWS_PIPE_LOCAL_INPUT_CLOSED'});expect(client.readWindowsPipeClientLocalInputClose(stream)).toBe(proof);
  expect(sequence).toEqual(['final','close']);expect(errors).toEqual([]);expect(stream.readableEnded).toBe(false);expect(s.owner.held).toBe(0);
 });
 it.each(['queued','reverse','rejected'] as const)('%s 역방향 read는 IN 정상 proof가 될 수 없다',async mode=>{
  const s=setup();s.native.autoClose=false;s.native.autoReadCancel=false;const {op,stream,peer}=await opened(s);const errors=observe(stream);stream.read(0);await until(()=>peer.reads.length===1);const r=peer.reads.shift()!;
  if(mode==='queued'){r.buffer.write('x');r.done.resolve({bytesRead:1,eof:false});await flush();}
  const ending=end(stream);void ending.catch(()=>{});await flush();
  if(mode==='reverse'){r.buffer.write('x');r.done.resolve({bytesRead:1,eof:false});}
  if(mode==='rejected')r.done.reject(Error('ORIGINAL_READ_REJECTED'));
  peer.closed.resolve();for(const pending of peer.reads.splice(0))pending.done.resolve({bytesRead:0,eof:false});await expect(ending).rejects.toBeInstanceOf(Error);await op.closed;expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();expect(errors.length).toBeGreaterThan(0);expect(s.owner.held).toBe(0);
 });
 it('다른 stream·OUT·동일 code 오류는 proof로 인정하지 않는다',async()=>{
  const s=setup(),{op,stream}=await opened(s,'OUT');const other=new Duplex({read(){},write(_b,_e,cb){cb();}});
  expect(client.readWindowsPipeClientLocalInputClose(other)).toBeNull();stream.destroy(Object.assign(Error('FORGED'),{code:'WINDOWS_PIPE_LOCAL_INPUT_CLOSED'}));await op.closed;
  expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();other.destroy();
 });
 it('실제 socket error는 원 identity를 유지하고 local proof를 만들지 않는다',async()=>{
  const s=setup(),{op,stream}=await opened(s);const errors=observe(stream),original=Error('ORIGINAL_SOCKET_FAILURE');stream.destroy(original);await op.closed;expect(errors).toEqual([original]);expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();
 });
 it('열린 read의 0바이트·eof false는 정상 EOF가 아닌 실패다',async()=>{
  const s=setup(),{op,stream,peer}=await opened(s,'OUT');const errors=observe(stream);stream.read(0);await until(()=>peer.reads.length===1);peer.reads.shift()!.done.resolve({bytesRead:0,eof:false});await op.closed;expect(errors).toHaveLength(1);
 });
 it.each(['operation','read','write','close','cancel'] as const)('%s 동기 throw 후 미완 소유와 원 오류를 잃지 않는다',async site=>{
  const s=setup(),original=Error('SYNC_'+site);s.native.autoClose=false;
  if(site==='operation'){
   s.native.openFailure=original;const op=s.make().connect(name('IN',s.capture),64);await expect(op.ready).rejects.toBe(original);let closed=false;void op.closed.then(()=>{closed=true;});await flush();expect(closed).toBe(false);expect(s.owner.held).toBe(278528);return;
  }
  const {op,stream,peer}=await opened(s);const errors=observe(stream);
  if(site==='read'){s.native.readFailure=original;stream.read(0);}
  if(site==='write'){s.native.writeFailure=original;stream.write(Buffer.from('x'),()=>{});}
  if(site==='close'){s.native.closeFailure=original;stream.destroy(original);}
  if(site==='cancel'){s.native.cancelFailure=original;op.cancel('THROW');}
  await flush();let closed=false;void op.closed.then(()=>{closed=true;});expect(closed).toBe(false);expect(s.owner.held).toBeGreaterThanOrEqual(278528);
  if(site==='read'||site==='write')expect(errors).toEqual([]);peer.closed.resolve();
  if(site==='read'||site==='write'){await flush();expect(closed).toBe(false);}else await op.closed;
 });
 it('closed reject는 실제 정리의 증거가 아니므로 pool을 유지한다',async()=>{
  const s=setup();s.native.autoClose=false;const {op,peer}=await opened(s);op.cancel('TEST_DONE');peer.closed.reject(Error('UNCONFIRMED_CLOSE'));let closed=false;void op.closed.then(()=>{closed=true;});await flush();expect(closed).toBe(false);expect(s.owner.held).toBe(278528);
 });
});

describe('L1 EOF 뒤 미소비 출력 보존',()=>{
 for(const mode of ['READ','END'] as const){
  it.each(['CONTROL','OUT','ERR'] as const)(`%s의 마지막 bytes와 EOF 뒤 native close가 먼저 와도 소비와 ${mode}를 기다린다`,async lane=>{
   const s=setup();s.native.autoClose=false;
   const {op,stream,peer}=await opened(s,lane,8),errors=observe(stream),events:string[]=[];
   stream.on('end',()=>events.push('end'));stream.on('close',()=>events.push('close'));
   stream.read(0);await until(()=>peer.reads.length===1);
   const read=peer.reads.shift()!;read.buffer.write('ok');read.done.resolve({bytesRead:2,eof:true});await flush();
   expect(stream.readableLength).toBe(2);const held=s.owner.held;expect(held).toBeGreaterThanOrEqual(278528);
   let closed=false;void op.closed.then(()=>{closed=true;});
   peer.closed.resolve();await flush();
   expect(stream.readableLength,'native close만으로 상위가 읽지 않은 bytes를 버리지 않는다').toBe(2);
   expect(stream.destroyed).toBe(false);expect(closed).toBe(false);expect(s.owner.held).toBe(held);expect(errors).toEqual([]);
   const writes=peer.writes.length;expect(()=>stream.write(Buffer.from('late'))).toThrow();expect(peer.writes).toHaveLength(writes);
   expect(stream.read(1).toString()).toBe('o');expect(stream.readableLength).toBe(1);expect(s.owner.held).toBe(held);expect(closed).toBe(false);
   expect(stream.read(1).toString()).toBe('k');
   // 이미 native가 반환한 실제 EOF도 마지막 pull로 소비한다.
   const ending=mode==='END'?end(stream):Promise.resolve();void ending.catch(()=>{});
   expect(stream.read()).toBeNull();await flush();
   expect({closed,readableEnded:stream.readableEnded,destroyed:stream.destroyed,held:s.owner.held,events},JSON.stringify({closes:peer.closes,cancels:peer.cancels,pendingReads:peer.reads.length})).toEqual({closed:true,readableEnded:true,destroyed:true,held:0,events:['end','close']});
   await ending;await op.closed;
   expect(stream.readableEnded).toBe(true);expect(events).toEqual(['end','close']);expect(errors).toEqual([]);
   expect(client.readWindowsPipeClientLocalInputClose(stream)).toBeNull();expect(s.owner.held).toBe(0);expect(closed).toBe(true);
  });
 }
});

describe('L2 native scratch 예산',()=>{
 it('L2 DATA의 2n보다 1byte 부족하면 native write와 복사 전에 거부한다',async()=>{
  const s=setup();s.options.clientBudgetBytes=278529;s.native.autoWrite=false;
  const {op,stream,peer}=await opened(s);
  try{expect(()=>stream.write(Buffer.from('x'))).toThrow();expect(peer.writes).toHaveLength(0);expect(s.owner.held).toBe(278528);}
  finally{op.cancel('L2_TEST_DONE');for(const w of peer.writes)w.done.reject(Error('TEST_CANCEL'));await op.closed;}
 });
 it('L2 DATA는 JS와 native scratch의 2n을 callback 뒤까지 예약한다',async()=>{
  const s=setup();s.options.clientBudgetBytes=278530;s.native.autoWrite=false;
  const {op,stream,peer}=await opened(s);let callbackHeld=0;
  try{stream.write(Buffer.from('x'),()=>{callbackHeld=s.owner.held;});await until(()=>peer.writes.length===1);expect(s.owner.held).toBe(278530);peer.writes[0].done.resolve(1);await until(()=>callbackHeld!==0);expect(callbackHeld).toBe(278530);expect(s.owner.held).toBe(278528);}
  finally{op.cancel('L2_TEST_DONE');for(const w of peer.writes)w.done.resolve(1);await op.closed;}
 });
 it('L2 read의 미소비 backing과 scratch는 합계 2n을 보존한다',async()=>{
  const s=setup(),{op,stream,peer}=await opened(s,'OUT',4);
  try{stream.read(0);await until(()=>peer.reads.length===1);expect(s.owner.held).toBe(278536);const r=peer.reads.shift()!;r.buffer.write('data');r.done.resolve({bytesRead:4,eof:true});await flush();expect(s.owner.held).toBe(278536);expect(stream.read(2).toString()).toBe('da');expect(s.owner.held).toBe(278536);expect(stream.read(2).toString()).toBe('ta');stream.read();await flush();}
  finally{op.cancel('L2_TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);}
 });
});
describe('L2 예약 경계 직접 관측',()=>{
 it('2n-1의 write는 private backing을 할당하기 전 거부한다',async()=>{const s=setup();s.options.clientBudgetBytes=278529;const {op,stream,peer}=await opened(s),allocate=vi.spyOn(Buffer,'allocUnsafeSlow');try{expect(()=>stream.write(Buffer.from('x'))).toThrow();expect(allocate).not.toHaveBeenCalled();expect(peer.writes).toHaveLength(0);}finally{allocate.mockRestore();op.cancel('TEST_DONE');await op.closed;}});
 it('2n+1의 cap에서 원 write는 2n만 유지하고 추가 write는 거부한다',async()=>{const s=setup();s.options.clientBudgetBytes=278531;s.native.autoWrite=false;const {op,stream,peer}=await opened(s);try{stream.write(Buffer.from('x'),()=>{});expect(s.owner.held).toBe(278530);expect(()=>stream.write(Buffer.from('y'))).toThrow();expect(peer.writes).toHaveLength(1);peer.writes[0].done.resolve(1);await flush();expect(s.owner.held).toBe(278528);}finally{op.cancel('TEST_DONE');for(const w of peer.writes)w.done.resolve(1);await op.closed;}});
 it('read도 2n-1에서는 backing과 native read 없이 종료한다',async()=>{const s=setup();s.options.clientBudgetBytes=278529;const {op,stream,peer}=await opened(s,'OUT',1),allocate=vi.spyOn(Buffer,'allocUnsafeSlow');try{stream.read(0);await op.closed;expect(allocate).not.toHaveBeenCalled();expect(peer.reads).toHaveLength(0);expect(s.owner.held).toBe(0);}finally{allocate.mockRestore();op.cancel('TEST_DONE');await op.closed;}});
 it('read의 2n cap은 실제 bytes 소비까지 반환하지 않는다',async()=>{const s=setup();s.options.clientBudgetBytes=278530;const {op,stream,peer}=await opened(s,'OUT',1);try{stream.read(0);await until(()=>peer.reads.length===1);expect(s.owner.held).toBe(278530);const r=peer.reads.shift()!;r.buffer.write('x');r.done.resolve({bytesRead:1,eof:true});await flush();expect(s.owner.held).toBe(278530);expect(stream.read(1).toString()).toBe('x');stream.read();await flush();}finally{op.cancel('TEST_DONE');await op.closed;expect(s.owner.held).toBe(0);}});
});
