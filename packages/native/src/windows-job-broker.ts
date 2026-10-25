import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {Duplex,Writable} from 'node:stream';
import {readWindowsPipeClientLocalInputClose} from './windows-pipe-client.js';
import {types,TextDecoder} from 'node:util';
import canonicalize from 'canonicalize';
import {DomainError} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {decodeWindowsHostMessage,encodeWindowsControl,type OriginalCapture,type BrokerSession,type WindowsControl,type WindowsHostMessage,type HostFinalized,type WindowsJobPorts} from './windows-job-backend.js';
import type {NativeControllerMemoryOwner} from './controller-attempts.js';

type Row=Record<string,unknown>;
type Lane='CONTROL'|'IN'|'OUT'|'ERR';
type Phase='NEW'|'PREPARING'|'PREPARED'|'GO_GRANTED'|'DRAINING'|'JOINED'|'UNCONFIRMED';
export type WindowsBrokerProcess={pid:number;creationFileTime100ns:string;windowsSessionId:number};
export type WindowsBrokerRegistration={version:1;hostEpochId:string;environmentDigest:string;controllerInstanceId:string;endpointId:string;hostProcess:WindowsBrokerProcess;controllerProcess:WindowsBrokerProcess;hostSidDigest:string;controllerSidDigest:string;key:Buffer};
export type WindowsBrokerBounds={maxControlBytes:131072;maxChunkBytes:number;streamHighWaterMarkBytes:number;maxQueuedBytes:number;maxInFlightBytes:number;maxRetainedRecords:number;handshakeMilliseconds:number;closeMilliseconds:number;maxPendingOperations:32};
export type WindowsBrokerConnectOperation={ready:Promise<Duplex>;cancel(reason:string):void;closed:Promise<void>};
export type WindowsBrokerPorts={connect(name:string,highWaterMark:number):WindowsBrokerConnectOperation;nowMs():number;startWait(deadlineMs:number):{done:Promise<void>;cancel():void};nonce():Buffer};
export type WindowsJobBrokerOptions={registration:WindowsBrokerRegistration;bounds:WindowsBrokerBounds;memory:NativeControllerMemoryOwner;ports:WindowsBrokerPorts};
export type WindowsJobBroker={broker:WindowsJobPorts['broker'];stopClaims():void;idle():Promise<void>;usage():Readonly<{accepting:boolean;activeSessions:number;retainedRecords:number;heldBytes:number;pendingOperations:number;unconfirmedSessions:number}>};
const domain='trio-windows-broker-v1',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,HEX=/^[0-9a-f]{64}$/;
function fail(code='WINDOWS_BROKER_INVALID'):never{throw new DomainError(code,409,'WAIT');}
function must(v:unknown,code='WINDOWS_BROKER_INVALID'):asserts v{if(!v)fail(code);}
function object(v:unknown,keys:readonly string[]):Row{
 must(v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v));
 must(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
 const own=Reflect.ownKeys(v);must(own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)));
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);must(d?.enumerable&&'value'in d);}
 return v as Row;
}
function positive(v:unknown,max=Number.MAX_SAFE_INTEGER):asserts v is number{must(typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=max);}
function uuid(v:unknown):asserts v is string{must(typeof v==='string'&&UUID.test(v));}
function hash(v:unknown):asserts v is string{must(typeof v==='string'&&HEX.test(v));}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;}
function json(v:unknown,cap=131072):{value:unknown;bytes:number}{
 let nodes=0,bytes=0;const active=new Set<object>();
 const add=(n:number)=>{bytes+=n;must(bytes<=cap,'WINDOWS_BROKER_LIMIT');};
 const string=(v:string)=>{add(2);for(const c of v){const x=c.codePointAt(0)!;must(x>=32&&x<=126);add(c==='"'||c==='\\'?2:1);}};
 const visit=(v:unknown,d:number):void=>{
 must(++nodes<=8192&&d<=20&&!types.isProxy(v),'WINDOWS_BROKER_LIMIT');
 if(v===null){add(4);return;}if(typeof v==='string'){must(v.length<=cap);string(v);return;}
 if(typeof v==='boolean'){add(v?4:5);return;}if(typeof v==='number'){must(Number.isSafeInteger(v)&&!Object.is(v,-0));add(String(v).length);return;}
 must(v!==null&&typeof v==='object'&&!active.has(v));active.add(v);
 try{if(Array.isArray(v)){must(Object.getPrototypeOf(v)===Array.prototype&&v.length<=8192&&Reflect.ownKeys(v).length===v.length+1);add(2+Math.max(0,v.length-1));for(let n=0;n<v.length;n++){const a=Object.getOwnPropertyDescriptor(v,String(n));must(a?.enumerable&&'value'in a);visit(a.value,d+1);}}
 else{must(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);const ks=Reflect.ownKeys(v);must(ks.length<=8192);add(2+Math.max(0,ks.length-1));for(const k of ks){must(typeof k==='string');string(k);add(1);const a=Object.getOwnPropertyDescriptor(v,k);must(a?.enumerable&&'value'in a);visit(a.value,d+1);}}}finally{active.delete(v);}
 };
 visit(v,0);return {value:v,bytes};
}
function copy<T>(v:T,cap=131072):T{json(v,cap);return freeze(JSON.parse(canonicalize(v)!) as T);}
const arrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer=Object.getOwnPropertyDescriptor(arrayPrototype,'buffer')!.get!;
const getOffset=Object.getOwnPropertyDescriptor(arrayPrototype,'byteOffset')!.get!;
const getLength=Object.getOwnPropertyDescriptor(arrayPrototype,'byteLength')!.get!;
function binary(v:unknown):Uint8Array{
 must(!types.isProxy(v)&&Buffer.isBuffer(v),'WINDOWS_BINARY_INVALID');
 try{return new Uint8Array(getBuffer.call(v) as ArrayBufferLike,getOffset.call(v) as number,getLength.call(v) as number);}catch{fail('WINDOWS_BINARY_INVALID');}
}
function processIdentity(v:unknown){const r=object(v,['pid','creationFileTime100ns','windowsSessionId']);positive(r.pid,0xffffffff);must(typeof r.windowsSessionId==='number'&&Number.isSafeInteger(r.windowsSessionId)&&r.windowsSessionId>=0&&r.windowsSessionId<=0xffffffff);must(typeof r.creationFileTime100ns==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(r.creationFileTime100ns)&&BigInt(r.creationFileTime100ns)<=18446744073709551615n);}
function captureCopy(v:OriginalCapture,registration:WindowsBrokerRegistration):OriginalCapture{
 const r=object(v,['origin','originDigest','frameInputDigest','launchRef']);hash(r.originDigest);hash(r.frameInputDigest);uuid(r.launchRef);
 json(v);
 const c=copy(v);
 encodeWindowsControl({version:1,requestId:registration.endpointId,originDigest:c.originDigest,attemptId:c.origin.authority.attemptId,sessionId:c.origin.authority.sessionId,launchId:c.origin.authority.launchId,command:'PREPARE',payload:{origin:c.origin,launchRef:c.launchRef}});
 const o=c.origin,a=o.authority;
 must(c.originDigest===digest({identity:o.identity,authority:o.authority,pins:o.pins,policy:o.policy,nativeLimitsDigest:digest(o.limits),frameInputDigest:c.frameInputDigest})&&c.frameInputDigest===o.identity.binding.inputDigest,'WINDOWS_CAPTURE_MISMATCH');
 must(a.hostEpochId===registration.hostEpochId&&a.environmentDigest===registration.environmentDigest&&a.controllerInstanceId===registration.controllerInstanceId&&a.controllerSidDigest===registration.controllerSidDigest,'WINDOWS_REGISTRATION_MISMATCH');
 return c;
}
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};}
function packed(v:unknown):Buffer{const s=canonicalize(v)!;must(Buffer.byteLength(s)<=131072,'WINDOWS_BROKER_LIMIT');const p=Buffer.alloc(4);p.writeUInt32BE(Buffer.byteLength(s));return Buffer.concat([p,Buffer.from(s,'ascii')]);}
function pipeBase(r:WindowsBrokerRegistration){return '\\\\.\\pipe\\trio-w5a-'+r.endpointId+'-'+r.hostEpochId;}
function pipeName(r:WindowsBrokerRegistration,c:OriginalCapture,lane:Lane){return pipeBase(r)+(lane==='CONTROL'?'-ctl':'-'+c.origin.authority.sessionId+'-'+c.origin.authority.launchId+'-'+c.originDigest.slice(0,16)+'-'+lane.toLowerCase());}
type Kind='OPEN'|'CHALLENGE'|'AUTH'|'ACCEPT'|'ATTACH'|'ATTACHED';
function envelope(r:WindowsBrokerRegistration,kind:Kind,lane:Lane,body:unknown){
 const unsigned={version:1,domain,kind,endpointId:r.endpointId,lane,body};
 return {...unsigned,mac:createHmac('sha256',r.key).update(canonicalize(unsigned)!,'ascii').digest('hex')};
}
function verified(r:WindowsBrokerRegistration,v:unknown,kind:Kind,lane:Lane):Row{
 const m=object(v,['version','domain','kind','endpointId','lane','body','mac']);
 must(m.version===1&&m.domain===domain&&m.kind===kind&&m.endpointId===r.endpointId&&m.lane===lane,'WINDOWS_BOOTSTRAP_MISMATCH');hash(m.mac);
 const {mac,...unsigned}=m;const want=createHmac('sha256',r.key).update(canonicalize(unsigned)!,'ascii').digest();
 must(timingSafeEqual(Buffer.from(mac as string,'hex'),want),'WINDOWS_BOOTSTRAP_MAC');return m;
}
type Release=()=>void;
class Budget{
 pending=0;loans=0;onReleased:()=>void=()=>{};private directHeld=0;private dataPending=0;private poolSize=0;private poolUsed=0;private poolRelease:Release|null=null;
 readonly controlReserve:number;
 constructor(readonly bounds:WindowsBrokerBounds,readonly memory:NativeControllerMemoryOwner){this.controlReserve=Math.min(Math.floor(bounds.maxInFlightBytes/2),65536);}
 get held(){return this.directHeld+this.poolSize;}
 start(){
 must(this.poolRelease===null&&this.held===0&&this.pending===0,'WINDOWS_BROKER_ACCOUNTING');
 const n=this.controlReserve;must(this.memory.available()>=n,'WINDOWS_BROKER_CAPACITY');
 const release=this.memory.hold(n);must(typeof release==='function');this.poolSize=n;this.poolRelease=release;
 }
 finish(){
 must(this.directHeld===0&&this.poolUsed===0&&this.pending===0&&this.loans===0,'WINDOWS_BROKER_ACCOUNTING');
 this.poolRelease?.();this.poolRelease=null;this.poolSize=0;
 }
 hold(n:number,control=false):Release{
 must(Number.isSafeInteger(n)&&n>=0,'WINDOWS_BROKER_CAPACITY');
 const pooled=control?Math.min(n,this.poolSize-this.poolUsed):0,extra=n-pooled;
 must(this.held+extra<=this.bounds.maxInFlightBytes&&this.memory.available()>=extra,'WINDOWS_BROKER_CAPACITY');
 const free=extra?this.memory.hold(extra):()=>{};must(typeof free==='function');this.directHeld+=extra;this.poolUsed+=pooled;this.loans++;let live=true;
 return ()=>{if(live){live=false;this.directHeld-=extra;this.poolUsed-=pooled;this.loans--;free();queueMicrotask(this.onReleased);}};
 }
 begin(control=false):Release{must(this.pending<32&&(control||this.dataPending<24),'WINDOWS_BROKER_OPERATIONS');this.pending++;if(!control)this.dataPending++;let active=true;return()=>{if(active){active=false;this.pending--;if(!control)this.dataPending--;}};}
 async operation<T>(work:()=>Promise<T>,control=false):Promise<T>{const done=this.begin(control);try{return await work();}finally{done();}}
}
class Reader{
 private wake=deferred<void>();private ended=false;private error:unknown=null;private reading=false;
 constructor(readonly socket:Duplex,readonly budget:Budget,readonly chunk:number,readonly onError:(e:unknown)=>void,readonly localInputClose?:()=>Error|null){
 socket.pause();socket.on('readable',()=>this.signal());socket.on('end',()=>{this.ended=true;this.signal();});
 socket.on('error',e=>{this.error=e;this.signal();onError(e);});
 socket.on('close',()=>{if(!this.ended)this.error??=localInputClose?.()??new DomainError('WINDOWS_PIPE_TRUNCATED',409,'WAIT');this.signal();});
 }
 private signal(){this.wake.resolve();this.wake=deferred<void>();}
 async exact(n:number,allowEof=false,control=false):Promise<{bytes:Buffer;release:Release}|null>{
 must(!this.reading,'WINDOWS_PIPE_CONCURRENT_READ');const done=this.budget.begin(control);this.reading=true;let release:Release|undefined;
 try{
 release=this.budget.hold(n,control);const bytes=Buffer.alloc(n);let offset=0;
 while(offset<n){
 if(this.error)throw this.error;
 const size=Math.min(n-offset,this.chunk,Math.max(1,this.socket.readableLength)),raw:unknown=this.socket.read(size);
 if(raw!==null){must(Buffer.isBuffer(raw)&&raw.length<=n-offset,'WINDOWS_PIPE_BYTES');const free=this.budget.hold(raw.length,control);try{raw.copy(bytes,offset);offset+=raw.length;}finally{free();}continue;}
 if(this.ended){if(offset===0&&allowEof){release();return null;}fail('WINDOWS_PIPE_TRUNCATED');}
 await this.wake.promise;
 }
 return {bytes,release};
 }catch(e){release?.();throw e;}finally{this.reading=false;done();}
 }
 async frame():Promise<{bytes:Buffer;release:Release}|null>{
 const p=await this.exact(4,true,true);if(!p)return null;
 let body:{bytes:Buffer;release:Release}|null=null,free:Release|undefined;
 try{const n=p.bytes.readUInt32BE();must(n>0&&n<=131072,'WINDOWS_CONTROL_LIMIT');body=await this.exact(n,false,true);must(body);free=this.budget.hold(n+4,true);return {bytes:Buffer.concat([p.bytes,body.bytes]),release:free};}
 catch(e){free?.();throw e;}finally{p.release();body?.release();}
 }
 async chunkRead():Promise<{bytes:Buffer;release:Release}|null>{
 must(!this.reading,'WINDOWS_PIPE_CONCURRENT_READ');const done=this.budget.begin();this.reading=true;
 try{for(;;){if(this.error)throw this.error;
 this.socket.read(0);const n=Math.min(this.chunk,this.socket.readableLength);if(n>0){const free=this.budget.hold(n);try{const raw:unknown=this.socket.read(n);must(Buffer.isBuffer(raw)&&raw.length===n,'WINDOWS_PIPE_BYTES');return {bytes:raw,release:free};}catch(e){free();throw e;}}
 if(this.ended)return null;await this.wake.promise;
 }}finally{this.reading=false;done();}
 }
}
type Connection={lane:Lane;operation:WindowsBrokerConnectOperation;socket:Duplex|null;reader:Reader|null;release:Release;closed:Promise<void>};
class Session{
 private capture:OriginalCapture|null;private readonly originDigest:string;private readonly authority:OriginalCapture['origin']['authority'];private readonly launchRef:string;
 private connections=new Map<Lane,Connection>();private tuple:Row|null=null;private requests=new Set<string>();private eventTaken=false;private outputTaken=new Set<Lane>();
 private eventQueue:WindowsHostMessage[]=[];private eventWait=deferred<void>();private eventEnded=false;private eventError:unknown=null;
 private readonly completion=deferred<{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}>();private readonly opened=deferred<BrokerSession>();
 private failed=false;private stopping=false;private ready=false;private phase:Phase='NEW';private finalized:HostFinalized|null=null;private finalRef:{recordId:string;digest:string}|null=null;
 private captureRelease:Release;private writes=new Set<Promise<void>>();private nativeEof=new Set<Lane>();private inputEndRequested=false;private localInputClosed=false;private controlEof=false;private joining=false;private spent:boolean=false;private hostError=false;private closeTimer:{done:Promise<void>;cancel():void}|null=null;
 readonly api:BrokerSession;
 constructor(c:OriginalCapture,readonly manager:Manager){
 this.capture=c;this.originDigest=c.originDigest;this.authority=c.origin.authority;this.launchRef=c.launchRef;
 this.captureRelease=manager.budget.hold(json(c).bytes*2+512);
 const input=this.input();
 this.api=Object.freeze({send:this.send.bind(this),events:{[Symbol.asyncIterator]:()=>this.events()},nativeInput:input,nativeOutput:{[Symbol.asyncIterator]:()=>this.native('OUT')},nativeError:{[Symbol.asyncIterator]:()=>this.native('ERR')},join:()=>this.completion.promise});
 }
 matches(c:OriginalCapture){return c.originDigest===this.originDigest&&c.launchRef===this.launchRef;}
 view(){return freeze({phase:this.phase,finalized:this.finalized?copy(this.finalized):null});}
 start(){void this.bootstrap().then(()=>this.opened.resolve(this.api),e=>{this.opened.reject(e);this.lose(e);});return this.opened.promise;}
 private time(){return this.manager.time();}
 private async deadline<T>(work:Promise<T>,milliseconds:number):Promise<T>{
 const timer=this.manager.ports.startWait(this.time()+milliseconds);object(timer,['done','cancel']);must(types.isPromise(timer.done)&&typeof timer.cancel==='function');this.manager.timers.add(timer);
 try{return await Promise.race([work,timer.done.then(()=>fail('WINDOWS_BROKER_TIMEOUT'))]);}finally{timer.cancel();this.manager.timers.delete(timer);}
 }
 private async connect(lane:Lane):Promise<Connection>{
 must(this.capture);const release=this.manager.budget.hold(this.manager.bounds.streamHighWaterMarkBytes*2+131072+256);
 let operation:WindowsBrokerConnectOperation;
 try{operation=this.manager.ports.connect(pipeName(this.manager.registration,this.capture,lane),this.manager.bounds.streamHighWaterMarkBytes);object(operation,['ready','cancel','closed']);must(types.isPromise(operation.ready)&&types.isPromise(operation.closed)&&typeof operation.cancel==='function');}
 catch(e){release();throw e;}
 const conn:Connection={lane,operation,socket:null,reader:null,release,closed:operation.closed};this.connections.set(lane,conn);
 void operation.closed.then(()=>{release();void this.tryJoin();},e=>{release();this.lose(e);});
 const ready=operation.ready.then(socket=>{
 must(socket instanceof Duplex,'WINDOWS_PIPE_REQUIRED');conn.socket=socket;conn.reader=new Reader(socket,this.manager.budget,this.manager.bounds.maxChunkBytes,e=>this.lose(e),()=>lane==='IN'&&this.inputEndRequested&&socket.readableLength===0?readWindowsPipeClientLocalInputClose(socket):null);
 if(this.stopping){socket.destroy();fail('WINDOWS_CONNECT_CANCELLED');}
 return conn;
 });
 void ready.catch(e=>this.lose(e));
 return this.deadline(this.manager.budget.operation(()=>ready,true),this.manager.bounds.handshakeMilliseconds);
 }
 private async write(conn:Connection,bytes:Buffer,control=false):Promise<void>{
 must(conn.socket&&!conn.socket.destroyed&&!this.failed,'WINDOWS_PIPE_CLOSED');
 const free=this.manager.budget.hold(bytes.length*2,control);const work=this.manager.budget.operation(()=>new Promise<void>((resolve,reject)=>{
 try{conn.socket!.write(bytes,e=>e?reject(e):resolve());}catch(e){reject(e);}
 }),control).finally(()=>{free();this.writes.delete(work);void this.tryJoin();});
 this.writes.add(work);void work.catch(e=>this.lose(e));return work;
 }
 private async sendPrivate(conn:Connection,kind:Kind,lane:Lane,body:unknown){const n=json(body).bytes;const free=this.manager.budget.hold(n*3+1024,true);try{await this.write(conn,packed(envelope(this.manager.registration,kind,lane,body)),true);}finally{free();}}
 private async receivePrivate(conn:Connection,kind:Kind,lane:Lane):Promise<Row>{
 const frame=await conn.reader!.frame();must(frame,'WINDOWS_BOOTSTRAP_EOF');
 let free:Release|undefined;
 try{free=this.manager.budget.hold(frame.bytes.length*3,true);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(frame.bytes.subarray(4));}catch{fail();}
 const body=parseStrictJson(text,131072);json(body);return copy(verified(this.manager.registration,body,kind,lane));}finally{frame.release();free?.();}
 }
 private async bootstrap(){
 const r=this.manager.registration,c=this.capture!;
 const clientBytes=binary(this.manager.ports.nonce());must(clientBytes.byteLength===32,'WINDOWS_NONCE_INVALID');
 const clientNonce=Buffer.from(clientBytes).toString('hex');must(clientNonce!==r.key.toString('hex'),'WINDOWS_NONCE_INVALID');must(!this.manager.nonces.has(clientNonce),'WINDOWS_NONCE_REUSED');this.manager.nonces.add(clientNonce);
 const ctl=await this.connect('CONTROL');
 await this.deadline(this.sendPrivate(ctl,'OPEN','CONTROL',{capture:c,controllerInstanceId:r.controllerInstanceId,clientNonce}),this.manager.bounds.handshakeMilliseconds);
 const challenge=await this.deadline(this.receivePrivate(ctl,'CHALLENGE','CONTROL'),this.manager.bounds.handshakeMilliseconds);
 const body=object(challenge.body,['hostEpochId','environmentDigest','originDigest','attemptId','sessionId','launchId','launchRef','controllerInstanceId','clientNonce','serverNonce','hostProcess','controllerProcess','hostSidDigest','controllerSidDigest']);hash(body.serverNonce);
 const tuple={hostEpochId:r.hostEpochId,environmentDigest:r.environmentDigest,originDigest:c.originDigest,attemptId:c.origin.authority.attemptId,sessionId:c.origin.authority.sessionId,launchId:c.origin.authority.launchId,launchRef:c.launchRef,controllerInstanceId:r.controllerInstanceId,clientNonce,serverNonce:body.serverNonce,hostProcess:r.hostProcess,controllerProcess:r.controllerProcess,hostSidDigest:r.hostSidDigest,controllerSidDigest:r.controllerSidDigest};
 must(digest(body)===digest(tuple),'WINDOWS_BOOTSTRAP_IDENTITY');this.tuple=copy(tuple);
 await this.deadline(this.sendPrivate(ctl,'AUTH','CONTROL',tuple),this.manager.bounds.handshakeMilliseconds);
 const accepted=await this.deadline(this.receivePrivate(ctl,'ACCEPT','CONTROL'),this.manager.bounds.handshakeMilliseconds);must(digest(accepted.body)===digest(tuple),'WINDOWS_BOOTSTRAP_IDENTITY');
 for(const lane of ['IN','OUT','ERR'] as const){
 const conn=await this.connect(lane);await this.deadline(this.sendPrivate(conn,'ATTACH',lane,tuple),this.manager.bounds.handshakeMilliseconds);
 const reply=await this.deadline(this.receivePrivate(conn,'ATTACHED',lane),this.manager.bounds.handshakeMilliseconds);must(digest(reply.body)===digest(tuple),'WINDOWS_BOOTSTRAP_IDENTITY');
 }
 this.phase='PREPARING';void this.controlPump();void this.inputDrain();
 }
 private correlated(m:WindowsControl|WindowsHostMessage){
 must(m.originDigest===this.originDigest&&m.attemptId===this.authority.attemptId&&m.sessionId===this.authority.sessionId&&m.launchId===this.authority.launchId,'WINDOWS_ORIGINAL_MISMATCH');
 }
 async send(control:WindowsControl){
 must(!this.stopping&&this.tuple,'WINDOWS_PIPE_CLOSED');json(control);const free=this.manager.budget.hold(json(control).bytes*3+8,true);
 try{const bytes=encodeWindowsControl(control);const frozen=copy(control);this.correlated(frozen);must(!this.requests.has(frozen.requestId)&&this.requests.size<128,'WINDOWS_CONTROL_REPLAY');
 if(frozen.command==='PREPARE')must(this.capture&&digest(frozen.payload.origin)===digest(this.capture.origin)&&frozen.payload.launchRef===this.launchRef,'WINDOWS_ORIGINAL_MISMATCH');
 if(frozen.command==='ACK_FINAL')this.finalRef=copy(frozen.payload);
 this.requests.add(frozen.requestId);await this.write(this.connections.get('CONTROL')!,bytes,true);
 }finally{free();}
 }
 private async controlPump(){
 try{const reader=this.connections.get('CONTROL')!.reader!;
 for(;;){const frame=await reader.frame();if(!frame){this.controlEof=true;break;}let free:Release|undefined;
 try{free=this.manager.budget.hold(frame.bytes.length*3,true);const m=decodeWindowsHostMessage(frame.bytes);this.correlated(m);must(this.requests.has(m.requestId),'WINDOWS_CORRELATION_MISMATCH');
 if(m.message==='EVENT'&&(m.payload.event.kind==='CREATE_NOT_ATTEMPTED'||m.payload.event.kind==='CREATE_FAILED'))this.noChildDrain();
 if(m.message==='PROGRESS'){this.phase=m.payload.phase;if(m.payload.bootstrap==='READY')this.ready=true;}
 if(m.message==='ERROR')this.hostError=true;
 if(m.message==='FINALIZED'){must(this.finalRef&&digest({recordId:m.payload.recordId,digest:m.payload.digest})===digest(this.finalRef)&&this.finalized===null,'WINDOWS_FINAL_MISMATCH');this.finalized=copy(m.payload);this.phase=m.payload.handles==='CLOSED'?'JOINED':'UNCONFIRMED';this.armCloseDeadline();}
 must(this.eventQueue.length<64&&this.eventQueue.reduce((n,v)=>n+json(v).bytes,0)+json(m).bytes<=this.manager.bounds.maxQueuedBytes,'WINDOWS_BROKER_QUEUE');
 // 소비자가 다음 사건을 요구할 때까지 원 message 사본의 credit을 유지한다.
 const held=this.manager.budget.hold(json(m).bytes,true);this.messageCredits.set(m,held);this.eventQueue.push(m);this.eventWait.resolve();this.eventWait=deferred<void>();
 }finally{frame.release();free?.();}
 }
 this.eventEnded=true;this.eventWait.resolve();if(!this.finalized)this.lose(new DomainError('WINDOWS_FINAL_MISSING',409,'WAIT'));else void this.tryJoin();
 }catch(e){this.lose(e);}
 }
 private consumerLoans=0;private messageCredits=new Map<WindowsHostMessage,Release>();
 private async *events():AsyncGenerator<WindowsHostMessage>{
 must(!this.eventTaken,'WINDOWS_DOUBLE_CONSUMER');this.eventTaken=true;let last:WindowsHostMessage|undefined;
 try{for(;;){if(last){this.messageCredits.get(last)?.();this.messageCredits.delete(last);last=undefined;}
 if(this.eventQueue.length){last=this.eventQueue.shift()!;yield last;continue;}if(this.eventError)throw this.eventError;if(this.eventEnded)return;await this.eventWait.promise;
 }}finally{if(last){this.messageCredits.get(last)?.();this.messageCredits.delete(last);}if(!this.eventEnded)this.lose(new DomainError('WINDOWS_EVENTS_ABANDONED',409,'WAIT'));void this.tryJoin();}
 }
 private async *native(lane:'OUT'|'ERR'):AsyncGenerator<Uint8Array>{
 must(!this.outputTaken.has(lane),'WINDOWS_DOUBLE_CONSUMER');this.outputTaken.add(lane);let held:Release|undefined;
 try{for(;;){held?.();held=undefined;const v=await this.connections.get(lane)!.reader!.chunkRead();if(!v){this.nativeEof.add(lane);void this.tryJoin();return;}this.consumerLoans++;held=()=>{v.release();this.consumerLoans--;void this.tryJoin();};yield v.bytes;}}
 catch(e){this.lose(e);throw e;}finally{held?.();if(!this.nativeEof.has(lane))this.lose(new DomainError('WINDOWS_LANE_ABANDONED',409,'WAIT'));void this.tryJoin();}
 }
 private noChildDraining=false;
 private noChildDrain(){
 if(this.noChildDraining)return;this.noChildDraining=true;
 for(const lane of ['OUT','ERR'] as const){
  must(!this.outputTaken.has(lane),'WINDOWS_NO_CHILD_CONSUMER');this.outputTaken.add(lane);
  void (async()=>{const extra=await this.connections.get(lane)!.reader!.exact(1,true);if(extra){extra.release();fail('WINDOWS_NO_CHILD_BYTES');}this.nativeEof.add(lane);void this.tryJoin();})().catch(e=>this.lose(e));
 }
 }
 private async inputDrain(){try{const r=this.connections.get('IN')!.reader!;const extra=await r.exact(1,true);if(extra){extra.release();fail('WINDOWS_INPUT_REVERSE_BYTES');}this.nativeEof.add('IN');void this.tryJoin();}catch(e){
 const stream=this.connections.get('IN')?.socket;
 if(this.inputEndRequested&&stream&&stream.readableLength===0&&readWindowsPipeClientLocalInputClose(stream)!==null&&e===readWindowsPipeClientLocalInputClose(stream)){this.localInputClosed=true;void this.tryJoin();return;}
 this.lose(e);
 }}
 private inputTickets=new Set<{free:Release;bytes:number;queuedDone:boolean;actualDone:boolean}>();
 private input():Writable{
 let queued=0,ended=false;
 type Ticket={free:Release;bytes:number;queuedDone:boolean;actualDone:boolean};
 const tickets=new WeakMap<Buffer,Ticket>();
 const settle=(ticket:Ticket)=>{if(ticket.queuedDone&&ticket.actualDone&&this.inputTickets.delete(ticket)){queued-=ticket.bytes;ticket.free();void this.tryJoin();}};
 const w=new Writable({highWaterMark:this.manager.bounds.streamHighWaterMarkBytes,write:(bytes:Buffer,_encoding,callback)=>{
 const ticket=tickets.get(bytes);if(!ticket){callback(new DomainError('WINDOWS_INPUT_CREDIT',409,'WAIT'));return;}ticket.actualDone=false;
 void (async()=>{
 try{
 for(let offset=0;offset<bytes.length;offset+=this.manager.bounds.maxChunkBytes){
 must(!this.stopping,'WINDOWS_PIPE_CLOSED');
 await this.write(this.connections.get('IN')!,bytes.subarray(offset,Math.min(bytes.length,offset+this.manager.bounds.maxChunkBytes)));
 }
 callback();
 }catch(e){callback(e instanceof Error?e:Error('WINDOWS_INPUT_FAILED'));}
 finally{ticket.actualDone=true;settle(ticket);}
 })();
 },final:callback=>{
 const conn=this.connections.get('IN');if(!conn?.socket){callback(new DomainError('WINDOWS_INPUT_UNCONNECTED',409,'WAIT'));return;}
 void this.endWrite(conn).then(()=>callback(),e=>callback(e instanceof Error?e:Error('WINDOWS_INPUT_FAILED')));
 }});
 w.on('error',e=>this.lose(e));
 const write=w.write.bind(w),end=w.end.bind(w);
 Object.defineProperty(w,'write',{value:(...args:unknown[])=>{
 must(this.ready&&!this.stopping&&!ended,'WINDOWS_INPUT_BEFORE_READY');const b=binary(args[0]);
 must(queued+b.byteLength<=this.manager.bounds.maxQueuedBytes,'WINDOWS_BROKER_QUEUE');
 const free=this.manager.budget.hold(b.byteLength);const own=Buffer.from(b),ticket:Ticket={free,bytes:b.byteLength,queuedDone:false,actualDone:true};queued+=b.byteLength;tickets.set(own,ticket);this.inputTickets.add(ticket);
 const userCallback=typeof args[1]==='function'?args[1]:typeof args[2]==='function'?args[2]:null;
 const returned=(e?:Error|null)=>{ticket.queuedDone=true;try{if(userCallback)userCallback(e);}finally{settle(ticket);}};
 try{return write(own,returned);}catch(e){ticket.queuedDone=true;settle(ticket);throw e;}
 }});
 Object.defineProperty(w,'end',{value:(...args:unknown[])=>{
 must(this.ready&&!this.stopping&&!ended,'WINDOWS_INPUT_BEFORE_READY');must(args.length===0||args.length===1&&typeof args[0]==='function','WINDOWS_INPUT_END_BYTES');ended=true;return Reflect.apply(end,w,args);
 }});
 return w;
 }
 private armCloseDeadline(){
 if(this.closeTimer)return;
 const timer=this.manager.ports.startWait(this.time()+this.manager.bounds.closeMilliseconds);
 object(timer,['done','cancel']);must(types.isPromise(timer.done)&&typeof timer.cancel==='function');this.closeTimer=timer;this.manager.timers.add(timer);
 void timer.done.then(()=>{if(!this.spent)this.lose(new DomainError('WINDOWS_CLOSE_TIMEOUT',409,'WAIT'));},e=>this.lose(e));
 }
 private endedWrites=new Set<Connection>();
 private endWrite(conn:Connection):Promise<void>{
 if(this.endedWrites.has(conn))return Promise.resolve();this.endedWrites.add(conn);if(conn.lane==='IN')this.inputEndRequested=true;
 const p=this.manager.budget.operation(()=>new Promise<void>((resolve,reject)=>{
 if(!conn.socket||conn.socket.destroyed){resolve();return;}
 try{conn.socket.end((e?:Error|null)=>e?reject(e):resolve());}catch(e){reject(e);}
 })).finally(()=>{this.writes.delete(p);void this.tryJoin();});
 this.writes.add(p);void p.catch(e=>this.lose(e));return p;
 }
 lose(e:unknown){
 if(!this.failed){this.failed=true;this.phase='UNCONFIRMED';this.eventError=e;this.manager.errors.push(e);}
 this.stopping=true;this.eventEnded=true;this.eventWait.resolve();this.api.nativeInput.destroy(e instanceof Error?e:new Error('WINDOWS_INPUT_STOPPED'));
 for(const conn of this.connections.values()){
 try{conn.operation.cancel('WINDOWS_BROKER_STOP');}catch(error){this.manager.errors.push(error);}
 conn.socket?.destroy();
 }
 // 소비 대기 중인 message만 회수하며, 이미 건넨 값은 iterator가 반납한다.
 for(const m of this.eventQueue.splice(0)){this.messageCredits.get(m)?.();this.messageCredits.delete(m);}
 void this.tryJoin();
 }
 private transportEnded(){return this.controlEof&&this.nativeEof.has('OUT')&&this.nativeEof.has('ERR')&&(this.nativeEof.has('IN')||this.localInputClosed);}
 private async tryJoin(){
 if(this.joining||this.spent)return;
 if(!this.failed&&(!this.transportEnded()||!this.finalized))return;
 if(this.writes.size||this.messageCredits.size||this.consumerLoans||this.inputTickets.size||this.manager.budget.pending)return;
 this.joining=true;
 try{
 // EOF만으로 실제 socket·connect callback 종료를 대신하지 않는다.
 for(const conn of this.connections.values()){if(!this.failed)await this.endWrite(conn);}
 await Promise.allSettled([...this.connections.values()].map(c=>c.closed));
 if(this.writes.size||this.messageCredits.size||this.consumerLoans||this.inputTickets.size||this.manager.budget.pending||this.manager.budget.loans!==1)return;
 const expected=!this.failed&&!this.hostError&&this.transportEnded()&&this.finalized?.handles==='CLOSED'&&this.finalized.closeCode===null;
 if(!expected&&!this.failed){this.failed=true;this.phase='UNCONFIRMED';this.manager.errors.push(new DomainError('WINDOWS_TRANSPORT_UNCONFIRMED',409,'WAIT'));}
 this.spent=true;this.closeTimer?.cancel();if(this.closeTimer)this.manager.timers.delete(this.closeTimer);this.closeTimer=null;this.capture=null;this.tuple=null;this.requests.clear();this.connections.clear();this.endedWrites.clear();this.captureRelease();
 this.manager.active--;this.manager.budget.finish();
 this.completion.resolve(freeze({end:expected?'EXPECTED':'LOST',finalized:this.finalized}));
 }finally{this.joining=false;}
 }
 reconsider(){void this.tryJoin();}
 get done(){return this.completion.promise;}
}
class Manager{
 accepting=true;active=0;readonly records=new Map<string,Session>();readonly nonces=new Set<string>();readonly launches=new Set<string>();readonly errors:unknown[]=[];readonly timers=new Set<{done:Promise<void>;cancel():void}>();
 readonly budget:Budget;private lastTime=-1;
 constructor(readonly registration:WindowsBrokerRegistration,readonly bounds:WindowsBrokerBounds,readonly memory:NativeControllerMemoryOwner,readonly ports:WindowsBrokerPorts){this.budget=new Budget(bounds,memory);this.budget.onReleased=()=>{for(const record of this.records.values())record.reconsider();};}
 time(){const now=this.ports.nowMs();must(Number.isFinite(now)&&now>=0&&now>=this.lastTime,'WINDOWS_CLOCK_UNCONFIRMED');this.lastTime=now;return now;}
 open(capture:OriginalCapture):Promise<BrokerSession>{
 let c:OriginalCapture;
 try{
 // 검증과 snapshot은 첫 await와 연결보다 먼저 끝낸다.
 must(this.accepting&&this.active===0,'WINDOWS_BROKER_NOT_ACCEPTING');
 must(this.records.size<this.bounds.maxRetainedRecords,'WINDOWS_BROKER_RETENTION');
 c=captureCopy(capture,this.registration);must(!this.records.has(c.originDigest),'WINDOWS_ORIGINAL_REPLAY');must(!this.launches.has(c.launchRef),'WINDOWS_LAUNCH_REPLAY');
 this.time();this.budget.start();const session=new Session(c,this);this.records.set(c.originDigest,session);this.launches.add(c.launchRef);this.active++;return session.start();
 }catch(e){if(this.active===0)this.budget.finish();return Promise.reject(e);}
 }
 readOriginal(capture:OriginalCapture){const c=captureCopy(capture,this.registration);const record=this.records.get(c.originDigest);return Promise.resolve(record?.matches(c)?record.view():null);}
 stopClaims(){this.accepting=false;}
 async idle(){await Promise.allSettled([...this.records.values()].map(s=>s.done));const errors=this.errors.splice(0);if(errors.length)throw new AggregateError(errors,'WINDOWS_BROKER_IDLE_UNCONFIRMED');}
 usage(){return freeze({accepting:this.accepting,activeSessions:this.active,retainedRecords:this.records.size,heldBytes:this.budget.held,pendingOperations:this.budget.pending,unconfirmedSessions:[...this.records.values()].filter(s=>s.view().phase==='UNCONFIRMED').length});}
}
export function createWindowsJobBroker(options:WindowsJobBrokerOptions):WindowsJobBroker{
 const o=object(options,['registration','bounds','memory','ports']);
 const r=object(o.registration,['version','hostEpochId','environmentDigest','controllerInstanceId','endpointId','hostProcess','controllerProcess','hostSidDigest','controllerSidDigest','key']);
 must(r.version===1);for(const k of ['hostEpochId','controllerInstanceId','endpointId'])uuid(r[k]);for(const k of ['environmentDigest','hostSidDigest','controllerSidDigest'])hash(r[k]);processIdentity(r.hostProcess);processIdentity(r.controllerProcess);
 const keyBytes=binary(r.key);must(keyBytes.byteLength===32,'WINDOWS_BOOTSTRAP_KEY');
 const {key:_key,...plain}=r;const registration={...copy(plain),key:Buffer.from(keyBytes)} as WindowsBrokerRegistration;Object.freeze(registration);
 const b=object(o.bounds,['maxControlBytes','maxChunkBytes','streamHighWaterMarkBytes','maxQueuedBytes','maxInFlightBytes','maxRetainedRecords','handshakeMilliseconds','closeMilliseconds','maxPendingOperations']);
 must(b.maxControlBytes===131072&&b.maxPendingOperations===32);for(const v of Object.values(b))positive(v);
 positive(b.maxChunkBytes,65536);positive(b.streamHighWaterMarkBytes,b.maxChunkBytes as number);positive(b.maxRetainedRecords,64);positive(b.handshakeMilliseconds,2147483647);positive(b.closeMilliseconds,2147483647);
 const bounds=copy(b) as WindowsBrokerBounds;
 const m=object(o.memory,['maxBytes','available','hold']);positive(m.maxBytes);must(typeof m.available==='function'&&typeof m.hold==='function');const memory=Object.freeze({maxBytes:m.maxBytes,available:m.available.bind(o.memory),hold:m.hold.bind(o.memory)}) as NativeControllerMemoryOwner;
 const p=object(o.ports,['connect','nowMs','startWait','nonce']);for(const v of Object.values(p))must(typeof v==='function');
 const ports=Object.freeze(Object.fromEntries(Object.entries(p).map(([k,v])=>[k,(v as (...a:unknown[])=>unknown).bind(o.ports)]))) as WindowsBrokerPorts;
 const manager=new Manager(registration,bounds,memory,ports);
 return Object.freeze({broker:Object.freeze({open:manager.open.bind(manager),readOriginal:manager.readOriginal.bind(manager)}),stopClaims:manager.stopClaims.bind(manager),idle:manager.idle.bind(manager),usage:manager.usage.bind(manager)});
}
// 이 factory는 포트 함수만 조립한다. 연결과 timer는 원 호출 시에만 시작한다.
export function createWindowsJobLocalPorts():WindowsBrokerPorts{
 const nowMs=()=>Number(process.hrtime.bigint()/1000000n);
 return Object.freeze({
 connect(name:string,_highWaterMark:number):WindowsBrokerConnectOperation{
 must(/^\\\\\.\\pipe\\trio-w5a-[a-f0-9-]+-(ctl|in|out|err)$/.test(name),'WINDOWS_PIPE_NAME');
 // 별도 승인된 좁은 권한의 client 포트가 없으면 실제 연결을 시작하지 않는다.
 fail('WINDOWS_PIPE_CLIENT_PORT_REQUIRED');
 },
 nowMs,startWait(deadlineMs:number){let timer:ReturnType<typeof setTimeout>|null=null;const d=deferred<void>();timer=setTimeout(()=>{timer=null;d.resolve();},Math.max(0,deadlineMs-nowMs()));return Object.freeze({done:d.promise,cancel:()=>{if(timer!==null){clearTimeout(timer);timer=null;}}});},nonce:()=>randomBytes(32)
 });
}

export const windowsJobBrokerWire=Object.freeze({pipeName,envelope});
