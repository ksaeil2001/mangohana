import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {MediaProfile} from '../../media/src/profile.js';
import {digest} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {nativeKernelImplementationDigest} from './identity.js';
import {createNativeJob,describeNativeBlobs,nativeJsonBytes,validateNativeEnvelope,validateNativeLimits,verifyNativeInput,verifyNativeResult,NativeJobError,
  type NativeJob,type NativeResult,type NativeRunner,type NativeTask,type NativeLimits,type NativeFrameLimits,type NativeComputation,type NativeTermination} from './dto.js';
import {validateNativeJob} from './jobs.js';
import {validateNativeControllerBinding,validateNativeControllerResponse,type NativeControllerBinding,type NativeControllerRequest,type NativeControllerResponse,type NativeControllerSnapshot} from './controller-protocol.js';

// Trusted parent ports only. These functions are never serialized to TLS or a
// child. They admit original owning intent and attest original DB observations;
// they do not consume GO, record replacement RESULTs, or release capacity.
export type NativeRemoteOriginalPort={accountId:string;
  admit(job:NativeJob):Promise<NativeControllerBinding>;
  attest(job:NativeJob,binding:NativeControllerBinding,result:NativeResult,snapshot:NativeControllerSnapshot):Promise<void>};
export type NativeRemoteExchangePort={exchange(request:NativeControllerRequest,originalJob?:NativeJob):Promise<NativeControllerResponse>;shutdown():Promise<void>};
type Options={profile:MediaProfile;limits:NativeLimits;client:NativeRemoteExchangePort};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function plain(value:unknown,keys:readonly string[],code:string):void{
  requireCondition(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code,409,'WAIT');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]),code,409,'WAIT');
}
function originalPort(value:NativeRemoteOriginalPort):Readonly<NativeRemoteOriginalPort>{
  plain(value,['accountId','admit','attest'],'NATIVE_REMOTE_PORT_UNCONFIRMED');
  requireCondition(uuid.test(value.accountId)&&typeof value.admit==='function'&&typeof value.attest==='function','NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
  return Object.freeze({accountId:value.accountId,admit:value.admit.bind(value),attest:value.attest.bind(value)});
}

// One instance owns the total API/worker parent budget across all targets. The
// TLS port separately owns its complete socket/codec/writer budget. Neither is
// a physical RSS claim or privileged controller/subtree proof.
export class NativeRemoteController{
  static windows(options:NativeRemoteWindowsOptions):NativeRemoteControllerV2{return new WindowsRemoteController(options);}
  readonly parentInstanceId=randomUUID();
  readonly profileDigest:string;
  readonly kernelImplementationDigest=nativeKernelImplementationDigest();
  readonly observationIsolation:'OWNED_FIXTURE'|'LINUX_CGROUP_V2';
  private readonly profile:MediaProfile;
  private readonly limits:Readonly<NativeLimits>;
  private readonly client:NativeRemoteExchangePort;
  private readonly reservationBytes:number;
  private readonly active=new Set<Promise<unknown>>();
  private held=0;
  private accepting=true;
  private closed?:Promise<void>;
  constructor(options:Options){
    plain(options,['profile','limits','client'],'NATIVE_REMOTE_PORT_UNCONFIRMED');validateNativeLimits(options.limits);
    nativeJsonBytes(options.profile,options.limits.maxMetadataBytes);
    requireCondition(options.profile.enabled&&['SYNTHETIC','MEASURED'].includes(options.profile.kind)&&typeof options.client?.exchange==='function'&&typeof options.client.shutdown==='function','NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
    this.profile=Object.freeze(structuredClone(options.profile));this.profileDigest=digest(this.profile);this.observationIsolation=this.profile.kind==='SYNTHETIC'?'OWNED_FIXTURE':'LINUX_CGROUP_V2';this.limits=Object.freeze({...options.limits});
    this.client=Object.freeze({exchange:options.client.exchange.bind(options.client),shutdown:options.client.shutdown.bind(options.client)});
    const bytes=2*this.limits.maxInputBytes+2*this.limits.maxOutputBytes+6*this.limits.maxMetadataBytes+4096;
    requireCondition(Number.isSafeInteger(bytes)&&bytes<=this.limits.parentInFlightBytes,'NATIVE_PARENT_CAPACITY_WAIT',409,'WAIT');this.reservationBytes=bytes;
  }
  frameLimits(side:'input'|'output'):Readonly<NativeFrameLimits>{
    requireCondition(side==='input'||side==='output','NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');
    return Object.freeze({maxMetadataBytes:this.limits.maxMetadataBytes,maxBinaryBytes:side==='input'?this.limits.maxInputBytes:this.limits.maxOutputBytes,maxItems:this.limits.maxItems});
  }
  usage():Readonly<{reservedBytes:number;active:number;accepting:boolean}>{return Object.freeze({reservedBytes:this.held,active:this.active.size,accepting:this.accepting});}
  forPort(value:NativeRemoteOriginalPort):NativeRunner{
    const port=originalPort(value);
    return Object.freeze({run:(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:import('./dto.js').NativeRunHooks)=>{
      requireCondition(hooks===undefined,'NATIVE_REMOTE_PARENT_HOOKS_CONFLICT',409,'WAIT');return this.capture(port,task,metadata,blobs);
    }});
  }
  queryOriginal(value:NativeRemoteOriginalPort,jobValue:NativeJob,bindingValue:NativeControllerBinding):Promise<NativeComputation>{
    const began=performance.now(),port=originalPort(value);this.reserve();
    try{
      nativeJsonBytes(jobValue,this.limits.maxMetadataBytes);validateNativeEnvelope(jobValue,this.frameLimits('input'));verifyNativeInput(jobValue);
      const job=structuredClone(jobValue),binding=this.binding(port,job,bindingValue,false);
      return this.track(this.execute(port,job,new Map(),began,binding));
    }catch(error){this.held-=this.reservationBytes;throw error;}
  }
  private reserve():void{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
    requireCondition(this.held+this.reservationBytes<=this.limits.parentInFlightBytes,'NATIVE_PARENT_CAPACITY_WAIT',409,'WAIT');this.held+=this.reservationBytes;
  }
  private capture(port:Readonly<NativeRemoteOriginalPort>,task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>):Promise<NativeComputation>{
    const began=performance.now();this.reserve();
    try{
      requireCondition(blobs instanceof Map&&Object.getPrototypeOf(blobs)===Map.prototype&&Reflect.ownKeys(blobs).length===0,'NATIVE_BINARY_MISMATCH',422,'WAIT');
      const job=createNativeJob(task,this.profileDigest,metadata,blobs,this.frameLimits('input'));validateNativeJob({envelope:job,blobs});
      requireCondition(digest(job.metadata.profile)===this.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
      const captured=structuredClone(job),copied=new Map([...blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]));
      return this.track(this.execute(port,captured,copied,began));
    }catch(error){this.held-=this.reservationBytes;throw error;}
  }
  private track<T>(operation:Promise<T>):Promise<T>{this.active.add(operation);void operation.finally(()=>this.active.delete(operation)).catch(()=>{});return operation;}
  private binding(port:Readonly<NativeRemoteOriginalPort>,job:NativeJob,value:NativeControllerBinding,currentParent:boolean):NativeControllerBinding{
    const binding=validateNativeControllerBinding(value);
    requireCondition(binding.accountId===port.accountId&&binding.jobId===job.jobId&&binding.parentInstanceId===(currentParent?this.parentInstanceId:value.parentInstanceId)&&binding.inputDigest===job.inputDigest&&binding.profileDigest===this.profileDigest&&job.profileDigest===this.profileDigest&&binding.kernelDigest===this.kernelImplementationDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');return binding;
  }
  private async execute(port:Readonly<NativeRemoteOriginalPort>,job:NativeJob,blobs:Map<string,Buffer>,began:number,recovery?:NativeControllerBinding):Promise<NativeComputation>{
    const deadline=began+this.limits.timeoutMs;let binding:NativeControllerBinding|undefined,snapshot:NativeControllerSnapshot|undefined,goSent=false;
    const check=()=>requireCondition(this.accepting&&performance.now()<deadline,this.accepting?'NATIVE_JOB_TIMEOUT':'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
    try{
      binding=recovery??this.binding(port,job,await port.admit(structuredClone(job)),true);check();
      const request=(command:'PREPARE'|'QUERY'):NativeControllerRequest=>({control:command==='PREPARE'?{version:1,requestId:randomUUID(),binding:binding!,command}:{version:1,requestId:randomUUID(),binding:binding!,command,includeRawResult:true},...(command==='PREPARE'?{input:{envelope:job,blobs}}:{})});
      const exchange=async(value:NativeControllerRequest):Promise<NativeControllerResponse>=>{
        check();const response=await this.client.exchange(value,job);
        plain(response,Object.hasOwn(response,'rawResult')?['control','rawResult']:['control'],'NATIVE_CONTROL_RAW_MISMATCH');
        const control=validateNativeControllerResponse(response.control,this.limits.maxMetadataBytes,value.control);
        const hasRaw=value.control.command==='QUERY'&&value.control.includeRawResult&&control.snapshot.rawResult!==null;
        requireCondition(hasRaw===Object.hasOwn(response,'rawResult'),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
        if(hasRaw){plain(response.rawResult,['envelope','blobs'],'NATIVE_CONTROL_RAW_MISMATCH');requireCondition(response.rawResult!.blobs instanceof Map&&Object.getPrototypeOf(response.rawResult!.blobs)===Map.prototype&&Reflect.ownKeys(response.rawResult!.blobs).length===0,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');}
        requireCondition(!snapshot||control.snapshot.attemptId===snapshot.attemptId&&control.snapshot.controllerInstanceId===snapshot.controllerInstanceId,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
        snapshot=control.snapshot;check();return {...response,control};
      };
      let response=await exchange(request(recovery?'QUERY':'PREPARE'));
      if(!recovery&&snapshot!.phase==='READY'&&snapshot!.termination===null){
        const ready=snapshot!;goSent=true;
        response=await exchange({control:{version:1,requestId:randomUUID(),binding,command:'GO',attemptId:ready.attemptId,controllerInstanceId:ready.controllerInstanceId}});
      }
      for(;;){
        check();const current=snapshot!;
        // A raw allocation can be visible before its original PUT/receipt and
        // final TERM join. The coordinator's query-only projection suppresses
        // that frame with this exact transient code. It is not a new attempt
        // or success: only the same non-cost QUERY may wait for the final facts.
        const pendingRaw=current.code==='NATIVE_RAW_RESULT_UNCONFIRMED'&&current.phase==='GO_GRANTED'&&current.termination===null&&current.rawResult===null&&!response.rawResult;
        requireCondition(current.code==='OK'||pendingRaw,'NATIVE_REMOTE_EXECUTION_UNCONFIRMED',409,'WAIT');
        if(response.rawResult&&current.rawResult&&current.termination){
          const raw=response.rawResult;nativeJsonBytes(raw.envelope,this.limits.maxMetadataBytes);validateNativeEnvelope(raw.envelope,this.frameLimits('output'));verifyNativeResult(job,raw.envelope);
          requireCondition(digest(raw.envelope)===current.rawResult.resultDigest&&digest(describeNativeBlobs(raw.blobs,this.frameLimits('output')))===digest(raw.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
          requireCondition(current.phase==='GO_GRANTED'&&current.termination.operationJoined&&current.termination.directChildClosed&&current.termination.goAttempted&&current.termination.startedComputation&&['DIRECT_CHILD_ONLY','CGROUP_EMPTY'].includes(current.termination.kind),'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');
          await port.attest(structuredClone(job),structuredClone(binding),structuredClone(raw.envelope),structuredClone(current));check();
          // Parent attestation receives no binary data. Recheck the actual
          // result after its asynchronous DB acknowledgement before returning.
          requireCondition(digest(raw.envelope)===current.rawResult.resultDigest&&digest(describeNativeBlobs(raw.blobs,this.frameLimits('output')))===digest(raw.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
          return {metadata:structuredClone(raw.envelope.metadata),blobs:new Map([...raw.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))};
        }
        // This is non-cost-incurring original status lookup only. PREPARE and
        // GO occur once; any transport failure escapes without replaying them.
        await new Promise(resolve=>setTimeout(resolve,Math.min(25,Math.max(1,deadline-performance.now()))));
        response=await exchange(request('QUERY'));
      }
    }catch(error){
      const termination:NativeTermination=snapshot?.termination??{jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:goSent,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'};
      const code=error instanceof DomainError?error.code:'NATIVE_REMOTE_EXECUTION_UNCONFIRMED';
      throw new NativeJobError(code,error instanceof DomainError?error.status:409,error instanceof DomainError?error.nextAction:'WAIT',termination);
    }finally{
      // Every started exchange/DB acknowledgement is awaited. A deadline never
      // returns copied-buffer capacity while that original I/O is still live.
      this.held-=this.reservationBytes;
    }
  }
  stopClaims():void{this.accepting=false;}
  async idle():Promise<void>{while(this.active.size)await Promise.allSettled([...this.active]);}
  shutdown():Promise<void>{if(this.closed)return this.closed;this.stopClaims();this.closed=(async()=>{await this.idle();await this.client.shutdown();})();return this.closed;}
}

// Windows 경로는 명시 factory로만 고른다. V1 생성자와 부모 포트는 그대로 보존한다.
import {types as windowsTypes} from 'node:util';
import type {NextAction} from '../../contracts/src/errors.js';
import type {NativeTerminationV2,WindowsEvidenceRef} from './dto.js';
import {validateNativeControllerResponseV2,type NativeControllerRequestV2,type NativeControllerResponseV2,type NativeControllerSnapshotV2} from './controller-protocol.js';

export type NativeRemoteExchangePortV2={exchange(request:NativeControllerRequestV2,originalJob?:NativeJob):Promise<NativeControllerResponseV2>;shutdown():Promise<void>};
export type NativeRemoteOriginalPortV2={accountId:string;
  admit(job:NativeJob):Promise<NativeControllerBinding>;
  attest(job:NativeJob,binding:NativeControllerBinding,result:NativeResult,snapshot:NativeControllerSnapshotV2):Promise<void>};
export type NativeRemoteCostRef={evidenceId:string;evidenceDigest:string};
export type NativeRemoteResultResponseRef={requestId:string;responseDigest:string};
type CostedRemoteOriginalMethodsV2=NativeRemoteOriginalPortV2&{
  authorizeResultQuery(request:NativeControllerRequestV2):Promise<NativeRemoteCostRef|null>;
  finishResultQuery(request:NativeControllerRequestV2,responseRef:NativeRemoteResultResponseRef):Promise<NativeRemoteCostRef|null>;
};
declare const costedRemoteOriginalBrand:unique symbol;
export type CostedRemoteOriginalPortV2=Readonly<CostedRemoteOriginalMethodsV2>&{readonly [costedRemoteOriginalBrand]:true};
const costedRemotePorts=new WeakSet<object>();
export function createCostedRemoteOriginalPortV2(value:CostedRemoteOriginalMethodsV2):CostedRemoteOriginalPortV2{
  windowsPlain(value,['accountId','admit','attest','authorizeResultQuery','finishResultQuery']);
  requireCondition(typeof value.accountId==='string'&&uuid.test(value.accountId)&&['admit','attest','authorizeResultQuery','finishResultQuery'].every(key=>typeof Reflect.get(value,key)==='function'),'NATIVE_REMOTE_COST_PORT_UNCONFIRMED',409,'WAIT');
  const owned=Object.freeze({accountId:value.accountId,admit:value.admit.bind(value),attest:value.attest.bind(value),authorizeResultQuery:value.authorizeResultQuery.bind(value),finishResultQuery:value.finishResultQuery.bind(value)});
  const port=owned as CostedRemoteOriginalPortV2;
  costedRemotePorts.add(port);return port;
}
function costRef(value:NativeRemoteCostRef|null):void{
  windowsPlain(value,['evidenceId','evidenceDigest'],'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED');
  requireCondition(value!==null&&typeof value.evidenceId==='string'&&uuid.test(value.evidenceId)&&typeof value.evidenceDigest==='string'&&windowsHash.test(value.evidenceDigest),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
}
function freezeQuery(value:NativeControllerRequestV2):NativeControllerRequestV2{
  const request=structuredClone(value);Object.freeze(request.control.binding);Object.freeze(request.control);return Object.freeze(request);
}
export type NativeRemoteWindowsOptions={profile:MediaProfile;limits:NativeLimits;client:NativeRemoteExchangePortV2;windows:{version:2}};
export interface NativeRemoteControllerV2{
  readonly protocolVersion:2;
  readonly parentInstanceId:string;
  readonly profileDigest:string;
  readonly kernelImplementationDigest:string;
  readonly nativeLimitsDigest:string;
  readonly observationIsolation:'WINDOWS_JOB_OBJECT';
  frameLimits(side:'input'|'output'):Readonly<NativeFrameLimits>;
  usage():Readonly<{reservedBytes:number;active:number;accepting:boolean}>;
  forPort(port:NativeRemoteOriginalPortV2):NativeRunner;
  forCostedPort(port:CostedRemoteOriginalPortV2):NativeRunner;
  queryOriginal(port:NativeRemoteOriginalPortV2,job:NativeJob,binding:NativeControllerBinding):Promise<NativeComputation>;
  readOriginalMetadata(port:NativeRemoteOriginalPortV2,job:NativeJob,binding:NativeControllerBinding):Promise<NativeControllerSnapshotV2>;
  stopClaims():void;
  idle():Promise<void>;
  shutdown():Promise<void>;
}
const windowsHash=/^[a-f0-9]{64}$/;
function windowsPlain(value:unknown,keys:readonly string[],code='NATIVE_REMOTE_PORT_UNCONFIRMED'):void{
  requireCondition(!windowsTypes.isProxy(value),code,409,'WAIT');plain(value,keys,code);
}
function windowsOriginalPort(value:NativeRemoteOriginalPortV2):Readonly<NativeRemoteOriginalPortV2>{
  windowsPlain(value,['accountId','admit','attest']);
  requireCondition(uuid.test(value.accountId)&&typeof value.admit==='function'&&typeof value.attest==='function','NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
  return Object.freeze({accountId:value.accountId,admit:value.admit.bind(value),attest:value.attest.bind(value)});
}

// 부모 오류는 원 종료/ref만 보존한다. wire 자료 자체를 DB·비용·해제 증명으로 승격하지 않는다.
export class NativeJobErrorV2 extends DomainError{
  readonly version=2 as const;
  readonly termination:Readonly<NativeTerminationV2>;
  readonly windowsEvidenceRef:Readonly<WindowsEvidenceRef>|null;
  constructor(code:string,status:number,nextAction:NextAction,evidence:{version:2;termination:NativeTerminationV2;windowsEvidenceRef:WindowsEvidenceRef|null}){
    super(code,status,nextAction);const invalid='NATIVE_TERMINATION_UNCONFIRMED';
    windowsPlain(evidence,['version','termination','windowsEvidenceRef'],invalid);requireCondition(evidence.version===2,invalid,409,'WAIT');
    const term=evidence.termination;windowsPlain(term,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind'],invalid);
    requireCondition(typeof term.jobId==='string'&&uuid.test(term.jobId)&&typeof term.inputDigest==='string'&&windowsHash.test(term.inputDigest)&&typeof term.profileDigest==='string'&&windowsHash.test(term.profileDigest),invalid,409,'WAIT');
    for(const key of ['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'] as const)requireCondition(typeof term[key]==='boolean',invalid,409,'WAIT');
    requireCondition(!term.startedComputation||term.goAttempted,invalid,409,'WAIT');
    if(term.kind==='NO_CHILD_CREATED')requireCondition(term.operationJoined&&!term.goAttempted&&!term.startedComputation&&!term.directChildClosed&&!term.subtreeTerminationConfirmed,invalid,409,'WAIT');
    else if(term.kind==='WINDOWS_JOB_EMPTY')requireCondition(term.operationJoined&&term.directChildClosed&&term.subtreeTerminationConfirmed,invalid,409,'WAIT');
    else requireCondition(term.kind==='UNCONFIRMED'&&!term.subtreeTerminationConfirmed,invalid,409,'WAIT');
    const ref=evidence.windowsEvidenceRef;
    if(ref!==null){windowsPlain(ref,['recordId','recordDigest','linkId','linkDigest'],invalid);
      requireCondition(typeof ref.recordId==='string'&&uuid.test(ref.recordId)&&typeof ref.linkId==='string'&&uuid.test(ref.linkId)&&typeof ref.recordDigest==='string'&&windowsHash.test(ref.recordDigest)&&typeof ref.linkDigest==='string'&&windowsHash.test(ref.linkDigest),invalid,409,'WAIT');}
    this.termination=Object.freeze({...term});this.windowsEvidenceRef=ref===null?null:Object.freeze({...ref});Object.freeze(this);
  }
}

class WindowsRemoteController implements NativeRemoteControllerV2{
  readonly protocolVersion=2 as const;
  readonly parentInstanceId=randomUUID();
  readonly profileDigest:string;
  readonly kernelImplementationDigest=nativeKernelImplementationDigest();
  readonly nativeLimitsDigest:string;
  readonly observationIsolation='WINDOWS_JOB_OBJECT' as const;
  private readonly profile:MediaProfile;
  private readonly limits:Readonly<NativeLimits>;
  private readonly client:Readonly<NativeRemoteExchangePortV2>;
  private readonly reservationBytes:number;
  private readonly active=new Set<Promise<unknown>>();
  private held=0;
  private accepting=true;
  private closed?:Promise<void>;
  constructor(options:NativeRemoteWindowsOptions){
    windowsPlain(options,['profile','limits','client','windows']);windowsPlain(options.windows,['version']);
    requireCondition(options.windows.version===2,'NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
    windowsPlain(options.limits,['maxMetadataBytes','maxInputBytes','maxOutputBytes','maxItems','childMemoryBytes','maxProcesses','timeoutMs','terminationWaitMs','parentInFlightBytes'],'NATIVE_LIMIT_UNCONFIRMED');validateNativeLimits(options.limits);
    nativeJsonBytes(options.profile,options.limits.maxMetadataBytes);windowsPlain(options.client,['exchange','shutdown']);
    requireCondition(options.profile.enabled===true&&['SYNTHETIC','MEASURED'].includes(options.profile.kind)&&typeof options.client.exchange==='function'&&typeof options.client.shutdown==='function','NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
    this.profile=Object.freeze(structuredClone(options.profile));this.profileDigest=digest(this.profile);this.limits=Object.freeze({...options.limits});this.nativeLimitsDigest=digest(this.limits);
    this.client=Object.freeze({exchange:options.client.exchange.bind(options.client),shutdown:options.client.shutdown.bind(options.client)});
    const bytes=2*this.limits.maxInputBytes+2*this.limits.maxOutputBytes+6*this.limits.maxMetadataBytes+4096;
    requireCondition(Number.isSafeInteger(bytes)&&bytes<=this.limits.parentInFlightBytes,'NATIVE_PARENT_CAPACITY_WAIT',409,'WAIT');this.reservationBytes=bytes;
    for(const key of ['protocolVersion','parentInstanceId','profileDigest','kernelImplementationDigest','nativeLimitsDigest','observationIsolation'])Object.defineProperty(this,key,{writable:false,configurable:false});
  }
  frameLimits(side:'input'|'output'):Readonly<NativeFrameLimits>{
    requireCondition(side==='input'||side==='output','NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');
    return Object.freeze({maxMetadataBytes:this.limits.maxMetadataBytes,maxBinaryBytes:side==='input'?this.limits.maxInputBytes:this.limits.maxOutputBytes,maxItems:this.limits.maxItems});
  }
  usage():Readonly<{reservedBytes:number;active:number;accepting:boolean}>{return Object.freeze({reservedBytes:this.held,active:this.active.size,accepting:this.accepting});}
  forPort(value:NativeRemoteOriginalPortV2):NativeRunner{
    const port=windowsOriginalPort(value);
    return Object.freeze({run:(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:import('./dto.js').NativeRunHooks)=>{
      requireCondition(hooks===undefined,'NATIVE_REMOTE_PARENT_HOOKS_CONFLICT',409,'WAIT');return this.capture(port,task,metadata,blobs);
    }});
  }
  queryOriginal(value:NativeRemoteOriginalPortV2,jobValue:NativeJob,bindingValue:NativeControllerBinding):Promise<NativeComputation>{
    const began=performance.now(),port=windowsOriginalPort(value);this.reserve();
    try{const {job,binding}=this.original(port,jobValue,bindingValue);return this.track(()=>this.execute(port,job,new Map(),began,binding));}
    catch(error){this.held-=this.reservationBytes;throw error;}
  }
  readOriginalMetadata(value:NativeRemoteOriginalPortV2,jobValue:NativeJob,bindingValue:NativeControllerBinding):Promise<NativeControllerSnapshotV2>{
    const began=performance.now(),port=windowsOriginalPort(value);this.reserve();
    try{const {job,binding}=this.original(port,jobValue,bindingValue);return this.track(()=>this.metadata(job,binding,began));}
    catch(error){this.held-=this.reservationBytes;throw error;}
  }
  forCostedPort(port:CostedRemoteOriginalPortV2):NativeRunner{
    requireCondition(costedRemotePorts.has(port),'NATIVE_REMOTE_COST_PORT_UNCONFIRMED',409,'WAIT');
    return Object.freeze({run:(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:import('./dto.js').NativeRunHooks)=>{
      requireCondition(hooks===undefined,'NATIVE_REMOTE_PARENT_HOOKS_CONFLICT',409,'WAIT');return this.captureCosted(port,task,metadata,blobs);
    }});
  }
  private captureCosted(port:CostedRemoteOriginalPortV2,task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>):Promise<NativeComputation>{
    const began=performance.now();this.reserve();
    try{
      requireCondition(!windowsTypes.isProxy(blobs)&&blobs instanceof Map&&Object.getPrototypeOf(blobs)===Map.prototype&&Reflect.ownKeys(blobs).length===0,'NATIVE_BINARY_MISMATCH',422,'WAIT');
      const job=createNativeJob(task,this.profileDigest,metadata,blobs,this.frameLimits('input'));validateNativeJob({envelope:job,blobs});
      requireCondition(digest(job.metadata.profile)===this.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
      const captured=structuredClone(job),copied=new Map([...blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]));
      return this.track(()=>this.executeCosted(port,captured,copied,began));
    }catch(error){this.held-=this.reservationBytes;throw error;}
  }
  private original(port:Readonly<NativeRemoteOriginalPortV2>,jobValue:NativeJob,bindingValue:NativeControllerBinding):{job:NativeJob;binding:NativeControllerBinding}{
    nativeJsonBytes(jobValue,this.limits.maxMetadataBytes);validateNativeEnvelope(jobValue,this.frameLimits('input'));verifyNativeInput(jobValue);
    const job=structuredClone(jobValue);requireCondition(digest(job.metadata.profile)===this.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
    return {job,binding:this.binding(port,job,bindingValue,false)};
  }
  private reserve():void{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
    requireCondition(this.held+this.reservationBytes<=this.limits.parentInFlightBytes,'NATIVE_PARENT_CAPACITY_WAIT',409,'WAIT');this.held+=this.reservationBytes;
  }
  private capture(port:Readonly<NativeRemoteOriginalPortV2>,task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>):Promise<NativeComputation>{
    const began=performance.now();this.reserve();
    try{
      requireCondition(!windowsTypes.isProxy(blobs)&&blobs instanceof Map&&Object.getPrototypeOf(blobs)===Map.prototype&&Reflect.ownKeys(blobs).length===0,'NATIVE_BINARY_MISMATCH',422,'WAIT');
      const job=createNativeJob(task,this.profileDigest,metadata,blobs,this.frameLimits('input'));validateNativeJob({envelope:job,blobs});
      requireCondition(digest(job.metadata.profile)===this.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
      const captured=structuredClone(job),copied=new Map([...blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]));
      return this.track(()=>this.execute(port,captured,copied,began));
    }catch(error){this.held-=this.reservationBytes;throw error;}
  }
  private track<T>(work:()=>Promise<T>):Promise<T>{
    // 첫 I/O보다 먼저 active를 등록한다. stop/deadline도 시작한 I/O의 실제 완료를 기다린다.
    const operation=Promise.resolve().then(work);this.active.add(operation);void operation.then(()=>this.active.delete(operation),()=>this.active.delete(operation));return operation;
  }
  private binding(port:Readonly<NativeRemoteOriginalPortV2>,job:NativeJob,value:NativeControllerBinding,currentParent:boolean):NativeControllerBinding{
    const binding=validateNativeControllerBinding(value);
    requireCondition(binding.accountId===port.accountId&&binding.jobId===job.jobId&&(!currentParent||binding.parentInstanceId===this.parentInstanceId)&&binding.inputDigest===job.inputDigest&&binding.profileDigest===this.profileDigest&&job.profileDigest===this.profileDigest&&binding.kernelDigest===this.kernelImplementationDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');return binding;
  }
  private check(deadline:number):void{requireCondition(this.accepting&&performance.now()<deadline,this.accepting?'NATIVE_JOB_TIMEOUT':'NATIVE_SHUTDOWN_WAIT',409,'WAIT');}
  private error(error:unknown,job:NativeJob,snapshot:NativeControllerSnapshotV2|undefined,goSent:boolean):NativeJobErrorV2{
    if(error instanceof NativeJobErrorV2)return error;
    const termination:NativeTerminationV2=snapshot?.termination??{jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:goSent,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'};
    return new NativeJobErrorV2(error instanceof DomainError?error.code:'NATIVE_REMOTE_EXECUTION_UNCONFIRMED',error instanceof DomainError?error.status:409,error instanceof DomainError?error.nextAction:'WAIT',{version:2,termination,windowsEvidenceRef:snapshot?.windowsEvidenceRef??null});
  }
  private async response(request:NativeControllerRequestV2,job:NativeJob,previous?:NativeControllerSnapshotV2):Promise<NativeControllerResponseV2>{
    const expected=structuredClone(request.control),response=await this.client.exchange(request,structuredClone(job));
    windowsPlain(response,Object.hasOwn(response,'rawResult')?['control','rawResult']:['control'],'NATIVE_CONTROL_RAW_MISMATCH');
    const control=validateNativeControllerResponseV2(response.control,this.limits.maxMetadataBytes,expected),current=control.snapshot;
    const hasRaw=expected.command==='QUERY'&&expected.includeRawResult&&current.rawResult!==null;
    requireCondition(hasRaw===Object.hasOwn(response,'rawResult'),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    if(hasRaw){windowsPlain(response.rawResult,['envelope','blobs'],'NATIVE_CONTROL_RAW_MISMATCH');
      requireCondition(!windowsTypes.isProxy(response.rawResult!.blobs)&&response.rawResult!.blobs instanceof Map&&Object.getPrototypeOf(response.rawResult!.blobs)===Map.prototype&&Reflect.ownKeys(response.rawResult!.blobs).length===0,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');}
    if(previous){
      requireCondition(current.attemptId===previous.attemptId&&current.controllerInstanceId===previous.controllerInstanceId,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
      for(const key of ['windowsEvidenceRef','rawResult','termination'] as const)if(previous[key]!==null)requireCondition(current[key]!==null&&digest(current[key])===digest(previous[key]),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    }
    return {...response,control};
  }
  private verifyRaw(job:NativeJob,response:NativeControllerResponseV2):void{
    const raw=response.rawResult!,current=response.control.snapshot;
    nativeJsonBytes(raw.envelope,this.limits.maxMetadataBytes);validateNativeEnvelope(raw.envelope,this.frameLimits('output'));verifyNativeResult(job,raw.envelope);
    requireCondition(digest(raw.envelope)===current.rawResult!.resultDigest&&digest(describeNativeBlobs(raw.blobs,this.frameLimits('output')))===digest(raw.envelope.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
  }
  private async metadata(job:NativeJob,binding:NativeControllerBinding,began:number):Promise<NativeControllerSnapshotV2>{
    const deadline=began+this.limits.timeoutMs;let snapshot:NativeControllerSnapshotV2|undefined;
    try{this.check(deadline);const response=await this.response({control:{version:2,requestId:randomUUID(),binding,command:'QUERY',includeRawResult:false}},job);snapshot=response.control.snapshot;this.check(deadline);return structuredClone(snapshot);}
    catch(error){throw this.error(error,job,snapshot,false);}
    finally{this.held-=this.reservationBytes;}
  }
  private async execute(port:Readonly<NativeRemoteOriginalPortV2>,job:NativeJob,blobs:Map<string,Buffer>,began:number,recovery?:NativeControllerBinding):Promise<NativeComputation>{
    const deadline=began+this.limits.timeoutMs;let snapshot:NativeControllerSnapshotV2|undefined,goSent=false;
    try{
      this.check(deadline);const binding=recovery??this.binding(port,job,await port.admit(structuredClone(job)),true);this.check(deadline);
      const request=(command:'PREPARE'|'QUERY'):NativeControllerRequestV2=>({control:command==='PREPARE'?{version:2,requestId:randomUUID(),binding:structuredClone(binding),command}:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command,includeRawResult:true},...(command==='PREPARE'?{input:{envelope:structuredClone(job),blobs}}:{})});
      const exchange=async(value:NativeControllerRequestV2):Promise<NativeControllerResponseV2>=>{this.check(deadline);const response=await this.response(value,job,snapshot);snapshot=response.control.snapshot;this.check(deadline);return response;};
      let response=await exchange(request(recovery?'QUERY':'PREPARE'));
      // READY 권한은 최초 PREPARE ACK에만 있다. 뒤늦은 QUERY READY는 새 GO를 만들지 않는다.
      const first=snapshot!;
      if(!recovery&&(first.code==='OK'||first.code==='WINDOWS_EVIDENCE_PENDING')&&first.phase==='READY'&&first.termination===null&&first.windowsEvidenceRef===null&&first.rawResult===null&&!response.rawResult){
        goSent=true;response=await exchange({control:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command:'GO',attemptId:first.attemptId,controllerInstanceId:first.controllerInstanceId}});
      }
      for(;;){
        this.check(deadline);const current=snapshot!;
        if(current.termination?.kind==='NO_CHILD_CREATED')throw new DomainError(current.code==='OK'?'NATIVE_REMOTE_EXECUTION_UNCONFIRMED':current.code,409,'WAIT');
        const empty=current.termination===null&&current.windowsEvidenceRef===null&&current.rawResult===null&&!response.rawResult;
        const progress=empty&&['PREPARING','GO_GRANTED'].includes(current.phase)&&(current.code==='OK'||current.code==='WINDOWS_EVIDENCE_PENDING');
        requireCondition(current.phase!=='UNKNOWN'&&(current.code==='OK'||progress),'NATIVE_REMOTE_EXECUTION_UNCONFIRMED',409,'WAIT');
        if(response.rawResult&&current.rawResult&&current.termination&&current.windowsEvidenceRef){
          requireCondition(current.phase==='GO_GRANTED'&&current.termination.kind==='WINDOWS_JOB_EMPTY'&&current.termination.operationJoined&&current.termination.directChildClosed&&current.termination.subtreeTerminationConfirmed&&current.termination.goAttempted&&current.termination.startedComputation,'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');
          this.verifyRaw(job,response);
          await port.attest(structuredClone(job),structuredClone(binding),structuredClone(response.rawResult.envelope),structuredClone(current));this.check(deadline);
          // attest에는 bytes를 넘기지 않는다. 비동기 확인 이후 실제 frame을 다시 검사한다.
          this.verifyRaw(job,response);
          return {metadata:structuredClone(response.rawResult.envelope.metadata),blobs:new Map([...response.rawResult.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))};
        }
        // 최종 ACK는 raw를 싣지 않으므로 QUERY 한 번만 이어간다. QUERY의 최종 raw 거부는 즉시 WAIT다.
        const finalAck=response.control.command!=='QUERY'&&current.rawResult!==null&&current.termination!==null&&current.windowsEvidenceRef!==null;
        requireCondition(progress||finalAck,'NATIVE_REMOTE_EXECUTION_UNCONFIRMED',409,'WAIT');
        if(!finalAck)await new Promise(resolve=>setTimeout(resolve,Math.min(25,Math.max(1,deadline-performance.now()))));
        response=await exchange(request('QUERY'));
      }
    }catch(error){throw this.error(error,job,snapshot,goSent);}
    finally{this.held-=this.reservationBytes;}
  }
  private async executeCosted(port:CostedRemoteOriginalPortV2,job:NativeJob,blobs:Map<string,Buffer>,began:number):Promise<NativeComputation>{
    const deadline=began+this.limits.timeoutMs;let snapshot:NativeControllerSnapshotV2|undefined,goSent=false;
    try{
      this.check(deadline);const binding=this.binding(port,job,await port.admit(structuredClone(job)),true);this.check(deadline);
      const exchange=async(request:NativeControllerRequestV2):Promise<NativeControllerResponseV2>=>{this.check(deadline);const result=await this.response(request,job,snapshot);snapshot=result.control.snapshot;this.check(deadline);return result;};
      let response=await exchange({control:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command:'PREPARE'},input:{envelope:structuredClone(job),blobs}});
      const first=snapshot!;
      if((first.code==='OK'||first.code==='WINDOWS_EVIDENCE_PENDING')&&first.phase==='READY'&&first.termination===null&&first.windowsEvidenceRef===null&&first.rawResult===null&&!response.rawResult){
        goSent=true;response=await exchange({control:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command:'GO',attemptId:first.attemptId,controllerInstanceId:first.controllerInstanceId}});
      }
      // 비용형만 metadata로 진행을 확인한다. ordinary V2의 polling은 바꾸지 않는다.
      for(;;){
        this.check(deadline);const current=snapshot!;
        if(current.termination?.kind==='NO_CHILD_CREATED')throw new DomainError(current.code==='OK'?'NATIVE_REMOTE_EXECUTION_UNCONFIRMED':current.code,409,'WAIT');
        const empty=current.termination===null&&current.windowsEvidenceRef===null&&current.rawResult===null&&!response.rawResult;
        const progress=empty&&['PREPARING','GO_GRANTED'].includes(current.phase)&&(current.code==='OK'||current.code==='WINDOWS_EVIDENCE_PENDING');
        const final=current.phase==='GO_GRANTED'&&current.code==='OK'&&current.rawResult!==null&&current.termination!==null&&current.windowsEvidenceRef!==null;
        requireCondition(progress||final||response.control.command==='PREPARE'&&current.phase==='READY'&&(current.code==='OK'||current.code==='WINDOWS_EVIDENCE_PENDING'),'NATIVE_REMOTE_EXECUTION_UNCONFIRMED',409,'WAIT');
        if(final&&response.control.command==='QUERY')break;
        if(response.control.command==='QUERY')await new Promise(resolve=>setTimeout(resolve,Math.min(25,Math.max(1,deadline-performance.now()))));
        response=await exchange({control:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command:'QUERY',includeRawResult:false}});
      }
      const final=snapshot!;
      requireCondition(final.termination?.kind==='WINDOWS_JOB_EMPTY'&&final.termination.operationJoined&&final.termination.directChildClosed&&final.termination.subtreeTerminationConfirmed&&final.termination.goAttempted&&final.termination.startedComputation,'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');
      const request=freezeQuery({control:{version:2,requestId:randomUUID(),binding:structuredClone(binding),command:'QUERY',includeRawResult:true}});
      // ACK 불명은 새 ID/GET으로 대체하지 않는다. 모든 원 promise는 이 실행이 join한다.
      costRef(await port.authorizeResultQuery(request));this.check(deadline);
      response=await exchange(request);const current=snapshot!;
      requireCondition(current.phase==='GO_GRANTED'&&current.code==='OK'&&response.rawResult&&current.rawResult&&current.windowsEvidenceRef&&current.termination?.kind==='WINDOWS_JOB_EMPTY'&&current.termination.operationJoined&&current.termination.directChildClosed&&current.termination.subtreeTerminationConfirmed&&current.termination.goAttempted&&current.termination.startedComputation,'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
      this.verifyRaw(job,response);
      const responseRef=Object.freeze({requestId:request.control.requestId,responseDigest:digest({control:response.control,rawResult:response.rawResult.envelope})});
      costRef(await port.finishResultQuery(request,responseRef));this.check(deadline);this.verifyRaw(job,response);
      await port.attest(structuredClone(job),structuredClone(binding),structuredClone(response.rawResult.envelope),structuredClone(current));this.check(deadline);this.verifyRaw(job,response);
      return {metadata:structuredClone(response.rawResult.envelope.metadata),blobs:new Map([...response.rawResult.blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))};
    }catch(error){throw this.error(error,job,snapshot,goSent);}
    finally{this.held-=this.reservationBytes;}
  }
  stopClaims():void{this.accepting=false;}
  async idle():Promise<void>{while(this.active.size)await Promise.allSettled([...this.active]);}
  shutdown():Promise<void>{if(this.closed)return this.closed;this.stopClaims();this.closed=(async()=>{await this.idle();await this.client.shutdown();})();return this.closed;}
}
