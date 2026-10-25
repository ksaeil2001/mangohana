import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import net,{type Socket} from 'node:net';
import tls,{type TLSSocket} from 'node:tls';
import {PassThrough} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {createNativeJob,createNativeResult,type NativeJob} from '../../packages/native/src/dto.js';
import type {NativeControllerPeerVerifier} from '../../packages/native/src/controller-attempts.js';
import {writeNativeControllerRequest,readNativeControllerResponse,type NativeControllerRequest,type NativeControllerResponse,
  type NativeControllerSnapshot,type NativeControllerRequestControl} from '../../packages/native/src/controller-protocol.js';
import {createNativeControllerTlsServer,NativeControllerTlsClient,nativeControllerTlsReservationBytes,
  type NativeControllerTlsBounds,type NativeControllerTlsCoordinator,type NativeControllerTlsMaterials} from '../../packages/native/src/controller-tls.js';

const hostname='server.native-controller.test.invalid';
const wire={maxControlBytes:4096,input:{maxMetadataBytes:8192,maxBinaryBytes:4096,maxItems:4},output:{maxMetadataBytes:8192,maxBinaryBytes:1024*1024,maxItems:4}};
const cleanups:(()=>Promise<void>)[]=[],releaseGates:(()=>void)[]=[];
function deferred(){let resolve:()=>void=()=>{};const promise=new Promise<void>(yes=>{resolve=yes;});releaseGates.push(resolve);return {promise,resolve};}
async function eventually(predicate:()=>boolean,maximum=4000){const began=performance.now();while(!predicate()){expect(performance.now()-began).toBeLessThan(maximum);await new Promise(resolve=>setTimeout(resolve,10));}}
function pem(name:string){return readFileSync(new URL(`../fixtures/native-controller-tls-certs/${name}.pem`,import.meta.url));}
function materials(identity:'server'|'api'|'worker'|'unregistered'|'foreign-client'):NativeControllerTlsMaterials{return {ca:pem('owned-ca-cert'),certificate:pem(`${identity}-cert`),privateKey:pem(`${identity}-key`)};}
function pin(identity:'server'|'api'|'worker'|'unregistered'|'foreign-client'){return sha256(new X509Certificate(pem(`${identity}-cert`)).raw);}
function bounds(changes:Partial<NativeControllerTlsBounds>={}):NativeControllerTlsBounds{return {wire:structuredClone(wire),deadlineMilliseconds:2500,maxConnections:4,maxInFlightBytes:64*1024*1024,streamHighWaterMarkBytes:1024,transportAllowanceBytes:256*1024,maxTlsMaterialBytes:64*1024,maxPinnedPeers:4,...changes};}
function specimen(source=Buffer.from([1,2,3,4]),inputLimits=wire.input){
  const blobs=new Map([['source',source]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'source'}]},blobs,inputLimits);
  const binding={accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:sha256('owned-tls-kernel')};
  const control:NativeControllerRequestControl={version:1,requestId:randomUUID(),binding,command:'PREPARE'};
  return {job,blobs,request:{control,input:{envelope:job,blobs}} as NativeControllerRequest};
}
function query(request:NativeControllerRequest,includeRawResult=false):NativeControllerRequest{return {control:{version:1,requestId:randomUUID(),command:'QUERY',binding:structuredClone(request.control.binding),includeRawResult}};}
function go(request:NativeControllerRequest,snapshot:NativeControllerSnapshot):NativeControllerRequest{return {control:{version:1,requestId:randomUUID(),command:'GO',binding:structuredClone(request.control.binding),attemptId:snapshot.attemptId,controllerInstanceId:snapshot.controllerInstanceId}};}
async function encoded(request:NativeControllerRequest){const stream=new PassThrough(),parts:Buffer[]=[];const read=(async()=>{for await(const part of stream)parts.push(part as Buffer);})();await writeNativeControllerRequest(stream,request,wire);stream.end();await read;return Buffer.concat(parts);}

// This coordinator owns explicit synthetic bindings and state only. There is no
// PostgreSQL connection, child, provider, application approval or release proof.
function coordinatorFixture(peers:NativeControllerPeerVerifier){
  type Original={job:NativeJob;snapshot:NativeControllerSnapshot;bindingDigest:string;serviceRole:string};
  const originals=new Map<string,Original>(),seen:{role:string;request:NativeControllerRequest}[]=[];
  let beforeReply:(()=>Promise<void>)|undefined,idleGate:Promise<void>|undefined,rawBytes:Buffer|undefined;
  const claim=vi.fn(),physicalGo=vi.fn(),load=vi.fn(),stopClaims=vi.fn(),idle=vi.fn(async()=>{await idleGate;});
  const serve=vi.fn(async(transport:unknown,request:NativeControllerRequest,reply:(response:NativeControllerResponse)=>Promise<void>)=>{
    const peer=await peers.authenticate(transport),control=request.control,key=control.binding.capacityReservationId;seen.push({role:peer.serviceRole,request:structuredClone(request)});
    let original=originals.get(key);
    if(control.command==='PREPARE'){
      claim();if(!original){expect(request.input).toBeDefined();original={job:structuredClone(request.input!.envelope),snapshot:{attemptId:randomUUID(),controllerInstanceId:randomUUID(),phase:'READY',rawResult:null,termination:null,code:'OK'},bindingDigest:digest(control.binding),serviceRole:peer.serviceRole};originals.set(key,original);}
    }else load();
    if(!original||original.bindingDigest!==digest(control.binding)||original.serviceRole!==peer.serviceRole)throw new DomainError('OWNED_TLS_ORIGINAL_CALLER_MISMATCH',409,'WAIT');
    if(control.command==='GO'){
      if(control.attemptId!==original.snapshot.attemptId||control.controllerInstanceId!==original.snapshot.controllerInstanceId)throw new DomainError('OWNED_TLS_ORIGINAL_ATTEMPT_MISMATCH',409,'WAIT');
      if(original.snapshot.phase!=='GO_GRANTED'){physicalGo();original.snapshot.phase='GO_GRANTED';}
    }
    const response:NativeControllerResponse={control:{version:1,requestId:control.requestId,command:control.command,binding:structuredClone(control.binding),snapshot:structuredClone(original.snapshot)}};
    if(control.command==='QUERY'&&control.includeRawResult&&rawBytes){
      const raw=createNativeResult(original.job,{metadata:{archiveBlobId:'archive',byteLength:rawBytes.length},blobs:new Map([['archive',rawBytes]])},wire.output);
      response.control.snapshot.rawResult={rawResultId:randomUUID(),resultDigest:digest(raw)};response.rawResult={envelope:raw,blobs:new Map([['archive',rawBytes]])};
    }
    await beforeReply?.();await reply(response);return response.control;
  });
  const coordinator:NativeControllerTlsCoordinator={serve,stopClaims,idle};
  return {coordinator,serve,claim,physicalGo,load,stopClaims,idle,seen,originals,setBeforeReply:(hook:()=>Promise<void>)=>{beforeReply=hook;},setIdleGate:(gate:Promise<void>)=>{idleGate=gate;},setRaw:(bytes:Buffer)=>{rawBytes=bytes;}};
}
async function setup(serverBounds=bounds()){
  let state:ReturnType<typeof coordinatorFixture>|undefined;
  const pins=[{certificateSha256:pin('api'),serviceRole:'trio_web_api' as const,peerId:randomUUID()},{certificateSha256:pin('worker'),serviceRole:'trio_web_worker' as const,peerId:randomUUID()}];
  const sourceMaterials=materials('server'),factory=vi.fn((verifier:NativeControllerPeerVerifier)=>{state=coordinatorFixture(verifier);return state.coordinator;});
  const server=createNativeControllerTlsServer({materials:sourceMaterials,pinnedPeers:pins,bounds:serverBounds},factory);cleanups.push(()=>server.shutdown());
  expect(factory).toHaveBeenCalledTimes(1);const address=await server.listen({host:'127.0.0.1',port:0});
  const client=(identity:'api'|'worker'|'unregistered'|'foreign-client'='api',changes:{servername?:string;serverCertificateSha256?:string;bounds?:NativeControllerTlsBounds}={})=>{
    const credentials=materials(identity),configuration={materials:credentials,serverCertificateSha256:pin('server'),host:'127.0.0.1',port:address.port,servername:hostname,bounds:bounds(),...changes};
    const value=new NativeControllerTlsClient(configuration);cleanups.push(()=>value.shutdown());return {value,configuration};
  };
  return {server,address,client,factory,state:state!,pins,sourceMaterials,serverBounds};
}
function ownedSocket(socket:Socket){socket.on('error',()=>{});cleanups.push(async()=>{if(!socket.closed){const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.destroy();await closed;}});return socket;}
function ownedTls(options:tls.ConnectionOptions&{allowHalfOpen:true}){return ownedSocket(tls.connect(options)) as TLSSocket;}
async function directTls(port:number,identity:'api'|'worker'|'unregistered'|'foreign-client'|null='api',session?:Buffer):Promise<TLSSocket>{
  const credentials=identity?materials(identity):undefined;
  const socket=ownedTls({host:'127.0.0.1',port,servername:hostname,ca:pem('owned-ca-cert'),cert:credentials?.certificate,key:credentials?.privateKey,allowHalfOpen:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',session});
  await new Promise<void>((resolve,reject)=>{socket.once('secureConnect',()=>{expect(socket.authorized).toBe(true);resolve();});socket.once('error',reject);});return socket;
}
afterEach(async()=>{for(const release of releaseGates.splice(0))release();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

describe('owned native controller mutual TLS and parent transport lifetime',{timeout:20_000},()=>{
  it('uses request and response half EOF with one original PREPARE and one GO; successful writes alone are not ACKs',async()=>{
    const f=await setup(),client=f.client().value,sample=specimen(),ready=await client.exchange(sample.request);
    expect(ready.control.snapshot.phase).toBe('READY');expect(f.state.seen[0].role).toBe('trio_web_api');expect(f.state.seen[0].request.input?.blobs).toEqual(structuredClone(sample.blobs));
    const first=await client.exchange(go(sample.request,ready.control.snapshot));expect(first.control.snapshot.phase).toBe('GO_GRANTED');
    expect((await client.exchange(go(sample.request,ready.control.snapshot))).control.snapshot).toEqual(first.control.snapshot);
    expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).toHaveBeenCalledTimes(1);
    expect((await client.exchange(query(sample.request))).control.snapshot).toEqual(first.control.snapshot);expect(client.usage()).toMatchObject({connections:0,reservedBytes:0});
  });

  it.each(['unregistered','foreign-client'] as const)('rejects %s client certificate before coordinator or original claim/GO',async identity=>{
    const f=await setup(),sample=specimen();await expect(f.client(identity).value.exchange(sample.request)).rejects.toBeInstanceOf(DomainError);
    expect(f.state.serve).not.toHaveBeenCalled();expect(f.state.claim).not.toHaveBeenCalled();expect(f.state.physicalGo).not.toHaveBeenCalled();
    // Same CN, CA, TCP host and port confer no peer authority. Unregistered DER
    // pins fail despite a valid chain; the foreign chain fails mTLS itself.
    expect(new X509Certificate(pem('api-cert')).subject).toBe(new X509Certificate(pem('unregistered-cert')).subject);
  });

  it('rejects a client with no certificate and cannot reuse an owned session as missing-certificate identity',async()=>{
    const f=await setup(),sample=specimen(),first=await directTls(f.address.port),session=first.getSession();first.end(await encoded(sample.request));
    await readNativeControllerResponse(first,wire,sample.request.control);first.destroy();await eventually(()=>first.closed);
    expect(f.state.claim).toHaveBeenCalledTimes(1);const before=f.state.serve.mock.calls.length;
    const missing=ownedTls({host:'127.0.0.1',port:f.address.port,servername:hostname,ca:pem('owned-ca-cert'),allowHalfOpen:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',session});
    // An invalid half-open peer still owns its unfinished writable side. Read
    // the rejection EOF, then close that side and observe the actual close.
    missing.once('end',()=>missing.destroy());missing.resume();
    await eventually(()=>missing.closed);expect(f.state.serve).toHaveBeenCalledTimes(before);expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).not.toHaveBeenCalled();
  });

  it.each(['HOSTNAME','SERVER_PIN'] as const)('keeps default server CA/hostname verification and refuses %s before sending a controller command',async changed=>{
    const f=await setup(),client=f.client('api',changed==='HOSTNAME'?{servername:'wrong.native-controller.test.invalid'}:{serverCertificateSha256:sha256('owned-wrong-server-pin')}).value;
    await expect(client.exchange(specimen().request)).rejects.toBeInstanceOf(DomainError);expect(f.state.serve).not.toHaveBeenCalled();expect(f.state.claim).not.toHaveBeenCalled();expect(f.state.physicalGo).not.toHaveBeenCalled();expect(client.usage().reservedBytes).toBe(0);
  });

  it('copies materials pins bounds control binding job metadata Maps and buffers before the first await',async()=>{
    const f=await setup(),created=f.client(),sample=specimen(),expected=structuredClone(sample.request),exchange=created.value.exchange(sample.request);
    f.sourceMaterials.ca.fill(0);f.sourceMaterials.certificate.fill(0);f.sourceMaterials.privateKey.fill(0);f.pins[0].serviceRole='trio_web_worker';f.pins[0].peerId=randomUUID();f.serverBounds.deadlineMilliseconds=1;
    created.configuration.materials.ca.fill(0);created.configuration.materials.certificate.fill(0);created.configuration.materials.privateKey.fill(0);created.configuration.servername='wrong.invalid';created.configuration.serverCertificateSha256=sha256('changed');created.configuration.bounds.deadlineMilliseconds=1;
    sample.request.control.binding.accountId=randomUUID();sample.job.metadata.entries=[];sample.blobs.get('source')!.fill(9);sample.blobs.clear();
    const response=await exchange;expect(response.control.binding).toEqual(expected.control.binding);expect(f.state.seen[0]).toEqual({role:'trio_web_api',request:expected});expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it('authenticates the actual worker socket but still rejects a changed original caller and crossed durable binding',async()=>{
    const f=await setup(),api=f.client().value,worker=f.client('worker').value,sample=specimen();await api.exchange(sample.request);
    await expect(worker.exchange(query(sample.request))).rejects.toBeInstanceOf(DomainError);
    const crossed=query(sample.request);crossed.control.binding.parentInstanceId=randomUUID();await expect(api.exchange(crossed)).rejects.toBeInstanceOf(DomainError);
    expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).not.toHaveBeenCalled();expect(f.state.seen.map(entry=>entry.role)).toEqual(['trio_web_api','trio_web_worker','trio_web_api']);
  });

  it('reserves full frames at the first TCP connection and absolute deadline closes an incomplete TLS handshake',async()=>{
    const b=bounds({deadlineMilliseconds:250,maxConnections:1});b.maxInFlightBytes=nativeControllerTlsReservationBytes(b);const f=await setup(b),raw=ownedSocket(net.connect({host:'127.0.0.1',port:f.address.port}));
    await eventually(()=>f.server.usage().connections===1);expect(f.server.usage().reservedBytes).toBe(nativeControllerTlsReservationBytes(b));expect(f.state.serve).not.toHaveBeenCalled();
    const refused=ownedSocket(net.connect({host:'127.0.0.1',port:f.address.port}));await eventually(()=>refused.closed);expect(f.server.usage().reservedBytes).toBe(nativeControllerTlsReservationBytes(b));
    await eventually(()=>raw.closed);expect(f.state.serve).not.toHaveBeenCalled();await f.server.shutdown();expect(f.server.usage()).toEqual({connections:0,reservedBytes:0,ambiguousConnections:0,accepting:false});
  });

  it('keeps a public raw/TLS close correlation gap held until owned listener shutdown proves all connections closed',async()=>{
    const f=await setup(bounds({deadlineMilliseconds:250})),raw=ownedSocket(net.connect({host:'127.0.0.1',port:f.address.port}));await eventually(()=>f.server.usage().connections===1);raw.destroy();await eventually(()=>raw.closed);
    await new Promise(resolve=>setTimeout(resolve,300));
    const ambiguous=f.server.lifetimes().filter(lifetime=>!lifetime.tlsObserved);
    console.info(JSON.stringify({ownedTlsTrace:'pre_handshake_close_correlation',ambiguousObserved:ambiguous.length>0,rawCloseObserved:ambiguous.every(lifetime=>lifetime.tcpClosed)}));
    if(ambiguous.length){expect(f.server.usage().reservedBytes).toBeGreaterThan(0);expect(ambiguous.every(lifetime=>!lifetime.tlsClosed&&lifetime.codecJoined&&lifetime.writerJoined&&lifetime.serveJoined)).toBe(true);}
    else expect(f.server.lifetimes().every(lifetime=>lifetime.tlsClosed&&lifetime.codecJoined&&lifetime.writerJoined&&lifetime.serveJoined)).toBe(true);
    expect(f.state.serve).not.toHaveBeenCalled();await f.server.shutdown();expect(f.server.lifetimes()).toEqual([]);expect(f.server.usage().reservedBytes).toBe(0);
  });

  it('reserves overlapping client send/read buffers before connect and refuses a second request until real close and I/O join',async()=>{
    const f=await setup(),gate=deferred();f.state.setBeforeReply(()=>gate.promise);const b=bounds({maxConnections:1});b.maxInFlightBytes=nativeControllerTlsReservationBytes(b);
    const client=f.client('api',{bounds:b}).value,sample=specimen(),operation=client.exchange(sample.request),rejected=expect(operation).rejects.toBeInstanceOf(DomainError);
    await eventually(()=>f.state.claim.mock.calls.length===1);expect(client.usage()).toMatchObject({connections:1,reservedBytes:nativeControllerTlsReservationBytes(b)});
    const copied=vi.spyOn(Buffer,'from'),cloned=vi.spyOn(globalThis,'structuredClone');
    try{expect(()=>client.exchange(sample.request)).toThrow('NATIVE_TLS_CAPACITY_WAIT');expect(copied).not.toHaveBeenCalled();expect(cloned).not.toHaveBeenCalled();}
    finally{copied.mockRestore();cloned.mockRestore();}expect(f.state.serve).toHaveBeenCalledTimes(1);
    await client.shutdown();await rejected;expect(client.usage()).toMatchObject({connections:0,reservedBytes:0,accepting:false});expect(f.server.usage().reservedBytes).toBeGreaterThan(0);gate.resolve();
  });

  it.each(['ENVELOPE_LIMIT','ACTUAL_LIMIT','ACTUAL_DIGEST'] as const)('validates %s before copying binary input or connecting and returns failed client admission',async condition=>{
    const f=await setup(),client=f.client().value,large=Buffer.alloc(wire.input.maxBinaryBytes+1,7),sample=condition==='ENVELOPE_LIMIT'?specimen(large,{...wire.input,maxBinaryBytes:large.length}):specimen();
    if(condition==='ACTUAL_LIMIT')sample.blobs.set('source',large);else if(condition==='ACTUAL_DIGEST')sample.blobs.get('source')!.fill(9);
    const binary=sample.blobs.get('source'),copied=vi.spyOn(Buffer,'from'),connect=vi.spyOn(tls,'connect');
    try{
      expect(()=>client.exchange(sample.request)).toThrow(condition==='ACTUAL_DIGEST'?'NATIVE_BINARY_MISMATCH':'NATIVE_BINARY_LIMIT');
      expect(copied.mock.calls.some(call=>call[0]===binary)).toBe(false);expect(connect).not.toHaveBeenCalled();expect(client.usage()).toMatchObject({connections:0,reservedBytes:0});
    }finally{copied.mockRestore();connect.mockRestore();}
    expect(f.state.serve).not.toHaveBeenCalled();expect((await client.exchange(specimen().request)).control.snapshot.phase).toBe('READY');expect(f.state.claim).toHaveBeenCalledTimes(1);
  });

  it.each(['CAPTURE','CONNECT'] as const)('returns a client admission after a synchronous %s failure and permits the next owned request',async boundary=>{
    const f=await setup(),client=f.client().value,sample=specimen(),failure=()=>{throw new Error('OWNED_TLS_SYNCHRONOUS_FAILURE');};
    const method=boundary==='CAPTURE'?vi.spyOn(globalThis,'structuredClone').mockImplementationOnce(failure):vi.spyOn(tls,'connect').mockImplementationOnce(failure);
    try{expect(()=>client.exchange(sample.request)).toThrow('OWNED_TLS_SYNCHRONOUS_FAILURE');expect(client.usage()).toMatchObject({connections:0,reservedBytes:0});}
    finally{method.mockRestore();}expect(f.state.serve).not.toHaveBeenCalled();expect((await client.exchange(sample.request)).control.snapshot.phase).toBe('READY');
  });

  it('releases each observed TLS transport through public connection quiescence so READY can be followed by GO with one slot while native work remains owned',async()=>{
    const b=bounds({maxConnections:1});b.maxInFlightBytes=nativeControllerTlsReservationBytes(b);const f=await setup(b),idle=deferred();f.state.setIdleGate(idle.promise);
    const client=f.client().value,sample=specimen(),ready=await client.exchange(sample.request);
    await eventually(()=>f.server.usage().connections===0);expect(f.server.usage().reservedBytes).toBe(0);expect(f.state.idle).not.toHaveBeenCalled();
    const granted=await client.exchange(go(sample.request,ready.control.snapshot));expect(granted.control.snapshot.phase).toBe('GO_GRANTED');
    for(let index=0;index<3;index++){await eventually(()=>f.server.usage().connections===0);expect((await client.exchange(query(sample.request))).control.snapshot).toEqual(granted.control.snapshot);}
    await eventually(()=>f.server.usage().connections===0);expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).toHaveBeenCalledTimes(1);expect(f.state.idle).not.toHaveBeenCalled();
    let joined=false;const shutdown=f.server.shutdown().then(()=>{joined=true;});await eventually(()=>f.state.idle.mock.calls.length===1);expect(joined).toBe(false);expect(f.server.usage().reservedBytes).toBe(0);
    idle.resolve();await shutdown;expect(f.server.usage()).toMatchObject({connections:0,reservedBytes:0,accepting:false});
  });

  it.each(['SLOW_FRAME','NO_EOF','TRAILING','SECOND_FRAME'] as const)('requires one complete request EOF and closes %s without coordinator work',async condition=>{
    const f=await setup(bounds({deadlineMilliseconds:350})),socket=await directTls(f.address.port),bytes=await encoded(specimen().request);
    socket.once('end',()=>socket.destroy());socket.resume();
    if(condition==='SLOW_FRAME'){socket.write(bytes.subarray(0,1));await new Promise(resolve=>setTimeout(resolve,180));socket.write(bytes.subarray(1,2));}
    else if(condition==='NO_EOF')socket.write(bytes);
    else socket.end(condition==='TRAILING'?Buffer.concat([bytes,Buffer.from([1])]):Buffer.concat([bytes,bytes]));
    await eventually(()=>socket.closed);expect(f.state.serve).not.toHaveBeenCalled();expect(f.state.claim).not.toHaveBeenCalled();expect(f.state.physicalGo).not.toHaveBeenCalled();
    await f.server.shutdown();expect(f.server.usage().reservedBytes).toBe(0);
  });

  it('blocks wire-supplied peer roles and approvals before coordinator/DB and disallows renegotiation identity changes',async()=>{
    const f=await setup(bounds({deadlineMilliseconds:350})),socket=await directTls(f.address.port),request=specimen().request;
    const control=Buffer.from(JSON.stringify({...request.control,serviceRole:'trio_web_api',approved:true})),prefix=Buffer.alloc(12);prefix.write('TMCTRV1\0');prefix.writeUInt32BE(control.length,8);socket.end(Buffer.concat([prefix,control]));
    await eventually(()=>socket.closed);expect(f.state.serve).not.toHaveBeenCalled();
    const renegotiating=await directTls(f.address.port);await new Promise<void>(resolve=>renegotiating.renegotiate({requestCert:true},error=>{expect(error).toBeInstanceOf(Error);resolve();}));
    renegotiating.destroy();await eventually(()=>renegotiating.closed);expect(f.state.claim).not.toHaveBeenCalled();
  });

  it('keeps the transport reservation when the response is not read until absolute close and writer/coordinator join',async()=>{
    const f=await setup(bounds({deadlineMilliseconds:500})),sample=specimen(),client=f.client().value;await client.exchange(sample.request);f.state.setRaw(Buffer.alloc(1024*1024,7));
    const beforeWrite=deferred();f.state.setBeforeReply(()=>beforeWrite.promise);
    const socket=await directTls(f.address.port);socket.pause();socket.end(await encoded(query(sample.request,true)));
    await eventually(()=>f.state.serve.mock.calls.length===2);expect(f.server.usage().reservedBytes).toBeGreaterThan(0);
    expect(f.server.lifetimes().some(lifetime=>!lifetime.serveJoined)).toBe(true);beforeWrite.resolve();
    // A paused remote reader need not emit close while encrypted data remains
    // queued. Observe the owned server's physical close/I/O join first.
    await eventually(()=>f.server.usage().reservedBytes===0||f.server.lifetimes().every(lifetime=>lifetime.tlsObserved&&lifetime.tlsClosed&&lifetime.writerJoined&&lifetime.serveJoined),2000);
    socket.resume();await eventually(()=>socket.closed);await f.server.shutdown();expect(f.server.usage().reservedBytes).toBe(0);expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).not.toHaveBeenCalled();
  });

  it('ACK loss performs no automatic PREPARE/GO retry; a new client can recover only through explicit QUERY',async()=>{
    const f=await setup(),sample=specimen(),gate=deferred();f.state.setBeforeReply(()=>gate.promise);
    const client=f.client('api',{bounds:bounds({deadlineMilliseconds:250})}).value,lost=client.exchange(sample.request);await eventually(()=>f.state.claim.mock.calls.length===1);
    await expect(lost).rejects.toMatchObject({code:'NATIVE_TLS_DEADLINE'});expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).not.toHaveBeenCalled();expect(f.server.usage().reservedBytes).toBeGreaterThan(0);
    gate.resolve();f.state.setBeforeReply(async()=>{});const recovered=await f.client().value.exchange(query(sample.request));expect(recovered.control.snapshot.phase).toBe('READY');expect(f.state.claim).toHaveBeenCalledTimes(1);expect(f.state.load).toHaveBeenCalledTimes(1);expect(f.state.physicalGo).not.toHaveBeenCalled();
  });

  it('shutdown joins incomplete handshakes and actual listener sockets before it waits for independently owned native coordinator work',async()=>{
    const f=await setup(),sample=specimen(),idle=deferred();f.state.setIdleGate(idle.promise);await f.client().value.exchange(sample.request);
    await eventually(()=>f.server.usage().connections===0);expect(f.state.idle).not.toHaveBeenCalled();
    const raw=ownedSocket(net.connect({host:'127.0.0.1',port:f.address.port}));await eventually(()=>f.server.usage().connections===1);expect(f.server.usage().reservedBytes).toBeGreaterThan(0);
    let joined=false;const shutdown=f.server.shutdown().then(()=>{joined=true;});await eventually(()=>raw.closed);await eventually(()=>f.state.idle.mock.calls.length===1);
    expect(joined).toBe(false);expect(f.state.stopClaims).toHaveBeenCalledTimes(1);expect(f.server.usage().accepting).toBe(false);expect(f.state.serve).toHaveBeenCalledTimes(1);
    if(f.server.lifetimes().some(lifetime=>!lifetime.tlsObserved))expect(f.server.usage().reservedBytes).toBeGreaterThan(0);
    expect(f.server.lifetimes().every(lifetime=>lifetime.codecJoined&&lifetime.writerJoined&&lifetime.serveJoined)).toBe(true);
    idle.resolve();await shutdown;expect(f.server.usage()).toEqual({connections:0,reservedBytes:0,ambiguousConnections:0,accepting:false});
  });

  it('shutdown joins an already requested listener start and leaves no active listener or transport reservation',async()=>{
    const factory=vi.fn((peers:NativeControllerPeerVerifier)=>coordinatorFixture(peers).coordinator),server=createNativeControllerTlsServer({materials:materials('server'),pinnedPeers:[{certificateSha256:pin('api'),serviceRole:'trio_web_api',peerId:randomUUID()}],bounds:bounds()},factory);cleanups.push(()=>server.shutdown());
    const listening=server.listen({host:'127.0.0.1',port:0}),shutdown=server.shutdown();await listening;await shutdown;
    expect(server.usage()).toEqual({connections:0,reservedBytes:0,ambiguousConnections:0,accepting:false});expect(factory).toHaveBeenCalledTimes(1);
    expect(()=>server.listen({host:'127.0.0.1',port:0})).toThrow('NATIVE_TLS_CONFIGURATION');
  });

  it('shutdown does not free a pending coordinator reply through socket destruction and client waits for real outbound/read close join',async()=>{
    const f=await setup(),gate=deferred();f.state.setBeforeReply(()=>gate.promise);const client=f.client().value,operation=client.exchange(specimen().request);await eventually(()=>f.state.claim.mock.calls.length===1);
    const rejection=expect(operation).rejects.toBeInstanceOf(DomainError);let joined=false;const stopping=f.server.shutdown().then(()=>{joined=true;});await eventually(()=>client.usage().connections===0);await rejection;
    expect(joined).toBe(false);expect(f.server.usage().reservedBytes).toBeGreaterThan(0);gate.resolve();await stopping;expect(f.server.usage().reservedBytes).toBe(0);expect(client.usage().reservedBytes).toBe(0);
  });

  it('does not infer whole memory capacity from highWaterMark and closes malformed bounds before invoking the coordinator factory',()=>{
    const factory=vi.fn(()=>({serve:vi.fn(),stopClaims:vi.fn(),idle:vi.fn()})),configuration={materials:materials('server'),pinnedPeers:[{certificateSha256:pin('api'),serviceRole:'trio_web_api' as const,peerId:randomUUID()}],bounds:bounds({transportAllowanceBytes:1})};
    expect(()=>createNativeControllerTlsServer(configuration,factory)).toThrow('NATIVE_TLS_CONFIGURATION');expect(factory).not.toHaveBeenCalled();
    const b=bounds();expect(nativeControllerTlsReservationBytes(b)).toBeGreaterThan(b.wire.input.maxBinaryBytes+b.wire.output.maxBinaryBytes+b.streamHighWaterMarkBytes);
  });
});
