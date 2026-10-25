import {describe,it,expect,vi} from 'vitest';
import {Writable} from 'node:stream';
import {createNativeControllerMemory,type NativeOriginalAttemptV2} from '../../packages/native/src/controller-attempts.js';
import {createWindowsOriginalController,type WindowsOriginalController,type WindowsControllerJournalPort} from '../../packages/native/src/controller.js';
import {writeNativeControllerRequest,type NativeControllerRequestV2} from '../../packages/native/src/controller-protocol.js';
import {randomUUID} from 'node:crypto';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {createNativeJob,createNativeResult,NativeJobError,type NativeJob,type NativeRunHooks,type NativeComputation,type NativeJobEvidence,type NativeTermination} from '../../packages/native/src/dto.js';
import {NativeControllerAttempts,type NativeCapturedAttemptRunner,type NativeOriginalAttempt,type NativeControllerAttemptStore,type NativeControllerPeer,type NativeControllerRawStore,type NativeRawAllocation} from '../../packages/native/src/controller-attempts.js';
import type {NativeControllerBinding,NativeControllerRequest,NativeControllerResponse} from '../../packages/native/src/controller-protocol.js';

const frameLimits={maxMetadataBytes:4096,maxBinaryBytes:1024,maxItems:4};
const reply=async()=>{};
// This runner simulates lifecycle facts for state-machine tests. It creates no
// process, host proof, network listener, provider result or capacity release.
class FakeRunner implements NativeCapturedAttemptRunner{
  parentInstanceId=randomUUID();profileDigest=digest(syntheticProfile);kernelImplementationDigest=sha256('fake-controller-kernel');attempts=0;computations=0;
  active=new Set<Promise<NativeComputation>>();
  frameLimits(){return frameLimits;}
  runCaptured(job:NativeJob,blobs:Map<string,Buffer>,hooks:NativeRunHooks):Promise<NativeComputation>{
    this.attempts++;let go=false;const operation=(async()=>{
      const termination=():NativeTermination=>({jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:go,startedComputation:go,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'});
      const evidence=(code:string):NativeJobEvidence=>({version:1,jobId:job.jobId,task:job.task,inputDigest:job.inputDigest,profileDigest:job.profileDigest,isolation:'OWNED_FIXTURE',state:code==='OK'?'SUCCEEDED':'FAILED',code,goAttempted:go,startedComputation:go,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,elapsedMs:0,inputBytes:[...blobs.values()].reduce((sum,item)=>sum+item.length,0),outputBytes:16});
      let code='OK';try{await hooks.intent(job);await hooks.consumeGo(job);go=true;this.computations++;const result={metadata:{rawBlobId:'raw'},blobs:new Map([['raw',Buffer.from('simulated result')]])},frame=createNativeResult(job,result,frameLimits);await hooks.rawResult?.(job,frame,result.blobs);await hooks.observation(job,evidence(code),termination(),frame);return result;}
      catch(error){code=error instanceof DomainError?error.code:'NATIVE_CONTROL_UNCONFIRMED';await hooks.observation(job,evidence(code),termination(),null);throw new NativeJobError(code,409,'WAIT',termination());}
      finally{await hooks.termination(job,evidence(code),termination());}
    })();this.active.add(operation);void operation.finally(()=>this.active.delete(operation)).catch(()=>{});return operation;
  }
  stopClaims(){}
  async idle(){while(this.active.size)await Promise.allSettled([...this.active]);}
  async reconcileTerminations(){}
}
function fixture(options:{goWaitMilliseconds?:number;maxInFlightBytes?:number}={}){
  const runner=new FakeRunner(),blobs=new Map([['entry',Buffer.from([1,2,3,4])]]),job=createNativeJob('ZIP_WRITE',runner.profileDigest,{profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'entry'}]},blobs,frameLimits);
  const binding={accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:runner.kernelImplementationDigest};
  const peer:NativeControllerPeer={serviceRole:'trio_web_api',peerId:randomUUID()},channel=Symbol('owned authenticated channel'),otherChannel=Symbol('second owned channel');let saved:NativeOriginalAttempt|undefined,claimAckLost=false,goAckLost=false,putAckLost=false,claimCount=0,goCount=0,putCount=0,allocated:NativeRawAllocation|undefined,stored:Map<string,Buffer>|undefined;
  const authorize=(who:NativeControllerPeer,lookup:NativeControllerBinding)=>{if(who.serviceRole!==peer.serviceRole||who.peerId!==peer.peerId||digest(lookup)!==digest(binding))throw new DomainError('NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');};
  const store:NativeControllerAttemptStore={
    claim:async(who,lookup,input,attemptId,controllerInstanceId)=>{authorize(who,lookup);claimCount++;if(saved)return {created:false,attempt:structuredClone(saved)};saved={binding:structuredClone(lookup),job:structuredClone(input),snapshot:{attemptId,controllerInstanceId,phase:'PREPARING',rawResult:null,termination:null,code:'OK'}};if(claimAckLost)throw new Error('OWNED_ADMISSION_ACK_LOST');return {created:true,attempt:structuredClone(saved)};},
    load:async(who,lookup)=>{authorize(who,lookup);if(!saved)throw new DomainError('NATIVE_CONTROL_NOT_FOUND',409,'WAIT');return structuredClone(saved);},
    ready:async(who,attempt)=>{authorize(who,attempt.binding);saved!.snapshot.phase='READY';return structuredClone(saved!);},
    grantGo:async(who,attempt)=>{authorize(who,attempt.binding);if(saved!.snapshot.phase==='GO_GRANTED')return {created:false,attempt:structuredClone(saved!)};expect(saved!.snapshot.phase).toBe('READY');saved!.snapshot.phase='GO_GRANTED';goCount++;if(goAckLost)throw new Error('OWNED_GO_ACK_LOST');return {created:true,attempt:structuredClone(saved!)};},
    observe:async(who,attempt,event,evidence,termination)=>{authorize(who,attempt.binding);saved!.snapshot.code=evidence.code;if(event==='TERMINATION')saved!.snapshot.termination=structuredClone(termination);},
    unknown:async(who,attempt,code)=>{authorize(who,attempt.binding);saved!.snapshot.phase='UNKNOWN';saved!.snapshot.code=code;}
  };
  const raw:NativeControllerRawStore={
    allocate:async(who,attempt,result)=>{authorize(who,attempt.binding);if(allocated)return structuredClone(allocated);allocated={attemptId:attempt.snapshot.attemptId,reference:{rawResultId:randomUUID(),resultDigest:digest(result)},result:structuredClone(result)};saved!.snapshot.rawResult=structuredClone(allocated.reference);return structuredClone(allocated);},
    putOriginal:async(_who,allocation,payload)=>{expect(allocated?.reference).toEqual(allocation.reference);putCount++;stored=new Map([...payload].map(([id,bytes])=>[id,Buffer.from(bytes)]));if(putAckLost)throw new DomainError('NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');},
    readExisting:async(who,attempt)=>{authorize(who,attempt.binding);return stored&&allocated?{envelope:structuredClone(allocated.result),blobs:new Map([...stored].map(([id,bytes])=>[id,Buffer.from(bytes)]))}:null;}
  };
  const peers={authenticate:async(transport:unknown)=>{if(transport!==channel&&transport!==otherChannel)throw new DomainError('NATIVE_PEER_UNCONFIRMED',409,'WAIT');return structuredClone(peer);}};
  const make=(nextRunner:NativeCapturedAttemptRunner=runner)=>new NativeControllerAttempts(nextRunner,peers,store,raw,{maxControlBytes:4096,goWaitMilliseconds:options.goWaitMilliseconds??10000,maxInFlightBytes:options.maxInFlightBytes??256*1024});
  const service=make(),prepare=():NativeControllerRequest=>({control:{version:1,requestId:randomUUID(),binding:structuredClone(binding),command:'PREPARE'},input:{envelope:structuredClone(job),blobs:new Map([...blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))}});
  const query=(includeRawResult=false):NativeControllerRequest=>({control:{version:1,requestId:randomUUID(),binding:structuredClone(binding),command:'QUERY',includeRawResult}});
  const go=(attempt=saved!):NativeControllerRequest=>({control:{version:1,requestId:randomUUID(),binding:structuredClone(binding),command:'GO',attemptId:attempt.snapshot.attemptId,controllerInstanceId:attempt.snapshot.controllerInstanceId}});
  return {runner,binding,job,channel,otherChannel,service,make,store,raw,peers,prepare,query,go,record:()=>structuredClone(saved!),counters:()=>({claimCount,goCount,putCount}),setClaimAckLost:()=>{claimAckLost=true;},setGoAckLost:()=>{goAckLost=true;},setPutAckLost:()=>{putAckLost=true;}};
}

describe('original controller attempt coordinator with owned fake persistence ports',()=>{
  it('gives two clients one attempt and one GO while preserving original frame and raw candidate',async()=>{
    const f=fixture();const [first,second]=await Promise.all([f.service.serve(f.channel,f.prepare(),reply),f.service.serve(f.otherChannel,f.prepare(),reply)]);expect(first.snapshot.attemptId).toBe(second.snapshot.attemptId);expect(f.runner.attempts).toBe(1);
    await Promise.all([f.service.serve(f.channel,f.go(),reply),f.service.serve(f.otherChannel,f.go(),reply)]);await f.service.idle();expect(f.runner.computations).toBe(1);expect(f.counters()).toEqual({claimCount:2,goCount:1,putCount:1});
    let candidate:NativeControllerResponse|undefined;await f.service.serve(f.channel,f.query(true),async response=>{candidate=response;});expect(candidate?.rawResult?.envelope).toMatchObject({jobId:f.job.jobId,inputDigest:f.job.inputDigest,profileDigest:f.job.profileDigest});expect(candidate?.control.snapshot.termination?.kind).toBe('DIRECT_CHILD_ONLY');expect(candidate).not.toHaveProperty('approved');expect(candidate).not.toHaveProperty('receipt');
  });
  it('keeps admission ACK loss query only even across a new coordinator and runner',async()=>{
    const f=fixture();f.setClaimAckLost();await expect(f.service.serve(f.channel,f.prepare(),reply)).rejects.toThrow('OWNED_ADMISSION_ACK_LOST');expect(f.runner.attempts).toBe(0);const original=f.record(),nextRunner=new FakeRunner(),next=f.make(nextRunner);
    expect((await next.serve(f.channel,f.prepare(),reply)).snapshot).toEqual(original.snapshot);expect((await next.serve(f.channel,f.query(),reply)).snapshot.attemptId).toBe(original.snapshot.attemptId);await expect(next.serve(f.channel,f.go(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});expect(nextRunner.attempts).toBe(0);await next.idle();await f.service.idle();
  });
  it('does not let a restarted instance grant GO for an original prepared child',async()=>{
    const f=fixture();await f.service.serve(f.channel,f.prepare(),reply);const nextRunner=new FakeRunner(),next=f.make(nextRunner);const before=f.record();expect((await next.serve(f.channel,f.query(),reply)).snapshot).toEqual(before.snapshot);await expect(next.serve(f.channel,f.go(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});expect(nextRunner.attempts).toBe(0);
    await f.service.serve(f.channel,f.go(),reply);await f.service.idle();await next.idle();expect(f.runner.computations).toBe(1);
  });
  it('consumes a lost GO ACK once and never forwards a second physical enable from that record',async()=>{
    const f=fixture({goWaitMilliseconds:25});await f.service.serve(f.channel,f.prepare(),reply);f.setGoAckLost();await expect(f.service.serve(f.channel,f.go(),reply)).rejects.toThrow('OWNED_GO_ACK_LOST');expect((await f.service.serve(f.channel,f.query(),reply)).snapshot.phase).toBe('GO_GRANTED');await f.service.serve(f.channel,f.go(),reply);await f.service.idle();expect(f.counters().goCount).toBe(1);expect(f.runner.attempts).toBe(1);expect(f.runner.computations).toBe(0);expect(f.record().snapshot.code).toBe('NATIVE_CONTROL_GO_WAIT');
  });
  it('reconciles original raw bytes after PUT ACK loss without allocating another object or PUT',async()=>{
    const f=fixture();await f.service.serve(f.channel,f.prepare(),reply);f.setPutAckLost();await f.service.serve(f.channel,f.go(),reply);await f.service.idle();const before=f.record(),next=f.make(new FakeRunner());let raw:NativeControllerResponse|undefined;
    await next.serve(f.channel,f.query(true),async response=>{raw=response;});expect(raw?.rawResult?.blobs.get('raw')).toEqual(Buffer.from('simulated result'));expect(raw?.control.snapshot.rawResult).toEqual(before.snapshot.rawResult);expect(raw?.control.snapshot.code).toBe('NATIVE_RAW_RESULT_UNCONFIRMED');expect(f.counters().putCount).toBe(1);await next.idle();
  });
  it('rejects peer JSON and cross account reservation parent profile and kernel before another attempt',async()=>{
    const f=fixture();await expect(f.service.serve({serviceRole:'trio_web_api',peerId:'claimed'},f.prepare(),reply)).rejects.toMatchObject({code:'NATIVE_PEER_UNCONFIRMED'});
    for(const key of ['accountId','capacityReservationId','parentInstanceId','profileDigest','kernelDigest'] as const){const request=f.prepare();request.control.binding[key]=key.endsWith('Digest')?sha256('other'):randomUUID();await expect(f.service.serve(f.channel,request,reply)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});}
    expect(f.runner.attempts).toBe(0);expect(f.counters().goCount).toBe(0);await f.service.idle();
  });
  it('captures the caller frame before authentication or store awaits and does not share the response snapshot',async()=>{
    const f=fixture(),request=f.prepare(),before=structuredClone(request.input!.envelope);const original=f.peers.authenticate;f.peers.authenticate=async channel=>{request.input!.envelope.metadata.entries=[];request.input!.blobs.get('entry')!.fill(0);return original(channel);};
    await f.service.serve(f.channel,request,async response=>{response.control.snapshot.attemptId=randomUUID();});expect(f.record().job).toEqual(before);f.peers.authenticate=original;await f.service.serve(f.channel,f.go(),reply);await f.service.idle();expect(f.runner.computations).toBe(1);
  });
  it('keeps outbound response buffers occupied until writer I/O joins independently of native termination',async()=>{
    const budget=2*frameLimits.maxBinaryBytes+4*frameLimits.maxMetadataBytes+2*4096+32,f=fixture({maxInFlightBytes:budget+8});f.setClaimAckLost();await expect(f.service.serve(f.channel,f.prepare(),reply)).rejects.toThrow('OWNED_ADMISSION_ACK_LOST');
    let release:()=>void=()=>{},entered:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});const response=f.service.serve(f.channel,f.query(),async()=>{entered();await pending;});await writing;
    try{await expect(f.service.serve(f.channel,f.query(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROL_CAPACITY_WAIT'});expect(f.runner.attempts).toBe(0);}finally{release();await response;await f.service.idle();}
    expect((await f.service.serve(f.channel,f.query(),reply)).snapshot.phase).toBe('PREPARING');await f.service.idle();
  });
  it('stops a prepared WAIT child without granting compute or using a lease as release authority',async()=>{
    const f=fixture();await f.service.serve(f.channel,f.prepare(),reply);f.service.stopClaims();await expect(f.service.serve(f.channel,f.go(),reply)).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});await f.service.idle();expect(f.runner.computations).toBe(0);expect(f.counters().goCount).toBe(0);expect(f.record().snapshot).toMatchObject({phase:'UNKNOWN',code:'NATIVE_SHUTDOWN_WAIT'});expect(f.store).not.toHaveProperty('release');
  });
  it('retains the original request budget through final controller bookkeeping I/O after termination',async()=>{
    const one=2*frameLimits.maxBinaryBytes+4*frameLimits.maxMetadataBytes+2*4096+32,f=fixture({maxInFlightBytes:2*one+8}),originalLoad=f.store.load;let releaseLoad:()=>void=()=>{},enteredLoad:()=>void=()=>{},releaseReply:()=>void=()=>{},enteredReply:()=>void=()=>{},blocked=false;
    const loadPending=new Promise<void>(resolve=>{releaseLoad=resolve;}),loadEntered=new Promise<void>(resolve=>{enteredLoad=resolve;}),replyPending=new Promise<void>(resolve=>{releaseReply=resolve;}),replyEntered=new Promise<void>(resolve=>{enteredReply=resolve;});
    f.store.load=async(peer,binding)=>{const record=await originalLoad(peer,binding);if(record.snapshot.termination&&!blocked){blocked=true;enteredLoad();await loadPending;}return record;};
    await f.service.serve(f.channel,f.prepare(),reply);await f.service.serve(f.channel,f.go(),reply);await loadEntered;
    const responding=f.service.serve(f.channel,f.query(),async()=>{enteredReply();await replyPending;});await replyEntered;
    try{await expect(f.service.serve(f.channel,f.query(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROL_CAPACITY_WAIT'});expect(f.record().snapshot.termination?.operationJoined).toBe(true);}
    finally{releaseReply();releaseLoad();await responding;await f.service.idle();}
  });
  it('rejects a changed fresh admission attempt ID before creating a child',async()=>{
    const f=fixture(),original=f.store.claim;f.store.claim=async(...args)=>{const claim=await original(...args);claim.attempt.snapshot.attemptId=randomUUID();return claim;};
    try{await expect(f.service.serve(f.channel,f.prepare(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROL_ATTEMPT_UNCONFIRMED'});}
    finally{f.service.stopClaims();await f.service.idle();}
    expect(f.runner.attempts).toBe(0);expect(f.runner.computations).toBe(0);expect(f.counters().goCount).toBe(0);
  });
  it.each([['ready','attemptId'],['ready','controllerInstanceId'],['grant','attemptId'],['grant','controllerInstanceId']] as const)('rejects changed %s acknowledgement %s before forwarding GO',async(stage,field)=>{
    const f=fixture();
    if(stage==='ready'){const original=f.store.ready;f.store.ready=async(...args)=>{const record=await original(...args);record.snapshot[field]=randomUUID();return record;};}
    else{const original=f.store.grantGo;f.store.grantGo=async(...args)=>{const grant=await original(...args);grant.attempt.snapshot[field]=randomUUID();return grant;};}
    try{
      const prepared=await f.service.serve(f.channel,f.prepare(),reply);
      if(stage==='ready')expect(prepared.snapshot).toMatchObject({phase:'UNKNOWN',code:'NATIVE_CONTROL_ATTEMPT_UNCONFIRMED'});
      else await expect(f.service.serve(f.channel,f.go(),reply)).rejects.toMatchObject({code:'NATIVE_CONTROL_ATTEMPT_UNCONFIRMED'});
    }finally{f.service.stopClaims();await f.service.idle();}
    expect(f.runner.computations).toBe(0);expect(f.counters().putCount).toBe(0);
  });
});

// W3-B: 여기서는 순수 가짜 포트만 사용하고 실제 host를 생성하지 않는다.
describe('W3-B Windows server composition',()=>{
  it('exports a shared parent memory owner before controller construction',async()=>{
    const api=await import('../../packages/native/src/controller-attempts.js');
    expect('createNativeControllerMemory' in api,'W3-B 부모 전체 예산 owner가 필요하다').toBe(true);
  });
  it('exports the Windows original controller without constructing a host',async()=>{
    const api=await import('../../packages/native/src/controller.js');
    expect('createWindowsOriginalController' in api,'실제 W2와 원 journal을 연결하는 factory가 필요하다').toBe(true);
  });
});

function windowsCoordinatorFixture(maxBytes=33554432){
  const legacy=fixture(),memory=createNativeControllerMemory(maxBytes),calls={prepare:0,grant:0,load:0,auth:0};
  const attempt:NativeOriginalAttemptV2={binding:legacy.binding,job:legacy.job,snapshot:{version:2,attemptId:randomUUID(),controllerInstanceId:randomUUID(),phase:'READY',rawResult:null,termination:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'}};
  const limits={maxMetadataBytes:4096,maxInputBytes:1024,maxOutputBytes:1024,maxItems:4,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:8388608};
  const controller:WindowsOriginalController={kind:'WINDOWS_JOB_OBJECT',controllerInstanceId:attempt.snapshot.controllerInstanceId,profileDigest:legacy.runner.profileDigest,kernelImplementationDigest:legacy.runner.kernelImplementationDigest,limits,memory,
    frameLimits:()=>frameLimits,prepareOriginal:async()=>{calls.prepare++;return structuredClone(attempt);},grantOriginal:async()=>{calls.grant++;return structuredClone(attempt);},loadOriginal:async()=>{calls.load++;return structuredClone(attempt);},readRawOriginal:async()=>null,stopClaims:()=>{},idle:async()=>{},reconcileTerminations:async()=>{}};
  const peers={authenticate:async()=>{calls.auth++;return legacy.peers.authenticate(legacy.channel);}};
  const bounds={maxControlBytes:4096,goWaitMilliseconds:100,maxInFlightBytes:maxBytes};
  const service=new NativeControllerAttempts(controller,peers,bounds),query=():NativeControllerRequestV2=>({control:{version:2,requestId:randomUUID(),binding:legacy.binding,command:'QUERY',includeRawResult:false}});
  // 이 표본의 control은 UUID/binding을 포함하므로 wire 검사는 큰 C를 쓴다.
  const framed=new NativeControllerAttempts(controller,peers,{...bounds,maxControlBytes:4096});
  return {legacy,memory,calls,attempt,controller,service,framed,query};
}
async function w3flush(){for(let n=0;n<40;n++)await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));}
function w3deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
describe('W3-B coordinator reservations and real codec lifetime',()=>{
  it('returns an earlier reservation when the distinct result loan cannot be acquired',async()=>{
    const f=windowsCoordinatorFixture(30000);const request=f.query();
    await expect(f.service.serve(f.legacy.channel,request,async()=>{})).rejects.toMatchObject({code:'NATIVE_CONTROL_CAPACITY_WAIT'});
    expect(f.calls.auth).toBe(0);expect(f.memory.available()).toBe(f.memory.maxBytes);
  });
  it('rejects cross versions before authentication or mutations',async()=>{
    const f=windowsCoordinatorFixture();
    await expect(f.framed.serve(f.legacy.channel,f.legacy.query(),async()=>{})).rejects.toMatchObject({code:'NATIVE_CONTROLLER_VERSION_UNCONFIRMED'});
    await expect(f.legacy.service.serve(f.legacy.channel,f.query(),async()=>{})).rejects.toMatchObject({code:'NATIVE_CONTROLLER_VERSION_UNCONFIRMED'});
    expect(f.calls).toEqual({prepare:0,grant:0,load:0,auth:0});expect(f.memory.available()).toBe(f.memory.maxBytes);
  });
  it('retains the wire hold through actual iterator.return after decode failure',async()=>{
    const f=windowsCoordinatorFixture(),returnEntered=w3deferred(),returnDone=w3deferred();let first=true;
    const source:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>({next:async()=>{if(first){first=false;return {done:false,value:Buffer.alloc(12)};}return {done:true,value:undefined};},return:async()=>{returnEntered.resolve();await returnDone.promise;return {done:true,value:undefined};}})};
    const work=f.framed.serveFramed(f.legacy.channel,source,new Writable({write:(_c,_e,done)=>done()}));void work.catch(()=>{});
    await returnEntered.promise;let idle=false;const waiting=f.framed.idle().then(()=>{idle=true;});await w3flush();
    expect(idle).toBe(false);expect(f.memory.available()).toBeLessThan(f.memory.maxBytes);expect(f.calls.auth).toBe(0);
    returnDone.resolve();await expect(work).rejects.toMatchObject({code:'NATIVE_CONTROL_INVALID'});await waiting;expect(f.memory.available()).toBe(f.memory.maxBytes);
  });
  it('keeps separate request and wire holds until the actual writer callback ends',async()=>{
    const f=windowsCoordinatorFixture(),chunks:Buffer[]=[];
    await writeNativeControllerRequest(new Writable({write:(chunk:Buffer,_e,done)=>{chunks.push(Buffer.from(chunk));done();}}),f.query(),{maxControlBytes:4096,input:frameLimits,output:frameLimits});
    const entered=w3deferred();let release=false,callback:(()=>void)|undefined;
    const destination=new Writable({write:(_c,_e,done)=>{entered.resolve();if(release)done();else callback=done;}});
    const source={async *[Symbol.asyncIterator](){yield* chunks;}};
    const work=f.framed.serveFramed(f.legacy.channel,source,destination);await entered.promise;
    let idle=false;const waiting=f.framed.idle().then(()=>{idle=true;});await w3flush();expect(idle).toBe(false);expect(f.memory.available()).toBeLessThan(f.memory.maxBytes);
    release=true;callback!();await work;await waiting;expect(f.calls.load).toBe(1);expect(f.memory.available()).toBe(f.memory.maxBytes);
  });
});

// 아래 표본은 실제 W2 조정기와 원 port 모양을 사용하지만 DB/OS는 모두
// 메모리 가짜다. PG 원자료의 양성은 별도 W3-B PG suite가 담당한다.
async function windowsAdapterFixture(options:{grantPending?:Promise<void>;grantAckLost?:boolean;parentRelease?:Promise<void>;loadError?:Error;maxBytes?:number}={}){
  vi.doMock('sharp',()=>({default:()=>{throw new Error('W3B_REAL_ADDON_FORBIDDEN');}}));
  const addon=vi.spyOn(process,'dlopen').mockImplementation(()=>{throw new Error('W3B_REAL_ADDON_FORBIDDEN');});
  const cp=(await import('node:child_process')).default,net=(await import('node:net')).default;
  const guards=[addon,...(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const).map(key=>vi.spyOn(cp,key).mockImplementation(()=>{throw new Error('W3B_REAL_PROCESS_FORBIDDEN');})),vi.spyOn(net.Socket.prototype,'connect').mockImplementation(()=>{throw new Error('W3B_REAL_NETWORK_FORBIDDEN');})];
  const shared=await import('../fixtures/windows-native.js');
  const legacy=fixture(),limits={...shared.windowsNativeLimits},baseMemory=createNativeControllerMemory(options.maxBytes??33554432);
  const reservations:{bytes:number;active:boolean}[]=[];
  const memory:import('../../packages/native/src/controller-attempts.js').NativeControllerMemoryOwner=Object.freeze({maxBytes:baseMemory.maxBytes,available:baseMemory.available,hold:(bytes:number)=>{const release=baseMemory.hold(bytes),record={bytes,active:true};reservations.push(record);return ()=>{record.active=false;release();};}});
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:randomUUID(),keyVersion:'w3b-unit-v1',environmentDigest:sha256('unit env'),hostEpochId:randomUUID(),sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:sha256('controller'),childSidDigest:sha256('child'),appContainerSidDigest:sha256('container')};
  const input:import('../../packages/native/src/windows-job-backend.js').WindowsPrepareInput={identity:{binding:legacy.binding,intentDigest:sha256('intent'),sourceInput:{executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('semantic stage')},inputEvidenceDigest:sha256('original input'),inputFingerprint:sha256('canonical input'),basisRef:null},authority,pins:{executableDigest:sha256('exe'),bootstrapDigest:sha256('boot'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('host'),runtimeFilesDigest:sha256('files'),nativeLimitsDigest:digest(limits)},policy,limits,frame:{envelope:legacy.job,blobs:new Map([['entry',Buffer.from([1,2,3,4])]])}};
  const clock=shared.createWindowsNativeClock(),host=shared.createWindowsNativeBroker(input,{parentRelease:options.parentRelease});
  type Cap=import('../../packages/native/src/windows-job-backend.js').OriginalCapture;
  type Row=import('../../packages/native/src/windows-job-backend.js').JournalEntry;
  type Seal=import('../../packages/native/src/windows-job-backend.js').WindowsSealEnvelope;
  type Ref=import('../../packages/native/src/windows-job-backend.js').OriginalRef;
  let capture:Cap|null=null,go=false,stored:{ref:Ref;envelope:Seal}|null=null,finalRef:import('../../packages/native/src/dto.js').WindowsEvidenceRef|null=null;
  let rawAllocation:NativeRawAllocation|null=null,rawFrame:import('../../packages/native/src/frame.js').NativeFrame<import('../../packages/native/src/dto.js').NativeResult>|null=null;
  const rows:Row[]=[],calls={offer:0,capture:0,go:0,ready:0,finish:0,put:0,get:0,load:0};
  const snapshot=():NativeOriginalAttemptV2=>({binding:structuredClone(legacy.binding),job:structuredClone(legacy.job),snapshot:{version:2,attemptId:authority.attemptId,controllerInstanceId:authority.controllerInstanceId,phase:go?'GO_GRANTED':calls.ready?'READY':'PREPARING',rawResult:finalRef?rawAllocation?.reference??null:null,termination:finalRef?{jobId:legacy.job.jobId,inputDigest:legacy.job.inputDigest,profileDigest:legacy.job.profileDigest,goAttempted:go,startedComputation:go,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY'}:null,windowsEvidenceRef:finalRef,code:'OK'}});
  const journal:WindowsControllerJournalPort={controllerInstanceId:authority.controllerInstanceId,profileDigest:legacy.runner.profileDigest,kernelImplementationDigest:legacy.runner.kernelImplementationDigest,limits,memory,
    offerOriginal:async()=>{calls.offer++;return input;},
    portsFor:()=>({original:{
      captureFresh:async value=>{calls.capture++;const {frame,...origin}=value;capture={origin,originDigest:digest({identity:origin.identity,authority:origin.authority,pins:origin.pins,policy:origin.policy,nativeLimitsDigest:digest(origin.limits),frameInputDigest:frame.envelope.inputDigest}),frameInputDigest:frame.envelope.inputDigest,launchRef:randomUUID()};return {created:true,capture};},
      grantOriginal:async()=>{calls.go++;go=true;await options.grantPending;if(options.grantAckLost)throw new Error('UNIT_ORIGINAL_ACK_LOST');return {created:true,goGrantRef:{jobId:legacy.job.jobId,rowDigest:sha256('original GO')}};},
      readOriginal:async cap=>({originDigest:cap.originDigest,state:'CONFIRMED',goGrantRef:go?{jobId:legacy.job.jobId,rowDigest:sha256('original GO')}:null})
    },journal:{
      appendOriginal:async(_cap,event,source)=>{const row={event,source,sourceDigest:digest(source)};rows.push(row);return {eventId:event.eventId,payloadDigest:event.payloadDigest,sourceDigest:row.sourceDigest};},
      lookupEvent:async(_cap,ref)=>rows.find(row=>row.event.eventId===ref.eventId)??null,
      scanOriginal:async function*(){yield* rows;},
      sealOriginal:async(_cap,envelope)=>{stored={ref:{recordId:randomUUID(),digest:digest(envelope)},envelope};return stored.ref;},
      readOriginal:async()=>stored
    }}),
    readyOriginal:async()=>{calls.ready++;},parentJoinedOriginal:async(_cap,ack)=>ack,
    finishOriginal:async(_cap,value)=>{calls.finish++;expect(value.outcome.state).toBe('JOINED');expect(value.brokerJoin.finalized).toEqual(value.finalized);finalRef={recordId:value.finalized.recordId,recordDigest:value.finalized.digest,linkId:randomUUID(),linkDigest:sha256('signed original link')};return finalRef;},
    readOriginal:async()=>({capture:capture!,record:stored,windowsEvidenceRef:finalRef}),
    loadOriginal:async()=>{calls.load++;if(options.loadError)throw options.loadError;if(!capture)throw Object.assign(new Error('NATIVE_CONTROL_BINDING_MISMATCH'),{code:'23514'});return snapshot();},close:async()=>{}
  };
  const raw:NativeControllerRawStore={allocate:async(_who,attempt,result)=>{rawAllocation={attemptId:attempt.snapshot.attemptId,reference:{rawResultId:randomUUID(),resultDigest:digest(result)},result};return rawAllocation;},putOriginal:async(_who,allocation,blobs)=>{calls.put++;rawFrame={envelope:allocation.result,blobs};},readExisting:async()=>{calls.get++;return rawFrame;}};
  const controller=createWindowsOriginalController({journal,broker:host.broker,clock:clock.clock,raw}),peers={authenticate:async()=>legacy.peers.authenticate(legacy.channel)};
  const service=new NativeControllerAttempts(controller,peers,{maxControlBytes:4096,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});
  const prepare=():NativeControllerRequestV2=>({control:{version:2,requestId:randomUUID(),binding:legacy.binding,command:'PREPARE'},input:input.frame});
  const query=():NativeControllerRequestV2=>({control:{version:2,requestId:randomUUID(),binding:legacy.binding,command:'QUERY',includeRawResult:false}});
  const goRequest=(attempt:NativeOriginalAttemptV2['snapshot']):NativeControllerRequestV2=>({control:{version:2,requestId:randomUUID(),binding:legacy.binding,command:'GO',attemptId:attempt.attemptId,controllerInstanceId:attempt.controllerInstanceId}});
  return {legacy,controller,service,prepare,query,goRequest,clock,host,memory,reservations,input,shared,calls,journal,rows,snapshot,restore:()=>{for(const guard of guards.reverse())guard.mockRestore();}};
}
async function w3until(predicate:()=>boolean){for(let n=0;n<100&&!predicate();n++)await w3flush();expect(predicate(),'지정 가짜 원 포트 경계 도착').toBe(true);}
describe('W3-B actual W2 adapter with fake original ports',()=>{
  it('uses one fresh capture and GO and returns pending QUERY before future finalization',async()=>{
    const finalGate=w3deferred(),f=await windowsAdapterFixture({parentRelease:finalGate.promise});
    try{
      expect(f.calls).toEqual({offer:0,capture:0,go:0,ready:0,finish:0,put:0,get:0,load:0});expect(f.clock.pending()).toBe(0);
      const [prepared,duplicate]=await Promise.all([f.service.serve(f.legacy.channel,f.prepare(),async()=>{}),f.service.serve(f.legacy.channel,f.prepare(),async()=>{})]);
      expect(prepared.snapshot.attemptId).toBe(duplicate.snapshot.attemptId);
      await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});await w3until(()=>f.host.receivedParentAcks.length===1);
      const pending=await f.service.serve(f.legacy.channel,f.query(),async()=>{});
      expect(pending.snapshot).toMatchObject({phase:'GO_GRANTED',termination:null,windowsEvidenceRef:null,rawResult:null,code:'WINDOWS_EVIDENCE_PENDING'});expect(f.calls.finish).toBe(0);expect(f.host.finalized).toBeNull();expect(f.calls.get).toBe(0);
      finalGate.resolve();await f.service.idle();const final=await f.service.serve(f.legacy.channel,f.query(),async()=>{});
      expect(final.snapshot.termination?.kind).toBe('WINDOWS_JOB_EMPTY');expect(final.snapshot.windowsEvidenceRef).not.toBeNull();expect(f.calls).toMatchObject({offer:1,capture:1,go:1,put:1,finish:1});expect(f.host.joins).toBe(1);expect(f.host.failures).toEqual([]);expect(f.clock.pending()).toBe(0);expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{finalGate.resolve();f.service.stopClaims();f.restore();}
  });
  it('closes a finite GO gate while a committed ACK is still pending and never forwards its late ACK',async()=>{
    const ack=w3deferred(),f=await windowsAdapterFixture({grantPending:ack.promise});
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{}),grant=f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});void grant.catch(()=>{});
      await w3until(()=>f.calls.go===1);f.clock.advance(100);await expect(grant).rejects.toMatchObject({code:'WINDOWS_GO_UNCONFIRMED'});
      let joined=false;const idle=f.service.idle().finally(()=>{joined=true;});void idle.catch(()=>{});await w3flush();expect(joined).toBe(false);expect(f.memory.maxBytes-f.memory.available()).toBeGreaterThanOrEqual(f.controller.limits.parentInFlightBytes);
      ack.resolve();await expect(idle).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});expect(f.host.controls.filter(control=>control.command==='GRANT_GO')).toHaveLength(0);expect(f.calls.finish).toBe(0);expect(f.calls.go).toBe(1);expect(f.clock.pending()).toBe(0);expect(f.memory.maxBytes-f.memory.available()).toBe(4096);
    }finally{ack.resolve();f.service.stopClaims();f.restore();}
  });
  it('does not turn a nonmatching SQL error into a fresh offer or capture',async()=>{
    const original=Object.assign(new Error('NATIVE_CONTROL_BINDING_MISMATCH'),{code:'42501'}),f=await windowsAdapterFixture({loadError:original});
    try{await expect(f.service.serve(f.legacy.channel,f.prepare(),async()=>{})).rejects.toBe(original);expect(f.calls).toMatchObject({offer:0,capture:0,go:0});expect(f.host.captures).toHaveLength(0);await f.service.idle();expect(f.memory.available()).toBe(f.memory.maxBytes);}finally{f.restore();}
  });
});

describe('W3-B same completion reconciliation',()=>{
  it('retains the original completion through a failed final store and retries only those original bytes',async()=>{
    const f=await windowsAdapterFixture();const original=f.journal.finishOriginal.bind(f.journal);let failed=0;
    f.journal.finishOriginal=async(...args)=>{if(failed<2){failed++;throw new Error('UNIT_FINAL_DB_UNAVAILABLE');}return original(...args);};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});
      await expect(f.service.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});
      expect(failed).toBe(2);expect(f.calls.finish).toBe(0);
      await f.controller.reconcileTerminations();const final=await f.service.serve(f.legacy.channel,f.query(),async()=>{});
      expect(final.snapshot.windowsEvidenceRef).not.toBeNull();expect(f.calls).toMatchObject({capture:1,go:1,put:1,finish:1});await f.service.idle();expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{f.service.stopClaims();f.restore();}
  });
});

describe('W3-B GO terminal paths and independent drains',()=>{
  it.each(['ACK_LOST','CREATED_FALSE','REJECTED'] as const)('never enables a second physical GO after %s',async failure=>{
    const f=await windowsAdapterFixture({grantAckLost:failure==='ACK_LOST'}),ports=f.journal.portsFor;
    if(failure!=='ACK_LOST')f.journal.portsFor=peer=>{const base=ports(peer);return {...base,original:{...base.original,grantOriginal:async cap=>{if(failure==='REJECTED')throw new DomainError('UNIT_DB_GO_REJECTED',409,'WAIT');const ack=await base.original.grantOriginal(cap);return {...ack,created:false};}}};};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});
      await expect(f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{})).rejects.toMatchObject({code:'WINDOWS_GO_UNCONFIRMED'});
      await expect(f.service.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});
      expect(f.host.controls.filter(control=>control.command==='GRANT_GO')).toHaveLength(0);expect(f.calls.capture).toBe(1);expect(f.calls.go).toBe(failure==='REJECTED'?0:1);expect(f.calls.finish).toBe(0);expect(f.clock.pending()).toBe(0);
    }finally{f.service.stopClaims();f.restore();}
  });
  it('stops a prepared original without consuming a DB GO',async()=>{
    const f=await windowsAdapterFixture();
    try{const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});f.service.stopClaims();await expect(f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{})).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});await expect(f.service.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});expect(f.calls.go).toBe(0);expect(f.host.controls.filter(c=>c.command==='GRANT_GO')).toHaveLength(0);expect(f.clock.pending()).toBe(0);}finally{f.restore();}
  });
  it('returns WAIT when the original snapshot lookup fails after the actual GO ACK',async()=>{
    const f=await windowsAdapterFixture(),load=f.journal.loadOriginal;let lost=false;
    f.journal.loadOriginal=async(...args)=>{if(f.calls.go&&!lost){lost=true;throw new Error('UNIT_ACK_SNAPSHOT_UNAVAILABLE');}return load(...args);};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});
      await expect(f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{})).rejects.toMatchObject({code:'WINDOWS_GO_UNCONFIRMED'});
      f.service.stopClaims();await f.service.idle().catch(()=>{});expect(lost).toBe(true);expect(f.calls.go).toBe(1);expect(f.host.captures).toHaveLength(1);
    }finally{f.service.stopClaims();f.restore();}
  });
  it('retains L while an actual clock cancellation ACK is pending after W2 joined',async()=>{
    const f=await windowsAdapterFixture(),cancel=w3deferred();const clock=f.clock.clock,start=clock.startWait;
    clock.startWait=at=>{const handle=start(at);return {done:handle.done,cancel:async()=>{await cancel.promise;await handle.cancel();}};};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});await w3until(()=>f.calls.finish===1);
      let idle=false;const pending=f.service.idle().then(()=>{idle=true;});await w3flush();expect(idle).toBe(false);expect(f.memory.maxBytes-f.memory.available()).toBeGreaterThanOrEqual(f.controller.limits.parentInFlightBytes);
      cancel.resolve();await pending;expect(f.clock.pending()).toBe(0);expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{cancel.resolve();f.service.stopClaims();f.restore();}
  });
  it('joins the actual parent DB ACK before PARENT_JOINED without making QUERY wait for future finish',async()=>{
    const f=await windowsAdapterFixture(),put=w3deferred(),ports=f.controller;
    // 실제 부모 DB ACK만 독립 지연한다. W2 전체 idle은 대기 집합에 넣지 않는다.
    const entered=w3deferred(),joined=f.journal.parentJoinedOriginal;
    f.journal.parentJoinedOriginal=async(...args)=>{entered.resolve();await put.promise;return joined(...args);};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});await entered.promise;
      const query=await f.service.serve(f.legacy.channel,f.query(),async()=>{});expect(query.snapshot.code).toBe('WINDOWS_EVIDENCE_PENDING');expect(f.host.receivedParentAcks).toHaveLength(0);expect(f.calls.put).toBe(1);
      let idle=false;const pending=f.service.idle().then(()=>{idle=true;});await w3flush();expect(idle).toBe(false);expect(f.memory.maxBytes-f.memory.available()).toBeGreaterThanOrEqual(ports.limits.parentInFlightBytes);
      put.resolve();await pending;expect(f.host.receivedParentAcks).toHaveLength(1);expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{put.resolve();f.service.stopClaims();f.restore();}
  });
});

describe('W3-B finalization under aggregate memory pressure',()=>{
  it('hands off the original completion without a new reservation after final store failure',async()=>{
    const f=await windowsAdapterFixture();let pressureRelease:(()=>void)|undefined,pressureBytes=0,failed=0;
    f.journal.finishOriginal=async()=>{failed++;if(failed===2){pressureBytes=f.memory.available()-128;pressureRelease=f.memory.hold(pressureBytes);}throw new Error('UNIT_FINAL_STORE_FAILED_WITH_SHARED_PRESSURE');};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});
      await w3until(()=>failed===2);await w3flush();
      const originalOwned=f.memory.maxBytes-f.memory.available()-pressureBytes;
      expect(originalOwned,'L은 정리하고 원 completion의 별도 반환 loan만 보존해야 한다').toBeLessThan(f.controller.limits.parentInFlightBytes);
      expect(originalOwned).toBeGreaterThanOrEqual(3*4*131072);expect(f.clock.pending()).toBe(0);
    }finally{pressureRelease?.();f.service.stopClaims();f.restore();}
  });
});

describe('W3-B unconfirmed input shutdown',()=>{
  it.each(['THREW','NOT_DONE','NO_RETURN'] as const)('retains the wire hold and reports WAIT when iterator shutdown is %s',async mode=>{
    const f=windowsCoordinatorFixture();const iterator:AsyncIterator<Uint8Array>={next:async()=>({done:false,value:Buffer.alloc(12)})};
    if(mode!=='NO_RETURN')iterator.return=async()=>{if(mode==='THREW')throw new Error('UNIT_SOURCE_CLOSE_FAILED');return {done:false,value:Buffer.alloc(0)};};
    const source:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>iterator};
    await expect(f.framed.serveFramed(f.legacy.channel,source,new Writable({write:(_c,_e,done)=>done()}))).rejects.toBeDefined();
    expect(f.memory.available()).toBeLessThan(f.memory.maxBytes);await expect(f.framed.idle()).rejects.toMatchObject({code:'NATIVE_CONTROL_JOIN_UNCONFIRMED'});expect(f.calls.auth).toBe(0);
  });
});

describe('W3-B bounded public return ownership',()=>{
  it('keeps the first large seal wrapper loan while reading a second and separately loans the final view',async()=>{
    const f=await windowsAdapterFixture(),ports=f.journal.portsFor,readCounts:number[]=[];let finalViewLoans=0;
    f.journal.portsFor=who=>{const base=ports(who);return {...base,journal:{...base.journal,
      sealOriginal:async(...args)=>{await base.journal.sealOriginal(...args);throw new Error('UNIT_SEAL_COMMIT_ACK_LOST');},
      readOriginal:async(...args)=>{readCounts.push(f.reservations.filter(lease=>lease.active&&lease.bytes===3*(131072+4096)).length);return base.journal.readOriginal(...args);}
    }};};
    const read=f.journal.readOriginal;f.journal.readOriginal=async(...args)=>{finalViewLoans=f.reservations.filter(lease=>lease.active&&lease.bytes===3*4*131072).length;return read(...args);};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});await f.service.idle();
      expect(Buffer.byteLength(JSON.stringify(f.host.script!.seal()))).toBeGreaterThan(f.input.limits.maxMetadataBytes);expect(readCounts).toHaveLength(2);expect(readCounts[1]).toBe(readCounts[0]+1);expect(finalViewLoans).toBeGreaterThanOrEqual(2);expect(f.memory.available()).toBe(f.memory.maxBytes);expect(f.calls.go).toBe(1);
    }finally{f.service.stopClaims();f.restore();}
  });
});

describe('W3-B confirmed creation absence',()=>{
  it('publishes only the linked original NO_CHILD_CREATED without GO raw or accounting',async()=>{
    const f=await windowsAdapterFixture();
    type Message=import('../../packages/native/src/windows-job-backend.js').WindowsHostMessage;
    type Control=import('../../packages/native/src/windows-job-backend.js').WindowsControl;
    type Final=import('../../packages/native/src/windows-job-backend.js').HostFinalized;
    const messages:Message[]=[],waiters:((item:IteratorResult<Message>)=>void)[]=[];let ended=false,opens=0,joins=0,finalized:Final|null=null;
    const push=(message:Message)=>{const waiter=waiters.shift();if(waiter)waiter({done:false,value:message});else messages.push(message);};
    const end=()=>{ended=true;for(const waiter of waiters.splice(0))waiter({done:true,value:undefined});};
    let joinResolve!:(value:{end:'EXPECTED';finalized:Final})=>void;const joined=new Promise<{end:'EXPECTED';finalized:Final}>(yes=>{joinResolve=yes;});
    const originalLoad=f.journal.loadOriginal;
    f.journal.loadOriginal=async(...args)=>{const attempt=await originalLoad(...args);if(attempt.snapshot.windowsEvidenceRef)attempt.snapshot.termination={jobId:f.input.frame.envelope.jobId,inputDigest:f.input.frame.envelope.inputDigest,profileDigest:f.input.frame.envelope.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:true,kind:'NO_CHILD_CREATED'};return attempt;};
    let script:ReturnType<typeof f.shared.windowsNativeScript>|undefined;
    f.host.broker.open=async capture=>{
      opens++;script=f.shared.windowsNativeScript({...capture.origin,frame:f.input.frame},'NOT_ATTEMPTED');
      const emit=(control:Control,message:Message['message'],payload:unknown)=>push({version:1,requestId:control.requestId,originDigest:capture.originDigest,attemptId:capture.origin.authority.attemptId,sessionId:capture.origin.authority.sessionId,launchId:capture.origin.authority.launchId,message,payload} as Message);
      return {send:async control=>{
        if(control.command==='PREPARE'){for(const row of script!.entries)emit(control,'EVENT',row);emit(control,'FINAL_CANDIDATE',{evidence:script!.evidence()});}
        else if(control.command==='PARENT_JOINED')Object.assign(script!.joinAck,control.payload);
        else if(control.command==='ACK_FINAL'){finalized={...control.payload,handles:'CLOSED',closeCode:null};emit(control,'FINALIZED',finalized);end();joinResolve({end:'EXPECTED',finalized});}
        else expect(control.command).toBe('ACK_EVENT');
      },events:{[Symbol.asyncIterator]:()=>({next:async()=>messages.length?{done:false,value:messages.shift()!}:ended?{done:true,value:undefined}:new Promise(resolve=>waiters.push(resolve))})},nativeInput:new Writable({write:(_c,_e,done)=>done()}),nativeOutput:{async *[Symbol.asyncIterator](){throw new Error('NO_CHILD_CANNOT_READ_NATIVE_STDOUT');yield Buffer.alloc(0);}},nativeError:{async *[Symbol.asyncIterator](){throw new Error('NO_CHILD_CANNOT_READ_NATIVE_STDERR');yield Buffer.alloc(0);}},join:()=>{joins++;return joined;}};
    };
    try{
      await f.service.serve(f.legacy.channel,f.prepare(),async()=>{});await f.service.idle();const final=await f.service.serve(f.legacy.channel,f.query(),async()=>{});
      expect(final.snapshot.termination?.kind).toBe('NO_CHILD_CREATED');expect(final.snapshot.windowsEvidenceRef).not.toBeNull();expect(final.snapshot.rawResult).toBeNull();expect(final.snapshot.phase).toBe('PREPARING');expect(f.calls).toMatchObject({capture:1,go:0,ready:0,put:0,get:0,finish:1});expect(script!.evidence().final.accounting).toBeNull();expect(opens).toBe(1);expect(joins).toBe(1);expect(f.clock.pending()).toBe(0);expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{f.service.stopClaims();f.restore();}
  });
});

describe('W3-B live reservation identity',()=>{
  it('rejects a different binding at the same reservation and preserves the original READY GO stop and idle',async()=>{
    const f=await windowsAdapterFixture(),load=f.journal.loadOriginal,offer=f.journal.offerOriginal;
    f.journal.loadOriginal=async(who,binding)=>{if(digest(binding)!==digest(f.input.identity.binding))throw Object.assign(new Error('NATIVE_CONTROL_BINDING_MISMATCH'),{code:'23514'});return load(who,binding);};
    f.journal.offerOriginal=async(who,binding,frame)=>{if(digest(binding)!==digest(f.input.identity.binding))throw new DomainError('WINDOWS_NATIVE_BINDING_MISMATCH',409,'WAIT');return offer(who,binding,frame);};
    try{
      const prepared=await f.service.serve(f.legacy.channel,f.prepare(),async()=>{}),other=f.prepare();other.control.binding={...other.control.binding,parentInstanceId:randomUUID()};
      await expect(f.service.serve(f.legacy.channel,other,async()=>{})).rejects.toBeDefined();
      const go=await f.service.serve(f.legacy.channel,f.goRequest(prepared.snapshot),async()=>{});expect(go.snapshot.phase).toBe('GO_GRANTED');
      await f.service.idle();f.service.stopClaims();await f.service.idle();expect(f.calls).toMatchObject({capture:1,offer:1,go:1,put:1,finish:1});expect(f.host.captures).toHaveLength(1);expect(f.clock.pending()).toBe(0);expect(f.memory.available()).toBe(f.memory.maxBytes);
    }finally{f.service.stopClaims();f.restore();}
  });
});
