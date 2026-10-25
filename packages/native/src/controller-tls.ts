import tls,{type TLSSocket} from 'node:tls';
import {type Socket,type AddressInfo,isIP} from 'node:net';
import {constants} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {nativeJsonBytes,describeNativeBlobs,validateNativeEnvelope,verifyNativeInput,type NativeJob} from './dto.js';
import {validateNativeJob} from './jobs.js';
import type {NativeControllerPeer,NativeControllerPeerVerifier} from './controller-attempts.js';
import {readNativeControllerRequest,readNativeControllerResponse,writeNativeControllerRequest,writeNativeControllerResponse,
  validateNativeControllerRequest,validateNativeControllerResponse,type NativeControllerWireLimits,type NativeControllerRequest,
  type NativeControllerResponse,type NativeControllerResponseControl} from './controller-protocol.js';

export type NativeControllerTlsMaterials={ca:Buffer;certificate:Buffer;privateKey:Buffer};
export type NativeControllerTlsPeerPin={certificateSha256:string;serviceRole:NativeControllerPeer['serviceRole'];peerId:string};
export type NativeControllerTlsBounds={wire:NativeControllerWireLimits;deadlineMilliseconds:number;maxConnections:number;maxInFlightBytes:number;
  streamHighWaterMarkBytes:number;transportAllowanceBytes:number;maxTlsMaterialBytes:number;maxPinnedPeers:number};
export type NativeControllerTlsServerConfiguration={materials:NativeControllerTlsMaterials;pinnedPeers:readonly NativeControllerTlsPeerPin[];bounds:NativeControllerTlsBounds};
export type NativeControllerTlsClientConfiguration={materials:NativeControllerTlsMaterials;serverCertificateSha256:string;host:string;port:number;servername:string;bounds:NativeControllerTlsBounds};
export interface NativeControllerTlsCoordinator{
  // serve settles only after this request's store/read/reply I/O joins. Native
  // work continuing after READY remains owned by the coordinator's separate
  // Hold/pending-I/O/maxInFlightBytes budget. TLS does not release that work.
  serve(transport:unknown,request:NativeControllerRequest,reply:(response:NativeControllerResponse)=>Promise<void>):Promise<NativeControllerResponseControl>;
  stopClaims():void;
  idle():Promise<void>;
}
export type NativeControllerTlsCoordinatorFactory=(peers:NativeControllerPeerVerifier,bounds:Readonly<NativeControllerTlsBounds>)=>NativeControllerTlsCoordinator;
export type NativeControllerTlsUsage={connections:number;reservedBytes:number;ambiguousConnections:number;accepting:boolean};
export type NativeControllerTlsLifetime={tcpClosed:boolean;tlsObserved:boolean;tlsClosed:boolean;codecJoined:boolean;writerJoined:boolean;serveJoined:boolean;coordinatorJoined:boolean};

const hash=/^[a-f0-9]{64}$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const wait=(code:string)=>new DomainError(code,409,'WAIT');
function plain(value:unknown,keys:readonly string[]):void{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]),'NATIVE_TLS_CONFIGURATION',409,'WAIT');
}
function positive(value:number):void{requireCondition(Number.isSafeInteger(value)&&value>0,'NATIVE_TLS_CONFIGURATION',409,'WAIT');}
function copyBounds(value:NativeControllerTlsBounds):Readonly<NativeControllerTlsBounds>{
  plain(value,['wire','deadlineMilliseconds','maxConnections','maxInFlightBytes','streamHighWaterMarkBytes','transportAllowanceBytes','maxTlsMaterialBytes','maxPinnedPeers']);
  for(const key of ['deadlineMilliseconds','maxConnections','maxInFlightBytes','streamHighWaterMarkBytes','transportAllowanceBytes','maxTlsMaterialBytes','maxPinnedPeers'] as const)positive(value[key]);
  requireCondition(value.deadlineMilliseconds<=2_147_483_647,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  plain(value.wire,['maxControlBytes','input','output']);positive(value.wire.maxControlBytes);requireCondition(value.wire.maxControlBytes<=0xffffffff,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  for(const frame of [value.wire.input,value.wire.output]){plain(frame,['maxMetadataBytes','maxBinaryBytes','maxItems']);for(const count of Object.values(frame))positive(count);requireCondition(frame.maxMetadataBytes<=0xffffffff&&frame.maxItems<=frame.maxMetadataBytes,'NATIVE_TLS_CONFIGURATION',409,'WAIT');}
  // highWaterMark is stream backpressure, not a total memory ceiling. The caller
  // must supply a separate transport allowance including record/queue overlap.
  requireCondition(value.transportAllowanceBytes>=4*value.streamHighWaterMarkBytes+2*16384,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  return Object.freeze({...value,wire:Object.freeze({...value.wire,input:Object.freeze({...value.wire.input}),output:Object.freeze({...value.wire.output})})});
}
function copyMaterials(value:NativeControllerTlsMaterials,bounds:Readonly<NativeControllerTlsBounds>):NativeControllerTlsMaterials{
  plain(value,['ca','certificate','privateKey']);let bytes=0;
  for(const material of Object.values(value)){requireCondition(Buffer.isBuffer(material)&&material.length>0,'NATIVE_TLS_CONFIGURATION',409,'WAIT');bytes+=material.length;}
  requireCondition(Number.isSafeInteger(bytes)&&bytes<=bounds.maxTlsMaterialBytes,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  return Object.freeze({ca:Buffer.from(value.ca),certificate:Buffer.from(value.certificate),privateKey:Buffer.from(value.privateKey)});
}
function copyPins(values:readonly NativeControllerTlsPeerPin[],bounds:Readonly<NativeControllerTlsBounds>):Map<string,Readonly<NativeControllerPeer>>{
  requireCondition(Array.isArray(values)&&Object.getPrototypeOf(values)===Array.prototype&&values.length>0&&values.length<=bounds.maxPinnedPeers&&Reflect.ownKeys(values).length===values.length+1&&Object.keys(values).length===values.length,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
  for(let index=0;index<values.length;index++){const descriptor=Object.getOwnPropertyDescriptor(values,String(index));requireCondition(descriptor&&descriptor.enumerable&&'value'in descriptor,'NATIVE_TLS_CONFIGURATION',409,'WAIT');}
  const pins=new Map<string,Readonly<NativeControllerPeer>>();
  for(const value of values){plain(value,['certificateSha256','serviceRole','peerId']);requireCondition(hash.test(value.certificateSha256)&&uuid.test(value.peerId)&&['trio_web_api','trio_web_worker'].includes(value.serviceRole)&&!pins.has(value.certificateSha256),'NATIVE_TLS_CONFIGURATION',409,'WAIT');pins.set(value.certificateSha256,Object.freeze({serviceRole:value.serviceRole,peerId:value.peerId}));}
  return pins;
}
export function nativeControllerTlsReservationBytes(bounds:NativeControllerTlsBounds):number{
  const b=copyBounds(bounds),i=b.wire.input,o=b.wire.output,c=b.wire.maxControlBytes;
  const input=24+c+i.maxMetadataBytes+i.maxBinaryBytes,output=24+c+o.maxMetadataBytes+o.maxBinaryBytes;
  const coordinator=2*i.maxBinaryBytes+2*o.maxBinaryBytes+2*i.maxMetadataBytes+2*o.maxMetadataBytes+2*c+32;
  // Reserve before handshaking for codec buffers, copied input, coordinator
  // copies and simultaneous outbound copies. This is encoded-buffer accounting,
  // not a measured V8/OpenSSL RSS claim or a replacement for host isolation.
  const bytes=2*input+2*output+coordinator+2*(c+i.maxMetadataBytes+o.maxMetadataBytes)+b.transportAllowanceBytes;
  requireCondition(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=b.maxInFlightBytes,'NATIVE_TLS_CONFIGURATION',409,'WAIT');return bytes;
}
function closePromise(socket:Socket):Promise<void>{
  if(socket.closed)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{socket.off('close',done);resolve();};socket.once('close',done);
    // tlsClientError can run inside an already emitting close event, before
    // public `closed` updates. A newly registered listener misses that event;
    // recheck the documented close state after the current event unwinds.
    queueMicrotask(()=>{if(socket.closed)done();});
  });
}
function beforeDeadline(deadline:number):void{requireCondition(performance.now()<deadline,'NATIVE_TLS_DEADLINE',409,'WAIT');}
function errorCode(error:unknown):string{return error instanceof DomainError?error.code:'NATIVE_TLS_UNCONFIRMED';}
function certificatePin(socket:TLSSocket):string{
  requireCondition(socket.authorized===true&&!socket.isSessionReused(),'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');
  const certificate=socket.getPeerCertificate();requireCondition(certificate&&Buffer.isBuffer(certificate.raw)&&certificate.raw.length>0,'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');
  return sha256(certificate.raw);
}
function copyRequest(value:NativeControllerRequest,wire:NativeControllerWireLimits):NativeControllerRequest{
  plain(value,Object.hasOwn(value,'input')?['control','input']:['control']);const control=validateNativeControllerRequest(value.control,wire.maxControlBytes);
  if(control.command!=='PREPARE'){requireCondition(!Object.hasOwn(value,'input'),'NATIVE_CONTROL_INVALID',422,'WAIT');return {control};}
  requireCondition(value.input,'NATIVE_CONTROL_INVALID',422,'WAIT');plain(value.input,['envelope','blobs']);nativeJsonBytes(value.input.envelope,wire.input.maxMetadataBytes);
  requireCondition(value.input.blobs instanceof Map&&Object.getPrototypeOf(value.input.blobs)===Map.prototype&&Reflect.ownKeys(value.input.blobs).length===0,'NATIVE_CONTROL_INVALID',422,'WAIT');
  validateNativeEnvelope(value.input.envelope,wire.input);verifyNativeInput(value.input.envelope);
  requireCondition(digest(describeNativeBlobs(value.input.blobs,wire.input))===digest(value.input.envelope.blobs),'NATIVE_BINARY_MISMATCH',422,'WAIT');
  validateNativeJob(value.input);requireCondition(control.binding.jobId===value.input.envelope.jobId&&control.binding.inputDigest===value.input.envelope.inputDigest&&control.binding.profileDigest===value.input.envelope.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
  return {control,input:{envelope:structuredClone(value.input.envelope),blobs:new Map([...value.input.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))}};
}
function copyResponse(value:NativeControllerResponse,request:NativeControllerRequest,wire:NativeControllerWireLimits):NativeControllerResponse{
  plain(value,Object.hasOwn(value,'rawResult')?['control','rawResult']:['control']);const control=validateNativeControllerResponse(value.control,wire.maxControlBytes,request.control);
  const hasRaw=request.control.command==='QUERY'&&request.control.includeRawResult&&control.snapshot.rawResult!==null;
  requireCondition(hasRaw===Object.hasOwn(value,'rawResult'),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');if(!hasRaw)return {control};
  requireCondition(value.rawResult,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');plain(value.rawResult,['envelope','blobs']);nativeJsonBytes(value.rawResult.envelope,wire.output.maxMetadataBytes);
  validateNativeEnvelope(value.rawResult.envelope,wire.output);requireCondition(value.rawResult.blobs instanceof Map&&Object.getPrototypeOf(value.rawResult.blobs)===Map.prototype&&Reflect.ownKeys(value.rawResult.blobs).length===0&&digest(describeNativeBlobs(value.rawResult.blobs,wire.output))===digest(value.rawResult.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
  return {control,rawResult:{envelope:structuredClone(value.rawResult.envelope),blobs:new Map([...value.rawResult.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))}};
}
async function endWrites(socket:TLSSocket):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const fail=()=>{clean();reject(wait('NATIVE_TLS_WRITE_UNCONFIRMED'));},done=()=>{clean();resolve();},clean=()=>{socket.off('error',fail);socket.off('close',fail);};
    socket.once('error',fail);socket.once('close',fail);if(socket.destroyed)fail();else socket.end(done);
  });
}
async function* boundedSource(socket:TLSSocket,maximum:number,deadline:number):AsyncGenerator<Uint8Array>{
  // A default Readable async iterator destroys even a half-open TLS socket at
  // readable EOF. Keep the writable response side owned by the writer; callers
  // still destroy and join the actual socket on every failure or final close.
  let received=0;for await(const part of socket.iterator({destroyOnReturn:false})){beforeDeadline(deadline);requireCondition(part instanceof Uint8Array,'NATIVE_CONTROL_INVALID',422,'WAIT');received+=part.byteLength;requireCondition(Number.isSafeInteger(received)&&received<=maximum,'NATIVE_CONTROL_LIMIT',413,'WAIT');yield part;}
}
function wireMaximum(wire:NativeControllerWireLimits,side:'input'|'output'):number{return 24+wire.maxControlBytes+wire[side].maxMetadataBytes+wire[side].maxBinaryBytes;}
// Endpoint tuples only correlate two public socket lifetimes. They never decide
// peer/account/owner permissions; those come exclusively from actual verified
// DER pins, the fixed peer map, and the store's independent original binding.
function endpoint(socket:Socket):string|undefined{
  if(!socket.remoteAddress||!socket.remotePort||!socket.localAddress||!socket.localPort)return undefined;
  return JSON.stringify([socket.localAddress,socket.localPort,socket.remoteAddress,socket.remotePort]);
}
type Hold={raw:Socket;tls?:TLSSocket;key:string;bytes:number;deadline:number;rawClosed:boolean;tlsClosed:boolean;codecJoined:boolean;writerJoined:boolean;taskJoined:boolean;coordinatorJoined:boolean;released:boolean;timer:ReturnType<typeof setTimeout>;task?:Promise<void>};

export class NativeControllerTlsServer{
  private readonly server:tls.Server;
  private readonly bounds:Readonly<NativeControllerTlsBounds>;
  private readonly coordinator:NativeControllerTlsCoordinator;
  private readonly peers=new WeakMap<TLSSocket,Readonly<NativeControllerPeer>>();
  private readonly pins:Map<string,Readonly<NativeControllerPeer>>;
  private readonly holds=new Set<Hold>();
  private readonly byEndpoint=new Map<string,Hold>();
  private readonly orphanCloses=new Set<Promise<void>>();
  private readonly bytes:number;
  private accepting=true;
  private quiescing=false;
  private quiescence?:Promise<void>;
  private quiescenceQueued=false;
  private reserved=0;
  private listenTask?:Promise<AddressInfo>;
  private stopping?:Promise<void>;
  constructor(configuration:NativeControllerTlsServerConfiguration,createCoordinator:NativeControllerTlsCoordinatorFactory){
    plain(configuration,['materials','pinnedPeers','bounds']);this.bounds=copyBounds(configuration.bounds);const materials=copyMaterials(configuration.materials,this.bounds);
    this.pins=copyPins(configuration.pinnedPeers,this.bounds);this.bytes=nativeControllerTlsReservationBytes(this.bounds);
    this.server=tls.createServer({ca:materials.ca,cert:materials.certificate,key:materials.privateKey,requestCert:true,rejectUnauthorized:true,
      allowHalfOpen:true,highWaterMark:this.bounds.streamHighWaterMarkBytes,handshakeTimeout:this.bounds.deadlineMilliseconds,
      minVersion:'TLSv1.3',maxVersion:'TLSv1.3',secureOptions:constants.SSL_OP_NO_TICKET});
    const verifier:NativeControllerPeerVerifier=Object.freeze({authenticate:async(transport:unknown)=>{
      requireCondition(transport instanceof tls.TLSSocket&&!transport.destroyed,'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');
      const peer=this.peers.get(transport);requireCondition(peer&&this.pins.get(certificatePin(transport))===peer,'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');return {...peer};
    }});
    requireCondition(typeof createCoordinator==='function','NATIVE_TLS_CONFIGURATION',409,'WAIT');this.coordinator=createCoordinator(verifier,this.bounds);
    requireCondition(this.coordinator&&typeof this.coordinator.serve==='function'&&typeof this.coordinator.stopClaims==='function'&&typeof this.coordinator.idle==='function'&&!('then'in this.coordinator),'NATIVE_TLS_CONFIGURATION',409,'WAIT');
    // Public prependListener runs before the TLS server's handshake listener.
    this.server.prependListener('connection',(raw:Socket)=>this.reserve(raw));
    this.server.on('secureConnection',socket=>this.secure(socket));
    this.server.on('tlsClientError',(_error,socket)=>{const hold=this.attach(socket);socket.destroy();if(hold)this.finish(hold);});
    this.server.on('resumeSession',(_id,callback)=>callback(null,null));this.server.on('newSession',(_id,_session,callback)=>callback());
    this.server.on('error',()=>{this.accepting=false;this.limitAccepts();for(const hold of this.holds){hold.raw.destroy();hold.tls?.destroy();}});this.limitAccepts();
  }
  usage():NativeControllerTlsUsage{return {connections:this.holds.size,reservedBytes:this.reserved,ambiguousConnections:[...this.holds].filter(hold=>!hold.tls).length,accepting:this.accepting};}
  lifetimes():readonly Readonly<NativeControllerTlsLifetime>[]{return Object.freeze([...this.holds].map(hold=>Object.freeze({tcpClosed:hold.rawClosed,tlsObserved:!!hold.tls,tlsClosed:hold.tlsClosed,codecJoined:hold.codecJoined,writerJoined:hold.writerJoined,serveJoined:hold.taskJoined,coordinatorJoined:hold.coordinatorJoined})));}
  private limitAccepts():void{
    const capacity=Math.min(this.bounds.maxConnections,Math.floor(this.bounds.maxInFlightBytes/this.bytes));
    const closedUnjoined=[...this.holds].filter(hold=>hold.rawClosed).length;this.server.maxConnections=this.accepting&&!this.quiescing?Math.max(0,capacity-closedUnjoined):0;
  }
  private reserve(raw:Socket):void{
    raw.on('error',()=>{});const key=endpoint(raw);
    if(!this.accepting||!key||this.byEndpoint.has(key)||this.holds.size>=this.bounds.maxConnections||this.reserved+this.bytes>this.bounds.maxInFlightBytes){raw.destroy();return;}
    const started=performance.now();
    const hold:Hold={raw,key,bytes:this.bytes,deadline:started+this.bounds.deadlineMilliseconds,rawClosed:false,tlsClosed:false,codecJoined:true,writerJoined:true,taskJoined:true,coordinatorJoined:true,released:false,
      timer:setTimeout(()=>{raw.destroy();hold.tls?.destroy();},Math.max(1,this.bounds.deadlineMilliseconds-(performance.now()-started)))};
    this.reserved+=hold.bytes;this.holds.add(hold);this.byEndpoint.set(key,hold);
    raw.once('close',()=>{hold.rawClosed=true;this.limitAccepts();this.release(hold);});this.limitAccepts();
  }
  private attach(socket:TLSSocket):Hold|undefined{
    socket.on('error',()=>{});const key=endpoint(socket),hold=key?this.byEndpoint.get(key):undefined;
    if(!hold||hold.released||(hold.tls&&hold.tls!==socket)){
      const closed=closePromise(socket);this.orphanCloses.add(closed);void closed.finally(()=>this.orphanCloses.delete(closed));socket.destroy();return undefined;
    }
    if(!hold.tls){hold.tls=socket;socket.disableRenegotiation();const closed=closePromise(socket);void closed.then(()=>{hold.tlsClosed=true;this.peers.delete(socket);this.release(hold);});}
    return hold;
  }
  private secure(socket:TLSSocket):void{
    const hold=this.attach(socket);if(!hold)return;
    try{
      beforeDeadline(hold.deadline);requireCondition(this.accepting&&!hold.rawClosed,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const peer=this.pins.get(certificatePin(socket));requireCondition(peer,'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');this.peers.set(socket,peer);
    }catch{socket.destroy();this.finish(hold);return;}
    hold.taskJoined=false;
    hold.task=(async()=>{
      try{
        const source=boundedSource(socket,wireMaximum(this.bounds.wire,'input'),hold.deadline);let request:NativeControllerRequest;
        hold.codecJoined=false;try{request=await readNativeControllerRequest(source,this.bounds.wire);}finally{try{await source.return(undefined);}finally{hold.codecJoined=true;}}
        beforeDeadline(hold.deadline);requireCondition(this.accepting&&!socket.destroyed&&this.peers.has(socket),'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
        hold.coordinatorJoined=false;let replied=false;
        await this.coordinator.serve(socket,request,async response=>{
          beforeDeadline(hold.deadline);requireCondition(!replied&&!socket.destroyed,'NATIVE_TLS_WRITE_UNCONFIRMED',409,'WAIT');replied=true;
          const captured=copyResponse(response,request,this.bounds.wire);hold.writerJoined=false;
          try{await writeNativeControllerResponse(socket,captured,this.bounds.wire,request.control);beforeDeadline(hold.deadline);await endWrites(socket);await closePromise(socket);}finally{hold.writerJoined=true;}
        });
      }catch{socket.destroy();}
      finally{hold.taskJoined=true;this.finish(hold);}
    })();void hold.task.catch(()=>{});
  }
  private finish(hold:Hold):void{
    if(!hold.taskJoined||!hold.codecJoined||!hold.writerJoined)return;
    // A joined serve promise includes this request's coordinator I/O. Waiting
    // for global idle here would retain READY's socket slot while its separate
    // native child waits for GO, deadlocking maxConnections=1.
    hold.coordinatorJoined=true;
    this.release(hold);
  }
  private quiesceClosedTls():void{
    if(!this.accepting)return;if(this.quiescence){this.quiescenceQueued=true;return;}
    this.quiescing=true;this.limitAccepts();
    this.quiescence=new Promise<number>((resolve,reject)=>this.server.getConnections((error,count)=>error?reject(error):resolve(count))).then(count=>{
      if(count!==0)return;
      // The public raw 'connection' socket need not emit normal socket events.
      // While accepts are disabled, global connection zero verifies raw close
      // only for an already observed/closed TLS lifetime whose own I/O joined.
      for(const hold of this.holds)if(hold.tls&&hold.tlsClosed&&hold.codecJoined&&hold.writerJoined&&hold.taskJoined&&hold.coordinatorJoined){hold.rawClosed=true;this.release(hold);}
    }).finally(()=>{this.quiescence=undefined;this.quiescing=false;this.limitAccepts();if(this.quiescenceQueued){this.quiescenceQueued=false;this.quiesceClosedTls();}});void this.quiescence.catch(()=>{});
  }
  private release(hold:Hold):void{
    if(hold.released||!hold.tlsClosed||!hold.codecJoined||!hold.writerJoined||!hold.taskJoined||!hold.coordinatorJoined)return;
    if(!hold.rawClosed){this.quiesceClosedTls();return;}
    hold.released=true;clearTimeout(hold.timer);this.reserved-=hold.bytes;this.holds.delete(hold);if(this.byEndpoint.get(hold.key)===hold)this.byEndpoint.delete(hold.key);this.limitAccepts();
  }
  listen(value:{host:string;port:number}):Promise<AddressInfo>{
    plain(value,['host','port']);requireCondition(this.accepting&&!this.listenTask&&isIP(value.host)>0&&Number.isSafeInteger(value.port)&&value.port>=0&&value.port<=65535,'NATIVE_TLS_CONFIGURATION',409,'WAIT');const captured={...value};
    this.listenTask=(async()=>{
      await new Promise<void>((resolve,reject)=>{const clean=()=>{this.server.off('listening',done);this.server.off('error',fail);},fail=(error:Error)=>{clean();reject(error);},done=()=>{clean();resolve();};this.server.once('error',fail);this.server.once('listening',done);try{this.server.listen(captured);}catch(error){clean();reject(error);}});
      const address=this.server.address();requireCondition(address&&typeof address!=='string','NATIVE_TLS_UNCONFIRMED',409,'WAIT');return {...address};
    })();return this.listenTask;
  }
  shutdown():Promise<void>{
    if(this.stopping)return this.stopping;this.accepting=false;this.limitAccepts();
    this.stopping=(async()=>{
      this.coordinator.stopClaims();
      await this.listenTask?.catch(()=>{});
      const serverClosed=this.server.listening?new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve())):Promise.resolve();
      for(const hold of this.holds){hold.raw.destroy();hold.tls?.destroy();}
      await Promise.allSettled([...this.holds].flatMap(hold=>hold.task?[hold.task]:[]));await serverClosed;
      const count=await new Promise<number>((resolve,reject)=>this.server.getConnections((error,value)=>error?reject(error):resolve(value)));
      requireCondition(count===0,'NATIVE_TLS_CLOSE_UNCONFIRMED',409,'WAIT');await Promise.all([...this.orphanCloses]);await this.quiescence;await this.coordinator.idle();
      // Missing raw/TLS correlation is held until this owned listener has closed
      // all actual connections, codecs/writers have joined and coordinator I/O
      // has joined. A deadline, rejected race or TERM is insufficient on its own.
      for(const hold of this.holds){hold.rawClosed=true;hold.tlsClosed=true;hold.taskJoined=true;hold.coordinatorJoined=true;this.release(hold);}
      requireCondition(this.holds.size===0&&this.reserved===0,'NATIVE_TLS_CLOSE_UNCONFIRMED',409,'WAIT');
    })();return this.stopping;
  }
}
export function createNativeControllerTlsServer(configuration:NativeControllerTlsServerConfiguration,createCoordinator:NativeControllerTlsCoordinatorFactory):NativeControllerTlsServer{return new NativeControllerTlsServer(configuration,createCoordinator);}

export class NativeControllerTlsClient{
  private readonly bounds:Readonly<NativeControllerTlsBounds>;
  private readonly materials:NativeControllerTlsMaterials;
  private readonly target:Readonly<{host:string;port:number;servername:string;pin:string}>;
  private readonly bytes:number;
  private readonly sockets=new Set<TLSSocket>();
  private readonly pending=new Set<Promise<unknown>>();
  private reserved=0;
  private admitted=0;
  private accepting=true;
  private stopping?:Promise<void>;
  constructor(configuration:NativeControllerTlsClientConfiguration){
    plain(configuration,['materials','serverCertificateSha256','host','port','servername','bounds']);this.bounds=copyBounds(configuration.bounds);this.materials=copyMaterials(configuration.materials,this.bounds);this.bytes=nativeControllerTlsReservationBytes(this.bounds);
    requireCondition(hash.test(configuration.serverCertificateSha256)&&typeof configuration.host==='string'&&configuration.host.length>0&&configuration.host.length<=253&&!/[\u0000-\u0020\u007f]/.test(configuration.host)&&typeof configuration.servername==='string'&&configuration.servername.length>0&&configuration.servername.length<=253&&!/[\u0000-\u0020\u007f]/.test(configuration.servername)&&Number.isSafeInteger(configuration.port)&&configuration.port>0&&configuration.port<=65535,'NATIVE_TLS_CONFIGURATION',409,'WAIT');
    this.target=Object.freeze({host:configuration.host,port:configuration.port,servername:configuration.servername,pin:configuration.serverCertificateSha256});
  }
  usage():NativeControllerTlsUsage{return {connections:this.admitted,reservedBytes:this.reserved,ambiguousConnections:0,accepting:this.accepting};}
  exchange(value:NativeControllerRequest,originalJob?:NativeJob):Promise<NativeControllerResponse>{
    requireCondition(this.accepting&&this.admitted<this.bounds.maxConnections&&this.reserved+this.bytes<=this.bounds.maxInFlightBytes,'NATIVE_TLS_CAPACITY_WAIT',409,'WAIT');
    this.reserved+=this.bytes;this.admitted++;const began=performance.now(),deadline=began+this.bounds.deadlineMilliseconds;let socket:TLSSocket,request:NativeControllerRequest,original:NativeJob|undefined;
    // All caller-owned request/configuration buffers are captured synchronously,
    // after reservation but before the first connection/await/write callback.
    try{
      request=copyRequest(value,this.bounds.wire);
      if(originalJob){nativeJsonBytes(originalJob,this.bounds.wire.input.maxMetadataBytes);validateNativeEnvelope(originalJob,this.bounds.wire.input);verifyNativeInput(originalJob);
        requireCondition(originalJob.jobId===request.control.binding.jobId&&originalJob.inputDigest===request.control.binding.inputDigest&&originalJob.profileDigest===request.control.binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');original=structuredClone(originalJob);}
      // Node 24.11.1 documents these public TLS connect options; the installed
      // ConnectionOptions declaration omits allowHalfOpen. Keep the actual option.
      const options:tls.ConnectionOptions&{allowHalfOpen:true;highWaterMark:number}={host:this.target.host,port:this.target.port,servername:this.target.servername,ca:this.materials.ca,cert:this.materials.certificate,key:this.materials.privateKey,
        rejectUnauthorized:true,allowHalfOpen:true,highWaterMark:this.bounds.streamHighWaterMarkBytes,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',secureOptions:constants.SSL_OP_NO_TICKET};
      beforeDeadline(deadline);socket=tls.connect(options);
    }catch(error){this.reserved-=this.bytes;this.admitted--;throw error;}
    this.sockets.add(socket);socket.on('error',()=>{});socket.disableRenegotiation();const closed=closePromise(socket);
    let failure:Error|undefined;const timer=setTimeout(()=>{failure=wait('NATIVE_TLS_DEADLINE');socket.destroy(failure);},Math.max(1,this.bounds.deadlineMilliseconds-(performance.now()-began)));
    const operation=(async()=>{
      const io:Promise<unknown>[]=[];
      try{
        await new Promise<void>((resolve,reject)=>{const clean=()=>{socket.off('error',fail);socket.off('close',lost);socket.off('secureConnect',secure);},fail=(error:Error)=>{clean();reject(error);},lost=()=>fail(failure??wait('NATIVE_TLS_PEER_UNCONFIRMED')),secure=()=>{try{beforeDeadline(deadline);requireCondition(certificatePin(socket)===this.target.pin,'NATIVE_TLS_PEER_UNCONFIRMED',409,'WAIT');clean();resolve();}catch(error){fail(error instanceof Error?error:wait('NATIVE_TLS_PEER_UNCONFIRMED'));}};socket.once('error',fail);socket.once('close',lost);socket.once('secureConnect',secure);});
        // Default CA and hostname verification remain enabled. secureConnect,
        // write/finish/close alone are never a PREPARE/GO business ACK.
        beforeDeadline(deadline);const write=(async()=>{await writeNativeControllerRequest(socket,request,this.bounds.wire);beforeDeadline(deadline);await endWrites(socket);})();
        const source=boundedSource(socket,wireMaximum(this.bounds.wire,'output'),deadline);
        const read=(async()=>{try{return await readNativeControllerResponse(source,this.bounds.wire,request.control,original);}finally{await source.return(undefined);}})();
        io.push(write,read);const [,response]=await Promise.all([write,read]);beforeDeadline(deadline);return response;
      }catch(error){throw failure??(error instanceof DomainError?error:wait(errorCode(error)));}
      finally{socket.destroy();await Promise.allSettled(io);await closed;clearTimeout(timer);this.sockets.delete(socket);this.reserved-=this.bytes;this.admitted--;}
    })();this.pending.add(operation);void operation.finally(()=>this.pending.delete(operation)).catch(()=>{});return operation;
  }
  shutdown():Promise<void>{if(this.stopping)return this.stopping;this.accepting=false;for(const socket of this.sockets)socket.destroy(wait('NATIVE_SHUTDOWN_WAIT'));this.stopping=(async()=>{await Promise.allSettled([...this.pending]);requireCondition(!this.sockets.size&&this.reserved===0&&this.admitted===0,'NATIVE_TLS_CLOSE_UNCONFIRMED',409,'WAIT');})();return this.stopping;}
}
