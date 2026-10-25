import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {createHmac,randomUUID} from 'node:crypto';
import {Duplex,Writable} from 'node:stream';
import canonicalize from 'canonicalize';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {createWindowsJobBackend,encodeWindowsControl,decodeWindowsControl,type OriginalCapture,type WindowsPrepareInput,type WindowsJobPorts,type WindowsHostMessage,type WindowsControl,type JournalEntry,type WindowsSource,type HostFinalized,type WindowsSealEnvelope} from '../../packages/native/src/windows-job-backend.js';
const nativeGuard=vi.hoisted(()=>vi.spyOn(process,'dlopen').mockImplementation(()=>{throw Error('FORBIDDEN_NATIVE_ADDON');}));
afterAll(()=>nativeGuard.mockRestore());
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{throw Error('FORBIDDEN_PROCESS');}),spawnSync:vi.fn(()=>{throw Error('FORBIDDEN_PROCESS');}),exec:vi.fn(()=>{throw Error('FORBIDDEN_PROCESS');}),execFile:vi.fn(()=>{throw Error('FORBIDDEN_PROCESS');}),fork:vi.fn(()=>{throw Error('FORBIDDEN_PROCESS');})}));
const socketGuard=vi.hoisted(()=>vi.fn(function(){throw Error('FORBIDDEN_PIPE_CONSTRUCTION');}));
vi.mock('node:net',()=>({Socket:socketGuard,connect:vi.fn(()=>{throw Error('FORBIDDEN_PIPE');}),createConnection:vi.fn(()=>{throw Error('FORBIDDEN_PIPE');}),default:{connect:vi.fn(()=>{throw Error('FORBIDDEN_PIPE');})}}));
vi.mock('node:tls',()=>({connect:vi.fn(()=>{throw Error('FORBIDDEN_TLS');})}));
const modulePath='../../packages/native/src/windows-job-broker.js';
const brokerModule=await import(modulePath).catch(()=>({})) as typeof import('../../packages/native/src/windows-job-broker.js');
const id=(n:number)=>('00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0')) as `${string}-${string}-${string}-${string}-${string}`;
const h=(s:string)=>digest(s);
const clone=<T>(v:T):T=>structuredClone(v);
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function flush(){for(let n=0;n<60;n++)await Promise.resolve();await new Promise<void>(r=>setImmediate(r));}
async function until(fn:()=>boolean){for(let n=0;n<40&&!fn();n++)await flush();expect(fn(),'지정한 가짜 완료 경계에 도달해야 한다').toBe(true);}
class Queue<T> implements AsyncIterable<T>{
 values:T[]=[];readers:((v:IteratorResult<T>)=>void)[]=[];ended=false;
 push(v:T){const r=this.readers.shift();if(r)r({value:v,done:false});else this.values.push(v);}
 end(){this.ended=true;for(const r of this.readers.splice(0))r({value:undefined,done:true});}
 [Symbol.asyncIterator](){return {next:async():Promise<IteratorResult<T>>=>this.values.length?{value:this.values.shift()!,done:false}:this.ended?{value:undefined,done:true}:new Promise(r=>this.readers.push(r))};}
}
function input(binarySize=15):WindowsPrepareInput{
 const limits={maxMetadataBytes:4096,maxInputBytes:Math.max(16384,binarySize*2),maxOutputBytes:16384,maxItems:8,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:1048576};
 const blobs=new Map([['source',Buffer.alloc(binarySize,0x61)]]);
 const job=createNativeJob('DECODE_IMAGE',h('profile'),{},blobs,{maxMetadataBytes:4096,maxBinaryBytes:limits.maxInputBytes,maxItems:8},id(21));
 const identity={binding:{accountId:id(22),capacityReservationId:id(23),jobId:id(21),parentInstanceId:id(24),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:h('kernel')},intentDigest:h('intent'),sourceInput:{executionId:id(25),inputEvidenceId:id(26),stageInputDigest:h('stage')},inputEvidenceDigest:h('record'),inputFingerprint:h('input'),basisRef:{evidenceId:id(27),evidenceDigest:h('basis')}};
 const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
 const authority={attemptId:id(28),controllerInstanceId:id(29),controllerId:'controller',keyVersion:'key-v1',environmentDigest:h('environment'),hostEpochId:id(2),sessionId:id(3),launchId:id(4),policyDigest:digest(policy),controllerSidDigest:h('controller-sid'),childSidDigest:h('child-sid'),appContainerSidDigest:h('container-sid')};
 const pins={executableDigest:h('exe'),bootstrapDigest:h('bootstrap'),helperRuntimeDigest:h('python'),helperScriptDigest:h('helper'),runtimeFilesDigest:h('runtime'),nativeLimitsDigest:digest(limits)};
 return {identity,authority,pins,policy,limits,frame:{envelope:job,blobs}};
}
function capture(i=input()):OriginalCapture{
 const {frame,...origin}=i;return {origin,originDigest:digest({identity:i.identity,authority:i.authority,pins:i.pins,policy:i.policy,nativeLimitsDigest:digest(i.limits),frameInputDigest:frame.envelope.inputDigest}),frameInputDigest:frame.envelope.inputDigest,launchRef:id(30)};
}
function noChild(mode:'NOT_ATTEMPTED'|'FAILED'){
 const i=input(),c=capture(i),events=new Queue<WindowsHostMessage>(),join=deferred<{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}>(),controls:WindowsControl[]=[],rows:JournalEntry[]=[],entries:JournalEntry[]=[];
 let stored:{ref:{recordId:string;digest:string};envelope:WindowsSealEnvelope}|null=null;
 const gate=deferred<void>(),ackGate=deferred<void>(),parentGate=deferred<void>();
 let blockJournal=false,blockAck=false,blockParent=false,failJournal=false,failAck=false,failParent=false,parentCount=0,goCount=0;
 const failureCode=mode==='FAILED'?'WINDOWS_CREATE_ACCESS_DENIED':'WINDOWS_POLICY_UNCONFIRMED';
 const add=(kind:JournalEntry['event']['kind'],payload:unknown,facts:WindowsSource['facts'])=>{
 const body={eventId:id(100+entries.length),sequence:entries.length+1,kind,qpcTicks:String(100+entries.length*10),previousDigest:entries.at(-1)?.event.payloadDigest??null,payload};
 const event={...body,payloadDigest:digest(body)} as JournalEntry['event'];const source:WindowsSource={version:1,originDigest:c.originDigest,eventId:event.eventId,facts};entries.push({event,source,sourceDigest:digest(source)});};
 add('PRE_CREATE',{bindingDigest:digest(i.identity),policyDigest:i.authority.policyDigest,pinsDigest:digest(i.pins)},[]);
 if(mode==='FAILED'){add('CREATE_ARMED',{callId:id(200)},[]);add('CREATE_FAILED',{win32Error:5,creationConfirmedAbsent:true},[{kind:'WIN32',callId:id(200),api:'CreateProcessAsUserW',qpcTicks:'120',status:'FAILED',win32Error:5,value:null}]);add('FAILED',{code:failureCode,phase:'CREATE'},[]);}
 else add('CREATE_NOT_ATTEMPTED',{code:failureCode},[]);
 const evidence={version:1 as const,kind:'WINDOWS_JOB_OBJECT' as const,identity:i.identity,authority:i.authority,pins:i.pins,policy:{requested:i.policy,osReadback:null,brokerApplied:null},lifecycle:{creation:mode,root:null,rootExit:null,goGrantRef:null,goWrite:'NOT_ATTEMPTED' as const,events:entries.map(r=>r.event)},final:{outcome:'NO_CHILD_CREATED' as const,activeProcesses:null,rootSignaled:false,stdioJoined:false,parentIoJoined:true,recordSealed:true,accounting:null,failureCode}};
 const emit=(message:string,payload:unknown)=>events.push({version:1,requestId:controls.at(-1)!.requestId,originDigest:c.originDigest,attemptId:i.authority.attemptId,sessionId:i.authority.sessionId,launchId:i.authority.launchId,message,payload} as WindowsHostMessage);
 let next=0,now=0;const waits:{at:number;resolve:()=>void}[]=[];
 const session={send:async(control:WindowsControl)=>{
 controls.push(control);
 if(control.command==='PREPARE')emit('EVENT',entries[next++]);
 if(control.command==='ACK_EVENT'){
 if(control.payload.eventId===entries.find(r=>r.event.kind.startsWith('CREATE_')&&r.event.kind!=='CREATE_ARMED')!.event.eventId){if(blockAck)await ackGate.promise;if(failAck)throw Error('ACK_LOST');}
 if(next<entries.length)emit('EVENT',entries[next++]);
 }
 // 원 host처럼 부모 ACK 전에는 candidate를 보내지 않는다.
 if(control.command==='PARENT_JOINED')emit('FINAL_CANDIDATE',{evidence});
 if(control.command==='ACK_FINAL'){const f={...control.payload,handles:'CLOSED' as const,closeCode:null};emit('FINALIZED',f);events.end();join.resolve({end:'EXPECTED',finalized:f});}
 },events,nativeInput:new Writable({write:(_b,_e,cb)=>cb(Error('NO_CHILD_INPUT'))}),nativeOutput:{[Symbol.asyncIterator](){throw Error('NO_CHILD_READ');}},nativeError:{[Symbol.asyncIterator](){throw Error('NO_CHILD_READ');}},join:()=>join.promise};
 const ports:WindowsJobPorts={original:{captureFresh:async()=>({created:true,capture:c}),grantOriginal:async()=>{goCount++;throw Error('NO_CHILD_GO');},readOriginal:async()=>({originDigest:c.originDigest,state:'CONFIRMED',goGrantRef:null})},broker:{open:async()=>session,readOriginal:async()=>null},journal:{appendOriginal:async(_c,e,s)=>{if(e.kind==='CREATE_NOT_ATTEMPTED'||e.kind==='CREATE_FAILED'){if(blockJournal)await gate.promise;if(failJournal)throw Error('JOURNAL_LOST');}const row={event:e,source:s,sourceDigest:digest(s)};rows.push(row);return {eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest};},lookupEvent:async()=>null,scanOriginal:async function*(){yield*rows;},sealOriginal:async(_c,e)=>{const ref={recordId:id(201),digest:digest(e)};stored={ref,envelope:e};return ref;},readOriginal:async()=>stored},parent:{rawResult:async()=>{throw Error('NO_CHILD_RAW');},joinOriginal:async()=>{parentCount++;if(blockParent)await parentGate.promise;if(failParent)throw Error('PARENT_LOST');return {joinId:id(202),originDigest:c.originDigest,digest:h('parent')};}},clock:{nowMs:()=>now,waitUntil:at=>new Promise(r=>waits.push({at,resolve:r}))}};
 const backend=createWindowsJobBackend(i,ports);
 return {backend,ports,host:session,c,entries,controls,rows,gate,ackGate,parentGate,get parentCount(){return parentCount;},get goCount(){return goCount;},set blockJournal(v:boolean){blockJournal=v;},set blockAck(v:boolean){blockAck=v;},set blockParent(v:boolean){blockParent=v;},set failJournal(v:boolean){failJournal=v;},set failAck(v:boolean){failAck=v;},set failParent(v:boolean){failParent=v;},emit,advance(ms:number){now+=ms;for(const w of waits.splice(0)){if(w.at<=now)w.resolve();else waits.push(w);}},async cleanup(){gate.resolve();ackGate.resolve();parentGate.resolve();await backend.stop('CALLER_ABORT');},forceCleanup(){gate.resolve();ackGate.resolve();parentGate.resolve();events.end();join.resolve({end:'LOST',finalized:null});now=100000;for(const w of waits.splice(0))w.resolve();}};
}
afterEach(()=>{expect(nativeGuard).not.toHaveBeenCalled();vi.clearAllMocks();});
describe('W5-A 미생성 부모 선행 합류',()=>{
 it.each(['NOT_ATTEMPTED','FAILED'] as const)('%s 원 event ACK 뒤 부모 합류로 candidate 대기 순환을 푼다',async mode=>{
 const f=noChild(mode);try{void f.backend.prepare().catch(()=>{});await until(()=>f.rows.some(r=>r.event.kind==='CREATE_NOT_ATTEMPTED'||r.event.kind==='CREATE_FAILED'));await flush();
 expect(f.parentCount,'candidate를 기다리는 host보다 먼저 부모 합류가 시작되어야 한다').toBe(1);
 await until(()=>f.controls.some(c=>c.command==='ACK_FINAL'));await f.backend.idle();expect((await f.backend.query()).outcome?.state).toBe('JOINED');expect(f.goCount).toBe(0);
 }finally{f.forceCleanup();await flush();}
 });
});
describe('W5-A broker factory',()=>{
 it('가짜 포트 연결 전에 실제 factory가 존재해야 한다',()=>{expect(brokerModule.createWindowsJobBroker).toBeTypeOf('function');});
});

type BrokerOptions=import('../../packages/native/src/windows-job-broker.js').WindowsJobBrokerOptions;
type ConnectOperation=import('../../packages/native/src/windows-job-broker.js').WindowsBrokerConnectOperation;
type Lane='CONTROL'|'IN'|'OUT'|'ERR';
function paddedPacket(value:unknown,bytes=40000){const raw=Buffer.from(canonicalize(value)!,'ascii'),prefix=Buffer.alloc(4);prefix.writeUInt32BE(bytes);return Buffer.concat([prefix,Buffer.alloc(bytes-raw.length,32),raw]);}
function packet(value:unknown){const b=Buffer.from(canonicalize(value)!,'ascii'),p=Buffer.alloc(4);p.writeUInt32BE(b.length);return Buffer.concat([p,b]);}
function signed(key:Buffer,kind:string,lane:string,body:unknown,endpointId=id(1)){
 const unsigned={version:1,domain:'trio-windows-broker-v1',kind,endpointId,lane,body};
 return {...unsigned,mac:createHmac('sha256',key).update(canonicalize(unsigned)!,'ascii').digest('hex')};
}
class FakePipe extends Duplex{
 readonly written:Buffer[]=[];private collected=Buffer.alloc(0);attached=false;deferWrites=false;callbacks:((error?:Error)=>void)[]=[];
 constructor(readonly lane:Lane,readonly peer:Peer){super({allowHalfOpen:true,highWaterMark:64});}
 _read(){}
 _write(chunk:Buffer,_encoding:BufferEncoding,callback:(e?:Error|null)=>void){
 this.written.push(Buffer.from(chunk));
 try{
 if(this.lane==='CONTROL'||!this.attached){
 this.collected=Buffer.concat([this.collected,chunk]);while(this.collected.length>=4&&this.collected.length>=4+this.collected.readUInt32BE()){
 const n=this.collected.readUInt32BE(),frame=this.collected.subarray(0,n+4);this.collected=this.collected.subarray(n+4);this.peer.receive(this,JSON.parse(frame.subarray(4).toString('ascii')));
 }
 }
 if(this.deferWrites)this.callbacks.push(error=>callback(error));else callback();
 }catch(e){callback(e as Error);}
 }
 reply(value:unknown,fragmented=false){const bytes=packet(value);if(fragmented){for(const b of bytes)this.push(Buffer.from([b]));}else this.push(bytes);}
 failWrites(){for(const cb of this.callbacks.splice(0))cb(Error('ORIGINAL_WRITE_FAILED'));}
 completeWrites(){for(const cb of this.callbacks.splice(0))cb();}
}
class Peer{
 readonly c=capture();readonly pipes=new Map<Lane,FakePipe>();readonly names:string[]=[];readonly operations:ConnectOperation[]=[];readonly cancels:string[]=[];readonly controls:WindowsControl[]=[];
 readonly key=Buffer.from(Array.from({length:32},(_,n)=>n));readonly clients:string[]=[];readonly closeGates= new Map<Lane,ReturnType<typeof deferred<void>>>();
 padBootstrap=false;tuple:Record<string,unknown>|null=null;phaseFault:string|null=null;fragmented=false;deferClose=false;deferConnect=false;readyGates=new Map<Lane,ReturnType<typeof deferred<Duplex>>>();
 blockKind:string|null=null;onControl:((control:WindowsControl)=>void)|null=null;now=0;holds=0;peak=0;released=0;nonceByte=17;waits:{at:number;resolve:()=>void;cancelled:boolean}[]=[];
 options:BrokerOptions;
 constructor(){
 const a=this.c.origin.authority;
 this.options={registration:{version:1,hostEpochId:a.hostEpochId,environmentDigest:a.environmentDigest,controllerInstanceId:a.controllerInstanceId,endpointId:id(1),hostProcess:{pid:101,creationFileTime100ns:'123',windowsSessionId:7},controllerProcess:{pid:202,creationFileTime100ns:'456',windowsSessionId:7},hostSidDigest:'b'.repeat(64),controllerSidDigest:a.controllerSidDigest,key:this.key},bounds:{maxControlBytes:131072,maxChunkBytes:1024,streamHighWaterMarkBytes:64,maxQueuedBytes:131072,maxInFlightBytes:4194304,maxRetainedRecords:2,handshakeMilliseconds:100,closeMilliseconds:100,maxPendingOperations:32},memory:{maxBytes:8388608,available:()=>8388608-this.holds,hold:(n:number)=>{expect(n).toBeGreaterThanOrEqual(0);this.holds+=n;this.peak=Math.max(this.peak,this.holds);let live=true;return()=>{expect(live,'credit을 정확히 한 번 반납한다').toBe(true);live=false;this.holds-=n;this.released++;};}},ports:{connect:(name,hwm)=>this.connect(name,hwm),nowMs:()=>this.now,startWait:at=>{const d=deferred<void>(),w={at,resolve:d.resolve,cancelled:false};this.waits.push(w);return {done:d.promise,cancel:()=>{w.cancelled=true;}};},nonce:()=>Buffer.alloc(32,this.nonceByte++)}};
 }
 connect(name:string,hwm:number){
 expect(hwm).toBe(64);this.names.push(name);const lane:Lane=name.endsWith('-ctl')?'CONTROL':name.endsWith('-in')?'IN':name.endsWith('-out')?'OUT':'ERR';const p=new FakePipe(lane,this);this.pipes.set(lane,p);
 const ready=deferred<Duplex>(),closed=deferred<void>();this.closeGates.set(lane,closed);this.readyGates.set(lane,ready);p.once('close',()=>{if(!this.deferClose)closed.resolve();});
 const op={ready:ready.promise,cancel:(reason:string)=>{this.cancels.push(reason);if(!this.deferConnect)p.destroy();},closed:closed.promise};this.operations.push(op);if(!this.deferConnect)ready.resolve(p);return op;
 }
 receive(p:FakePipe,m:Record<string,unknown>){
 const lane=p.lane,r=this.options.registration;if(m.kind===this.blockKind)p.deferWrites=true;
 if(m.domain==='trio-windows-broker-v1'){
 const body=m.body as Record<string,unknown>,kind=m.kind;
 const {mac,...unsigned}=m;expect(mac).toBe(createHmac('sha256',this.key).update(canonicalize(unsigned)!,'ascii').digest('hex'));
 if(kind==='OPEN'){
 const c=body.capture as OriginalCapture;this.clients.push(body.clientNonce as string);
 this.tuple={hostEpochId:r.hostEpochId,environmentDigest:r.environmentDigest,originDigest:c.originDigest,attemptId:c.origin.authority.attemptId,sessionId:c.origin.authority.sessionId,launchId:c.origin.authority.launchId,launchRef:c.launchRef,controllerInstanceId:r.controllerInstanceId,clientNonce:body.clientNonce,serverNonce:'22'.repeat(32),hostProcess:r.hostProcess,controllerProcess:r.controllerProcess,hostSidDigest:r.hostSidDigest,controllerSidDigest:r.controllerSidDigest};
 this.reply(p,'CHALLENGE','CONTROL');
 }else if(kind==='AUTH'){expect(body).toEqual(this.tuple);this.reply(p,'ACCEPT','CONTROL');}
 else if(kind==='ATTACH'){expect(body).toEqual(this.tuple);p.attached=true;this.reply(p,'ATTACHED',lane);}
 else throw Error('UNEXPECTED_PRIVATE');
 }else{const control=decodeWindowsControl(packet(m));this.controls.push(control);this.onControl?.(control);}
 }
 reply(p:FakePipe,kind:string,lane:Lane){
 const body=clone(this.tuple!);if(this.phaseFault===kind+'-epoch')body.hostEpochId=id(80);if(this.phaseFault===kind+'-process')body.hostProcess={...this.options.registration.hostProcess,creationFileTime100ns:'124'};
 const m=signed(this.key,kind,lane,body);if(this.phaseFault===kind+'-mac')m.mac='f'.repeat(64);if(this.phaseFault===kind+'-lane')m.lane='ERR';
 if(this.padBootstrap&&kind==='CHALLENGE')p.push(paddedPacket(m));else p.reply(m,this.fragmented);
 }
 advance(ms:number){this.now+=ms;for(const w of this.waits)if(!w.cancelled&&w.at<=this.now){w.cancelled=true;w.resolve();}}
 message(message:'PROGRESS'|'FINALIZED'|'ERROR',payload:unknown,requestId=this.controls.at(-1)!.requestId){
 const a=this.c.origin.authority;this.pipes.get('CONTROL')!.reply({version:1,requestId,originDigest:this.c.originDigest,attemptId:a.attemptId,sessionId:a.sessionId,launchId:a.launchId,message,payload});
 }
 command(command:'QUERY'|'ACK_FINAL'|'PREPARE'='QUERY'):WindowsControl{
 const a=this.c.origin.authority;const common={version:1 as const,requestId:id(300+this.controls.length),originDigest:this.c.originDigest,attemptId:a.attemptId,sessionId:a.sessionId,launchId:a.launchId};
 if(command==='ACK_FINAL')return {...common,command,payload:{recordId:id(400),digest:h('final')}};
 if(command==='PREPARE')return {...common,command,payload:{origin:this.c.origin,launchRef:this.c.launchRef}};
 return {...common,command,payload:{}};
 }
 eof(){for(const p of this.pipes.values())p.push(null);}
 cleanup(){for(const [lane,p]of this.pipes){p.completeWrites();p.destroy();this.closeGates.get(lane)!.resolve();}}
}
const resources:Peer[]=[];
function peer(){const p=new Peer();resources.push(p);return p;}
afterEach(async()=>{for(const p of resources.splice(0))p.cleanup();await flush();});
async function drain(iterable:AsyncIterable<unknown>){for await(const _ of iterable){void _;}}
async function complete(p:Peer,s:import('../../packages/native/src/windows-job-backend.js').BrokerSession){
 const out=drain(s.nativeOutput),err=drain(s.nativeError),events=drain(s.events);const ack=p.command('ACK_FINAL');await s.send(ack);p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});p.eof();await Promise.all([out,err,events]);return s.join();
}
describe('W5-A 인증된 가짜 4lane 전송',()=>{
 it('네 lane 인증을 끝낸 뒤 같은 원 제어를 보내고 실제 close 뒤 EXPECTED가 된다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options);expect(p.names).toEqual([]);expect(b.usage().activeSessions).toBe(0);
 const s=await b.broker.open(p.c);expect(p.names).toHaveLength(4);const command=p.command('PREPARE');await s.send(command);expect(p.controls).toEqual([command]);
 expect(await complete(p,s)).toMatchObject({end:'EXPECTED',finalized:{handles:'CLOSED'}});await b.idle();expect(b.usage()).toMatchObject({activeSessions:0,retainedRecords:1,heldBytes:0,pendingOperations:0});expect(p.holds).toBe(0);
 });
 it('prefix 1byte 단편과 합쳐진 frame을 원 codec으로 처리하고 native bytes를 바꾸지 않는다',async()=>{
 const p=peer();p.fragmented=true;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'PREPARING',bootstrap:'NONE',bootstrapFact:null});
 const bytes=Buffer.from([0,255,84,77,78,65,84,86,49,0,10]),out=s.nativeOutput[Symbol.asyncIterator]();p.pipes.get('OUT')!.push(bytes);
 const n=await out.next();expect(Buffer.from(n.value!)).toEqual(bytes);expect(b.usage().heldBytes).toBeGreaterThan(bytes.length);p.pipes.get('OUT')!.push(null);await out.next();const err=drain(s.nativeError),events=drain(s.events);const ack=p.command('ACK_FINAL');await s.send(ack);p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});p.eof();await Promise.all([err,events]);expect(await s.join()).toMatchObject({end:'EXPECTED'});await b.idle();
 });
 it.each(['CHALLENGE','ACCEPT','ATTACHED'] as const)('%s의 다른 MAC은 후속 create 제어 없이 LOST로 정리한다',async kind=>{
 const p=peer();p.phaseFault=kind+'-mac';const b=brokerModule.createWindowsJobBroker(p.options);await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_BOOTSTRAP_MAC'});p.cleanup();await expect(b.idle()).rejects.toThrow();expect(p.controls).toHaveLength(0);expect(p.holds).toBe(0);
 });
 it.each(['epoch','process','lane'] as const)('host %s 불일치를 거부한다',async fault=>{
 const p=peer();p.phaseFault='CHALLENGE-'+fault;const b=brokerModule.createWindowsJobBroker(p.options);await expect(b.broker.open(p.c)).rejects.toMatchObject({nextAction:'WAIT'});p.cleanup();await expect(b.idle()).rejects.toThrow();expect(p.names).toHaveLength(1);
 });
 it('동일 원 capture·동시 세션·stopClaims 뒤 새 연결을 거부한다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);
 await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_BROKER_NOT_ACCEPTING'});
 await complete(p,s);await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_ORIGINAL_REPLAY'});
 b.stopClaims();await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_BROKER_NOT_ACCEPTING'});expect(p.names).toHaveLength(4);await b.idle();
 });
 it('READY 전 write와 end는 child 입력 없이 거부한다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const count=p.pipes.get('IN')!.written.length;
 expect(()=>s.nativeInput.write(Buffer.from('x'))).toThrow(/WINDOWS_INPUT_BEFORE_READY/);expect(()=>s.nativeInput.end()).toThrow(/WINDOWS_INPUT_BEFORE_READY/);expect(p.pipes.get('IN')!.written).toHaveLength(count);await complete(p,s);
 });
 it('FINALIZED와 EOF가 있어도 실제 closed 완료까지 join·credit을 보존한다',async()=>{
 const p=peer();p.deferClose=true;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);let done=false;const pending=complete(p,s).then(v=>{done=true;return v;});await flush();expect(done).toBe(false);expect(p.holds).toBeGreaterThan(0);for(const d of p.closeGates.values())d.resolve();expect(await pending).toMatchObject({end:'EXPECTED'});expect(p.holds).toBe(0);await b.idle();
 });
 it('연결 timeout 뒤 late ready에는 handshake를 쓰지 않고 actual closed까지 보유한다',async()=>{
 const p=peer();p.deferConnect=true;p.deferClose=true;const b=brokerModule.createWindowsJobBroker(p.options),pending=b.broker.open(p.c);await flush();p.advance(101);await expect(pending).rejects.toMatchObject({code:'WINDOWS_BROKER_TIMEOUT'});
 expect(p.holds).toBeGreaterThan(0);const socket=p.pipes.get('CONTROL')!;p.readyGates.get('CONTROL')!.resolve(socket);await flush();expect(socket.written).toHaveLength(0);let idle=false;const waiting=b.idle().catch(()=>{}).then(()=>{idle=true;});await flush();expect(idle).toBe(false);p.closeGates.get('CONTROL')!.resolve();await waiting;expect(p.holds).toBe(0);await b.idle();
 });
});

describe('W5-A 미생성 중 취소와 원 실패 보존',()=>{
 it.each(['NOT_ATTEMPTED','FAILED'] as const)('저장 중 취소한 %s도 정확 event ACK 뒤 부모를 한 번만 합류한다',async mode=>{
 const f=noChild(mode);f.blockJournal=true;try{
 void f.backend.prepare().catch(()=>{});await until(()=>f.controls.filter(c=>c.command==='ACK_EVENT').length===(mode==='FAILED'?2:1));void f.backend.stop('CALLER_ABORT');
 expect(f.parentCount).toBe(0);f.gate.resolve();await until(()=>f.controls.some(c=>c.command==='ACK_FINAL'));await f.backend.idle();expect(f.parentCount).toBe(1);expect(f.goCount).toBe(0);expect((await f.backend.query()).outcome?.state).toBe('JOINED');
 }finally{f.forceCleanup();await flush();}
 });
 it.each(['NOT_ATTEMPTED','FAILED'] as const)('저장 중 deadline이 지난 %s의 정리 ACK와 동일 재전송을 허용한다',async mode=>{
 const f=noChild(mode);f.blockJournal=true;f.blockParent=true;try{
 void f.backend.prepare().catch(()=>{});await until(()=>f.controls.filter(c=>c.command==='ACK_EVENT').length===(mode==='FAILED'?2:1));f.advance(1001);await flush();f.gate.resolve();await until(()=>f.parentCount===1);
 const row=f.entries.find(r=>r.event.kind==='CREATE_NOT_ATTEMPTED'||r.event.kind==='CREATE_FAILED')!;f.emit('EVENT',clone(row));f.parentGate.resolve();await until(()=>f.controls.filter(c=>c.command==='ACK_EVENT'&&c.payload.eventId===row.event.eventId).length===2);
 await until(()=>f.controls.some(c=>c.command==='ACK_FINAL'));expect(f.parentCount).toBe(1);expect(f.rows.filter(r=>r.event.kind===row.event.kind)).toHaveLength(1);expect(f.goCount).toBe(0);
 }finally{f.forceCleanup();await flush();}
 });
 it.each(['journal','ack','parent'] as const)('%s 원 실패를 후보·GO·재합류 성공으로 바꾸지 않는다',async fault=>{
 const f=noChild('NOT_ATTEMPTED');if(fault==='journal')f.failJournal=true;if(fault==='ack')f.failAck=true;if(fault==='parent')f.failParent=true;
 try{void f.backend.prepare().catch(()=>{});await until(()=>f.controls.some(c=>c.command==='STOP'));f.advance(2000);await flush();expect((await f.backend.query()).outcome?.state).toBe('WAIT');expect(f.controls.some(c=>c.command==='ACK_FINAL')).toBe(false);expect(f.parentCount).toBe(fault==='parent'?1:0);expect(f.goCount).toBe(0);}finally{f.forceCleanup();await flush();}
 });
 it('부모 ACK가 대기하면 FINAL 후보와 SEAL ACK를 앞당기지 않는다',async()=>{
 const f=noChild('NOT_ATTEMPTED');f.blockParent=true;try{void f.backend.prepare().catch(()=>{});await until(()=>f.parentCount===1);expect(f.controls.some(c=>c.command==='PARENT_JOINED'||c.command==='ACK_FINAL')).toBe(false);f.parentGate.resolve();await until(()=>f.controls.some(c=>c.command==='ACK_FINAL'));expect(f.parentCount).toBe(1);}finally{f.forceCleanup();await flush();}
 });
});
describe('W5-A 입력 경계와 보유 한도',()=>{
 it.each(['extra','getter','proxy','cycle','alias','key','bounds','capture'] as const)('%s 입력은 연결 전에 거부한다',async fault=>{
 const p=peer();const options=p.options;let offered:unknown=options;
 if(fault==='extra')Object.defineProperty(options,'hidden',{value:true});
 if(fault==='getter')Object.defineProperty(options.registration.hostProcess,'pid',{get:()=>{throw Error('GETTER_CALLED');},enumerable:true});
 if(fault==='proxy')offered=new Proxy(options,{get:()=>{throw Error('PROXY_CALLED');}});
 if(fault==='cycle')(options.registration.hostProcess as unknown as Record<string,unknown>).pid=options.registration;
 if(fault==='alias'){const leaf={a:'x'};let v:unknown=leaf;for(let n=0;n<15;n++)v=[v,v];(options.registration.hostProcess as unknown as Record<string,unknown>).pid=v;}
 if(fault==='key')options.registration.key=Buffer.alloc(31);
 if(fault==='bounds')options.bounds.maxChunkBytes=65537;
 if(fault==='capture')p.c.frameInputDigest=h('different');
 try{const b=brokerModule.createWindowsJobBroker(offered as BrokerOptions);await expect(b.broker.open(p.c)).rejects.toMatchObject({nextAction:'WAIT'});}catch(e){expect((e as Error).message).not.toMatch(/GETTER_CALLED|PROXY_CALLED/);}
 expect(p.names).toHaveLength(0);
 });
 it('소유 byte 예산이 부족하면 connect 전에 거부한다',async()=>{
 const p=peer();p.options.bounds.maxInFlightBytes=1;const b=brokerModule.createWindowsJobBroker(p.options);await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_BROKER_CAPACITY'});expect(p.names).toHaveLength(0);expect(p.holds).toBe(0);
 });
 it('최초 snapshot은 caller의 사후 key·capture·port 교체와 분리한다',async()=>{
 const p=peer();const originalKey=Buffer.from(p.key);const b=brokerModule.createWindowsJobBroker(p.options);p.options.ports.connect=()=>{throw Error('REPLACED_CONNECT');};
 const opening=b.broker.open(p.c);p.c.launchRef=id(77);p.options.registration.key.fill(255);p.key.set(originalKey);const s=await opening;
 // 원 peer는 최초 OPEN의 실제 고정 tuple을 대조한다.
 expect(p.tuple!.launchRef).toBe(id(30));await complete(p,s);await b.idle();
 });
 it('readOriginal miss는 null이고 다른 launchRef로 원 기록을 조회할 수 없다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options);expect(await b.broker.readOriginal(p.c)).toBeNull();const s=await b.broker.open(p.c);await complete(p,s);expect(await b.broker.readOriginal(p.c)).toMatchObject({phase:'JOINED',finalized:{handles:'CLOSED'}});
 const other=clone(p.c);other.launchRef=id(88);expect(await b.broker.readOriginal(other)).toBeNull();await b.idle();
 });
 it('retention이 찬 epoch는 기록을 비우거나 연결을 재사용하지 않는다',async()=>{
 const p=peer();p.options.bounds.maxRetainedRecords=1;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await complete(p,s);await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_BROKER_RETENTION'});expect(b.usage().retainedRecords).toBe(1);expect(p.names).toHaveLength(4);
 });
 it('native lane과 사건 stream의 두 번째 소비자를 거부한다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const first=s.nativeOutput[Symbol.asyncIterator](),pending=first.next();const second=s.nativeOutput[Symbol.asyncIterator]();await expect(second.next()).rejects.toMatchObject({code:'WINDOWS_DOUBLE_CONSUMER'});p.pipes.get('OUT')!.push(null);await pending;
 const events=s.events[Symbol.asyncIterator](),waiting=events.next();await expect(s.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({code:'WINDOWS_DOUBLE_CONSUMER'});const ack=p.command('ACK_FINAL');await s.send(ack);p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});await waiting;p.eof();await events.next();await drain(s.nativeError);expect(await s.join()).toMatchObject({end:'EXPECTED'});await b.idle();
 });
 it('HOST ERROR 뒤 FINALIZED가 와도 정상 종료를 합성하지 않는다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('ERROR',{code:'WINDOWS_HOST_FAILED'});const result=await complete(p,s);expect(result.end).toBe('LOST');expect(result.finalized).toMatchObject({handles:'CLOSED'});await expect(b.idle()).rejects.toThrow();await b.idle();
 });
 it('close 기한은 취소를 요청하되 미확인 closed의 credit을 반납하지 않는다',async()=>{
 const p=peer();p.deferClose=true;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const events=drain(s.events).catch(e=>e);const ack=p.command('ACK_FINAL');await s.send(ack);p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});await flush();p.advance(101);await flush();expect(p.cancels.length).toBeGreaterThan(0);expect(p.holds).toBeGreaterThan(0);for(const d of p.closeGates.values())d.resolve();expect(await events).toMatchObject({code:'WINDOWS_CLOSE_TIMEOUT'});expect(await s.join()).toMatchObject({end:'LOST',finalized:{handles:'CLOSED'}});await expect(b.idle()).rejects.toThrow();expect(p.holds).toBe(0);
 });
});

describe('W5-A 원 bytes와 엄격한 frame 경계',()=>{
 it.each([1023,1024,1025])('READY 뒤 %i bytes 원 write를 transport chunk로 나누어 보존한다',async size=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 const bytes=Buffer.alloc(size,0xab),lane=p.pipes.get('IN')!,before=lane.written.length;
 await new Promise<void>((resolve,reject)=>s.nativeInput.write(bytes,e=>e?reject(e):resolve()));const transmitted=lane.written.slice(before);expect(transmitted.every(b=>b.length<=1024)).toBe(true);expect(Buffer.concat(transmitted)).toEqual(bytes);await new Promise<void>((resolve,reject)=>s.nativeInput.end((e?:Error)=>e?reject(e):resolve()));
 expect(await complete(p,s)).toMatchObject({end:'EXPECTED'});await b.idle();expect(p.holds).toBe(0);
 });
 it('입력 write callback이 대기해도 제어 ACK를 보내고 원 buffer credit은 유지한다',async()=>{
 const p=peer();p.options.bounds.maxQueuedBytes=1024;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 const lane=p.pipes.get('IN')!;lane.deferWrites=true;const before=p.holds;let returned=false;const write=new Promise<void>((resolve,reject)=>s.nativeInput.write(Buffer.alloc(1024,7),e=>e?reject(e):resolve())).then(()=>{returned=true;});await flush();expect(returned).toBe(false);expect(p.holds).toBeGreaterThan(before);
 expect(()=>s.nativeInput.write(Buffer.from('x'))).toThrow(/WINDOWS_BROKER_QUEUE/);await s.send(p.command());expect(p.controls).toHaveLength(2);expect(returned).toBe(false);lane.completeWrites();await write;await complete(p,s);await b.idle();expect(p.holds).toBe(0);
 });
 it.each(['zero','oversize','truncated','duplicate','renegotiate'] as const)('%s control은 정상 종료를 만들지 못한다',async fault=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const events=drain(s.events).catch(e=>e);await s.send(p.command());
 if(fault==='zero')p.pipes.get('CONTROL')!.push(Buffer.alloc(4));
 if(fault==='oversize'){const v=Buffer.alloc(4);v.writeUInt32BE(131073);p.pipes.get('CONTROL')!.push(v);}
 if(fault==='truncated'){const v=Buffer.alloc(5);v.writeUInt32BE(2);v[4]=123;p.pipes.get('CONTROL')!.push(v);p.pipes.get('CONTROL')!.push(null);}
 if(fault==='duplicate'){const body=Buffer.from('{"version":1,"version":1}'),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);p.pipes.get('CONTROL')!.push(Buffer.concat([prefix,body]));}
 if(fault==='renegotiate')p.pipes.get('CONTROL')!.reply(signed(p.key,'OPEN','CONTROL',{}));
 expect(await s.join()).toMatchObject({end:'LOST',finalized:null});expect(await events).toBeInstanceOf(Error);await expect(b.idle()).rejects.toThrow();expect(p.holds).toBe(0);
 });
 it.each([131071,131072,131073])('%i byte control body의 최대 길이를 prefix에서 검사한다',async bytes=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const received:WindowsHostMessage[]=[],reading=(async()=>{try{for await(const m of s.events)received.push(m);}catch{return;}})();await s.send(p.command());const a=p.c.origin.authority;
 const message={version:1,requestId:p.controls[0].requestId,originDigest:p.c.originDigest,attemptId:a.attemptId,sessionId:a.sessionId,launchId:a.launchId,message:'PROGRESS',payload:{phase:'PREPARING',bootstrap:'NONE',bootstrapFact:null}};
 const text=canonicalize(message)!,body=Buffer.from(' '.repeat(bytes-text.length)+text),prefix=Buffer.alloc(4);prefix.writeUInt32BE(bytes);p.pipes.get('CONTROL')!.push(Buffer.concat([prefix,body]));await flush();
 if(bytes>131072){expect(received).toHaveLength(0);expect(await s.join()).toMatchObject({end:'LOST'});await expect(b.idle()).rejects.toThrow();}
 else{expect(received).toHaveLength(1);const out=drain(s.nativeOutput),err=drain(s.nativeError),ack=p.command('ACK_FINAL');await s.send(ack);p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});p.eof();await Promise.all([out,err]);expect(await s.join()).toMatchObject({end:'EXPECTED'});await b.idle();}
 await reading;expect(p.holds).toBe(0);
 });
 it('새 broker와 원 backend가 미생성 부모 ACK부터 원 FINALIZED까지 연결된다',async()=>{
 const f=noChild('NOT_ATTEMPTED'),p=peer(),b=brokerModule.createWindowsJobBroker(p.options);
 f.ports.broker=b.broker;p.onControl=control=>{void f.host.send(control);};
 const host=(async()=>{for await(const message of f.host.events){await until(()=>p.pipes.has('CONTROL'));p.pipes.get('CONTROL')!.reply(message);}p.eof();})();
 try{void f.backend.prepare().catch(()=>{});await until(()=>f.controls.some(c=>c.command==='ACK_FINAL'));await f.backend.idle();await b.idle();await host;expect((await f.backend.query()).outcome?.state).toBe('JOINED');expect(f.parentCount).toBe(1);expect(f.goCount).toBe(0);expect(p.names).toHaveLength(4);expect(p.holds).toBe(0);}
 finally{f.forceCleanup();p.cleanup();await flush();}
 });
 it('공유 HMAC과 local pipe golden vector가 Python 계약과 같은 bytes다',()=>{
 const body={hostEpochId:id(2),environmentDigest:'d'.repeat(64),originDigest:'a'.repeat(64),attemptId:id(5),sessionId:id(3),launchId:id(4),launchRef:id(7),controllerInstanceId:id(6),clientNonce:'11'.repeat(32),serverNonce:'22'.repeat(32),hostProcess:{pid:101,creationFileTime100ns:'123',windowsSessionId:7},controllerProcess:{pid:202,creationFileTime100ns:'456',windowsSessionId:7},hostSidDigest:'b'.repeat(64),controllerSidDigest:'c'.repeat(64)};
 const r={...peer().options.registration,controllerInstanceId:id(6),environmentDigest:'d'.repeat(64),controllerSidDigest:'c'.repeat(64)};
 const wire=brokerModule.windowsJobBrokerWire,envelope=wire.envelope(r,'CHALLENGE','CONTROL',body);
 expect(envelope.mac).toBe('574e52801765a93b3e80bcea9375fcf46157b62ee81f4b160c0df68550411fe6');
 const c=capture();c.originDigest='a'.repeat(64);
 expect(wire.pipeName(r,c,'CONTROL')).toBe('\\\\.\\pipe\\trio-w5a-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002-ctl');
 expect(wire.pipeName(r,c,'OUT')).toBe('\\\\.\\pipe\\trio-w5a-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002-00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004-aaaaaaaaaaaaaaaa-out');
 });
});

describe('W5-A 독립 검토 직접 회귀',()=>{
 it.each(['OPEN','AUTH','ATTACH'] as const)('%s write가 대기해도 handshake 기한에 취소하고 실제 callback까지 보유한다',async kind=>{
 const p=peer();p.blockKind=kind;p.deferClose=true;const b=brokerModule.createWindowsJobBroker(p.options);let failure:unknown=null;const opening=b.broker.open(p.c).catch(e=>{failure=e;return null;});
 await until(()=>[...p.pipes.values()].some(s=>s.callbacks.length>0));p.advance(101);await flush();try{
 expect(failure).toMatchObject({code:'WINDOWS_BROKER_TIMEOUT'});expect(p.cancels.length).toBeGreaterThan(0);expect(p.holds).toBeGreaterThan(0);let idle=false;const waiting=b.idle().catch(()=>{}).then(()=>{idle=true;});for(const d of p.closeGates.values())d.resolve();await flush();expect(idle).toBe(false);for(const s of p.pipes.values())s.completeWrites();await opening;await waiting;expect(p.holds).toBe(0);
 }finally{p.cleanup();await flush();}
 });
 it.each(['bootstrap','control'] as const)('%s frame 확보 뒤 decode 예산 거부에도 원 credit을 회수한다',async phase=>{
 const p=peer();if(phase==='bootstrap')p.padBootstrap=true;const hold=p.options.memory.hold;let denied=false,armed=phase==='bootstrap';
 p.options.memory.hold=n=>{
 if(armed&&p.tuple&&n>=50000){denied=true;throw Error('DECODE_CREDIT_DENIED');}return hold(n);
 };
 const b=brokerModule.createWindowsJobBroker(p.options);
 if(phase==='bootstrap')await expect(b.broker.open(p.c)).rejects.toThrow('DECODE_CREDIT_DENIED');
 else{const s=await b.broker.open(p.c);await s.send(p.command());const a=p.c.origin.authority;
 const message={version:1,requestId:p.controls[0].requestId,originDigest:p.c.originDigest,attemptId:a.attemptId,sessionId:a.sessionId,launchId:a.launchId,message:'PROGRESS',payload:{phase:'PREPARING',bootstrap:'NONE',bootstrapFact:null}};
 armed=true;p.pipes.get('CONTROL')!.push(paddedPacket(message));expect(await s.join()).toMatchObject({end:'LOST'});}
 p.cleanup();await expect(b.idle()).rejects.toThrow();expect(denied).toBe(true);expect(p.holds).toBe(0);expect(b.usage().heldBytes).toBe(0);
 });
 it('소비자가 보유한 OUT slice는 실패 뒤 return까지 join과 세션 슬롯을 붙든다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);const iterator=s.nativeOutput[Symbol.asyncIterator]();p.pipes.get('OUT')!.push(Buffer.from('retained output'));expect((await iterator.next()).value).toBeDefined();let joined=false;const done=s.join().then(v=>{joined=true;return v;});p.pipes.get('CONTROL')!.push(Buffer.alloc(4));await flush();
 try{expect(joined).toBe(false);expect(b.usage().activeSessions).toBe(1);expect(p.holds).toBeGreaterThan(0);}finally{await iterator.return?.();p.cleanup();}
 expect(await done).toMatchObject({end:'LOST'});await expect(b.idle()).rejects.toThrow();expect(p.holds).toBe(0);
 });
 it('첫 입력 write 실패 때 Writable 대기 항목도 callback과 원 credit을 합류한다',async()=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 const lane=p.pipes.get('IN')!;lane.deferWrites=true;const callbacks:unknown[]=[];s.nativeInput.write(Buffer.alloc(64,1),e=>callbacks.push(e));s.nativeInput.write(Buffer.alloc(64,2),e=>callbacks.push(e));await flush();lane.failWrites();
 expect(await s.join()).toMatchObject({end:'LOST'});await flush();await expect(b.idle()).rejects.toThrow();expect(callbacks).toHaveLength(2);expect(callbacks.every(e=>e instanceof Error)).toBe(true);expect(p.holds).toBe(0);expect(b.usage().pendingOperations).toBe(0);
 });
 it('native 예산 포화 뒤에도 STOP 전송에 제어 전용 여유를 남긴다',async()=>{
 const p=peer();p.options.bounds.maxInFlightBytes=1000000;p.options.bounds.maxQueuedBytes=4194304;const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 const lane=p.pipes.get('IN')!;lane.deferWrites=true;let count=0;for(;count<1000;count++){try{s.nativeInput.write(Buffer.alloc(1024,1),()=>{});}catch(e){expect(e).toMatchObject({code:'WINDOWS_BROKER_CAPACITY'});break;}}
 expect(count).toBeGreaterThan(0);expect(count).toBeLessThan(1000);const stop={...p.command(),command:'STOP',payload:{reason:'CALLER_ABORT'}} as WindowsControl;
 try{await expect(s.send(stop)).resolves.toBeUndefined();expect(p.controls.at(-1)).toMatchObject({command:'STOP'});}finally{lane.failWrites();p.cleanup();await s.join();await b.idle().catch(()=>{});}
 expect(p.holds).toBe(0);
 });
 it.each(['EXPECTED','LOST'] as const)('%s 뒤 다른 origin에서도 같은 launchRef는 재사용하지 않는다',async end=>{
 const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);
 if(end==='EXPECTED')await complete(p,s);else{p.pipes.get('CONTROL')!.push(Buffer.alloc(4));await s.join();await b.idle().catch(()=>{});}
 const next=clone(p.c);Object.assign(next.origin.authority,{launchId:id(99)});next.originDigest=digest({identity:next.origin.identity,authority:next.origin.authority,pins:next.origin.pins,policy:next.origin.policy,nativeLimitsDigest:digest(next.origin.limits),frameInputDigest:next.frameInputDigest});
 await expect(b.broker.open(next)).rejects.toMatchObject({code:'WINDOWS_LAUNCH_REPLAY'});expect(p.names).toHaveLength(4);expect(p.holds).toBe(0);
 });
});

describe('W5-A 원 CREATED backend 큰 입력',()=>{
 it('실제 backend의 65537byte blob write를 원 bytes 그대로 bounded chunk로 전송한다',async()=>{
 const i=input(65537),p=peer();Object.assign(p.c,capture(i));p.options.bounds.maxChunkBytes=65536;
 const script=createdScript(i),b=brokerModule.createWindowsJobBroker(p.options),events=new Queue<WindowsHostMessage>(),rows:JournalEntry[]=[];
 let hostClosed=false,prepared=false,go=false,goKnown=false,next=0,stored:{ref:{recordId:string;digest:string};envelope:WindowsSealEnvelope}|null=null;
 const emit=(message:string,payload:unknown)=>{const c=p.controls.at(-1)!;events.push({version:1,requestId:c.requestId,originDigest:p.c.originDigest,attemptId:i.authority.attemptId,sessionId:i.authority.sessionId,launchId:i.authority.launchId,message,payload} as WindowsHostMessage);};
 const resultBlobs=new Map([['output',Buffer.from('result')]]),result={envelope:createNativeResult(i.frame.envelope,{metadata:{ok:true},blobs:resultBlobs},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8}),blobs:resultBlobs};
 const output:Buffer[]=[];const sink=new Writable({write:(bytes:Buffer,_e,cb)=>{output.push(Buffer.from(bytes));cb();}});await writeNativeFrame(sink,result,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
 const ports:WindowsJobPorts={original:{captureFresh:async()=>({created:true,capture:p.c}),grantOriginal:async()=>{goKnown=true;return {created:true,goGrantRef:{jobId:i.identity.binding.jobId,rowDigest:h('go')}};},readOriginal:async()=>({originDigest:p.c.originDigest,state:'CONFIRMED',goGrantRef:goKnown?{jobId:i.identity.binding.jobId,rowDigest:h('go')}:null})},broker:b.broker,journal:{appendOriginal:async(_c,e,s)=>{const row={event:e,source:s,sourceDigest:digest(s)};rows.push(row);return {eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest};},lookupEvent:async()=>null,scanOriginal:async function*(){yield*rows;},sealOriginal:async(_c,envelope)=>{const ref={recordId:id(401),digest:digest(envelope)};stored={ref,envelope};return ref;},readOriginal:async()=>stored},parent:{rawResult:async(_c,received)=>({rawResultId:id(402),resultDigest:digest(received.envelope)}),joinOriginal:async()=>script.joinAck},clock:{nowMs:()=>0,waitUntil:()=>new Promise(()=>{})}};
 p.onControl=control=>{
 if(control.command==='PREPARE')emit('EVENT',script.entries[next++]);
 if(control.command==='ACK_EVENT'){
  if(next<5)emit('EVENT',script.entries[next++]);
  else if(!prepared){prepared=true;emit('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:script.entries[4].source.facts[1]});}
  else if(go&&next<8)emit('EVENT',script.entries[next++]);
  else if(go&&next===8){next++;emit('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:script.entries[10].source.facts.find(f=>f.kind==='IO'&&f.bytesLength==='9')});p.pipes.get('IN')!.once('finish',()=>{setImmediate(()=>{for(const bytes of output)p.pipes.get('OUT')!.push(bytes);p.pipes.get('OUT')!.push(null);p.pipes.get('ERR')!.push(null);emit('EVENT',script.entries[8]);});});}
  else if(next===9){next++;emit('EVENT',script.entries[9]);}
  else if(next===11){next++;emit('EVENT',script.entries[11]);}
  else if(next===12){next++;emit('FINAL_CANDIDATE',{evidence:script.evidence()});}
 }
 if(control.command==='GRANT_GO'){go=true;script.complete(control.payload.goGrantRef);emit('EVENT',script.entries[next++]);}
 if(control.command==='PARENT_JOINED'){next=11;emit('EVENT',script.entries[10]);}
 if(control.command==='ACK_FINAL'){emit('FINALIZED',{...control.payload,handles:'CLOSED',closeCode:null});hostClosed=true;events.end();}
 };
 const host=(async()=>{for await(const m of events)p.pipes.get('CONTROL')!.reply(m);p.pipes.get('CONTROL')!.push(null);})();
 const backend=createWindowsJobBackend(i,ports);try{
 await backend.prepare();const done=backend.grantGo();await until(()=>p.pipes.get('IN')!.writableFinished||p.controls.some(c=>c.command==='STOP'));
 expect(p.controls.filter(c=>c.command==='STOP'),'큰 유효 blob 때문에 STOP을 보내지 않는다').toHaveLength(0);
 p.pipes.get('IN')!.push(null);expect((await done).state).toBe('JOINED');await backend.idle();await b.idle();await host;expect(hostClosed).toBe(true);
 const raw=p.pipes.get('IN')!.written.slice(1);expect(raw.every(v=>v.length<=65536)).toBe(true);const expected:Buffer[]=[];await writeNativeFrame(new Writable({write:(bytes:Buffer,_e,cb)=>{expected.push(Buffer.from(bytes));cb();}}),i.frame,{maxMetadataBytes:4096,maxBinaryBytes:i.limits.maxInputBytes,maxItems:8});
 expect(Buffer.concat(raw)).toEqual(Buffer.concat(expected));expect(rows).toHaveLength(12);expect(p.holds).toBe(0);
 }finally{events.end();p.cleanup();await flush();}
 });
});

import {writeNativeFrame} from '../../packages/native/src/frame.js';
import {validateWindowsJobEvidence,type WindowsJobEvidence,type WindowsJobAccounting} from '../../packages/native/src/windows-job-evidence.js';
import type {WindowsFact,WindowsPreparedAttempt,ParentJoinAck,OriginalRef,WindowsJobOutcome} from '../../packages/native/src/windows-job-backend.js';
type NativeRawResultReference=import('../../packages/native/src/controller-protocol.js').NativeRawResultReference;
type WindowsNativeAccountingOverrides=Partial<Omit<WindowsJobAccounting,'snapshotScope'|'memoryAccounting'>>;
const windowsEvidenceBounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
function createdScript(input:WindowsPrepareInput,mode:'CREATED'|'NOT_ATTEMPTED'|'UNKNOWN'='CREATED',accountingOverrides:WindowsNativeAccountingOverrides={}){
  const originDigest=digest({identity:input.identity,authority:input.authority,pins:input.pins,policy:input.policy,nativeLimitsDigest:digest(input.limits),frameInputDigest:input.frame.envelope.inputDigest});
  const accounting:WindowsJobAccounting={userTime100ns:'9007199254740993',kernelTime100ns:'300',peakJobMemoryBytes:'16384',peakProcessMemoryBytes:'8192',readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0',totalProcesses:'2',startQpcTicks:'120',endQpcTicks:'210',qpcFrequency:'10000000',snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS',...accountingOverrides};
  const qpc=(ticks:string)=>ticks==='210'?accounting.endQpcTicks:ticks==='209'?(BigInt(accounting.endQpcTicks)-1n).toString():(BigInt(accounting.startQpcTicks)+BigInt(ticks)-120n).toString();
  const entries:JournalEntry[]=[];
  type Event=JournalEntry['event'];
  const add=<K extends Event['kind']>(kind:K,payload:Extract<Event,{kind:K}>['payload'],facts:WindowsFact[]=[])=>{
    const body={eventId:randomUUID(),sequence:entries.length+1,kind,qpcTicks:qpc(String(100+entries.length*10)),previousDigest:entries.at(-1)?.event.payloadDigest??null,payload};
    const event={...body,payloadDigest:digest(body)} as Event;
    const source:WindowsSource={version:1,originDigest,eventId:event.eventId,facts};
    entries.push({event,source,sourceDigest:digest(source)});
  };
  const win=(api:string,value:unknown,qpcTicks:string,callId=randomUUID()):WindowsFact=>({kind:'WIN32',callId,api,qpcTicks:qpc(qpcTicks),status:'RETURNED',win32Error:null,value});
  const io=(lane:'IN'|'OUT'|'ERR',operation:'READ'|'WRITE'|'CLOSE',qpcTicks:string,bytes:Buffer):WindowsFact=>({kind:'IO',callId:randomUUID(),lane,operation,qpcTicks:qpc(qpcTicks),status:'RETURNED',bytesLength:String(bytes.length),sha256:sha256(bytes)});
  const root={pid:42,creationFileTime100ns:'133000000000000000'},createCallId=randomUUID(),processRef=randomUUID(),threadRef=randomUUID();
  const joinAck:ParentJoinAck={joinId:randomUUID(),originDigest,digest:sha256('W3-A fake original parent joined')};
  const osReadback={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,killOnJobClose:true as const,breakawayAllowed:false as const};
  const brokerApplied={wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const tokenValues=[{informationClass:'TOKEN_USER',values:{sidDigest:input.authority.childSidDigest}},{informationClass:'TOKEN_APPCONTAINER_SID',values:{sidDigest:input.authority.appContainerSidDigest}},{informationClass:'TOKEN_IS_APPCONTAINER',values:{isAppContainer:true}},{informationClass:'TOKEN_INTEGRITY_LEVEL',values:{sidDigest:sha256('w3a-fake-low-integrity')}},{informationClass:'TOKEN_SESSION_ID',values:{sessionId:7}}];
  const basic={TotalUserTime:accounting.userTime100ns,TotalKernelTime:accounting.kernelTime100ns,ThisPeriodTotalUserTime:accounting.userTime100ns,ThisPeriodTotalKernelTime:accounting.kernelTime100ns,TotalPageFaultCount:1,TotalProcesses:Number(accounting.totalProcesses),ActiveProcesses:0,TotalTerminatedProcesses:Number(accounting.totalProcesses)};
  const ioValues={ReadOperationCount:accounting.readOperations,WriteOperationCount:accounting.writeOperations,OtherOperationCount:accounting.otherOperations,ReadTransferCount:accounting.readBytes,WriteTransferCount:accounting.writeBytes,OtherTransferCount:accounting.otherBytes};
  const extended={BasicLimitInformation:{PerProcessUserTimeLimit:'0',PerJobUserTimeLimit:'0',LimitFlags:0x2308,MinimumWorkingSetSize:'0',MaximumWorkingSetSize:'0',ActiveProcessLimit:4,Affinity:'0',PriorityClass:0,SchedulingClass:0},IoInfo:ioValues,ProcessMemoryLimit:'524288',JobMemoryLimit:'1048576',PeakProcessMemoryUsed:accounting.peakProcessMemoryBytes,PeakJobMemoryUsed:accounting.peakJobMemoryBytes};
  let goGrantRef:{jobId:string;rowDigest:string}|null=null;
  add('PRE_CREATE',{bindingDigest:digest(input.identity),policyDigest:input.authority.policyDigest,pinsDigest:digest(input.pins)});
  if(mode==='NOT_ATTEMPTED')add('CREATE_NOT_ATTEMPTED',{code:'WINDOWS_POLICY_UNCONFIRMED'});
  else add('CREATE_ARMED',{callId:createCallId});
  if(mode==='CREATED'){
    add('CREATED_SUSPENDED',{...root,assignedBy:'PROC_THREAD_ATTRIBUTE_JOB_LIST'},[win('CreateProcessAsUserW',{processRef,threadRef,pid:42},'120',createCallId),win('GetProcessTimes',{processRef,creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'127')]);
    add('PREPARED',{membershipConfirmed:true,tokenDigest:digest(tokenValues),osReadbackDigest:digest(osReadback),brokerAppliedDigest:digest(brokerApplied)},[win('IsProcessInJob',{isMember:true},'128'),...tokenValues.map(value=>win('GetTokenInformation',value,'128')),win('GetProcessTimes',{processRef,creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'129'),win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'129'),win('QueryInformationJobObject',{informationClass:'CPU_RATE',values:{ControlFlags:5,CpuRate:2000}},'130')]);
    add('BOOTSTRAP_RESUMED',{resumeReturned:true},[win('ResumeThread',{previousSuspendCount:1},'135'),io('OUT','READ','140',Buffer.from('WAIT_V1\n'))]);
  }
  const prepared:WindowsPreparedAttempt={originDigest,attemptId:input.authority.attemptId,controllerInstanceId:input.authority.controllerInstanceId,sessionId:input.authority.sessionId,launchId:input.authority.launchId,root};
  const complete=(go:{jobId:string;rowDigest:string})=>{
    expect(mode).toBe('CREATED');expect(goGrantRef).toBeNull();goGrantRef=go;
    add('GO_AUTHORIZED',{goGrantRef:go},[{kind:'ORIGINAL_GO',qpcTicks:qpc('150'),goGrantRef:go}]);
    add('GO_WRITE_ARMED',{bytesLength:'6'});
    add('GO_WRITE',{result:'RETURNED',bytesLength:'6'},[io('IN','WRITE','170',Buffer.from('GO_V1\n'))]);
    add('ROOT_EXIT',{exitCode:0},[win('WaitForSingleObject',{waitResult:'SIGNALED'},'180'),win('GetExitCodeProcess',{exitCode:0},'180')]);
    add('TREE_EMPTY',{activeProcesses:0,totalProcesses:accounting.totalProcesses},[win('QueryInformationJobObject',{informationClass:'BASIC_ACCOUNTING',values:basic},'190')]);
    add('IO_JOINED',{stdinClosed:true,stdoutEof:true,stderrEof:true,parentIoJoined:true},[io('IN','CLOSE','198',Buffer.alloc(0)),io('OUT','READ','198',Buffer.alloc(0)),io('ERR','READ','198',Buffer.alloc(0)),io('OUT','READ','175',Buffer.from('READY_V1\n')),{kind:'PARENT_ACK',qpcTicks:qpc('200'),ack:joinAck}]);
    add('FINAL_ACCOUNTING',{accounting},[win('QueryInformationJobObject',{informationClass:'BASIC_AND_IO',values:{BasicInfo:basic,IoInfo:ioValues}},'209'),win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'209'),win('QueryPerformanceFrequency',{frequency:accounting.qpcFrequency},'209'),win('QueryPerformanceCounter',{ticks:accounting.endQpcTicks},'210')]);
  };
  const evidence=():WindowsJobEvidence=>validateWindowsJobEvidence({version:1,kind:'WINDOWS_JOB_OBJECT',identity:input.identity,authority:input.authority,pins:input.pins,policy:{requested:input.policy,osReadback:mode==='CREATED'?osReadback:null,brokerApplied:mode==='CREATED'?brokerApplied:null},lifecycle:{creation:mode==='UNKNOWN'?'UNCONFIRMED':mode,root:mode==='CREATED'?root:null,goGrantRef,goWrite:goGrantRef?'RETURNED':'NOT_ATTEMPTED',rootExit:goGrantRef?{exitCode:0,observedQpcTicks:qpc('180')}:null,events:entries.map(row=>row.event)},final:{outcome:mode==='UNKNOWN'?'UNCONFIRMED':mode==='NOT_ATTEMPTED'?'NO_CHILD_CREATED':goGrantRef?'JOB_EMPTY':'UNCONFIRMED',activeProcesses:goGrantRef?0:null,rootSignaled:goGrantRef!==null,stdioJoined:goGrantRef!==null,parentIoJoined:mode==='NOT_ATTEMPTED'||goGrantRef!==null,recordSealed:mode!=='UNKNOWN',accounting:goGrantRef?accounting:null,failureCode:mode==='UNKNOWN'?'WINDOWS_CREATE_UNCONFIRMED':mode==='NOT_ATTEMPTED'?'WINDOWS_POLICY_UNCONFIRMED':goGrantRef?null:'WINDOWS_INCOMPLETE'}},windowsEvidenceBounds);
  const seal=():WindowsSealEnvelope=>({version:1,originDigest,evidence:evidence(),entries:entries.map(row=>({eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest})),parentJoinAck:mode==='UNKNOWN'?null:joinAck});
  const finalized=(ref:OriginalRef):HostFinalized=>({...ref,handles:'CLOSED',closeCode:null});
  const outcome=(ref:OriginalRef,rawResult:NativeRawResultReference|null):WindowsJobOutcome=>({state:mode==='UNKNOWN'?'WAIT':'JOINED',code:mode==='CREATED'?'OK':mode==='UNKNOWN'?'WINDOWS_CREATE_UNCONFIRMED':'WINDOWS_POLICY_UNCONFIRMED',evidence:evidence(),rawResult,journalRef:ref});
  return {originDigest,entries,prepared,joinAck,complete,evidence,seal,finalized,outcome};
}

describe('W5-A 독립 검토 보완 2회',()=>{
 it('공동 owner가 먼저 포화되어도 실제 확보한 제어 credit으로 STOP을 보낸다',async()=>{
 const p=peer();p.options.bounds.maxQueuedBytes=4194304;p.options.memory={...p.options.memory,maxBytes:700000,available:()=>700000-p.holds};
 const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 const lane=p.pipes.get('IN')!;lane.deferWrites=true;const first=new Promise<void>(resolve=>{s.nativeInput.write(Buffer.alloc(64,1),()=>resolve());});await flush();
 let count=0;while(count++<1000){const remaining=p.options.memory.available();if(remaining===0)break;try{s.nativeInput.write(Buffer.alloc(Math.min(1024,remaining),2),()=>{});}catch(e){expect(e).toMatchObject({code:'WINDOWS_BROKER_CAPACITY'});break;}}
 expect(count).toBeLessThan(1000);expect(p.options.memory.available()).toBe(0);
 const a=p.c.origin.authority,common={version:1 as const,originDigest:p.c.originDigest,attemptId:a.attemptId,sessionId:a.sessionId,launchId:a.launchId};
 const cleanup:WindowsControl[]=[{...common,requestId:id(701),command:'STOP',payload:{reason:'JOURNAL_UNCONFIRMED'}},{...common,requestId:id(702),command:'ACK_EVENT',payload:{eventId:id(703),payloadDigest:h('payload'),sourceDigest:h('source')}},{...common,requestId:id(704),command:'PARENT_JOINED',payload:{joinId:id(705),originDigest:p.c.originDigest,digest:h('parent')}},{...common,requestId:id(706),command:'ACK_FINAL',payload:{recordId:id(707),digest:h('final')}}];
 try{await expect(Promise.all(cleanup.map(c=>s.send(c)))).resolves.toHaveLength(4);expect(p.controls.slice(-4).map(c=>c.command)).toEqual(['STOP','ACK_EVENT','PARENT_JOINED','ACK_FINAL']);expect(p.options.memory.available()).toBe(0);}finally{lane.failWrites();p.cleanup();await first;await s.join();await b.idle().catch(()=>{});}expect(p.holds).toBe(0);
 });
 it('timeout 뒤 같은 완료 turn의 ready 거부·closed에도 마지막 pending 해제 후 idle을 끝낸다',async()=>{
 const p=peer();p.deferConnect=true;p.deferClose=true;const b=brokerModule.createWindowsJobBroker(p.options),opening=b.broker.open(p.c).catch(e=>e);await flush();p.advance(101);expect(await opening).toMatchObject({code:'WINDOWS_BROKER_TIMEOUT'});
 let ended=false;const idle=b.idle().catch(e=>e).then(e=>{ended=true;return e;});
 p.readyGates.get('CONTROL')!.reject(Error('CONNECT_CANCELLED'));p.closeGates.get('CONTROL')!.resolve();await flush();
 expect(ended,'완료 callback 이후 새로운 외부 사건 없이 합류를 재평가한다').toBe(true);expect(await idle).toBeInstanceOf(AggregateError);expect(b.usage()).toMatchObject({activeSessions:0,pendingOperations:0,heldBytes:0});expect(p.holds).toBe(0);
 });
});

describe('W5-A 기본 실제 포트의 비활성 조립',()=>{
 it('실제 포트 factory 생성만으로 pipe나 timer를 시작하지 않는다',()=>{
 const set=vi.spyOn(globalThis,'setTimeout');try{const p=brokerModule.createWindowsJobLocalPorts();expect(Object.isFrozen(p)).toBe(true);expect(Object.keys(p).sort()).toEqual(['connect','nonce','nowMs','startWait']);expect(set).not.toHaveBeenCalled();}finally{set.mockRestore();}
 });
 it('승인된 네 로컬 lane도 최소권한 client가 없으면 socket 생성 전에 WAIT로 차단한다',()=>{
 const p=peer(),ports=brokerModule.createWindowsJobLocalPorts();
 for(const lane of ['CONTROL','IN','OUT','ERR'] as const){
 const name=brokerModule.windowsJobBrokerWire.pipeName(p.options.registration,p.c,lane);let failure:unknown;
 try{ports.connect(name,64);}catch(e){failure=e;}
 expect(failure).toMatchObject({code:'WINDOWS_PIPE_CLIENT_PORT_REQUIRED',status:409,nextAction:'WAIT'});
 }
 expect(socketGuard).not.toHaveBeenCalled();
 });
 it('기본 연결 차단 뒤 broker는 원 WAIT를 보존하고 메모리와 pending을 모두 정리한다',async()=>{
 const p=peer(),ports=brokerModule.createWindowsJobLocalPorts(),b=brokerModule.createWindowsJobBroker({...p.options,ports});
 await expect(b.broker.open(p.c)).rejects.toMatchObject({code:'WINDOWS_PIPE_CLIENT_PORT_REQUIRED',status:409,nextAction:'WAIT'});
 await expect(b.idle()).rejects.toThrow(AggregateError);
 expect(b.usage()).toMatchObject({activeSessions:0,pendingOperations:0,heldBytes:0,retainedRecords:1,unconfirmedSessions:1});
 expect(p.holds).toBe(0);expect(p.names).toHaveLength(0);expect(socketGuard).not.toHaveBeenCalled();
 });
 it('기본 connector가 원격·임의 pipe 경로를 socket 생성 전에 거부한다',()=>{
 const p=brokerModule.createWindowsJobLocalPorts();for(const name of ['tcp://127.0.0.1:99','server/pipe/other','arbitrary','\\\\server\\pipe\\trio-w5a'])expect(()=>p.connect(name,64)).toThrow(/WINDOWS_PIPE_NAME/);
 });
});

const fullWireGolden:{capture:OriginalCapture;control:WindowsControl;nativeBase64:string;controlBase64:string;captureDigest:string;nativeDigest:string;controlDigest:string}={
  "capture": {
    "origin": {
      "identity": {
        "binding": {
          "accountId": "00000000-0000-4000-8000-000000000016",
          "capacityReservationId": "00000000-0000-4000-8000-000000000017",
          "jobId": "00000000-0000-4000-8000-000000000015",
          "parentInstanceId": "00000000-0000-4000-8000-000000000018",
          "inputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
          "profileDigest": "2021b7c372990f797e86cb0f85931f66372edc040135039b0a741c1827b3475c",
          "kernelDigest": "0cfa9728aa127866a3ccaadc571b994aa622b4fd3b85b48b47a70e3391d04583"
        },
        "intentDigest": "3a4c15e51a0dff4a561a2966e5bd7d49b6914f42ff3cd950832b476ee6ac25f8",
        "sourceInput": {
          "executionId": "00000000-0000-4000-8000-000000000019",
          "inputEvidenceId": "00000000-0000-4000-8000-00000000001a",
          "stageInputDigest": "f0122973a228dfee0c0ed515bca6edf26ad455cec6072117bbb1f7063187be7e"
        },
        "inputEvidenceDigest": "d88a7ce5a47d826a6fa4463c9423b177b0df662ca6a121997e591f944facd332",
        "inputFingerprint": "48aed2374cea5f3bbbee1c8742439be758dcc1e999e0e3f0e03c1ee80e3565a0",
        "basisRef": {
          "evidenceId": "00000000-0000-4000-8000-00000000001b",
          "evidenceDigest": "92e590c9eefab28e8a6cce5254660e360ce1c859d96536250263c11dad8425c5"
        }
      },
      "authority": {
        "attemptId": "00000000-0000-4000-8000-00000000001c",
        "controllerInstanceId": "00000000-0000-4000-8000-00000000001d",
        "controllerId": "controller",
        "keyVersion": "key-v1",
        "environmentDigest": "77c14283c58bbf3de1ec75e1c4d5544522fe0438c0869f4ffd6a7ef091da4838",
        "hostEpochId": "00000000-0000-4000-8000-000000000002",
        "sessionId": "00000000-0000-4000-8000-000000000003",
        "launchId": "00000000-0000-4000-8000-000000000004",
        "policyDigest": "a6daef5724a063b8857b196a6c3c49ceb1cdd4a5c48242173a8abc6c0de4c82c",
        "controllerSidDigest": "03f787b40211d10a2fce666f3eafb152da7c4d245876d961f130f0230b2720e0",
        "childSidDigest": "d35dd89d7a3c570c942df54e62a1ad97f1a1dc080e91cce29e2500403b9fad12",
        "appContainerSidDigest": "e5f5daac135a7e6887e9daddff45ff1ab2817d597dfcff150e1256770a228e04"
      },
      "pins": {
        "executableDigest": "e0c6740700d6cdaaad9e7029d2d95f7986a13e1a9bca94732baaab2078eb1fe3",
        "bootstrapDigest": "1debf0dd5aba45749b8fe8ce9e296f600907825a8ca99a4b3b3e8ed95eca0d0a",
        "helperRuntimeDigest": "2d0edc2f0650c5218a2cbe6022e4bad2f146e015c465a29754ad6407b054d6b3",
        "helperScriptDigest": "904f41bf5e539c854cea8059af5a1070d0d111d06bd3c8ae5b31ffde0b458fe2",
        "runtimeFilesDigest": "2d52cd9073053426a522ce4fb85745902ca2f9482e61774b7c1fa6c44a68931d",
        "nativeLimitsDigest": "6d754d28ae58d5f825473b475db4efd7d267a365a40b26bcd9e75e7e88d0a30c"
      },
      "policy": {
        "maxProcesses": 4,
        "jobCommitLimitBytes": "1048576",
        "processCommitLimitBytes": "524288",
        "cpuRatePer10000": 2000,
        "wallTimeoutMs": 1000,
        "joinTimeoutMs": 500,
        "stdoutMaxBytes": "32768",
        "stderrMaxBytes": "1024"
      },
      "limits": {
        "maxMetadataBytes": 4096,
        "maxInputBytes": 16384,
        "maxOutputBytes": 16384,
        "maxItems": 8,
        "childMemoryBytes": 16777216,
        "maxProcesses": 4,
        "timeoutMs": 1000,
        "terminationWaitMs": 500,
        "parentInFlightBytes": 1048576
      }
    },
    "originDigest": "d077c6de5b8ff64166784635a606eeaca87ca857ec011a30fe6808fc0fc1ebd9",
    "frameInputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
    "launchRef": "00000000-0000-4000-8000-00000000001e"
  },
  "control": {
    "version": 1,
    "requestId": "00000000-0000-4000-8000-000000000320",
    "originDigest": "d077c6de5b8ff64166784635a606eeaca87ca857ec011a30fe6808fc0fc1ebd9",
    "attemptId": "00000000-0000-4000-8000-00000000001c",
    "sessionId": "00000000-0000-4000-8000-000000000003",
    "launchId": "00000000-0000-4000-8000-000000000004",
    "command": "PREPARE",
    "payload": {
      "origin": {
        "identity": {
          "binding": {
            "accountId": "00000000-0000-4000-8000-000000000016",
            "capacityReservationId": "00000000-0000-4000-8000-000000000017",
            "jobId": "00000000-0000-4000-8000-000000000015",
            "parentInstanceId": "00000000-0000-4000-8000-000000000018",
            "inputDigest": "e064cc2694b39a57768c615269245a7dce73ad055c94e246e63bd7490bd30082",
            "profileDigest": "2021b7c372990f797e86cb0f85931f66372edc040135039b0a741c1827b3475c",
            "kernelDigest": "0cfa9728aa127866a3ccaadc571b994aa622b4fd3b85b48b47a70e3391d04583"
          },
          "intentDigest": "3a4c15e51a0dff4a561a2966e5bd7d49b6914f42ff3cd950832b476ee6ac25f8",
          "sourceInput": {
            "executionId": "00000000-0000-4000-8000-000000000019",
            "inputEvidenceId": "00000000-0000-4000-8000-00000000001a",
            "stageInputDigest": "f0122973a228dfee0c0ed515bca6edf26ad455cec6072117bbb1f7063187be7e"
          },
          "inputEvidenceDigest": "d88a7ce5a47d826a6fa4463c9423b177b0df662ca6a121997e591f944facd332",
          "inputFingerprint": "48aed2374cea5f3bbbee1c8742439be758dcc1e999e0e3f0e03c1ee80e3565a0",
          "basisRef": {
            "evidenceId": "00000000-0000-4000-8000-00000000001b",
            "evidenceDigest": "92e590c9eefab28e8a6cce5254660e360ce1c859d96536250263c11dad8425c5"
          }
        },
        "authority": {
          "attemptId": "00000000-0000-4000-8000-00000000001c",
          "controllerInstanceId": "00000000-0000-4000-8000-00000000001d",
          "controllerId": "controller",
          "keyVersion": "key-v1",
          "environmentDigest": "77c14283c58bbf3de1ec75e1c4d5544522fe0438c0869f4ffd6a7ef091da4838",
          "hostEpochId": "00000000-0000-4000-8000-000000000002",
          "sessionId": "00000000-0000-4000-8000-000000000003",
          "launchId": "00000000-0000-4000-8000-000000000004",
          "policyDigest": "a6daef5724a063b8857b196a6c3c49ceb1cdd4a5c48242173a8abc6c0de4c82c",
          "controllerSidDigest": "03f787b40211d10a2fce666f3eafb152da7c4d245876d961f130f0230b2720e0",
          "childSidDigest": "d35dd89d7a3c570c942df54e62a1ad97f1a1dc080e91cce29e2500403b9fad12",
          "appContainerSidDigest": "e5f5daac135a7e6887e9daddff45ff1ab2817d597dfcff150e1256770a228e04"
        },
        "pins": {
          "executableDigest": "e0c6740700d6cdaaad9e7029d2d95f7986a13e1a9bca94732baaab2078eb1fe3",
          "bootstrapDigest": "1debf0dd5aba45749b8fe8ce9e296f600907825a8ca99a4b3b3e8ed95eca0d0a",
          "helperRuntimeDigest": "2d0edc2f0650c5218a2cbe6022e4bad2f146e015c465a29754ad6407b054d6b3",
          "helperScriptDigest": "904f41bf5e539c854cea8059af5a1070d0d111d06bd3c8ae5b31ffde0b458fe2",
          "runtimeFilesDigest": "2d52cd9073053426a522ce4fb85745902ca2f9482e61774b7c1fa6c44a68931d",
          "nativeLimitsDigest": "6d754d28ae58d5f825473b475db4efd7d267a365a40b26bcd9e75e7e88d0a30c"
        },
        "policy": {
          "maxProcesses": 4,
          "jobCommitLimitBytes": "1048576",
          "processCommitLimitBytes": "524288",
          "cpuRatePer10000": 2000,
          "wallTimeoutMs": 1000,
          "joinTimeoutMs": 500,
          "stdoutMaxBytes": "32768",
          "stderrMaxBytes": "1024"
        },
        "limits": {
          "maxMetadataBytes": 4096,
          "maxInputBytes": 16384,
          "maxOutputBytes": 16384,
          "maxItems": 8,
          "childMemoryBytes": 16777216,
          "maxProcesses": 4,
          "timeoutMs": 1000,
          "terminationWaitMs": 500,
          "parentInFlightBytes": 1048576
        }
      },
      "launchRef": "00000000-0000-4000-8000-00000000001e"
    }
  },
  "nativeBase64": "VE1OQVRWMQAAAAGZeyJ2ZXJzaW9uIjoxLCJqb2JJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxNSIsInRhc2siOiJERUNPREVfSU1BR0UiLCJ0YXNrVmVyc2lvbiI6Im5hdGl2ZS1wdXJlLXYxIiwicHJvZmlsZURpZ2VzdCI6IjIwMjFiN2MzNzI5OTBmNzk3ZTg2Y2IwZjg1OTMxZjY2MzcyZWRjMDQwMTM1MDM5YjBhNzQxYzE4MjdiMzQ3NWMiLCJtZXRhZGF0YSI6e30sImJsb2JzIjpbeyJpZCI6InNvdXJjZSIsImJ5dGVMZW5ndGgiOjE1LCJzaGEyNTYiOiJlZjJkZjBiNTM5YzZjMjNkZTBmNGNiZTQyNjQ4YzMwMWFlMGUyMmU4ODczNDBhNDU5OWZiNGVmNGUyNjc4ZTQ4In1dLCJpbnB1dERpZ2VzdCI6ImUwNjRjYzI2OTRiMzlhNTc3NjhjNjE1MjY5MjQ1YTdkY2U3M2FkMDU1Yzk0ZTI0NmU2M2JkNzQ5MGJkMzAwODIifWFhYWFhYWFhYWFhYWFhYQ==",
  "controlBase64": "AAAMjnsiYXR0ZW1wdElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDFjIiwiY29tbWFuZCI6IlBSRVBBUkUiLCJsYXVuY2hJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwNCIsIm9yaWdpbkRpZ2VzdCI6ImQwNzdjNmRlNWI4ZmY2NDE2Njc4NDYzNWE2MDZlZWFjYTg3Y2E4NTdlYzAxMWEzMGZlNjgwOGZjMGZjMWViZDkiLCJwYXlsb2FkIjp7ImxhdW5jaFJlZiI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxZSIsIm9yaWdpbiI6eyJhdXRob3JpdHkiOnsiYXBwQ29udGFpbmVyU2lkRGlnZXN0IjoiZTVmNWRhYWMxMzVhN2U2ODg3ZTlkYWRkZmY0NWZmMWFiMjgxN2Q1OTdkZmNmZjE1MGUxMjU2NzcwYTIyOGUwNCIsImF0dGVtcHRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxYyIsImNoaWxkU2lkRGlnZXN0IjoiZDM1ZGQ4OWQ3YTNjNTcwYzk0MmRmNTRlNjJhMWFkOTdmMWExZGMwODBlOTFjY2UyOWUyNTAwNDAzYjlmYWQxMiIsImNvbnRyb2xsZXJJZCI6ImNvbnRyb2xsZXIiLCJjb250cm9sbGVySW5zdGFuY2VJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxZCIsImNvbnRyb2xsZXJTaWREaWdlc3QiOiIwM2Y3ODdiNDAyMTFkMTBhMmZjZTY2NmYzZWFmYjE1MmRhN2M0ZDI0NTg3NmQ5NjFmMTMwZjAyMzBiMjcyMGUwIiwiZW52aXJvbm1lbnREaWdlc3QiOiI3N2MxNDI4M2M1OGJiZjNkZTFlYzc1ZTFjNGQ1NTQ0NTIyZmUwNDM4YzA4NjlmNGZmZDZhN2VmMDkxZGE0ODM4IiwiaG9zdEVwb2NoSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJrZXlWZXJzaW9uIjoia2V5LXYxIiwibGF1bmNoSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDQiLCJwb2xpY3lEaWdlc3QiOiJhNmRhZWY1NzI0YTA2M2I4ODU3YjE5NmE2YzNjNDljZWIxY2RkNGE1YzQ4MjQyMTczYThhYmM2YzBkZTRjODJjIiwic2Vzc2lvbklkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIn0sImlkZW50aXR5Ijp7ImJhc2lzUmVmIjp7ImV2aWRlbmNlRGlnZXN0IjoiOTJlNTkwYzllZWZhYjI4ZThhNmNjZTUyNTQ2NjBlMzYwY2UxYzg1OWQ5NjUzNjI1MDI2M2MxMWRhZDg0MjVjNSIsImV2aWRlbmNlSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMWIifSwiYmluZGluZyI6eyJhY2NvdW50SWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMTYiLCJjYXBhY2l0eVJlc2VydmF0aW9uSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMTciLCJpbnB1dERpZ2VzdCI6ImUwNjRjYzI2OTRiMzlhNTc3NjhjNjE1MjY5MjQ1YTdkY2U3M2FkMDU1Yzk0ZTI0NmU2M2JkNzQ5MGJkMzAwODIiLCJqb2JJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxNSIsImtlcm5lbERpZ2VzdCI6IjBjZmE5NzI4YWExMjc4NjZhM2NjYWFkYzU3MWI5OTRhYTYyMmI0ZmQzYjg1YjQ4YjQ3YTcwZTMzOTFkMDQ1ODMiLCJwYXJlbnRJbnN0YW5jZUlkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDE4IiwicHJvZmlsZURpZ2VzdCI6IjIwMjFiN2MzNzI5OTBmNzk3ZTg2Y2IwZjg1OTMxZjY2MzcyZWRjMDQwMTM1MDM5YjBhNzQxYzE4MjdiMzQ3NWMifSwiaW5wdXRFdmlkZW5jZURpZ2VzdCI6ImQ4OGE3Y2U1YTQ3ZDgyNmE2ZmE0NDYzYzk0MjNiMTc3YjBkZjY2MmNhNmExMjE5OTdlNTkxZjk0NGZhY2QzMzIiLCJpbnB1dEZpbmdlcnByaW50IjoiNDhhZWQyMzc0Y2VhNWYzYmJiZWUxYzg3NDI0MzliZTc1OGRjYzFlOTk5ZTBlM2YwZTAzYzFlZTgwZTM1NjVhMCIsImludGVudERpZ2VzdCI6IjNhNGMxNWU1MWEwZGZmNGE1NjFhMjk2NmU1YmQ3ZDQ5YjY5MTRmNDJmZjNjZDk1MDgzMmI0NzZlZTZhYzI1ZjgiLCJzb3VyY2VJbnB1dCI6eyJleGVjdXRpb25JZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxOSIsImlucHV0RXZpZGVuY2VJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxYSIsInN0YWdlSW5wdXREaWdlc3QiOiJmMDEyMjk3M2EyMjhkZmVlMGMwZWQ1MTViY2E2ZWRmMjZhZDQ1NWNlYzYwNzIxMTdiYmIxZjcwNjMxODdiZTdlIn19LCJsaW1pdHMiOnsiY2hpbGRNZW1vcnlCeXRlcyI6MTY3NzcyMTYsIm1heElucHV0Qnl0ZXMiOjE2Mzg0LCJtYXhJdGVtcyI6OCwibWF4TWV0YWRhdGFCeXRlcyI6NDA5NiwibWF4T3V0cHV0Qnl0ZXMiOjE2Mzg0LCJtYXhQcm9jZXNzZXMiOjQsInBhcmVudEluRmxpZ2h0Qnl0ZXMiOjEwNDg1NzYsInRlcm1pbmF0aW9uV2FpdE1zIjo1MDAsInRpbWVvdXRNcyI6MTAwMH0sInBpbnMiOnsiYm9vdHN0cmFwRGlnZXN0IjoiMWRlYmYwZGQ1YWJhNDU3NDliOGZlOGNlOWUyOTZmNjAwOTA3ODI1YThjYTk5YTRiM2IzZThlZDk1ZWNhMGQwYSIsImV4ZWN1dGFibGVEaWdlc3QiOiJlMGM2NzQwNzAwZDZjZGFhYWQ5ZTcwMjlkMmQ5NWY3OTg2YTEzZTFhOWJjYTk0NzMyYmFhYWIyMDc4ZWIxZmUzIiwiaGVscGVyUnVudGltZURpZ2VzdCI6IjJkMGVkYzJmMDY1MGM1MjE4YTJjYmU2MDIyZTRiYWQyZjE0NmUwMTVjNDY1YTI5NzU0YWQ2NDA3YjA1NGQ2YjMiLCJoZWxwZXJTY3JpcHREaWdlc3QiOiI5MDRmNDFiZjVlNTM5Yzg1NGNlYTgwNTlhZjVhMTA3MGQwZDExMWQwNmJkM2M4YWU1YjMxZmZkZTBiNDU4ZmUyIiwibmF0aXZlTGltaXRzRGlnZXN0IjoiNmQ3NTRkMjhhZTU4ZDVmODI1NDczYjQ3NWRiNGVmZDdkMjY3YTM2NWE0MGIyNmJjZDllNzVlN2U4OGQwYTMwYyIsInJ1bnRpbWVGaWxlc0RpZ2VzdCI6IjJkNTJjZDkwNzMwNTM0MjZhNTIyY2U0ZmI4NTc0NTkwMmNhMmY5NDgyZTYxNzc0YjdjMWZhNmM0NGE2ODkzMWQifSwicG9saWN5Ijp7ImNwdVJhdGVQZXIxMDAwMCI6MjAwMCwiam9iQ29tbWl0TGltaXRCeXRlcyI6IjEwNDg1NzYiLCJqb2luVGltZW91dE1zIjo1MDAsIm1heFByb2Nlc3NlcyI6NCwicHJvY2Vzc0NvbW1pdExpbWl0Qnl0ZXMiOiI1MjQyODgiLCJzdGRlcnJNYXhCeXRlcyI6IjEwMjQiLCJzdGRvdXRNYXhCeXRlcyI6IjMyNzY4Iiwid2FsbFRpbWVvdXRNcyI6MTAwMH19fSwicmVxdWVzdElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMzIwIiwic2Vzc2lvbklkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwidmVyc2lvbiI6MX0=",
  "captureDigest": "59652bdc734e5ba4c8bd37958c5de4633abf3de8c557938fb90284a722910098",
  "nativeDigest": "b8d2c1d0cb241831e2f321aad86644771053474216285c2e1316a0b61736d0eb",
  "controlDigest": "5694a99e485ced078c2cf2cb8e4a667bd9d6749b3716bb2d02bbd4fc0d4b3821"
};

it('W5-A 전체 capture·기존 control·native frame golden을 같은 bytes로 전달한다',async()=>{
 const g=fullWireGolden,p=peer();expect(p.c).toEqual(g.capture);expect(digest(g.capture)).toBe('59652bdc734e5ba4c8bd37958c5de4633abf3de8c557938fb90284a722910098');
 const control=encodeWindowsControl(g.control);expect(control.toString('base64')).toBe(g.controlBase64);expect(sha256(control)).toBe('5694a99e485ced078c2cf2cb8e4a667bd9d6749b3716bb2d02bbd4fc0d4b3821');
 const i=input(),expected:Buffer[]=[];await writeNativeFrame(new Writable({write:(b:Buffer,_e,cb)=>{expected.push(Buffer.from(b));cb();}}),i.frame,{maxMetadataBytes:4096,maxBinaryBytes:i.limits.maxInputBytes,maxItems:8});
 const native=Buffer.concat(expected);expect(native.toString('base64')).toBe(g.nativeBase64);expect(sha256(native)).toBe('b8d2c1d0cb241831e2f321aad86644771053474216285c2e1316a0b61736d0eb');
 const b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(g.capture);await s.send(g.control);expect(p.controls[0]).toEqual(g.control);
 p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});await flush();
 await new Promise<void>((resolve,reject)=>s.nativeInput.write(Buffer.from(g.nativeBase64,'base64'),e=>e?reject(e):resolve()));
 expect(Buffer.concat(p.pipes.get('IN')!.written.slice(1))).toEqual(Buffer.from(g.nativeBase64,'base64'));
 await new Promise<void>(resolve=>s.nativeInput.end(resolve));expect(await complete(p,s)).toMatchObject({end:'EXPECTED'});await b.idle();expect(p.holds).toBe(0);
});


const l1ClientModulePath='../../packages/native/src/windows-pipe-client.js';
const l1Client=await import(l1ClientModulePath).catch(()=>({})) as typeof import('../../packages/native/src/windows-pipe-client.js');
type L1Open=import('../../packages/native/src/windows-pipe-client.js').WindowsPipeClientOpenInput;
type L1Channel=import('../../packages/native/src/windows-pipe-client.js').WindowsPipeClientChannel;
type L1Binding=import('../../packages/native/src/windows-pipe-client.js').WindowsPipeClientNativeBinding;

class BrokerClientChannel implements L1Channel{
 readonly closed:Promise<void>;readonly writes:Buffer[]=[];readonly closeReasons:string[]=[];
 private reading:{buffer:Buffer;resolve:(v:{bytesRead:number;eof:boolean})=>void;reject:(e:unknown)=>void}|null=null;
 private ending=false;private error:unknown=null;private ended=false;
 constructor(readonly raw:FakePipe,readonly resource:ReturnType<typeof deferred<void>>,readonly closeGate:ReturnType<typeof deferred<void>>,readonly originalClosed:Promise<void>,readonly writePart:number,readonly reverseOnClose:boolean){
  this.closed=resource.promise;raw.pause();raw.on('readable',()=>this.pump());raw.on('end',()=>{this.ended=true;this.pump();});
  raw.on('error',e=>{this.error=e;this.pump();});
  raw.on('close',()=>{if(!this.ending&&!this.ended)this.error??=Error('FAKE_NATIVE_UNEXPECTED_CLOSE');this.pump();});
 }
 private pump(){
  const pending=this.reading;if(!pending)return;
  if(this.error){this.reading=null;pending.reject(this.error);return;}
  this.raw.read(0);
  if(this.raw.readableLength>0){const bytes=this.raw.read(Math.min(pending.buffer.length,this.raw.readableLength)) as Buffer;if(bytes){bytes.copy(pending.buffer);this.reading=null;pending.resolve({bytesRead:bytes.length,eof:false});return;}}
  if(this.ended){this.reading=null;pending.resolve({bytesRead:0,eof:true});}
 }
 readInto(buffer:Buffer):Promise<{bytesRead:number;eof:boolean}>{
  if(this.reading)throw Error('FAKE_NATIVE_DOUBLE_READ');
  return new Promise((resolve,reject)=>{this.reading={buffer,resolve,reject};this.pump();});
 }
 write(buffer:Buffer):Promise<number>{
  const n=Math.min(buffer.length,this.writePart);
  if(this.raw.attached&&this.raw.lane==='IN')this.writes.push(Buffer.from(buffer.subarray(0,n)));
  return new Promise((resolve,reject)=>this.raw.write(buffer.subarray(0,n),e=>e?reject(e):resolve(n)));
 }
 close(reason:string){
  this.closeReasons.push(reason);if(this.ending)return;this.ending=true;
  const pending=this.reading;this.reading=null;
  if(pending){if(this.reverseOnClose){pending.buffer[0]=0x41;pending.resolve({bytesRead:1,eof:false});}else pending.resolve({bytesRead:0,eof:false});}
  this.raw.destroy();
  void this.originalClosed.then(async()=>{await this.closeGate.promise;this.resource.resolve();});
 }
}
type L1BrokerFixture={p:Peer;b:ReturnType<typeof brokerModule.createWindowsJobBroker>;channels:Map<Lane,BrokerClientChannel>;streams:Map<Lane,Duplex>;nativeOpens:L1Open[];gates:ReturnType<typeof deferred<void>>[];cleanup():void};
function clientBrokerFixture(options:{blockInClose?:boolean;reverseOnClose?:boolean;writePart?:number;input?:WindowsPrepareInput}={}):L1BrokerFixture{
 expect(l1Client.createWindowsPipeClientPorts).toBeTypeOf('function');
 const p=peer();if(options.input){Object.assign(p.c,capture(options.input));p.options.bounds.maxChunkBytes=65536;}
 const channels=new Map<Lane,BrokerClientChannel>(),streams=new Map<Lane,Duplex>(),nativeOpens:L1Open[]=[],gates:ReturnType<typeof deferred<void>>[]=[];
 const binding:L1Binding={open:request=>{
  nativeOpens.push(request);expect(request).toMatchObject({desiredAccess:0x12008b,flags:0x40110000,creationDisposition:3,shareMode:0,inheritHandle:false});
  expect('key' in request).toBe(false);
  const op=p.connect(request.name,p.options.bounds.streamHighWaterMarkBytes),resource=deferred<void>(),closeGate=deferred<void>();
  gates.push(closeGate);if(!(options.blockInClose&&request.lane==='IN'))closeGate.resolve();
  let channel:BrokerClientChannel|null=null,stop:string|null=null;
  const ready=op.ready.then(raw=>{
   channel=new BrokerClientChannel(raw as FakePipe,resource,closeGate,op.closed,options.writePart??17,!!options.reverseOnClose&&request.lane==='IN');
   channels.set(request.lane,channel);if(stop)channel.close(stop);return channel;
  });
  return {ready,cancel:reason=>{stop=reason;if(channel)channel.close(reason);else op.cancel(reason);},closed:resource.promise};
 }};
 const ports=l1Client.createWindowsPipeClientPorts({registration:p.options.registration,bounds:p.options.bounds,clientBudgetBytes:2097152,memory:p.options.memory,authority:{resolve:async()=>({capture:p.c,pipeAclDigest:h('acl')}),current:async()=>true},binding});
 const injected:BrokerOptions['ports']={...p.options.ports,connect:(name,hwm)=>{
  const op=ports.connect(name,hwm),lane:Lane=name.endsWith('-ctl')?'CONTROL':name.endsWith('-in')?'IN':name.endsWith('-out')?'OUT':'ERR';
  void op.ready.then(stream=>{streams.set(lane,stream);},()=>{});return op;
 }};
 const b=brokerModule.createWindowsJobBroker({...p.options,ports:injected});
 const fixture={p,b,channels,streams,nativeOpens,gates,cleanup(){for(const gate of gates)gate.resolve();for(const channel of channels.values())channel.close('TEST_CLEANUP');p.cleanup();}};
 l1FixtureResources.push(fixture);return fixture;
}

const l1FixtureResources:L1BrokerFixture[]=[];
afterEach(async()=>{for(const f of l1FixtureResources.splice(0))f.cleanup();await flush();});
async function clientReady(f:ReturnType<typeof clientBrokerFixture>){
 const s=await f.b.broker.open(f.p.c);await s.send(f.p.command());
 f.p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});
 await flush();return s;
}
function endClientInput(s:import('../../packages/native/src/windows-job-backend.js').BrokerSession){
 return new Promise<void>((resolve,reject)=>s.nativeInput.end((e?:Error|null)=>e?reject(e):resolve()));
}
async function finishClient(f:ReturnType<typeof clientBrokerFixture>,s:import('../../packages/native/src/windows-job-backend.js').BrokerSession,omit?:'CONTROL'|'OUT'|'ERR'){
 const out=drain(s.nativeOutput).catch(e=>e),err=drain(s.nativeError).catch(e=>e),events=drain(s.events).catch(e=>e);
 const ack=f.p.command('ACK_FINAL');await s.send(ack);f.p.message('FINALIZED',{...ack.payload,handles:'CLOSED',closeCode:null});
 for(const lane of ['CONTROL','OUT','ERR'] as const)if(lane!==omit)f.p.pipes.get(lane)!.push(null);
 await flush();if(omit){f.p.advance(101);await flush();}
 await Promise.all([out,err,events]);return s.join();
}

describe('L1 실제 broker와 가짜 최소권한 client 조립',()=>{
 it('IN 로컬 닫힘은 EOF를 위장하지 않고 실제 close 뒤 EXPECTED까지 합류한다',async()=>{
  const f=clientBrokerFixture({blockInClose:true,writePart:7}),s=await clientReady(f),payload=Buffer.alloc(1025,0x61);
  await new Promise<void>((resolve,reject)=>s.nativeInput.write(payload,e=>e?reject(e):resolve()));
  expect(Buffer.concat(f.channels.get('IN')!.writes)).toEqual(payload);
  let ended=false;const ending=endClientInput(s).then(()=>{ended=true;});
  await flush();expect(ended).toBe(false);expect(f.p.holds).toBeGreaterThan(0);
  expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!)).toBeNull();
  f.channels.get('IN')!.closeGate.resolve();await ending;await flush();
  expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!)).toBeInstanceOf(Error);
  expect((await f.b.broker.readOriginal(f.p.c))?.phase,'정상 local-close가 원 broker를 실패로 바꾸면 안 된다').toBe('GO_GRANTED');
  expect(f.p.pipes.get('IN')!.readableEnded,'가짜 native 포트도 상대 EOF를 합성하지 않는다').toBe(false);
  expect(await finishClient(f,s)).toMatchObject({end:'EXPECTED',finalized:{handles:'CLOSED'}});
  await f.b.idle();expect(f.nativeOpens).toHaveLength(4);expect(f.p.holds).toBe(0);
  expect(f.b.usage()).toMatchObject({activeSessions:0,pendingOperations:0,heldBytes:0});
 });
 it.each(['CONTROL','OUT','ERR'] as const)('IN 로컬 닫힘 뒤 %s의 실제 EOF 하나가 없으면 성공하지 않는다',async omit=>{
  const f=clientBrokerFixture(),s=await clientReady(f);await endClientInput(s);
  expect((await f.b.broker.readOriginal(f.p.c))?.phase).toBe('GO_GRANTED');
  expect(await finishClient(f,s,omit)).toMatchObject({end:'LOST'});await expect(f.b.idle()).rejects.toThrow();
  expect(f.p.holds).toBe(0);
 });
 it('IN end를 요청하지 않은 broker에는 진짜 adapter 표지도 정상 종료가 아니다',async()=>{
  const f=clientBrokerFixture(),s=await clientReady(f);
  await new Promise<void>((resolve,reject)=>f.streams.get('IN')!.end((e?:Error|null)=>e?reject(e):resolve()));
  expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!)).toBeInstanceOf(Error);
  expect(await s.join()).toMatchObject({end:'LOST'});await expect(f.b.idle()).rejects.toThrow();expect(f.p.holds).toBe(0);
 });
 it('같은 오류 code만 내보내는 가짜 IN은 nominal local-close를 위조하지 못한다',async()=>{
  const p=peer(),b=brokerModule.createWindowsJobBroker(p.options),s=await b.broker.open(p.c);await s.send(p.command());
  p.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:{kind:'IO',callId:id(500),lane:'OUT',operation:'READ',qpcTicks:'175',status:'RETURNED',bytesLength:'9',sha256:sha256(Buffer.from('READY_V1\n'))}});
  await flush();await endClientInput(s);
  const forged=Object.assign(Error('WINDOWS_PIPE_LOCAL_INPUT_CLOSED'),{code:'WINDOWS_PIPE_LOCAL_INPUT_CLOSED'});
  expect(l1Client.readWindowsPipeClientLocalInputClose(p.pipes.get('IN')!)).toBeNull();
  p.pipes.get('IN')!.emit('error',forged);expect(await s.join()).toMatchObject({end:'LOST'});await expect(b.idle()).rejects.toThrow();expect(p.holds).toBe(0);
 });
 it('IN 로컬 닫힘의 회수 중 늦은 역방향 bytes가 생기면 표지 없이 실패한다',async()=>{
  const f=clientBrokerFixture({reverseOnClose:true}),s=await clientReady(f);
  await endClientInput(s).catch(()=>{});expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!)).toBeNull();
  expect(await s.join()).toMatchObject({end:'LOST'});await expect(f.b.idle()).rejects.toThrow();expect(f.p.holds).toBe(0);
 });
 it('다른 lane의 실제 오류에 IN 표지 객체를 재사용해도 성공으로 바꾸지 않는다',async()=>{
  const f=clientBrokerFixture(),s=await clientReady(f);await endClientInput(s);
  const proof=l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!);expect(proof).toBeInstanceOf(Error);
  expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('OUT')!)).toBeNull();
  const output=drain(s.nativeOutput).catch(e=>e);f.p.pipes.get('OUT')!.emit('error',proof);
  expect(await s.join()).toMatchObject({end:'LOST'});await output;await expect(f.b.idle()).rejects.toThrow();expect(f.p.holds).toBe(0);
 });
});


describe('L1 원 backend 가짜 client 연속 조립',()=>{
 it('L1 client의 로컬 입력 종료로 원 backend의 큰 native frame과 최종 합류를 연결한다',async()=>{
 const i=input(65537),f=clientBrokerFixture({input:i,writePart:4093}),p=f.p;
 const script=createdScript(i),b=f.b,events=new Queue<WindowsHostMessage>(),rows:JournalEntry[]=[];
 let hostClosed=false,prepared=false,go=false,goKnown=false,parentJoined=false,emptyAcked=false,next=0,stored:{ref:{recordId:string;digest:string};envelope:WindowsSealEnvelope}|null=null;
 const emit=(message:string,payload:unknown)=>{const c=p.controls.at(-1)!;events.push({version:1,requestId:c.requestId,originDigest:p.c.originDigest,attemptId:i.authority.attemptId,sessionId:i.authority.sessionId,launchId:i.authority.launchId,message,payload} as WindowsHostMessage);};
 const resultBlobs=new Map([['output',Buffer.from('result')]]),result={envelope:createNativeResult(i.frame.envelope,{metadata:{ok:true},blobs:resultBlobs},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8}),blobs:resultBlobs};
 const output:Buffer[]=[];const sink=new Writable({write:(bytes:Buffer,_e,cb)=>{output.push(Buffer.from(bytes));cb();}});await writeNativeFrame(sink,result,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
 const ports:WindowsJobPorts={original:{captureFresh:async()=>({created:true,capture:p.c}),grantOriginal:async()=>{goKnown=true;return {created:true,goGrantRef:{jobId:i.identity.binding.jobId,rowDigest:h('go')}};},readOriginal:async()=>({originDigest:p.c.originDigest,state:'CONFIRMED',goGrantRef:goKnown?{jobId:i.identity.binding.jobId,rowDigest:h('go')}:null})},broker:b.broker,journal:{appendOriginal:async(_c,e,s)=>{const row={event:e,source:s,sourceDigest:digest(s)};rows.push(row);return {eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest};},lookupEvent:async()=>null,scanOriginal:async function*(){yield*rows;},sealOriginal:async(_c,envelope)=>{const ref={recordId:id(401),digest:digest(envelope)};stored={ref,envelope};return ref;},readOriginal:async()=>stored},parent:{rawResult:async(_c,received)=>({rawResultId:id(402),resultDigest:digest(received.envelope)}),joinOriginal:async()=>script.joinAck},clock:{nowMs:()=>0,waitUntil:()=>new Promise(()=>{})}};
 p.onControl=control=>{
 if(control.command==='PREPARE')emit('EVENT',script.entries[next++]);
 if(control.command==='ACK_EVENT'){
  if(next<5)emit('EVENT',script.entries[next++]);
  else if(!prepared){prepared=true;emit('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:script.entries[4].source.facts[1]});}
  else if(go&&next<8)emit('EVENT',script.entries[next++]);
  else if(go&&next===8){next++;emit('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:script.entries[10].source.facts.find(f=>f.kind==='IO'&&f.bytesLength==='9')});p.pipes.get('IN')!.once('close',()=>{setImmediate(()=>{for(const bytes of output)p.pipes.get('OUT')!.push(bytes);p.pipes.get('OUT')!.push(null);p.pipes.get('ERR')!.push(null);emit('EVENT',script.entries[8]);});});}
  else if(next===9){next++;emit('EVENT',script.entries[9]);}
  else if(next===10&&control.payload.eventId===script.entries[9].event.eventId){emptyAcked=true;if(parentJoined){next=11;emit('EVENT',script.entries[10]);}}
  else if(next===11){next++;emit('EVENT',script.entries[11]);}
  else if(next===12){next++;emit('FINAL_CANDIDATE',{evidence:script.evidence()});}
 }
 if(control.command==='GRANT_GO'){go=true;script.complete(control.payload.goGrantRef);emit('EVENT',script.entries[next++]);}
 if(control.command==='PARENT_JOINED'){parentJoined=true;if(next===10&&emptyAcked){next=11;emit('EVENT',script.entries[10]);}}
 if(control.command==='ACK_FINAL'){emit('FINALIZED',{...control.payload,handles:'CLOSED',closeCode:null});hostClosed=true;events.end();}
 };
 const host=(async()=>{for await(const m of events)p.pipes.get('CONTROL')!.reply(m);p.pipes.get('CONTROL')!.push(null);})();
 const backend=createWindowsJobBackend(i,ports);try{
 await backend.prepare();const done=backend.grantGo();await until(()=>!!f.streams.get('IN')?.writableFinished||p.controls.some(c=>c.command==='STOP'));
 expect(p.controls.filter(c=>c.command==='STOP'),'큰 유효 blob 때문에 STOP을 보내지 않는다').toHaveLength(0);
 expect(l1Client.readWindowsPipeClientLocalInputClose(f.streams.get('IN')!)).toBeInstanceOf(Error);expect(p.pipes.get('IN')!.readableEnded).toBe(false);const outcome=await done;expect(outcome.state,JSON.stringify({code:outcome.code,final:outcome.evidence?.final,broker:await b.broker.readOriginal(p.c),controls:p.controls.map(c=>c.command),events:rows.map(r=>r.event.kind)})).toBe('JOINED');await backend.idle();await b.idle();await host;expect(hostClosed).toBe(true);
 const raw=p.pipes.get('IN')!.written.slice(1);expect(raw.every(v=>v.length<=65536)).toBe(true);const expected:Buffer[]=[];await writeNativeFrame(new Writable({write:(bytes:Buffer,_e,cb)=>{expected.push(Buffer.from(bytes));cb();}}),i.frame,{maxMetadataBytes:4096,maxBinaryBytes:i.limits.maxInputBytes,maxItems:8});
 expect(Buffer.concat(raw)).toEqual(Buffer.concat(expected));expect(rows).toHaveLength(12);expect(p.controls.filter(c=>c.command==='GRANT_GO')).toHaveLength(1);expect(p.holds).toBe(0);
 }finally{events.end();f.cleanup();await flush();}
 });
});
