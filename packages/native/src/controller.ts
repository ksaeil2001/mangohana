import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,lstat,realpath,writeFile,chown,chmod} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {DomainError,requireCondition,type NextAction} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {createNativeJob,nativeJsonBytes,describeNativeBlobs,validateNativeEnvelope,validateNativeLimits,verifyNativeInput,verifyNativeResult,NativeJobError,type NativeJob,type NativeComputation,type NativeLimits,type NativeResult,type NativeRunner,type NativeTask,type NativeTermination,type NativeJobEvidence,type NativeRunHooks,type NativeFrameLimits} from './dto.js';
import {NativeReader,readNativeFrame,writeNativeBytes,writeNativeFrame} from './frame.js';
import {LinuxCgroupIsolation,OwnedDirectChildIsolation,type OwnedNativeIsolation,type NativeBoundary} from './isolation.js';
import {nativeKernelImplementationDigest} from './identity.js';
import {validateNativeJob} from './jobs.js';
import type {NativeControllerMemoryOwner,NativeControllerPeer,NativeOriginalAttemptV2,NativeControllerRawStore,NativeControllerRawReadContext} from './controller-attempts.js';
import type {NativeControllerBinding,NativeRawResultReference} from './controller-protocol.js';
import type {WindowsEvidenceRef} from './dto.js';
import type {NativeFrame} from './frame.js';
import {createWindowsJobBackend,type WindowsPrepareInput,type WindowsJobPorts,type OriginalCapture,type WindowsPreparedAttempt,type ParentJoinAck,type WindowsJobOutcome,type HostFinalized,type OriginalRef,type WindowsSealEnvelope,type WindowsJobBackend,type JournalEntry,type WindowsHostMessage,type BrokerSession} from './windows-job-backend.js';

type Backend=OwnedNativeIsolation|LinuxCgroupIsolation;
export type {NativeJobEvidence} from './dto.js';
export type NativeChildLifecycleObservation=Readonly<{
  version:1;event:'SPAWNED'|'CLOSED';eventId:string;
  jobId:string;inputDigest:string;profileDigest:string;parentInstanceId:string;
  pid:number;observedMonotonicMs:number;exitCode:number|null;signal:NodeJS.Signals|null;
}>;
type Options={profile:MediaProfile;limits:NativeLimits;directoryRoot?:string;observe?:(evidence:NativeJobEvidence)=>void;observeChild?:(event:NativeChildLifecycleObservation)=>void};
type Close={code:number|null;signal:NodeJS.Signals|null};
type Attempt={job:NativeJob;hooks?:NativeRunHooks;result?:NativeResult;copied:Map<string,Buffer>;held:number;inputBytes:number;outputBytes:number;startedAt:number;deadline:number;cancelled:boolean;goAttempted:boolean;startedComputation:boolean;operationJoined:boolean;finalizationComplete:boolean;released:boolean;disposing:boolean;subtree:boolean;controlsPending:number;auditsPending:number;recordAttempted:boolean;proofAttempted:boolean;proofWritten:boolean;proofConfirmed:boolean;proofSnapshot?:{termination:NativeTermination;evidence:NativeJobEvidence};code:string;directory?:string;boundary?:NativeBoundary;child?:ChildProcessWithoutNullStreams;closed?:Close;closePromise?:Promise<Close>};
const bootstrap=fileURLToPath(new URL('./bootstrap.mjs',import.meta.url));
const wait=Buffer.from('WAIT_V1\n'),ready=Buffer.from('READY_V1\n');
const failureActions=new Set<NextAction>(['REFETCH','WAIT','NEW_CAPTURE','RESELECT_UPLOAD']);
const boundedWait=async<T>(promise:Promise<T>,milliseconds:number):Promise<T|null>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,milliseconds));})]);}finally{if(timer)clearTimeout(timer);}};

export class NativeController implements NativeRunner {
  readonly supportsParentHooks=true as const;
  readonly parentInstanceId=randomUUID();
  readonly profileDigest:string;
  private accepting=true;
  private parentHeld=0;
  private readonly active=new Set<Promise<unknown>>();
  private readonly unresolved=new Set<Attempt>();
  private readonly options:Options;
  private readonly implementationDigest:string;
  private constructor(options:Options,private readonly isolation:Backend){validateNativeLimits(options.limits);this.options={...options,profile:Object.freeze(structuredClone(options.profile)),limits:Object.freeze({...options.limits})};this.profileDigest=digest(this.options.profile);this.implementationDigest=nativeKernelImplementationDigest();}
  get kernelImplementationDigest():string{return this.implementationDigest;}
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>{
    requireCondition(direction==='input'||direction==='output','NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');const limits=this.options.limits;
    return Object.freeze({maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:direction==='input'?limits.maxInputBytes:limits.maxOutputBytes,maxItems:limits.maxItems});
  }
  static owned(options:Options&{isolation?:OwnedNativeIsolation}):NativeController {
    requireCondition(options.profile.kind==='SYNTHETIC'&&options.profile.enabled&&(!options.isolation||options.isolation.kind==='OWNED_FIXTURE'),'NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    return new NativeController(options,options.isolation??new OwnedDirectChildIsolation());
  }
  static async linux(options:Options&{cgroupRoot:string;childUid:number;childGid:number}):Promise<NativeController>{
    requireCondition(options.profile.kind==='MEASURED'&&options.profile.enabled,'NATIVE_HOST_UNCONFIRMED',409,'WAIT');validateNativeLimits(options.limits);
    // The root-owned cgroup backend is a host-validation candidate. It does not
    // authorize running the API/worker and its secrets as UID 0. A separately
    // owned privileged controller and immutable code/secret permissions still
    // need an implemented and verified service boundary before activation.
    throw new DomainError('NATIVE_RESOURCE_CONTROLLER_UNCONFIRMED',409,'WAIT');
  }
  stopClaims():void{this.accepting=false;}
  async idle():Promise<void>{
    while(this.active.size)await Promise.allSettled([...this.active]);
    requireCondition(this.unresolved.size===0,'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');
  }
  async reconcileTerminations():Promise<void>{
    for(const attempt of [...this.unresolved]){
      await this.terminate(attempt);
      // Retry only the same final proof. Neither the intent nor GO nor compute
      // is replayed, and a still-running observation is never duplicated.
      if(attempt.operationJoined&&!attempt.auditsPending&&!attempt.controlsPending&&!attempt.proofConfirmed)attempt.proofAttempted=false;
      await this.dispose(attempt);
    }
  }
  run(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:NativeRunHooks):Promise<NativeComputation>{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');return this.track(this.execute(task,metadata,blobs,hooks));
  }
  // Trusted owned callers can preserve an already captured frame. This is not
  // durable admission, one-time GO authority or privileged host proof.
  runCaptured(job:NativeJob,blobs:Map<string,Buffer>,hooks?:NativeRunHooks):Promise<NativeComputation>{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');return this.track(this.executeCaptured(job,blobs,hooks));
  }
  private async executeCaptured(job:NativeJob,blobs:Map<string,Buffer>,hooks?:NativeRunHooks):Promise<NativeComputation>{
    const startedAt=performance.now();validateNativeEnvelope(job,this.frameLimits('input'));verifyNativeInput(job);
    requireCondition(job.profileDigest===this.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
    return this.execute(job.task,job.metadata,blobs,hooks,job,startedAt);
  }
  private track<T>(promise:Promise<T>):Promise<T>{this.active.add(promise);void promise.finally(()=>this.active.delete(promise)).catch(()=>{});return promise;}
  private checkpoint(attempt:Attempt):void{requireCondition(!attempt.cancelled&&performance.now()<attempt.deadline,'NATIVE_JOB_TIMEOUT',409,'WAIT');}
  private snapshot(attempt:Attempt):NativeTermination{
    const kind=!attempt.operationJoined?'UNCONFIRMED':!attempt.child?'NO_CHILD_CREATED':!attempt.closed?'UNCONFIRMED':attempt.subtree?'CGROUP_EMPTY':this.isolation.kind==='OWNED_FIXTURE'?'DIRECT_CHILD_ONLY':'UNCONFIRMED';
    return {jobId:attempt.job.jobId,inputDigest:attempt.job.inputDigest,profileDigest:attempt.job.profileDigest,goAttempted:attempt.goAttempted,startedComputation:attempt.startedComputation,directChildClosed:!!attempt.closed,subtreeTerminationConfirmed:attempt.subtree,operationJoined:attempt.operationJoined,kind};
  }
  private evidence(attempt:Attempt):NativeJobEvidence{
    const termination=this.snapshot(attempt);return {version:1,jobId:attempt.job.jobId,task:attempt.job.task,inputDigest:attempt.job.inputDigest,profileDigest:attempt.job.profileDigest,isolation:this.isolation.kind,
      state:attempt.code==='OK'?'SUCCEEDED':termination.kind==='UNCONFIRMED'?'UNKNOWN':'FAILED',code:attempt.code,goAttempted:attempt.goAttempted,startedComputation:attempt.startedComputation,directChildClosed:!!attempt.closed,subtreeTerminationConfirmed:attempt.subtree,operationJoined:attempt.operationJoined,elapsedMs:performance.now()-attempt.startedAt,inputBytes:attempt.inputBytes,outputBytes:attempt.outputBytes};
  }
  private async audit(attempt:Attempt):Promise<void>{
    if(attempt.recordAttempted||(!attempt.directory&&!attempt.hooks))return;attempt.recordAttempted=true;attempt.auditsPending++;
    const evidence=this.evidence(attempt),termination=this.snapshot(attempt);
    const writing=this.track((async()=>{if(attempt.directory)await writeFile(path.join(attempt.directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});await attempt.hooks?.observation(attempt.job,evidence,termination,attempt.result??null);})().catch(()=>{throw new DomainError('NATIVE_EVIDENCE_UNCONFIRMED',409,'WAIT');}));
    const observed=this.track(writing.finally(async()=>{attempt.auditsPending--;if(attempt.finalizationComplete)await this.dispose(attempt);}));
    const result=await boundedWait(observed,this.options.limits.terminationWaitMs);
    requireCondition(result!==null,'NATIVE_EVIDENCE_UNCONFIRMED',409,'WAIT');
    try{this.options.observe?.(evidence);}catch{/* Observers cannot establish or change execution facts. */}
  }
  private control<T>(attempt:Attempt,promise:Promise<T>):Promise<T>{
    attempt.controlsPending++;return this.track(promise.finally(async()=>{attempt.controlsPending--;if(attempt.finalizationComplete)await this.dispose(attempt);}));
  }
  private async terminate(attempt:Attempt):Promise<void>{
    attempt.child?.kill('SIGKILL');const deadline=performance.now()+this.options.limits.terminationWaitMs;
    const boundary=attempt.boundary;
    if(boundary)await boundedWait(this.control(attempt,boundary.killSubtree().catch(()=>{})),Math.max(1,deadline-performance.now()));
    if(attempt.closePromise)await boundedWait(attempt.closePromise,Math.max(1,deadline-performance.now()));
    if(boundary){const empty=await boundedWait(this.control(attempt,boundary.empty(deadline).catch(()=>false)),Math.max(1,deadline-performance.now()));attempt.subtree=this.isolation instanceof LinuxCgroupIsolation&&empty===true;}
  }
  private async dispose(attempt:Attempt):Promise<void>{
    if(attempt.released||attempt.disposing||!attempt.finalizationComplete)return;attempt.disposing=true;
    try{
      if(!attempt.operationJoined){this.unresolved.add(attempt);return;}
      if(attempt.cancelled)await this.terminate(attempt);
      if(!attempt.recordAttempted&&(attempt.directory||attempt.hooks))await this.audit(attempt).catch(()=>{});
      const stopped=!attempt.child||(!!attempt.closed&&(this.isolation.kind==='OWNED_FIXTURE'||attempt.subtree));
      if(!stopped||attempt.controlsPending||attempt.auditsPending){this.unresolved.add(attempt);return;}
      if((attempt.directory||attempt.hooks)&&!attempt.proofAttempted){
        attempt.proofAttempted=true;attempt.auditsPending++;
        attempt.proofSnapshot??={termination:this.snapshot(attempt),evidence:this.evidence(attempt)};
        const {termination,evidence}=attempt.proofSnapshot;
        const writing=this.track((async()=>{if(attempt.directory&&!attempt.proofWritten){await writeFile(path.join(attempt.directory,'termination.json'),JSON.stringify(termination,null,2)+'\n',{flag:'wx',mode:0o600});attempt.proofWritten=true;}await attempt.hooks?.termination(attempt.job,evidence,termination);attempt.proofConfirmed=true;})());
        const observed=this.track(writing.finally(async()=>{attempt.auditsPending--;if(!attempt.disposing)await this.dispose(attempt);}));
        await boundedWait(observed,this.options.limits.terminationWaitMs).catch(()=>null);
      }
      if(attempt.auditsPending||((attempt.directory||attempt.hooks)&&!attempt.proofConfirmed)){this.unresolved.add(attempt);return;}
      if(attempt.boundary&&attempt.subtree){await this.control(attempt,attempt.boundary.close()).catch(()=>{});if(attempt.controlsPending){this.unresolved.add(attempt);return;}}
      attempt.copied.clear();this.parentHeld-=attempt.held;attempt.released=true;this.unresolved.delete(attempt);
    }finally{attempt.disposing=false;}
  }
  private async execute(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:NativeRunHooks,original?:NativeJob,startedAt=performance.now()):Promise<NativeComputation>{
    const limits=this.options.limits;
    const inputLimits={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems};
    requireCondition(metadata.profile&&digest(metadata.profile)===digest(this.options.profile),'NATIVE_PROFILE_MISMATCH',409,'WAIT');
    const job=createNativeJob(task,digest(this.options.profile),metadata,blobs,inputLimits,original?.jobId as ReturnType<typeof randomUUID>|undefined),inputBytes=job.blobs.reduce((sum,item)=>sum+item.byteLength,0);
    if(original){requireCondition(job.inputDigest===original.inputDigest,'NATIVE_INPUT_MISMATCH',422);validateNativeJob({envelope:job,blobs});}
    // Original inputs, immutable copies, output receive buffers and metadata
    // coexist in this attempt. The caller's complete asset maps remain a
    // separate, unverified parent-service memory boundary.
    const held=2*inputBytes+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32;
    requireCondition(Number.isSafeInteger(held)&&this.parentHeld+held<=limits.parentInFlightBytes,'NATIVE_CAPACITY_WAIT',409,'WAIT');this.parentHeld+=held;
    const attempt:Attempt={job,hooks,copied:new Map(),held,inputBytes,outputBytes:0,startedAt,deadline:startedAt+limits.timeoutMs,cancelled:false,goAttempted:false,startedComputation:false,operationJoined:false,finalizationComplete:false,released:false,disposing:false,subtree:false,controlsPending:0,auditsPending:0,recordAttempted:false,proofAttempted:false,proofWritten:false,proofConfirmed:false,code:'NATIVE_JOB_FAILED'};
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{attempt.cancelled=true;attempt.code='NATIVE_JOB_TIMEOUT';attempt.child?.kill('SIGKILL');if(attempt.boundary)void this.control(attempt,attempt.boundary.killSubtree()).catch(()=>{});reject(new DomainError('NATIVE_JOB_TIMEOUT',409,'WAIT'));},Math.max(1,attempt.deadline-performance.now()));});
    // Track the operation independently from its timeout response. Late setup
    // awaits keep their buffers and drain before idle or capacity can complete.
    const operation=this.track(this.operate(attempt,blobs,original!==undefined).finally(async()=>{attempt.operationJoined=true;if(attempt.finalizationComplete)await this.dispose(attempt);}));
    try{
      const output=await Promise.race([operation,timeout]);this.checkpoint(attempt);
      // Stage time includes setup, transfer, compute, output and termination.
      // Persisting the audit is a separate bounded finalization.
      if(timer)clearTimeout(timer);timer=undefined;attempt.code='OK';
      await this.audit(attempt);return output;
    }catch(error){
      if(timer)clearTimeout(timer);timer=undefined;attempt.cancelled=true;
      const code=attempt.code==='NATIVE_JOB_TIMEOUT'?'NATIVE_JOB_TIMEOUT':error instanceof DomainError?error.code:'NATIVE_JOB_FAILED';attempt.code=code;
      await this.terminate(attempt);try{await this.audit(attempt);}catch{if(code!=='NATIVE_JOB_TIMEOUT')attempt.code='NATIVE_EVIDENCE_UNCONFIRMED';}
      const status=error instanceof DomainError?error.status:409,nextAction=error instanceof DomainError?error.nextAction:'WAIT';
      throw new NativeJobError(attempt.code,status,nextAction,this.snapshot(attempt));
    }finally{if(timer)clearTimeout(timer);attempt.finalizationComplete=true;await this.dispose(attempt);if(attempt.code==='OK'&&!attempt.released)throw new NativeJobError('NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT',this.snapshot(attempt));}
  }
  private async operate(attempt:Attempt,blobs:Map<string,Buffer>,captured=false):Promise<NativeComputation>{
    const limits=this.options.limits;const inputLimits={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems};const outputLimits={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxOutputBytes,maxItems:limits.maxItems};
    this.checkpoint(attempt);
    if(captured){for(const descriptor of attempt.job.blobs)attempt.copied.set(descriptor.id,Buffer.from(blobs.get(descriptor.id)!));this.checkpoint(attempt);}
    await attempt.hooks?.intent(attempt.job);this.checkpoint(attempt);
    if(!captured)for(const descriptor of attempt.job.blobs)attempt.copied.set(descriptor.id,Buffer.from(blobs.get(descriptor.id)!));this.checkpoint(attempt);
    const root=path.resolve(this.options.directoryRoot??tmpdir());const stat=await lstat(root);this.checkpoint(attempt);const canonical=await realpath(root);this.checkpoint(attempt);requireCondition(stat.isDirectory()&&!stat.isSymbolicLink()&&root===canonical,'NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    attempt.directory=await mkdtemp(path.join(root,'trio-native-'));this.checkpoint(attempt);await chmod(attempt.directory,0o711);this.checkpoint(attempt);
    const scratch=path.join(attempt.directory,'work');await mkdir(scratch,{mode:0o700});this.checkpoint(attempt);
    if(this.isolation instanceof LinuxCgroupIsolation){await chown(scratch,this.isolation.childUid,this.isolation.childGid);this.checkpoint(attempt);}
    attempt.boundary=await this.isolation.create(attempt.job.jobId,limits);this.checkpoint(attempt);
    const env:NodeJS.ProcessEnv={TEMP:scratch,TMP:scratch,TMPDIR:scratch,TRIO_NATIVE_JOB_DIRECTORY:scratch};if(process.platform==='win32'){if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;if(process.env.WINDIR)env.WINDIR=process.env.WINDIR;}
    this.checkpoint(attempt);const child=spawn(process.execPath,[bootstrap,JSON.stringify({inputLimits,outputLimits})],{cwd:scratch,env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,...(this.isolation instanceof LinuxCgroupIsolation?{uid:this.isolation.childUid,gid:this.isolation.childGid}:{})});attempt.child=child;
    child.stdin.on('error',()=>{});let stderrBytes=0;child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>1024)child.kill('SIGKILL');});
    const observer=this.options.observeChild,identity={jobId:attempt.job.jobId,inputDigest:attempt.job.inputDigest,profileDigest:attempt.job.profileDigest,parentInstanceId:this.parentInstanceId};
    let observedPid:number|undefined;
    const observeChild=(event:NativeChildLifecycleObservation['event'],code:number|null,signal:NodeJS.Signals|null)=>{
      if(!observer||observedPid===undefined)return;
      // 부모 진단 사본은 실행/종료/비용의 권한이나 영속 증거가 아니다.
      try{observer(Object.freeze({version:1,event,eventId:randomUUID(),...identity,pid:observedPid,observedMonotonicMs:performance.now(),exitCode:code,signal}));}catch{/* 진단의 동기 예외는 원 작업 판정을 바꾸지 않는다. */}
    };
    if(observer)child.once('spawn',()=>{const pid=child.pid;if(pid!==undefined&&Number.isSafeInteger(pid)&&pid>0){observedPid=pid;observeChild('SPAWNED',null,null);}});
    attempt.closePromise=new Promise<Close>(resolve=>{child.once('close',(code,signal)=>{attempt.closed={code,signal};observeChild('CLOSED',code,signal);resolve(attempt.closed);});});child.on('error',()=>{});
    const reader=new NativeReader(child.stdout,wait.length+ready.length+12+limits.maxMetadataBytes+limits.maxOutputBytes);
    const initial=await reader.exact(wait.length);this.checkpoint(attempt);requireCondition(initial.equals(wait)&&child.pid,'NATIVE_BOOTSTRAP_INVALID',409,'WAIT');await attempt.boundary.attach(child.pid!);this.checkpoint(attempt);
    await attempt.hooks?.consumeGo(attempt.job);this.checkpoint(attempt);attempt.goAttempted=true;await writeNativeBytes(child.stdin,Buffer.from('GO_V1\n'));attempt.startedComputation=true;this.checkpoint(attempt);const loaded=await reader.exact(ready.length);this.checkpoint(attempt);requireCondition(loaded.equals(ready),'NATIVE_BOOTSTRAP_INVALID',409,'WAIT');
    await writeNativeFrame(child.stdin,{envelope:attempt.job,blobs:attempt.copied},inputLimits);this.checkpoint(attempt);child.stdin.end();const result=await readNativeFrame<NativeResult>(reader,outputLimits);this.checkpoint(attempt);verifyNativeResult(attempt.job,result.envelope);attempt.result=result.envelope;attempt.outputBytes=result.envelope.blobs.reduce((sum,item)=>sum+item.byteLength,0);
    const exit=await attempt.closePromise;this.checkpoint(attempt);requireCondition(exit.code===0&&exit.signal===null,'NATIVE_JOB_FAILED',409,'WAIT');await this.control(attempt,attempt.boundary.killSubtree());this.checkpoint(attempt);const empty=await this.control(attempt,attempt.boundary.empty(attempt.deadline));this.checkpoint(attempt);attempt.subtree=this.isolation instanceof LinuxCgroupIsolation&&empty;
    if(this.isolation instanceof LinuxCgroupIsolation)requireCondition(attempt.subtree,'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');
    const failure=result.envelope.metadata.nativeFailure;
    if(failure!==undefined){requireCondition(Object.keys(result.envelope.metadata).length===1&&failure&&typeof failure==='object'&&Object.keys(failure).length===3&&result.blobs.size===0,'NATIVE_OUTPUT_MISMATCH',409,'WAIT');const item=failure as {code:string;status:number;nextAction:NextAction};requireCondition(/^[A-Z_]{1,64}$/.test(item.code)&&[409,413,422,503].includes(item.status)&&failureActions.has(item.nextAction),'NATIVE_OUTPUT_MISMATCH',409,'WAIT');throw new DomainError(item.code,item.status,item.nextAction);}
    if(attempt.hooks?.rawResult){
      const sealed=digest(result.envelope),blobDigest=digest(result.envelope.blobs);
      await this.control(attempt,attempt.hooks.rawResult(attempt.job,result.envelope,result.blobs));this.checkpoint(attempt);
      validateNativeEnvelope(result.envelope,outputLimits);verifyNativeResult(attempt.job,result.envelope);
      requireCondition(digest(result.envelope)===sealed&&digest(describeNativeBlobs(result.blobs,outputLimits))===blobDigest,'NATIVE_OUTPUT_MISMATCH',409,'WAIT');
    }
    return {metadata:result.envelope.metadata,blobs:result.blobs};
  }
}

// Windows 서버 adapter는 OS/DB 구현을 생성하지 않는다. 원 DB와 broker는
// 인증된 부모가 주입하며, NativeController.owned의 Node 경로와 분리한다.
export interface WindowsControllerJournalPort{
  readonly controllerInstanceId:string;readonly profileDigest:string;readonly kernelImplementationDigest:string;
  readonly limits:Readonly<NativeLimits>;readonly memory:NativeControllerMemoryOwner;
  offerOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding,frame:NativeFrame<NativeJob>):Promise<WindowsPrepareInput>;
  portsFor(peer:NativeControllerPeer):Pick<WindowsJobPorts,'original'|'journal'>;
  readyOriginal(capture:OriginalCapture,prepared:WindowsPreparedAttempt):Promise<void>;
  parentJoinedOriginal(capture:OriginalCapture,ack:ParentJoinAck):Promise<ParentJoinAck>;
  finishOriginal(capture:OriginalCapture,completion:{outcome:WindowsJobOutcome;finalized:HostFinalized;brokerJoin:{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}}):Promise<WindowsEvidenceRef>;
  readOriginal(binding:NativeControllerBinding,expected:WindowsEvidenceRef|null):Promise<{capture:OriginalCapture;record:{ref:OriginalRef;envelope:WindowsSealEnvelope}|null;windowsEvidenceRef:WindowsEvidenceRef|null}>;
  loadOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding):Promise<NativeOriginalAttemptV2>;
  close():Promise<void>;
}
export type WindowsControllerClock={nowMs():number;startWait(deadlineMs:number):{done:Promise<void>;cancel():Promise<void>}};
export interface WindowsOriginalController{
  readonly kind:'WINDOWS_JOB_OBJECT';readonly controllerInstanceId:string;readonly profileDigest:string;readonly kernelImplementationDigest:string;
  readonly limits:Readonly<NativeLimits>;readonly memory:NativeControllerMemoryOwner;
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>;
  prepareOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding,frame:NativeFrame<NativeJob>):Promise<NativeOriginalAttemptV2>;
  grantOriginal(peer:NativeControllerPeer,attempt:NativeOriginalAttemptV2,goWaitMilliseconds:number):Promise<NativeOriginalAttemptV2>;
  loadOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding):Promise<NativeOriginalAttemptV2>;
  readRawOriginal(peer:NativeControllerPeer,attempt:NativeOriginalAttemptV2,context?:NativeControllerRawReadContext):Promise<NativeFrame<NativeResult>|null>;
  stopClaims():void;idle():Promise<void>;reconcileTerminations():Promise<void>;
}
type WindowsGateState='PENDING'|'ACKNOWLEDGED'|'REJECTED'|'UNCONFIRMED'|'STOPPED';
type WindowsGate={state:WindowsGateState;done:Promise<WindowsGateState>;settle(state:Exclude<WindowsGateState,'PENDING'>):void};
function windowsGate():WindowsGate{
  let resolve!:(state:WindowsGateState)=>void;const done=new Promise<WindowsGateState>(yes=>{resolve=yes;});
  const gate:WindowsGate={state:'PENDING',done,settle:state=>{if(gate.state==='PENDING'){gate.state=state;resolve(state);}}};return gate;
}
type WindowsScope={
  binding:NativeControllerBinding;peer:NativeControllerPeer;backend:WindowsJobBackend|null;capture:OriginalCapture|null;
  gate:WindowsGate|null;grantWork:Promise<NativeOriginalAttemptV2>|null;completion:Promise<void>|null;
  finalized:HostFinalized|null;brokerJoin:{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}|null;
  pending:Set<Promise<unknown>>;rawPending:Set<Promise<unknown>>;loans:Set<()=>void>;
  clocks:Set<{done:Promise<void>;cancel():Promise<void>}>;callbacks:Set<Promise<unknown>>;
  closing:boolean;wallDeadline:number|null;rawResult:NativeRawResultReference|null;parentAck:ParentJoinAck|null;
  completionValue:{outcome:WindowsJobOutcome;finalized:HostFinalized;brokerJoin:{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}}|null;
  code:string|null;releaseBackend:()=>void;releaseRecovery:()=>void;releaseUncertainty:()=>void;
};
const windowsJ=131072;
const windowsKey=(binding:NativeControllerBinding)=>binding.accountId+'/'+binding.capacityReservationId;
class WindowsOriginalAdapter implements WindowsOriginalController{
  readonly kind='WINDOWS_JOB_OBJECT' as const;
  readonly controllerInstanceId:string;readonly profileDigest:string;readonly kernelImplementationDigest:string;
  readonly limits:Readonly<NativeLimits>;readonly memory:NativeControllerMemoryOwner;
  private accepting=true;private readonly live=new Map<string,WindowsScope>();
  private readonly admission=new Map<string,Promise<NativeOriginalAttemptV2>>();private readonly pending=new Set<Promise<unknown>>();
  private readonly unresolved=new Map<string,{binding:NativeControllerBinding;code:string;peer:NativeControllerPeer;recovery:{capture:OriginalCapture;completion:NonNullable<WindowsScope['completionValue']>}|null;release:()=>void}>();
  constructor(private readonly journal:WindowsControllerJournalPort,private readonly broker:WindowsJobPorts['broker'],private readonly clock:WindowsControllerClock,private readonly raw:NativeControllerRawStore){
    validateNativeLimits(journal.limits);this.limits=Object.freeze({...journal.limits});this.memory=journal.memory;
    requireCondition(typeof journal.loadOriginal==='function'&&typeof broker.open==='function'&&typeof broker.readOriginal==='function'&&typeof clock.nowMs==='function'&&typeof clock.startWait==='function','WINDOWS_PORT_REQUIRED',409,'WAIT');
    this.controllerInstanceId=journal.controllerInstanceId;this.profileDigest=journal.profileDigest;this.kernelImplementationDigest=journal.kernelImplementationDigest;
  }
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>{
    requireCondition(direction==='input'||direction==='output','NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');
    return Object.freeze({maxMetadataBytes:this.limits.maxMetadataBytes,maxBinaryBytes:direction==='input'?this.limits.maxInputBytes:this.limits.maxOutputBytes,maxItems:this.limits.maxItems});
  }
  private track<T>(work:()=>Promise<T>,scope?:WindowsScope,raw=false):Promise<T>{
    let operation:Promise<T>;try{operation=Promise.resolve(work());}catch(error){operation=Promise.reject(error);}
    this.pending.add(operation);scope?.pending.add(operation);if(raw)scope?.rawPending.add(operation);
    void operation.then(()=>{this.pending.delete(operation);scope?.pending.delete(operation);scope?.rawPending.delete(operation);},()=>{this.pending.delete(operation);scope?.pending.delete(operation);scope?.rawPending.delete(operation);});return operation;
  }
  private loan(scope:WindowsScope,bytes:number):()=>void{
    const release=this.memory.hold(bytes);let active=true;
    const end=()=>{if(active){active=false;scope.loans.delete(end);release();}};scope.loans.add(end);return end;
  }
  private returned<T>(scope:WindowsScope,r:number,work:()=>Promise<T>):Promise<T>{
    const end=this.loan(scope,3*r);
    return this.track(work,scope).catch(error=>{end();throw error;});
  }
  private async read(peer:NativeControllerPeer,binding:NativeControllerBinding):Promise<NativeOriginalAttemptV2>{
    // 이 보수적 control 상한은 실제 닫힌 응답보다 크며, 호출자의 별도
    // request/result loan이 인계를 받은 뒤에만 이 호출 scope가 끝난다.
    const release=this.memory.hold(3*(this.limits.maxMetadataBytes+windowsJ+4096));
    try{return await this.track(()=>this.journal.loadOriginal(peer,binding));}finally{release();}
  }
  private mask(attempt:NativeOriginalAttemptV2):NativeOriginalAttemptV2{
    if(attempt.snapshot.windowsEvidenceRef)return attempt;
    const live=this.live.get(windowsKey(attempt.binding));
    if(live&&live.code===null)return {...attempt,snapshot:{...attempt.snapshot,termination:null,rawResult:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'}};
    return {...attempt,snapshot:{...attempt.snapshot,termination:null,rawResult:null,windowsEvidenceRef:null,code:live?.code??this.unresolved.get(windowsKey(attempt.binding))?.code??'WINDOWS_ATTEMPT_NOT_LIVE'}};
  }
  async loadOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding):Promise<NativeOriginalAttemptV2>{return this.mask(await this.read(peer,binding));}
  prepareOriginal(peer:NativeControllerPeer,binding:NativeControllerBinding,frame:NativeFrame<NativeJob>):Promise<NativeOriginalAttemptV2>{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const id=windowsKey(binding),current=this.admission.get(id);if(current)return current;
    // 등록이 첫 await보다 앞서므로 두 fresh offer가 동시에 시작되지 않는다.
    const operation=Promise.resolve().then(()=>this.prepare(peer,binding,frame));this.admission.set(id,operation);
    void operation.then(()=>this.admission.delete(id),()=>this.admission.delete(id));return operation;
  }
  private async prepare(peer:NativeControllerPeer,binding:NativeControllerBinding,frame:NativeFrame<NativeJob>):Promise<NativeOriginalAttemptV2>{
    const retained=this.live.get(windowsKey(binding));
    if(retained)requireCondition(digest(retained.binding)===digest(binding),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    try{return this.mask(await this.read(peer,binding));}
    catch(error){
      // 이 원 SQL 오류 쌍은 부재도 승인도 아니다. fresh capture의 원 DB
      // account lock/현재 권위/UNIQUE가 다음 단계의 최종 권위다.
      const sql=error as {code?:unknown;message?:unknown};if(sql.code!=='23514'||sql.message!=='NATIVE_CONTROL_BINDING_MISMATCH')throw error;
      requireCondition(!this.live.has(windowsKey(binding)),'WINDOWS_ATTEMPT_UNCONFIRMED',409,'WAIT');
    }
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
    const releaseBackend=this.memory.hold(this.limits.parentInFlightBytes);
    let releaseRecovery:(()=>void)|undefined,releaseUncertainty:(()=>void)|undefined;
    try{releaseRecovery=this.memory.hold(3*4*windowsJ);releaseUncertainty=this.memory.hold(4096);}catch(error){releaseRecovery?.();releaseBackend();throw error;}
    const scope:WindowsScope={binding:structuredClone(binding),peer:structuredClone(peer),backend:null,capture:null,gate:null,grantWork:null,completion:null,finalized:null,brokerJoin:null,pending:new Set(),rawPending:new Set(),loans:new Set(),clocks:new Set(),callbacks:new Set(),closing:false,wallDeadline:null,rawResult:null,parentAck:null,completionValue:null,code:null,releaseBackend,releaseRecovery,releaseUncertainty};
    this.live.set(windowsKey(binding),scope);
    let offered:WindowsPrepareInput|undefined;let releaseOffer:(()=>void)|undefined;
    try{
      releaseOffer=this.loan(scope,3*(windowsJ+this.limits.maxMetadataBytes+4096));
      offered=await this.track(()=>this.journal.offerOriginal(peer,binding,frame),scope);
      requireCondition(digest(offered.identity.binding)===digest(binding)&&offered.authority.controllerInstanceId===this.controllerInstanceId,'WINDOWS_ORIGINAL_MISMATCH',409,'WAIT');
      const ports=this.makePorts(scope);scope.backend=createWindowsJobBackend(offered,ports);offered=undefined;releaseOffer();releaseOffer=undefined;
      let prepared:WindowsPreparedAttempt;
      try{prepared=await scope.backend.prepare();}
      catch(error){
        scope.code=error instanceof DomainError?error.code:'WINDOWS_PREPARE_UNCONFIRMED';
        scope.completion=this.watch(scope);void scope.completion.catch(()=>{});
        // capture COMMIT ACK 소실/unique 충돌은 조회만 재확인한다.
        try{return this.mask(await this.read(peer,binding));}catch{throw error;}
      }
      requireCondition(scope.capture,'WINDOWS_CAPTURE_UNCONFIRMED',409,'WAIT');
      await this.returned(scope,4096,()=>this.journal.readyOriginal(scope.capture!,prepared));
      scope.completion=this.watch(scope);void scope.completion.catch(()=>{});
      return this.mask(await this.read(peer,binding));
    }catch(error){
      if(!scope.completion){this.stop(scope,error instanceof DomainError?error.code:'WINDOWS_PREPARE_UNCONFIRMED');scope.code=error instanceof DomainError?error.code:'WINDOWS_PREPARE_UNCONFIRMED';scope.completion=this.watch(scope);void scope.completion.catch(()=>{});}
      throw error;
    }finally{offered=undefined;releaseOffer?.();}
  }
  private timer(scope:WindowsScope,deadline:number):{done:Promise<void>;cancel():Promise<void>}{
    requireCondition(!scope.closing&&Number.isFinite(deadline)&&deadline>=0,'WINDOWS_CLOCK_UNCONFIRMED',409,'WAIT');
    const end=this.loan(scope,3*4096);let original:{done:Promise<void>;cancel():Promise<void>};
    try{original=this.clock.startWait(deadline);requireCondition(original&&original.done instanceof Promise&&typeof original.cancel==='function','WINDOWS_CLOCK_UNCONFIRMED',409,'WAIT');}catch(error){end();throw error;}
    const done=original.done.finally(()=>{scope.clocks.delete(handle);end();});void done.catch(()=>{});
    const handle={done,cancel:()=>this.track(async()=>{await original.cancel();await original.done;},scope)};scope.clocks.add(handle);return handle;
  }
  private stop(scope:WindowsScope,code:string):void{
    scope.code??=code;scope.gate?.settle('STOPPED');
    if(scope.backend)void this.track(()=>scope.backend!.stop('CALLER_ABORT'),scope).catch(()=>{});
  }
  private makePorts(scope:WindowsScope):WindowsJobPorts{
    const base=this.journal.portsFor(scope.peer);
    const returning=<T>(r:number,fn:()=>Promise<T>)=>this.returned(scope,r,fn);
    return {
      original:{
        captureFresh:input=>returning(windowsJ+4096,async()=>{const value=await base.original.captureFresh(input);scope.capture=value.capture;return value;}),
        grantOriginal:capture=>returning(4096,async()=>{
          requireCondition(this.accepting&&scope.gate?.state==='PENDING','WINDOWS_GO_UNCONFIRMED',409,'WAIT');
          try{
            const value=await base.original.grantOriginal(capture);
            if(!this.accepting||scope.gate?.state!=='PENDING')throw new DomainError('WINDOWS_GO_UNCONFIRMED',409,'WAIT');
            if(!value.created){scope.gate.settle('REJECTED');this.stop(scope,'WINDOWS_GO_REJECTED');throw new DomainError('WINDOWS_GO_REJECTED',409,'WAIT');}
            scope.gate.settle('ACKNOWLEDGED');return value;
          }catch(error){scope.gate?.settle('UNCONFIRMED');this.stop(scope,'WINDOWS_GO_UNCONFIRMED');throw error;}
        }),
        readOriginal:capture=>returning(4096,()=>base.original.readOriginal(capture))
      },
      journal:{
        appendOriginal:(capture,event,source)=>returning(4096,()=>base.journal.appendOriginal(capture,event,source)),
        lookupEvent:(capture,ref)=>returning(windowsJ+4096,()=>base.journal.lookupEvent(capture,ref)),
        scanOriginal:capture=>{
          const iterator=base.journal.scanOriginal(capture)[Symbol.asyncIterator]();let release:(()=>void)|undefined,reading=false,closed=false;
          const stream:AsyncIterableIterator<JournalEntry>={
            [Symbol.asyncIterator](){return this;},
            next:async()=>{
              requireCondition(!reading&&!closed,'WINDOWS_JOURNAL_UNCONFIRMED',409,'WAIT');reading=true;
              // W2의 이전 inspectValue는 동기 비교를 끝낸 뒤에만 next를 호출한다.
              release?.();release=undefined;
              const end=this.loan(scope,3*(windowsJ+4096));
              try{const next=await this.track(()=>iterator.next(),scope);if(next.done){closed=true;end();}else release=end;return next;}
              catch(error){end();throw error;}finally{reading=false;}
            },
            return:async()=>{requireCondition(!reading,'WINDOWS_JOURNAL_UNCONFIRMED',409,'WAIT');try{if(!closed&&iterator.return)await this.track(()=>iterator.return!(),scope);closed=true;return {done:true,value:undefined};}finally{release?.();release=undefined;}}
          };return stream;
        },
        sealOriginal:(capture,envelope)=>returning(4096,()=>base.journal.sealOriginal(capture,envelope)),
        readOriginal:capture=>returning(windowsJ+4096,()=>base.journal.readOriginal(capture))
      },
      broker:{
        open:async capture=>{
          const session=await this.track(()=>this.broker.open(capture),scope);let joined:ReturnType<BrokerSession['join']>|null=null;
          const events:AsyncIterable<WindowsHostMessage>={
            [Symbol.asyncIterator]:async function*(){
              for await(const message of session.events){
                if(message.message==='FINALIZED'){
                  await returning(4096,async()=>{nativeJsonBytes(message.payload,4096);scope.finalized=structuredClone(message.payload);});
                }
                yield message;
              }
            }
          };
          return {send:control=>this.track(()=>session.send(control),scope),events,nativeInput:session.nativeInput,nativeOutput:session.nativeOutput,nativeError:session.nativeError,
            join:()=>{if(!joined)joined=returning(4096,async()=>{const value=await session.join();nativeJsonBytes(value,4096);scope.brokerJoin=structuredClone(value);return value;});return joined;}};
        },
        readOriginal:capture=>returning(4096,()=>this.broker.readOriginal(capture))
      },
      parent:{
        rawResult:(capture,result)=>this.track(async()=>{
          const attempt=await this.read(scope.peer,capture.origin.identity.binding);
          const releaseAllocation=this.loan(scope,3*(this.limits.maxMetadataBytes+4096)+2*this.limits.maxOutputBytes);
          try{
            const allocation=await this.track(()=>this.raw.allocate(scope.peer,attempt,result.envelope),scope,true);
            requireCondition(allocation.attemptId===capture.origin.authority.attemptId&&allocation.reference.resultDigest===digest(result.envelope)&&digest(allocation.result)===digest(result.envelope),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
            try{await this.track(()=>this.raw.putOriginal(scope.peer,allocation,result.blobs),scope,true);}
            catch(error){const found=await this.track(()=>this.raw.readExisting(scope.peer,attempt,{purpose:'RUN_RECOVERY'}),scope,true);requireCondition(found&&digest(found.envelope)===allocation.reference.resultDigest&&digest(describeNativeBlobs(found.blobs,this.frameLimits('output')))===digest(result.envelope.blobs),'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');void error;}
            scope.rawResult=structuredClone(allocation.reference);return scope.rawResult;
          }finally{releaseAllocation();}
        },scope,true),
        joinOriginal:capture=>this.track(async()=>{
          // 과거에 시작한 raw 작업만 합류한다. W2 nativeWork/terminal/idle와
          // 미래 QUERY·reply·seal·finish·link는 이 집합에 절대 넣지 않는다.
          while(scope.rawPending.size)await Promise.all([...scope.rawPending]);
          scope.parentAck??={joinId:randomUUID(),originDigest:capture.originDigest,digest:digest({version:1,originDigest:capture.originDigest,rawResult:scope.rawResult})};
          return await returning(4096,()=>this.journal.parentJoinedOriginal(capture,scope.parentAck!));
        },scope)
      },
      clock:{nowMs:()=>this.clock.nowMs(),waitUntil:deadline=>{
        scope.wallDeadline??=deadline;const handle=this.timer(scope,deadline);
        const waiting=handle.done.then(()=>{});scope.callbacks.add(waiting);void waiting.then(()=>scope.callbacks.delete(waiting),()=>scope.callbacks.delete(waiting));return waiting;
      }}
    };
  }
  grantOriginal(peer:NativeControllerPeer,attempt:NativeOriginalAttemptV2,goWaitMilliseconds:number):Promise<NativeOriginalAttemptV2>{
    requireCondition(Number.isSafeInteger(goWaitMilliseconds)&&goWaitMilliseconds>0&&goWaitMilliseconds<=2147483647,'NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');
    const scope=this.live.get(windowsKey(attempt.binding));
    requireCondition(this.accepting&&scope?.backend&&scope.capture&&attempt.snapshot.attemptId===scope.capture.origin.authority.attemptId&&attempt.snapshot.controllerInstanceId===this.controllerInstanceId&&digest(peer)===digest(scope.peer),'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED',409,'WAIT');
    if(scope.grantWork)return scope.grantWork;
    scope.gate=windowsGate();const gate=scope.gate;
    const now=this.clock.nowMs();requireCondition(Number.isFinite(now)&&now>=0&&scope.wallDeadline!==null,'WINDOWS_CLOCK_UNCONFIRMED',409,'WAIT');
    const deadline=Math.min(scope.wallDeadline,now+goWaitMilliseconds),handle=this.timer(scope,deadline);
    const expiry=handle.done.then(()=>{if(gate.state==='PENDING'){gate.settle('UNCONFIRMED');this.stop(scope,'WINDOWS_GO_UNCONFIRMED');}},()=>{gate.settle('UNCONFIRMED');this.stop(scope,'WINDOWS_CLOCK_UNCONFIRMED');});
    scope.callbacks.add(expiry);void expiry.finally(()=>scope.callbacks.delete(expiry)).catch(()=>{});
    // 전체 종료 promise는 gate와 독립적으로 실제 끝까지 추적한다.
    void this.track(()=>scope.backend!.grantGo(),scope).then(()=>{gate.settle('UNCONFIRMED');},()=>{gate.settle('UNCONFIRMED');this.stop(scope,'WINDOWS_GO_UNCONFIRMED');});
    const work=(async()=>{
      const state=await gate.done;void handle.cancel().catch(()=>{});
      requireCondition(state==='ACKNOWLEDGED','WINDOWS_GO_UNCONFIRMED',409,'WAIT');
      try{
        const saved=await this.read(peer,attempt.binding);
        requireCondition(saved.snapshot.attemptId===attempt.snapshot.attemptId&&saved.snapshot.controllerInstanceId===attempt.snapshot.controllerInstanceId&&saved.snapshot.phase==='GO_GRANTED','WINDOWS_GO_UNCONFIRMED',409,'WAIT');return this.mask(saved);
      }catch{this.stop(scope,'WINDOWS_GO_UNCONFIRMED');throw new DomainError('WINDOWS_GO_UNCONFIRMED',409,'WAIT');}
    })();scope.grantWork=work;void work.catch(()=>{});return work;
  }
  private async watch(scope:WindowsScope):Promise<void>{
    let closed=scope.backend===null&&scope.capture===null;
    try{
      if(scope.backend){await scope.backend.idle();const view=await scope.backend.query();
        if(view.outcome?.state==='JOINED'&&scope.capture&&scope.finalized&&scope.brokerJoin){
          scope.completionValue={outcome:view.outcome,finalized:scope.finalized,brokerJoin:scope.brokerJoin};
          await this.finish(scope);closed=true;
        }else scope.code??=view.outcome?.code??'WINDOWS_TERMINATION_UNCONFIRMED';
      }
    }catch(error){scope.code=error instanceof DomainError?error.code:'WINDOWS_COMPLETION_UNCONFIRMED';}
    finally{
      scope.closing=true;
      // cancel ACK는 원 done 종료까지 기다린다. 취소에 불응한 port면 hold와
      // idle이 계속 대기하며 강제 lease/시간 경과로 반환하지 않는다.
      while(scope.clocks.size){const handles=[...scope.clocks];await Promise.allSettled(handles.map(h=>h.cancel()));await Promise.allSettled(handles.map(h=>h.done));}
      while(scope.callbacks.size)await Promise.allSettled([...scope.callbacks]);
      await Promise.resolve();await Promise.resolve();if(scope.backend)await scope.backend.idle();
      while(scope.pending.size)await Promise.allSettled([...scope.pending]);
      if(!closed){
        // 원 최종 저장만 실패한 경우 이미 관찰한 완료 자료를 별도 loan으로
        // 인계한다. backend L을 반환하면서 같은 자료를 잃거나 새 사건을 만들지 않는다.
        const recovery=scope.capture&&scope.completionValue?{capture:scope.capture,completion:scope.completionValue}:null;
        const release=recovery?scope.releaseRecovery:scope.releaseUncertainty;
        if(recovery)scope.releaseUncertainty();else scope.releaseRecovery();
        this.unresolved.set(windowsKey(scope.binding),{binding:structuredClone(scope.binding),peer:structuredClone(scope.peer),code:scope.code??'WINDOWS_TERMINATION_UNCONFIRMED',recovery,release});
      }else{scope.releaseRecovery();scope.releaseUncertainty();}
      if(this.live.get(windowsKey(scope.binding))===scope)this.live.delete(windowsKey(scope.binding));scope.backend=null;scope.capture=null;scope.finalized=null;scope.brokerJoin=null;scope.completionValue=null;scope.grantWork=null;scope.gate=null;scope.parentAck=null;scope.rawResult=null;
      for(const release of [...scope.loans])release();scope.releaseBackend();
    }
  }
  private async finish(scope:WindowsScope):Promise<void>{
    requireCondition(scope.capture&&scope.completionValue,'WINDOWS_COMPLETION_UNCONFIRMED',409,'WAIT');
    let ref:WindowsEvidenceRef;
    try{ref=await this.returned(scope,4096,()=>this.journal.finishOriginal(scope.capture!,scope.completionValue!));}
    catch{ref=await this.returned(scope,4096,()=>this.journal.finishOriginal(scope.capture!,scope.completionValue!));}
    const view=await this.returned(scope,4*windowsJ,()=>this.journal.readOriginal(scope.binding,ref));
    requireCondition(view.windowsEvidenceRef&&digest(view.windowsEvidenceRef)===digest(ref),'WINDOWS_LINK_UNCONFIRMED',409,'WAIT');
  }
  async readRawOriginal(peer:NativeControllerPeer,attempt:NativeOriginalAttemptV2,context?:NativeControllerRawReadContext):Promise<NativeFrame<NativeResult>|null>{
    requireCondition(attempt.snapshot.windowsEvidenceRef&&attempt.snapshot.rawResult,'WINDOWS_LINK_UNCONFIRMED',409,'WAIT');
    return await this.track(()=>this.raw.readExisting(peer,attempt,context));
  }
  stopClaims():void{this.accepting=false;for(const scope of this.live.values())this.stop(scope,'NATIVE_SHUTDOWN_WAIT');}
  async idle():Promise<void>{
    while(this.admission.size)await Promise.allSettled([...this.admission.values()]);
    for(;;){const scopes=[...this.live.values()],work=scopes.flatMap(s=>s.completion?[s.completion]:[]);if(!work.length)break;await Promise.allSettled(work);requireCondition(scopes.every(scope=>this.live.get(windowsKey(scope.binding))!==scope),'WINDOWS_LOCAL_DRAIN_UNCONFIRMED',409,'WAIT');}
    while(this.pending.size)await Promise.allSettled([...this.pending]);
    requireCondition(this.unresolved.size===0,'WINDOWS_TERMINATION_UNCONFIRMED',409,'WAIT');
  }
  async reconcileTerminations():Promise<void>{
    for(const scope of this.live.values())if(scope.completionValue&&scope.capture)await this.finish(scope);else this.stop(scope,scope.code??'WINDOWS_RECONCILE_WAIT');
    // 불명확한 원 기록은 새로운 broker/capture/GO나 합성 observation으로
    // 복구하지 않는다. 완성 이력의 재조회만 bounded 작은 ref를 정리한다.
    for(const [key,record]of this.unresolved){
      try{
        if(record.recovery){
          const {capture,completion}=record.recovery;
          requireCondition(capture.origin.authority.controllerInstanceId===this.controllerInstanceId,'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED',409,'WAIT');
          const release=this.memory.hold(3*(4096+4*windowsJ));
          try{
            const ref=await this.track(()=>this.journal.finishOriginal(capture,completion));
            const view=await this.track(()=>this.journal.readOriginal(record.binding,ref));
            requireCondition(view.windowsEvidenceRef&&digest(view.windowsEvidenceRef)===digest(ref),'WINDOWS_LINK_UNCONFIRMED',409,'WAIT');
          }finally{release();}
        }
        const saved=await this.read(record.peer,record.binding);
        if(saved.snapshot.windowsEvidenceRef){record.recovery=null;record.release();this.unresolved.delete(key);}
      }catch{/* 같은 원 자료의 저장/조회 권위가 확인되지 않으면 WAIT를 보존한다. */}
    }
  }
}
export function createWindowsOriginalController(options:{journal:WindowsControllerJournalPort;broker:WindowsJobPorts['broker'];clock:WindowsControllerClock;raw:NativeControllerRawStore}):WindowsOriginalController{
  return new WindowsOriginalAdapter(options.journal,options.broker,options.clock,options.raw);
}
