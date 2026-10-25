import {randomUUID} from 'node:crypto';
import type {Writable} from 'node:stream';
import type {WindowsOriginalController} from './controller.js';
import {digest} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {nativeJsonBytes,describeNativeBlobs,validateNativeEnvelope,verifyNativeInput,verifyNativeResult,type NativeJob,type NativeResult,type NativeRunHooks,type NativeComputation,type NativeJobEvidence,type NativeTermination,type NativeFrameLimits} from './dto.js';
import {validateNativeJob} from './jobs.js';
import type {NativeFrame} from './frame.js';
import {validateNativeControllerBinding,validateNativeControllerRequest,validateNativeControllerSnapshot,type NativeControllerBinding,type NativeControllerRequest,type NativeControllerResponse,type NativeControllerResponseControl,type NativeControllerSnapshot,type NativeRawResultReference,type NativeControllerSnapshotV2,type NativeControllerRequestV2,type NativeControllerResponseV2,type NativeControllerResponseControlV2,validateNativeControllerSnapshotV2,validateNativeControllerRequestV2,readNativeControllerRequest,writeNativeControllerResponse} from './controller-protocol.js';

// Trusted ports of the controller process. A transport authenticates the peer;
// each store transaction must independently check the original native intent,
// reservation, INPUT, profile, caller ownership/current target and durable GO.
// None of these ports, identities or return values are accepted from wire JSON.
export type NativeControllerPeer={serviceRole:'trio_web_api'|'trio_web_worker';peerId:string};
export interface NativeControllerPeerVerifier{authenticate(transport:unknown):Promise<NativeControllerPeer>}
export type NativeOriginalAttempt={binding:NativeControllerBinding;job:NativeJob;snapshot:NativeControllerSnapshot};
export type NativeOriginalAttemptV2={binding:NativeControllerBinding;job:NativeJob;snapshot:NativeControllerSnapshotV2};
export type NativeOriginalAttemptAny=NativeOriginalAttempt|NativeOriginalAttemptV2;
export type NativeControllerMemoryOwner={readonly maxBytes:number;available():number;hold(bytes:number):()=>void};
export function createNativeControllerMemory(maxBytes:number):NativeControllerMemoryOwner{
  requireCondition(Number.isSafeInteger(maxBytes)&&maxBytes>0,'NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');let held=0;
  return Object.freeze({maxBytes,available:()=>maxBytes-held,hold:(bytes:number)=>{
    requireCondition(Number.isSafeInteger(bytes)&&bytes>=0&&held+bytes<=maxBytes,'NATIVE_CONTROL_CAPACITY_WAIT',409,'WAIT');held+=bytes;let active=true;
    return ()=>{if(active){active=false;held-=bytes;}};
  }});
}
export interface NativeControllerAttemptStore{
  claim(peer:NativeControllerPeer,binding:NativeControllerBinding,job:NativeJob,attemptId:string,controllerInstanceId:string):Promise<{created:boolean;attempt:NativeOriginalAttempt}>;
  load(peer:NativeControllerPeer,binding:NativeControllerBinding):Promise<NativeOriginalAttempt>;
  ready(peer:NativeControllerPeer,attempt:NativeOriginalAttempt):Promise<NativeOriginalAttempt>;
  grantGo(peer:NativeControllerPeer,attempt:NativeOriginalAttempt):Promise<{created:boolean;attempt:NativeOriginalAttempt}>;
  observe(peer:NativeControllerPeer,attempt:NativeOriginalAttempt,event:'OBSERVATION'|'TERMINATION',evidence:NativeJobEvidence,termination:NativeTermination,result:NativeResult|null):Promise<void>;
  unknown(peer:NativeControllerPeer,attempt:NativeOriginalAttempt,code:string):Promise<void>;
}
export type NativeRawAllocation={attemptId:string;reference:NativeRawResultReference;result:NativeResult};
export type NativeControllerRawReadContext={purpose:'RUN_RECOVERY'}|{purpose:'PARENT_QUERY';requestId:string;requestDigest:string};
export interface NativeControllerRawStore{
  // Allocate original opaque object refs and the original target/asset retention
  // boundary durably before returning. A replay cannot allocate another set.
  allocate(peer:NativeControllerPeer,attempt:NativeOriginalAttemptAny,result:NativeResult):Promise<NativeRawAllocation>;
  putOriginal(peer:NativeControllerPeer,allocation:NativeRawAllocation,blobs:Map<string,Buffer>):Promise<void>;
  // This operation can only compare existing refs/receipts/GET bytes; never PUT.
  readExisting(peer:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context?:NativeControllerRawReadContext):Promise<NativeFrame<NativeResult>|null>;
}
export interface NativeCapturedAttemptRunner{
  readonly parentInstanceId:string;readonly profileDigest:string;readonly kernelImplementationDigest:string;
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>;
  runCaptured(job:NativeJob,blobs:Map<string,Buffer>,hooks:NativeRunHooks):Promise<NativeComputation>;
  stopClaims():void;idle():Promise<void>;reconcileTerminations():Promise<void>;
}
type Live={attempt:NativeOriginalAttempt;ready:Promise<NativeOriginalAttempt>;resolveReady:(attempt:NativeOriginalAttempt)=>void;grant:Promise<void>;resolveGrant:()=>void;rejectGrant:(error:Error)=>void;operation:Promise<void>;timer:ReturnType<typeof setTimeout>;goForwarded:boolean};
type Hold={bytes:number;logicalJoined:boolean;nativeExpected:boolean;nativeJoined:boolean;nativeOperationJoined:boolean;pending:number;released:boolean};
function deferred<T>(){let resolve:(value:T)=>void=()=>{},reject:(reason:Error)=>void=()=>{};const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};}
const key=(binding:NativeControllerBinding)=>`${binding.accountId}/${binding.capacityReservationId}`;

// This coordinator does not construct a listener, credentials, a privileged
// controller or a production factory. Missing real ports leave activation OFF.
export class NativeControllerAttempts{
  private accepting=true;
  private readonly live=new Map<string,Live>();
  private readonly operations=new Set<Promise<void>>();
  private readonly ioPending=new Set<Promise<unknown>>();
  private readonly holds=new Set<Hold>();
  private held=0;
  private readonly runner:NativeCapturedAttemptRunner;
  private readonly peers:NativeControllerPeerVerifier;
  private readonly store:NativeControllerAttemptStore;
  private readonly raw:NativeControllerRawStore;
  private readonly bounds:{maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number};
  private readonly windows:WindowsOriginalController|null;
  private readonly windowsIo=new Set<Promise<unknown>>();
  private readonly windowsWireHolds=new Set<()=>void>();
  constructor(controller:WindowsOriginalController,peers:NativeControllerPeerVerifier,bounds:{maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number});
  constructor(runner:NativeCapturedAttemptRunner,peers:NativeControllerPeerVerifier,store:NativeControllerAttemptStore,raw:NativeControllerRawStore,bounds:{maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number});
  constructor(runner:NativeCapturedAttemptRunner|WindowsOriginalController,peers:NativeControllerPeerVerifier,storeOrBounds:NativeControllerAttemptStore|{maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number},raw?:NativeControllerRawStore,legacyBounds?:{maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number}){
    this.windows='kind' in runner&&runner.kind==='WINDOWS_JOB_OBJECT'?runner:null;
    this.runner=runner as NativeCapturedAttemptRunner;this.peers=peers;
    this.store=storeOrBounds as NativeControllerAttemptStore;this.raw=raw!;
    const bounds=this.windows?storeOrBounds as {maxControlBytes:number;goWaitMilliseconds:number;maxInFlightBytes:number}:legacyBounds!;
    requireCondition(this.windows?raw===undefined&&legacyBounds===undefined:!!raw&&!!legacyBounds,'NATIVE_CONTROLLER_CONFIG_UNCONFIRMED',409,'WAIT');
    if(this.windows)requireCondition(this.windows.memory.maxBytes===bounds.maxInFlightBytes,'NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');
    requireCondition(Number.isSafeInteger(bounds.maxControlBytes)&&bounds.maxControlBytes>0&&Number.isSafeInteger(bounds.goWaitMilliseconds)&&bounds.goWaitMilliseconds>0&&bounds.goWaitMilliseconds<=2_147_483_647&&Number.isSafeInteger(bounds.maxInFlightBytes)&&bounds.maxInFlightBytes>0,'NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');
    this.bounds=Object.freeze({...bounds});
  }
  private release(hold:Hold):void{if(!hold.released&&hold.logicalJoined&&!hold.pending&&(!hold.nativeExpected||(hold.nativeJoined&&hold.nativeOperationJoined))){hold.released=true;this.held-=hold.bytes;this.holds.delete(hold);}}
  private io<T>(hold:Hold,promise:Promise<T>):Promise<T>{hold.pending++;const tracked=promise.finally(()=>{hold.pending--;this.ioPending.delete(tracked);this.release(hold);});this.ioPending.add(tracked);void tracked.catch(()=>{});return tracked;}
  private reserve(inputBytes:number):Hold{
    const input=this.runner.frameLimits('input'),output=this.runner.frameLimits('output'),bytes=2*inputBytes+2*output.maxBinaryBytes+2*input.maxMetadataBytes+2*output.maxMetadataBytes+2*this.bounds.maxControlBytes+32;
    requireCondition(Number.isSafeInteger(bytes)&&this.held+bytes<=this.bounds.maxInFlightBytes,'NATIVE_CONTROL_CAPACITY_WAIT',409,'WAIT');
    const hold:Hold={bytes,logicalJoined:false,nativeExpected:false,nativeJoined:false,nativeOperationJoined:false,pending:0,released:false};this.held+=bytes;this.holds.add(hold);return hold;
  }
  private record(value:NativeOriginalAttempt,binding:NativeControllerBinding):NativeOriginalAttempt{
    nativeJsonBytes(value.job,this.runner.frameLimits('input').maxMetadataBytes);const original=structuredClone(value.job);
    validateNativeEnvelope(original,this.runner.frameLimits('input'));verifyNativeInput(original);
    const actual=validateNativeControllerBinding(value.binding),snapshot=validateNativeControllerSnapshot(value.snapshot,actual);
    requireCondition(digest(actual)===digest(binding)&&original.jobId===binding.jobId&&original.inputDigest===binding.inputDigest&&original.profileDigest===binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    return {binding:actual,job:original,snapshot};
  }
  private originalRecord(value:NativeOriginalAttempt,original:NativeOriginalAttempt):NativeOriginalAttempt{
    const record=this.record(value,original.binding);
    requireCondition(record.snapshot.attemptId===original.snapshot.attemptId&&record.snapshot.controllerInstanceId===original.snapshot.controllerInstanceId,'NATIVE_CONTROL_ATTEMPT_UNCONFIRMED',409,'WAIT');
    return record;
  }
  private async start(peer:NativeControllerPeer,attempt:NativeOriginalAttempt,input:NativeFrame<NativeJob>,hold:Hold):Promise<NativeOriginalAttempt>{
    const ready=deferred<NativeOriginalAttempt>(),grant=deferred<void>();
    const live:Live={attempt,ready:ready.promise,resolveReady:ready.resolve,grant:grant.promise,resolveGrant:()=>grant.resolve(),rejectGrant:grant.reject,operation:Promise.resolve(),timer:setTimeout(()=>grant.reject(new DomainError('NATIVE_CONTROL_GO_WAIT',409,'WAIT')),this.bounds.goWaitMilliseconds),goForwarded:false};
    this.live.set(key(attempt.binding),live);
    const original=(job:NativeJob)=>requireCondition(digest(job)===digest(attempt.job),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    const hooks:NativeRunHooks={
      intent:async job=>{original(job);},
      consumeGo:async job=>{original(job);live.attempt=this.originalRecord(await this.io(hold,this.store.ready(peer,structuredClone(live.attempt))),attempt);requireCondition(live.attempt.snapshot.phase==='READY','NATIVE_CONTROL_READY_UNCONFIRMED',409,'WAIT');live.resolveReady(structuredClone(live.attempt));await live.grant;},
      rawResult:async(job,result,blobs)=>{
        original(job);verifyNativeResult(attempt.job,result);const allocation=await this.io(hold,this.raw.allocate(peer,structuredClone(attempt),structuredClone(result)));
        requireCondition(allocation.attemptId===attempt.snapshot.attemptId&&digest(allocation.result)===digest(result)&&allocation.reference.resultDigest===digest(result),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
        await this.io(hold,this.raw.putOriginal(peer,allocation,blobs));
      },
      observation:async(job,evidence,termination,result)=>{original(job);await this.io(hold,this.store.observe(peer,structuredClone(attempt),'OBSERVATION',structuredClone(evidence),structuredClone(termination),result?structuredClone(result):null));},
      termination:async(job,evidence,termination)=>{original(job);await this.io(hold,this.store.observe(peer,structuredClone(attempt),'TERMINATION',structuredClone(evidence),structuredClone(termination),null));requireCondition(termination.operationJoined&&termination.kind!=='UNCONFIRMED','NATIVE_CONTROL_JOIN_UNCONFIRMED',409,'WAIT');hold.nativeJoined=true;this.release(hold);}
    };
    live.operation=(async()=>{
      try{await this.runner.runCaptured(input.envelope,input.blobs,hooks);}
      catch(error){const code=error instanceof DomainError?error.code:'NATIVE_CONTROL_UNCONFIRMED';await this.io(hold,this.store.unknown(peer,structuredClone(attempt),code));}
      finally{try{clearTimeout(live.timer);live.rejectGrant(new DomainError('NATIVE_CONTROL_ATTEMPT_JOINED',409,'WAIT'));this.live.delete(key(attempt.binding));live.resolveReady(this.originalRecord(await this.io(hold,this.store.load(peer,attempt.binding)),attempt));}finally{hold.nativeOperationJoined=true;this.release(hold);}}
    })();
    this.operations.add(live.operation);void live.operation.finally(()=>this.operations.delete(live.operation)).catch(()=>{});
    // If ready acknowledgement is lost, the operation ends conservatively. An
    // existing record, even from this same instance with an empty map, cannot
    // call start again. The store must retain that original uncertainty.
    return Promise.race([live.ready,live.operation.then(()=>this.record(live.attempt,attempt.binding))]);
  }
  // reply is the server's writer and must join its actual outbound I/O. A
  // controller termination alone never releases pending sender/read buffers.
  private async serveLegacy(transport:unknown,request:NativeControllerRequest,reply:(response:NativeControllerResponse)=>Promise<void>):Promise<NativeControllerResponseControl>{
    const control=validateNativeControllerRequest(request.control,this.bounds.maxControlBytes),binding=control.binding;
    let captured:NativeFrame<NativeJob>|undefined;
    if(control.command==='PREPARE'){
      requireCondition(request.input,'NATIVE_CONTROL_INVALID',422,'WAIT');validateNativeEnvelope(request.input.envelope,this.runner.frameLimits('input'));validateNativeJob(request.input);
      requireCondition(request.input.envelope.jobId===binding.jobId&&request.input.envelope.inputDigest===binding.inputDigest&&request.input.envelope.profileDigest===binding.profileDigest&&binding.profileDigest===this.runner.profileDigest&&binding.kernelDigest===this.runner.kernelImplementationDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    }else requireCondition(!request.input,'NATIVE_CONTROL_INVALID',422,'WAIT');
    const hold=this.reserve(request.input?.envelope.blobs.reduce((sum,blob)=>sum+blob.byteLength,0)??0);
    try{
    if(request.input)captured={envelope:structuredClone(request.input.envelope),blobs:new Map([...request.input.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))};
    const peer=await this.io(hold,this.peers.authenticate(transport));let attempt:NativeOriginalAttempt;
    if(control.command==='PREPARE'){
      requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');requireCondition(request.input,'NATIVE_CONTROL_INVALID',422,'WAIT');
      requireCondition(captured,'NATIVE_CONTROL_INVALID',422,'WAIT');
      const attemptId=randomUUID(),claimed=await this.io(hold,this.store.claim(peer,binding,structuredClone(captured.envelope),attemptId,this.runner.parentInstanceId));attempt=this.record(claimed.attempt,binding);
      if(claimed.created){requireCondition(attempt.snapshot.attemptId===attemptId&&attempt.snapshot.controllerInstanceId===this.runner.parentInstanceId&&attempt.snapshot.phase==='PREPARING'&&digest(attempt.job)===digest(captured.envelope)&&!attempt.snapshot.termination&&!attempt.snapshot.rawResult,'NATIVE_CONTROL_ATTEMPT_UNCONFIRMED',409,'WAIT');hold.nativeExpected=true;attempt=await this.start(peer,attempt,captured,hold);}
    }else{
      attempt=this.record(await this.io(hold,this.store.load(peer,binding)),binding);
      if(control.command==='GO'){
        requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const live=this.live.get(key(binding));
        requireCondition(live&&live.attempt.snapshot.attemptId===control.attemptId&&live.attempt.snapshot.controllerInstanceId===control.controllerInstanceId&&control.controllerInstanceId===this.runner.parentInstanceId&&binding.profileDigest===this.runner.profileDigest&&binding.kernelDigest===this.runner.kernelImplementationDigest,'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED',409,'WAIT');
        this.originalRecord(attempt,live.attempt);
        if(!live.goForwarded){const grant=await this.io(hold,this.store.grantGo(peer,structuredClone(live.attempt)));attempt=this.originalRecord(grant.attempt,live.attempt);requireCondition(attempt.snapshot.phase==='GO_GRANTED','NATIVE_CONTROL_GO_UNCONFIRMED',409,'WAIT');
          if(grant.created){requireCondition(this.accepting&&this.live.get(key(binding))===live,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');live.goForwarded=true;clearTimeout(live.timer);live.attempt=attempt;live.resolveGrant();}}
      }
    }
    const response:NativeControllerResponse={control:{version:1,requestId:control.requestId,command:control.command,binding,snapshot:structuredClone(attempt.snapshot)}};
    if(control.command==='QUERY'&&control.includeRawResult&&attempt.snapshot.rawResult){
      const frame=await this.io(hold,this.raw.readExisting(peer,attempt));
      if(frame){validateNativeEnvelope(frame.envelope,this.runner.frameLimits('output'));verifyNativeResult(attempt.job,frame.envelope);requireCondition(digest(frame.envelope)===attempt.snapshot.rawResult.resultDigest&&digest(describeNativeBlobs(frame.blobs,this.runner.frameLimits('output')))===digest(frame.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');response.rawResult=frame;}
      else response.control.snapshot={...attempt.snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'};
    }
    await this.io(hold,reply(response));return response.control;
    }finally{hold.logicalJoined=true;this.release(hold);}
  }
  serve(transport:unknown,request:NativeControllerRequest,reply:(response:NativeControllerResponse)=>Promise<void>):Promise<NativeControllerResponseControl>;
  serve(transport:unknown,request:NativeControllerRequestV2,reply:(response:NativeControllerResponseV2)=>Promise<void>):Promise<NativeControllerResponseControlV2>;
  async serve(transport:unknown,request:NativeControllerRequest|NativeControllerRequestV2,reply:((response:NativeControllerResponse)=>Promise<void>)|((response:NativeControllerResponseV2)=>Promise<void>)):Promise<NativeControllerResponseControl|NativeControllerResponseControlV2>{
    if(this.windows)return this.windowsWork(()=>this.serveWindows(transport,request as NativeControllerRequestV2,reply as (response:NativeControllerResponseV2)=>Promise<void>));
    requireCondition(request.control.version===1,'NATIVE_CONTROLLER_VERSION_UNCONFIRMED',409,'WAIT');
    return this.serveLegacy(transport,request as NativeControllerRequest,reply as (response:NativeControllerResponse)=>Promise<void>);
  }
  private windowsWork<T>(fn:()=>Promise<T>):Promise<T>{
    let work:Promise<T>;try{work=Promise.resolve(fn());}catch(error){work=Promise.reject(error);}
    this.windowsIo.add(work);void work.then(()=>this.windowsIo.delete(work),()=>this.windowsIo.delete(work));return work;
  }
  private async serveWindows(transport:unknown,request:NativeControllerRequestV2,reply:(response:NativeControllerResponseV2)=>Promise<void>):Promise<NativeControllerResponseControlV2>{
    const controller=this.windows!;
    requireCondition(request.control.version===2,'NATIVE_CONTROLLER_VERSION_UNCONFIRMED',409,'WAIT');
    const control=validateNativeControllerRequestV2(request.control,this.bounds.maxControlBytes);
    const binding=control.binding,input=controller.frameLimits('input'),output=controller.frameLimits('output');
    requireCondition(binding.profileDigest===controller.profileDigest&&binding.kernelDigest===controller.kernelImplementationDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    if(control.command==='PREPARE'){
      requireCondition(this.accepting&&request.input,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');validateNativeEnvelope(request.input.envelope,input);validateNativeJob(request.input);
      requireCondition(request.input.envelope.jobId===binding.jobId&&request.input.envelope.inputDigest===binding.inputDigest&&request.input.envelope.profileDigest===binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    }else requireCondition(!request.input,'NATIVE_CONTROL_INVALID',422,'WAIT');
    const inputBytes=request.input?.envelope.blobs.reduce((sum,blob)=>sum+blob.byteLength,0)??0;
    const bytes=2*inputBytes+2*output.maxBinaryBytes+2*input.maxMetadataBytes+2*output.maxMetadataBytes+2*this.bounds.maxControlBytes+32;
    const release=controller.memory.hold(bytes);let releaseResult:(()=>void)|undefined;
    let captured:NativeFrame<NativeJob>|undefined;
    try{
      releaseResult=controller.memory.hold(3*(input.maxMetadataBytes+this.bounds.maxControlBytes+4096));
      if(request.input)captured={envelope:structuredClone(request.input.envelope),blobs:new Map([...request.input.blobs].map(([id,buffer])=>[id,Buffer.from(buffer)]))};
      const who=await this.peers.authenticate(transport);let attempt:NativeOriginalAttemptV2;
      if(control.command==='PREPARE')attempt=await controller.prepareOriginal(who,binding,captured!);
      else{
        attempt=await controller.loadOriginal(who,binding);
        if(control.command==='GO'){
          requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
          requireCondition(attempt.snapshot.attemptId===control.attemptId&&attempt.snapshot.controllerInstanceId===control.controllerInstanceId&&control.controllerInstanceId===controller.controllerInstanceId,'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED',409,'WAIT');
          attempt=await controller.grantOriginal(who,attempt,this.bounds.goWaitMilliseconds);
        }
      }
      requireCondition(digest(attempt.binding)===digest(binding)&&attempt.job.jobId===binding.jobId&&attempt.job.inputDigest===binding.inputDigest&&attempt.job.profileDigest===binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
      const snapshot=validateNativeControllerSnapshotV2(attempt.snapshot,binding);
      const response:NativeControllerResponseV2={control:{version:2,requestId:control.requestId,command:control.command,binding,snapshot}};
      if(control.command==='QUERY'&&control.includeRawResult&&snapshot.rawResult){
        const raw=await controller.readRawOriginal(who,attempt,{purpose:'PARENT_QUERY',requestId:control.requestId,requestDigest:digest(control)});
        if(raw){validateNativeEnvelope(raw.envelope,output);verifyNativeResult(attempt.job,raw.envelope);requireCondition(digest(raw.envelope)===snapshot.rawResult.resultDigest&&digest(describeNativeBlobs(raw.blobs,output))===digest(raw.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');response.rawResult=raw;}
        else response.control.snapshot={...snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'};
      }
      await reply(response);return response.control;
    }finally{captured=undefined;releaseResult?.();release();}
  }
  serveFramed(transport:unknown,source:AsyncIterable<Uint8Array>,destination:Writable):Promise<NativeControllerResponseControlV2>{
    requireCondition(this.windows,'NATIVE_CONTROLLER_VERSION_UNCONFIRMED',409,'WAIT');
    return this.windowsWork(async()=>{
      const controller=this.windows!,limits={maxControlBytes:this.bounds.maxControlBytes,input:controller.frameLimits('input'),output:controller.frameLimits('output')};
      const inbound=24+limits.maxControlBytes+limits.input.maxMetadataBytes+limits.input.maxBinaryBytes,outbound=24+limits.maxControlBytes+limits.output.maxMetadataBytes+limits.output.maxBinaryBytes;
      const release=controller.memory.hold(3*(inbound+outbound));this.windowsWireHolds.add(release);
      let iterator:AsyncIterator<Uint8Array>|undefined,ended=false,received=0;
      const bounded:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>{
        requireCondition(!iterator,'NATIVE_PROTOCOL_INVALID',422,'WAIT');iterator=source[Symbol.asyncIterator]();
        return {next:async()=>{const next=await iterator!.next();if(next.done){ended=true;return next;}requireCondition(next.value instanceof Uint8Array&&next.value.byteLength<=inbound,'NATIVE_BINARY_LIMIT',413,'WAIT');received+=next.value.byteLength;requireCondition(Number.isSafeInteger(received)&&received<=inbound,'NATIVE_BINARY_LIMIT',413,'WAIT');return next;}};
      }};
      try{
        const request=await readNativeControllerRequest(bounded,limits,2);requireCondition(request.control.version===2,'NATIVE_CONTROLLER_VERSION_UNCONFIRMED',409,'WAIT');
        return await this.serveWindows(transport,request as NativeControllerRequestV2,response=>writeNativeControllerResponse(destination,response,limits,request.control));
      }finally{
        try{if(iterator&&!ended){requireCondition(typeof iterator.return==='function','NATIVE_CONTROL_JOIN_UNCONFIRMED',409,'WAIT');const end=await iterator.return();requireCondition(end.done===true,'NATIVE_CONTROL_JOIN_UNCONFIRMED',409,'WAIT');ended=true;}}
        finally{if(!iterator||ended){this.windowsWireHolds.delete(release);release();}}
      }
    });
  }
  stopClaims():void{this.accepting=false;if(this.windows){this.windows.stopClaims();return;}this.runner.stopClaims();for(const live of this.live.values())live.rejectGrant(new DomainError('NATIVE_SHUTDOWN_WAIT',409,'WAIT'));}
  async idle():Promise<void>{if(this.windows){while(this.windowsIo.size)await Promise.allSettled([...this.windowsIo]);await this.windows.idle();requireCondition(this.windowsWireHolds.size===0,'NATIVE_CONTROL_JOIN_UNCONFIRMED',409,'WAIT');return;}while(this.operations.size)await Promise.all([...this.operations]);while(this.ioPending.size)await Promise.allSettled([...this.ioPending]);await this.runner.idle();requireCondition(!this.holds.size,'NATIVE_CONTROL_JOIN_UNCONFIRMED',409,'WAIT');}
  async reconcileTerminations():Promise<void>{if(this.windows)await this.windows.reconcileTerminations();else await this.runner.reconcileTerminations();}
}
