import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import canonicalize from 'canonicalize';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {NativeControllerDatabase} from '../../storage/src/native-controller-role.js';
import type {ObjectStore,ObjectReceipt} from '../../storage/src/objects.js';
import {nativeJsonBytes,validateNativeEnvelope,verifyNativeInput,verifyNativeResult,describeNativeBlobs,type NativeJob,type NativeResult,type NativeTermination,type NativeJobEvidence,type NativeFrameLimits} from '../../native/src/dto.js';
import {validateNativeControllerBinding,validateNativeControllerSnapshot,validateNativeControllerSnapshotV2,type NativeControllerSnapshotV2,type NativeControllerBinding} from '../../native/src/controller-protocol.js';
import type {NativeControllerAttemptStore,NativeControllerRawStore,NativeControllerPeer,NativeOriginalAttempt,NativeOriginalAttemptV2,NativeOriginalAttemptAny,NativeControllerMemoryOwner,NativeRawAllocation,NativeControllerRawReadContext} from '../../native/src/controller-attempts.js';
import type {NativeFrame} from '../../native/src/frame.js';
import {WindowsNativeJournal,type WindowsJournalConfiguration,type WindowsJournalMemory} from './windows-native-journal.js';
import type {WindowsControllerJournalPort} from '../../native/src/controller.js';
import {validateNativeJobObservation,type NativeJobObservation} from './native-jobs.js';
import {validateWindowsCostedIoRequest,validateWindowsCostedIoEvent,type WindowsCostedObjectIo,type WindowsCostedIoRequest,type WindowsCostedIoEvent,type WindowsCostedIoCall,type WindowsCostedIoReply} from './windows-native-cost.js';
import {captureWindowsCostedObjectIo} from './native-receipts.js';

type BlobRef={blobId:string;assetId:string;sha256:string;bytesLength:string};
type AttemptDecision={allowed:boolean;reason?:string;created?:boolean;attempt:NativeOriginalAttempt};
type RawDecision={allowed:boolean;reason?:string;created?:boolean;available?:boolean;allocation?:NativeRawAllocation;blobRefs?:BlobRef[]};
type Configuration={controllerId:string;controllerInstanceId:string;input:NativeFrameLimits;output:NativeFrameLimits};
type PutAuthority={peer:NativeControllerPeer;attempt:NativeOriginalAttemptAny;refs:BlobRef[];result:NativeResult;allocationDigest:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(code='NATIVE_CONTROL_RAW_MISMATCH'):never{throw new DomainError(code,409,'WAIT');}
function peer(value:NativeControllerPeer):NativeControllerPeer{
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireCondition(Object.keys(descriptors).length===2&&['serviceRole','peerId'].every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key])&&['trio_web_api','trio_web_worker'].includes(value.serviceRole)&&uuid.test(value.peerId),'NATIVE_PEER_UNCONFIRMED',409,'WAIT');
  return structuredClone(value);
}

// Credentials and SQL authority belong only to the controller process. The
// transport supplies authenticated peer identity; wire JSON cannot instantiate
// this store. Its raw candidates never approve, publish, settle or release.
export class NativeControllerStore implements NativeControllerAttemptStore,NativeControllerRawStore{
  protected readonly freshPuts=new WeakMap<NativeRawAllocation,PutAuthority>();
  protected readonly configuration:Readonly<Configuration>;
  constructor(protected readonly db:NativeControllerDatabase,configuration:Configuration,private readonly objects:ObjectStore,protected readonly bucketRef:string){
    requireCondition(uuid.test(configuration.controllerId)&&uuid.test(configuration.controllerInstanceId)&&bucketRef===objects.bucket&&bucketRef.length>0&&bucketRef.length<=256&&!/[\x00-\x1f\x7f]/.test(bucketRef),'NATIVE_CONTROLLER_CONFIG_UNCONFIRMED',409,'WAIT');
    for(const limits of [configuration.input,configuration.output])requireCondition(Object.keys(limits).length===3&&[limits.maxMetadataBytes,limits.maxBinaryBytes,limits.maxItems].every(value=>Number.isSafeInteger(value)&&value>0),'NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');
    this.configuration=Object.freeze({...configuration,input:Object.freeze({...configuration.input}),output:Object.freeze({...configuration.output})});
  }
  protected original(value:NativeOriginalAttempt,binding?:NativeControllerBinding):NativeOriginalAttempt;
  protected original(value:NativeOriginalAttemptV2,binding?:NativeControllerBinding):NativeOriginalAttemptV2;
  protected original(value:NativeOriginalAttemptAny,binding?:NativeControllerBinding):NativeOriginalAttemptAny;
  protected original(value:NativeOriginalAttemptAny,binding:NativeControllerBinding=value.binding):NativeOriginalAttemptAny{
    const actual=validateNativeControllerBinding(value.binding);nativeJsonBytes(value.job,this.configuration.input.maxMetadataBytes);
    const job=structuredClone(value.job);validateNativeEnvelope(job,this.configuration.input);verifyNativeInput(job);
    const snapshot=Object.hasOwn(value.snapshot,'version')?validateNativeControllerSnapshotV2(value.snapshot,actual):validateNativeControllerSnapshot(value.snapshot,actual);
    requireCondition(digest(actual)===digest(binding)&&job.jobId===actual.jobId&&job.inputDigest===actual.inputDigest&&job.profileDigest===actual.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    if('version'in snapshot)return {binding:actual,job,snapshot};
    return {binding:actual,job,snapshot};
  }
  protected mutation(who:NativeControllerPeer,value:NativeOriginalAttemptAny){
    const authenticated=peer(who),original=this.original(value);
    requireCondition(original.snapshot.controllerInstanceId===this.configuration.controllerInstanceId,'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED',409,'WAIT');
    return {authenticated,original,args:[JSON.stringify(original.binding),original.snapshot.attemptId,this.configuration.controllerInstanceId,this.configuration.controllerId,authenticated.serviceRole]};
  }
  async claim(who:NativeControllerPeer,bindingValue:NativeControllerBinding,jobValue:NativeJob,attemptId:string,controllerInstanceId:string):Promise<{created:boolean;attempt:NativeOriginalAttempt}>{
    const authenticated=peer(who),binding=validateNativeControllerBinding(bindingValue);nativeJsonBytes(jobValue,this.configuration.input.maxMetadataBytes);
    const job=structuredClone(jobValue);validateNativeEnvelope(job,this.configuration.input);verifyNativeInput(job);
    requireCondition(uuid.test(attemptId)&&controllerInstanceId===this.configuration.controllerInstanceId&&job.jobId===binding.jobId&&job.inputDigest===binding.inputDigest&&job.profileDigest===binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    const {inputDigest:ignored,...frame}=job;void ignored;const input=canonicalize(frame);requireCondition(input&&sha256(input)===job.inputDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    const record=await this.db.decision<AttemptDecision>(binding.accountId,'SELECT manga_web.native_controller_claim($1::jsonb,$2,$3,$4,$5,$6,$7) AS decision',[JSON.stringify(binding),input,attemptId,controllerInstanceId,this.configuration.controllerId,authenticated.serviceRole,authenticated.peerId],value=>{this.original(value.attempt,binding);requireCondition(typeof value.created==='boolean','NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');});
    return {created:record.created===true,attempt:this.original(record.attempt,binding)};
  }
  async load(who:NativeControllerPeer,bindingValue:NativeControllerBinding):Promise<NativeOriginalAttempt>{
    const authenticated=peer(who),binding=validateNativeControllerBinding(bindingValue);
    const record=await this.db.decision<AttemptDecision>(binding.accountId,'SELECT manga_web.native_controller_load($1::jsonb,$2,$3) AS decision',[JSON.stringify(binding),this.configuration.controllerId,authenticated.serviceRole],value=>{this.original(value.attempt,binding);});
    return this.original(record.attempt,binding);
  }
  async ready(who:NativeControllerPeer,value:NativeOriginalAttempt):Promise<NativeOriginalAttempt>{
    const {original,args}=this.mutation(who,value);
    const record=await this.db.decision<AttemptDecision>(original.binding.accountId,'SELECT manga_web.native_controller_ready($1::jsonb,$2,$3,$4,$5,$6) AS decision',[...args,randomUUID()],result=>{this.original(result.attempt,original.binding);});
    return this.original(record.attempt,original.binding);
  }
  async grantGo(who:NativeControllerPeer,value:NativeOriginalAttempt):Promise<{created:boolean;attempt:NativeOriginalAttempt}>{
    const {original,args}=this.mutation(who,value);
    const record=await this.db.decision<AttemptDecision>(original.binding.accountId,'SELECT manga_web.native_controller_grant_go($1::jsonb,$2,$3,$4,$5) AS decision',args,result=>{this.original(result.attempt,original.binding);requireCondition(typeof result.created==='boolean','NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');});
    return {created:record.created===true,attempt:this.original(record.attempt,original.binding)};
  }
  private async observation(who:NativeControllerPeer,value:NativeOriginalAttempt,kind:'OBSERVATION'|'TERMINATION'|'UNKNOWN',observationValue:NativeJobObservation):Promise<void>{
    const {original,args}=this.mutation(who,value),observation=validateNativeJobObservation(observationValue);
    requireCondition(observation.parentInstanceId===original.binding.parentInstanceId&&observation.termination.jobId===original.binding.jobId&&observation.termination.inputDigest===original.binding.inputDigest&&observation.termination.profileDigest===original.binding.profileDigest,'NATIVE_OBSERVATION_FENCE_REJECTED',409,'WAIT');
    await this.db.decision<AttemptDecision>(original.binding.accountId,'SELECT manga_web.native_controller_observe($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb) AS decision',[...args,randomUUID(),kind,JSON.stringify(observation)],record=>{this.original(record.attempt,original.binding);});
  }
  async observe(who:NativeControllerPeer,value:NativeOriginalAttempt,event:'OBSERVATION'|'TERMINATION',evidence:NativeJobEvidence,terminationValue:NativeTermination,resultValue:NativeResult|null):Promise<void>{
    const original=this.original(value),termination=structuredClone(terminationValue);nativeJsonBytes(evidence,16384);
    requireCondition(evidence.jobId===original.job.jobId&&evidence.inputDigest===original.job.inputDigest&&evidence.profileDigest===original.job.profileDigest&&evidence.task===original.job.task,'NATIVE_OBSERVATION_FENCE_REJECTED',409,'WAIT');
    let resultDigest:string|null=null;if(resultValue){nativeJsonBytes(resultValue,this.configuration.output.maxMetadataBytes);validateNativeEnvelope(resultValue,this.configuration.output);verifyNativeResult(original.job,resultValue);resultDigest=digest(resultValue);}
    requireCondition(event!=='TERMINATION'||!resultValue,'NATIVE_OBSERVATION_FENCE_REJECTED',409,'WAIT');
    await this.observation(who,original,event,{version:1,parentInstanceId:original.binding.parentInstanceId,event:event==='TERMINATION'?'TERMINATION':resultValue?'RESULT':'ERROR',code:evidence.code,resultDigest,termination:{...termination,isolation:evidence.isolation}});
  }
  async unknown(who:NativeControllerPeer,value:NativeOriginalAttempt,code:string):Promise<void>{
    // An ACK error establishes no new termination fact. Do not copy the prior
    // TERM and guess its isolation; the immutable original TERM stays in SQL.
    const original=this.original(value),termination={jobId:original.job.jobId,inputDigest:original.job.inputDigest,profileDigest:original.job.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED' as const};
    await this.observation(who,original,'UNKNOWN',{version:1,parentInstanceId:original.binding.parentInstanceId,event:'ERROR',code,resultDigest:null,termination:{...termination,isolation:'OWNED_FIXTURE'}});
  }
  protected rawDecision(record:RawDecision,original:NativeOriginalAttemptAny):{allocation:NativeRawAllocation;refs:BlobRef[]}{
    const allocation=record.allocation;if(!allocation||!record.blobRefs)invalid();
    if(Object.hasOwn(original.snapshot,'version')){
      closed(allocation,['attemptId','reference','result']);rawReference(allocation.reference);
      if(original.snapshot.rawResult!==null)requireCondition(digest(original.snapshot.rawResult)===digest(allocation.reference),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    }else validateNativeControllerSnapshot({...original.snapshot,rawResult:allocation.reference},original.binding);
    nativeJsonBytes(allocation.result,this.configuration.output.maxMetadataBytes);
    validateNativeEnvelope(allocation.result,this.configuration.output);verifyNativeResult(original.job,allocation.result);
    requireCondition(allocation.attemptId===original.snapshot.attemptId&&digest(allocation.result)===allocation.reference.resultDigest&&record.blobRefs.length===allocation.result.blobs.length,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    const ids=new Set<string>(),assets=new Set<string>();
    for(const ref of record.blobRefs){const descriptor=allocation.result.blobs.find(item=>item.id===ref.blobId);requireCondition(Object.keys(ref).length===4&&descriptor&&uuid.test(ref.assetId)&&descriptor.sha256===ref.sha256&&descriptor.byteLength.toString()===ref.bytesLength&&!ids.has(ref.blobId)&&!assets.has(ref.assetId),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');ids.add(ref.blobId);assets.add(ref.assetId);}
    return {allocation:structuredClone(allocation),refs:structuredClone(record.blobRefs)};
  }
  async allocate(who:NativeControllerPeer,value:NativeOriginalAttemptAny,resultValue:NativeResult):Promise<NativeRawAllocation>{
    const {authenticated,original,args}=this.mutation(who,value);nativeJsonBytes(resultValue,this.configuration.output.maxMetadataBytes);const result=structuredClone(resultValue);
    validateNativeEnvelope(result,this.configuration.output);verifyNativeResult(original.job,result);
    const refs=result.blobs.map(blob=>({blobId:blob.id,assetId:randomUUID(),sha256:blob.sha256,bytesLength:blob.byteLength.toString()}));
    const record=await this.db.decision<RawDecision>(original.binding.accountId,'SELECT manga_web.native_controller_allocate_raw($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) AS decision',[...args,randomUUID(),canonicalize(result),JSON.stringify(refs),this.bucketRef],value=>{this.rawDecision(value,original);requireCondition(typeof value.created==='boolean','NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');});
    const parsed=this.rawDecision(record,original);if(record.created)this.freshPuts.set(parsed.allocation,{peer:authenticated,attempt:original,refs:parsed.refs,result,allocationDigest:digest(parsed.allocation)});return parsed.allocation;
  }
  protected receipt(proof:ObjectReceipt,key:string,ref:BlobRef):ObjectReceipt{
    requireCondition(proof.key===key&&proof.sha256===ref.sha256&&proof.bytesLength===ref.bytesLength&&Number.isFinite(Date.parse(proof.completedAt))&&new Date(proof.completedAt).toISOString()===proof.completedAt,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    const precision=proof.completedAtPrecisionMilliseconds??1;requireCondition(precision===1||precision===1000,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return {...proof,completedAtPrecisionMilliseconds:precision};
  }
  protected async register(authenticated:NativeControllerPeer,attempt:NativeOriginalAttemptAny,allocation:NativeRawAllocation,ref:BlobRef,proof:ObjectReceipt):Promise<void>{
    await this.db.decision(attempt.binding.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(attempt.binding),this.configuration.controllerId,authenticated.serviceRole,allocation.reference.rawResultId,ref.blobId,JSON.stringify(proof),this.bucketRef]);
  }
  async putOriginal(who:NativeControllerPeer,allocation:NativeRawAllocation,blobValues:Map<string,Buffer>):Promise<void>{
    const authenticated=peer(who),authority=this.freshPuts.get(allocation);this.freshPuts.delete(allocation);
    requireCondition(authority&&digest(authenticated)===digest(authority.peer)&&digest(allocation)===authority.allocationDigest&&digest(allocation.result)===digest(authority.result)&&allocation.reference.resultDigest===digest(authority.result),'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');
    requireCondition(digest(describeNativeBlobs(blobValues,this.configuration.output))===digest(authority.result.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    const blobs=new Map([...blobValues].map(([id,bytes])=>[id,Buffer.from(bytes)]));
    const fresh=await this.db.decision<RawDecision>(authority.attempt.binding.accountId,'SELECT manga_web.native_controller_raw_lookup($1::jsonb,$2,$3,$4) AS decision',[JSON.stringify(authority.attempt.binding),this.configuration.controllerId,authenticated.serviceRole,this.bucketRef]);
    requireCondition(fresh.available,'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');
    for(const ref of authority.refs){const key=`${authority.attempt.binding.accountId}/${ref.assetId}`,bytes=blobs.get(ref.blobId);requireCondition(bytes,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
      const proof=this.receipt(await this.objects.put(key,bytes),key,ref),actual=await this.objects.read(key);requireCondition(actual.length.toString()===ref.bytesLength&&sha256(actual)===ref.sha256,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');await this.register(authenticated,authority.attempt,allocation,ref,proof);
    }
  }
  async readExisting(who:NativeControllerPeer,value:NativeOriginalAttemptAny):Promise<NativeFrame<NativeResult>|null>{
    const authenticated=peer(who),attempt=this.original(value),lookup=()=>this.db.decision<RawDecision>(attempt.binding.accountId,'SELECT manga_web.native_controller_raw_lookup($1::jsonb,$2,$3,$4) AS decision',[JSON.stringify(attempt.binding),this.configuration.controllerId,authenticated.serviceRole,this.bucketRef]);
    const record=await lookup();if(!record.available||!record.allocation)return null;const {allocation,refs}=this.rawDecision(record,attempt),blobs=new Map<string,Buffer>();
    for(const ref of refs){const key=`${attempt.binding.accountId}/${ref.assetId}`,receipt=await this.objects.receipt(key);if(!receipt)return null;const proof=this.receipt(receipt,key,ref),bytes=await this.objects.read(key);requireCondition(bytes.length.toString()===ref.bytesLength&&sha256(bytes)===ref.sha256,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');await this.register(authenticated,attempt,allocation,ref,proof);blobs.set(ref.blobId,bytes);}
    const checked=await lookup();requireCondition(checked.available&&checked.allocation&&digest(checked.allocation)===digest(allocation),'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');
    requireCondition(digest(describeNativeBlobs(blobs,this.configuration.output))===digest(allocation.result.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return {envelope:allocation.result,blobs};
  }
}

function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  requireCondition(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
  requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable&&'value'in d;}),'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');return value as Record<string,unknown>;
}
function rawReference(value:unknown):void{
  const ref=closed(value,['rawResultId','resultDigest']);requireCondition(typeof ref.rawResultId==='string'&&uuid.test(ref.rawResultId)&&typeof ref.resultDigest==='string'&&/^[a-f0-9]{64}$/.test(ref.resultDigest),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
}
type WindowsDatabaseAttempt={binding:NativeControllerBinding;job:NativeJob;snapshot:NativeControllerSnapshotV2&{isolation:'WINDOWS_JOB_OBJECT'}};
function windowsDatabaseAttempt(value:unknown,binding:NativeControllerBinding,input:NativeFrameLimits):WindowsDatabaseAttempt{
  const record=closed(value,['binding','job','snapshot']),actual=validateNativeControllerBinding(record.binding);
  requireCondition(digest(actual)===digest(binding),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
  nativeJsonBytes(record.job,input.maxMetadataBytes);const job=structuredClone(record.job) as NativeJob;validateNativeEnvelope(job,input);verifyNativeInput(job);
  requireCondition(job.jobId===actual.jobId&&job.inputDigest===actual.inputDigest&&job.profileDigest===actual.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
  const snapshot=closed(record.snapshot,['attemptId','controllerInstanceId','phase','rawResult','termination','code','version','isolation','windowsEvidenceRef']);
  nativeJsonBytes(snapshot,4096);
  requireCondition(snapshot.version===2&&snapshot.isolation==='WINDOWS_JOB_OBJECT'&&typeof snapshot.attemptId==='string'&&uuid.test(snapshot.attemptId)&&typeof snapshot.controllerInstanceId==='string'&&uuid.test(snapshot.controllerInstanceId)&&['PREPARING','READY','GO_GRANTED','UNKNOWN'].includes(String(snapshot.phase))&&typeof snapshot.code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(snapshot.code),'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
  if(snapshot.rawResult!==null)rawReference(snapshot.rawResult);
  if(snapshot.windowsEvidenceRef!==null){
    const ref=closed(snapshot.windowsEvidenceRef,['recordId','recordDigest','linkId','linkDigest']);
    requireCondition(['recordId','linkId'].every(key=>typeof ref[key]==='string'&&uuid.test(ref[key] as string))&&['recordDigest','linkDigest'].every(key=>typeof ref[key]==='string'&&/^[a-f0-9]{64}$/.test(ref[key] as string)),'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
  }
  if(snapshot.termination!==null){
    const t=closed(snapshot.termination,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind']);
    requireCondition(t.jobId===binding.jobId&&t.inputDigest===binding.inputDigest&&t.profileDigest===binding.profileDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    requireCondition(['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'].every(key=>typeof t[key]==='boolean')&&(!t.startedComputation||t.goAttempted),'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
    if(t.kind==='NO_CHILD_CREATED')requireCondition(t.operationJoined&&!t.goAttempted&&!t.startedComputation&&!t.directChildClosed&&!t.subtreeTerminationConfirmed&&snapshot.rawResult===null,'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
    else if(t.kind==='WINDOWS_JOB_EMPTY')requireCondition(t.operationJoined&&t.directChildClosed&&t.subtreeTerminationConfirmed,'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
    else requireCondition(t.kind==='UNCONFIRMED','NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');
  }
  return {binding:actual,job,snapshot:structuredClone(snapshot) as WindowsDatabaseAttempt['snapshot']};
}

// The exact three-key W3-A view charges the same parent owner synchronously.
// L is a per-Journal ceiling, never a replacement for the aggregate M budget.
export function createWindowsControllerPorts(options:{db:NativeControllerDatabase;configuration:WindowsJournalConfiguration;objects:ObjectStore;bucketRef:string;memory:NativeControllerMemoryOwner}):{journal:WindowsControllerJournalPort;raw:NativeControllerRawStore}{
  const {db,configuration,objects,bucketRef,memory}=options;let journalHeld=0;
  requireCondition(memory&&Number.isSafeInteger(memory.maxBytes)&&memory.maxBytes>0&&typeof memory.available==='function'&&typeof memory.hold==='function','NATIVE_CONTROL_LIMIT_UNCONFIRMED',409,'WAIT');
  const limit=configuration.limits.parentInFlightBytes;
  const view:WindowsJournalMemory=Object.freeze({maxBytes:limit,available:()=>Math.min(limit-journalHeld,memory.available()),hold:(bytes:number)=>{
    requireCondition(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=limit-journalHeld,'WINDOWS_JOURNAL_CAPACITY_WAIT',409,'WAIT');
    const releaseParent=memory.hold(bytes);journalHeld+=bytes;let active=true;
    return ()=>{if(active){active=false;journalHeld-=bytes;releaseParent();}};
  }});
  const input={maxMetadataBytes:configuration.limits.maxMetadataBytes,maxBinaryBytes:configuration.limits.maxInputBytes,maxItems:configuration.limits.maxItems};
  const output={maxMetadataBytes:configuration.limits.maxMetadataBytes,maxBinaryBytes:configuration.limits.maxOutputBytes,maxItems:configuration.limits.maxItems};
  // Validate the raw configuration before a Journal begins owning its lifetime.
  const raw=new NativeControllerStore(db,{controllerId:configuration.controllerId,controllerInstanceId:configuration.controllerInstanceId,input,output},objects,bucketRef);
  const original=new WindowsNativeJournal(db,configuration,view),controllerId=configuration.controllerId,profileDigest=configuration.capacity.profile.nativeProfileDigest,kernelDigest=configuration.capacity.profile.kernelDigest;
  const journal:WindowsControllerJournalPort=Object.freeze({
    controllerInstanceId:configuration.controllerInstanceId,profileDigest:configuration.capacity.profile.nativeProfileDigest,kernelImplementationDigest:configuration.capacity.profile.kernelDigest,limits:Object.freeze({...configuration.limits}),memory,
    offerOriginal:original.offerOriginal.bind(original),portsFor:original.portsFor.bind(original),readyOriginal:original.readyOriginal.bind(original),parentJoinedOriginal:original.parentJoinedOriginal.bind(original),finishOriginal:original.finishOriginal.bind(original),readOriginal:original.readOriginal.bind(original),close:original.close.bind(original),
    loadOriginal:async(who:NativeControllerPeer,bindingValue:NativeControllerBinding):Promise<NativeOriginalAttemptV2>=>{
      const authenticated=peer(who),binding=validateNativeControllerBinding(bindingValue);
      requireCondition(binding.profileDigest===profileDigest&&binding.kernelDigest===kernelDigest,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
      const record=await db.decision<{allowed:boolean;attempt:unknown}>(binding.accountId,'SELECT manga_web.native_controller_load($1::jsonb,$2,$3) AS decision',[JSON.stringify(binding),controllerId,authenticated.serviceRole],value=>{windowsDatabaseAttempt(value.attempt,binding,input);});
      const attempt=windowsDatabaseAttempt(record.attempt,binding,input),release=memory.hold(3*4*131072);
      let stored:Awaited<ReturnType<WindowsNativeJournal['readOriginal']>>|undefined;
      try{
        // This larger view remains internal: its facts/seal are validated by A,
        // and only the closed eight-key snapshot crosses the domain boundary.
        stored=await original.readOriginal(binding,attempt.snapshot.windowsEvidenceRef);
        requireCondition(stored.capture.origin.authority.attemptId===attempt.snapshot.attemptId&&stored.capture.origin.authority.controllerInstanceId===attempt.snapshot.controllerInstanceId&&digest(stored.windowsEvidenceRef)===digest(attempt.snapshot.windowsEvidenceRef),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
        const {isolation,...wire}=attempt.snapshot;void isolation;
        const snapshot=validateNativeControllerSnapshotV2(stored.windowsEvidenceRef===null?{...wire,termination:null,rawResult:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'}:wire,binding);
        return {binding:attempt.binding,job:attempt.job,snapshot};
      }finally{stored=undefined;release();}
    }
  });
  return {journal,raw};
}
// 비용형 raw 권위는 원 binding과 서버 context로만 구성한다. ObjectStore를
// 비용 수집 포트로 승격하지 않고, 원 5키 factory의 journal/memory 조립을 쓴다.
type CostedRawContext={purpose:'RUN_RECOVERY'}|{purpose:'PARENT_QUERY';requestId:string;requestDigest:string;deliveryClaimId:string;authenticatedPeerId:string};
type CostedRawDecision=RawDecision&{callRef?:WindowsCostedIoCall};
function rawReadContext(value:NativeControllerRawReadContext|undefined,who:NativeControllerPeer):CostedRawContext|null{
  if(value===undefined)return null;
  requireCondition(value!==null&&typeof value==='object'&&!types.isProxy(value),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
  const descriptor=Object.getOwnPropertyDescriptor(value,'purpose');requireCondition(descriptor?.enumerable&&'value'in descriptor,'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
  if(descriptor.value==='RUN_RECOVERY'){closed(value,['purpose']);return Object.freeze({purpose:'RUN_RECOVERY'});}
  const context=closed(value,['purpose','requestId','requestDigest']);
  requireCondition(context.purpose==='PARENT_QUERY'&&typeof context.requestId==='string'&&uuid.test(context.requestId)&&typeof context.requestDigest==='string'&&/^[a-f0-9]{64}$/.test(context.requestDigest),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
  return Object.freeze({purpose:'PARENT_QUERY',requestId:context.requestId,requestDigest:context.requestDigest,deliveryClaimId:randomUUID(),authenticatedPeerId:who.peerId});
}
function rawCall(value:unknown):WindowsCostedIoCall{
  const call=closed(value,['callId','callDigest']);requireCondition(typeof call.callId==='string'&&uuid.test(call.callId)&&typeof call.callDigest==='string'&&/^[a-f0-9]{64}$/.test(call.callDigest),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');return Object.freeze({callId:call.callId,callDigest:call.callDigest});
}
class CostedWindowsControllerRawStore extends NativeControllerStore{
  constructor(db:NativeControllerDatabase,configuration:Configuration,private readonly rawIo:WindowsCostedObjectIo,bucketRef:string,objects:ObjectStore){super(db,configuration,objects,bucketRef);}
  private contextArguments(who:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context:CostedRawContext):unknown[]{
    return [JSON.stringify(attempt.binding),this.configuration.controllerId,who.serviceRole,JSON.stringify(context)];
  }
  private async claimDelivery(who:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context:CostedRawContext):Promise<WindowsCostedIoCall|null>{
    if(context.purpose==='RUN_RECOVERY')return null;
    const record=await this.db.decision<{allowed:boolean;authority:unknown}>(attempt.binding.accountId,"SELECT jsonb_build_object('allowed',true,'authority',manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb)) AS decision",this.contextArguments(who,attempt,context));
    if(record.authority===null)return null;
    nativeJsonBytes(record.authority,16384);const authority=closed(record.authority,['version','requestId','requestDigest','callRef','binding','attemptId','controllerInstanceId','peerService','peerId','deliveryClaimId']);
    requireCondition(authority.version===1&&authority.requestId===context.requestId&&authority.requestDigest===context.requestDigest&&authority.deliveryClaimId===context.deliveryClaimId&&authority.attemptId===attempt.snapshot.attemptId&&authority.controllerInstanceId===attempt.snapshot.controllerInstanceId&&authority.peerService===who.serviceRole&&authority.peerId===who.peerId&&digest(authority.binding)===digest(attempt.binding),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
    return rawCall(authority.callRef);
  }
  private lookup(who:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context:CostedRawContext):Promise<CostedRawDecision>{
    return this.db.decision<CostedRawDecision>(attempt.binding.accountId,'SELECT manga_web.windows_native_cost_raw_lookup($1::jsonb,$2,$3,$4,$5::jsonb) AS decision',[JSON.stringify(attempt.binding),this.configuration.controllerId,who.serviceRole,this.bucketRef,JSON.stringify(context)]);
  }
  private async ioEvent(kind:'begin'|'lookup',who:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context:CostedRawContext,request:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>{
    const value=await this.db.decision<{allowed:boolean;event:unknown}>(attempt.binding.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[JSON.stringify(attempt.binding),this.configuration.controllerId,who.serviceRole,JSON.stringify(request),JSON.stringify(context)]);
    return value.event===null?null:validateWindowsCostedIoEvent(value.event,request);
  }
  private async object<T>(who:NativeControllerPeer,attempt:NativeOriginalAttemptAny,context:CostedRawContext,call:WindowsCostedIoCall,kind:WindowsCostedIoRequest['kind'],key:string,ref:BlobRef,bytes?:Buffer):Promise<T>{
    const request=validateWindowsCostedIoRequest({version:1,operationId:randomUUID(),eventId:randomUUID(),call,kind,key,expected:{sha256:ref.sha256,bytesLength:ref.bytesLength}});
    let started:WindowsCostedIoEvent|null;
    try{started=await this.ioEvent('begin',who,attempt,context,request);}
    catch(error){if(error instanceof DomainError||(error as {code?:unknown})?.code==='42501')throw error;started=await this.ioEvent('lookup',who,attempt,context,request);}
    requireCondition(started?.state==='UNCONFIRMED'&&started.ended===null,'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');
    let reply:WindowsCostedIoReply<unknown>;
    if(kind==='OBJECT_READ')reply=await this.rawIo.read(request);else if(kind==='OBJECT_RECEIPT')reply=await this.rawIo.receipt(request);else{requireCondition(Buffer.isBuffer(bytes),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');reply=await this.rawIo.put(request,Buffer.from(bytes));}
    closed(reply,reply.state==='RETURNED'?['state','event','value']:['state','event']);const event=validateWindowsCostedIoEvent(reply.event,request);
    requireCondition(reply.state===event.state&&event.state!=='UNCONFIRMED'&&event.ended!==null&&digest(event.started)===digest(started.started),'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');
    const stored=await this.ioEvent('lookup',who,attempt,context,request);requireCondition(stored&&digest(stored)===digest(event),'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');
    if(reply.state!=='RETURNED')throw new DomainError(event.code??'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');
    if(kind==='OBJECT_READ'){requireCondition(Buffer.isBuffer(reply.value)&&reply.value.length<=this.configuration.output.maxBinaryBytes&&event.observed!==null&&sha256(reply.value)===event.observed.sha256&&String(reply.value.length)===event.observed.bytesLength,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return Buffer.from(reply.value) as T;}
    if(reply.value===null){requireCondition(kind==='OBJECT_RECEIPT'&&event.observed===null,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return null as T;}
    requireCondition(event.observed!==null,'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');const proof=this.receipt(reply.value as ObjectReceipt,key,ref);requireCondition(proof.sha256===event.observed.sha256&&proof.bytesLength===event.observed.bytesLength,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return proof as T;
  }
  override async putOriginal(who:NativeControllerPeer,allocation:NativeRawAllocation,blobValues:Map<string,Buffer>):Promise<void>{
    closed(who,['serviceRole','peerId']);const authenticated=peer(who),authority=this.freshPuts.get(allocation);this.freshPuts.delete(allocation);
    requireCondition(authority&&digest(authenticated)===digest(authority.peer)&&digest(allocation)===authority.allocationDigest&&digest(allocation.result)===digest(authority.result)&&allocation.reference.resultDigest===digest(authority.result),'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');
    requireCondition(digest(describeNativeBlobs(blobValues,this.configuration.output))===digest(authority.result.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
    const blobs=new Map([...blobValues].map(([id,bytes])=>[id,Buffer.from(bytes)])),context:CostedRawContext={purpose:'RUN_RECOVERY'},fresh=await this.lookup(authenticated,authority.attempt,context);
    requireCondition(fresh.available,'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');const call=rawCall(fresh.callRef);
    for(const ref of authority.refs){const key=authority.attempt.binding.accountId+'/'+ref.assetId,bytes=blobs.get(ref.blobId);requireCondition(bytes,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');
      const proof=await this.object<ObjectReceipt>(authenticated,authority.attempt,context,call,'OBJECT_PUT',key,ref,bytes),actual=await this.object<Buffer>(authenticated,authority.attempt,context,call,'OBJECT_READ',key,ref);
      requireCondition(actual.length.toString()===ref.bytesLength&&sha256(actual)===ref.sha256,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');await this.register(authenticated,authority.attempt,allocation,ref,proof);
    }
  }
  override async readExisting(who:NativeControllerPeer,value:NativeOriginalAttemptAny,readContext?:NativeControllerRawReadContext):Promise<NativeFrame<NativeResult>|null>{
    closed(who,['serviceRole','peerId']);const authenticated=peer(who),context=rawReadContext(readContext,authenticated);if(context===null)return null;
    const attempt=this.original(value);
    requireCondition(Object.hasOwn(attempt.snapshot,'version'),'NATIVE_CONTROLLER_VERSION_UNCONFIRMED',409,'WAIT');
    const claimed=await this.claimDelivery(authenticated,attempt,context);if(context.purpose==='PARENT_QUERY'&&claimed===null)return null;
    const record=await this.lookup(authenticated,attempt,context);if(!record.available||!record.allocation)return null;
    const call=rawCall(record.callRef);if(claimed)requireCondition(digest(call)===digest(claimed),'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED',409,'WAIT');
    const {allocation,refs}=this.rawDecision(record,attempt),blobs=new Map<string,Buffer>();
    for(const ref of refs){const key=attempt.binding.accountId+'/'+ref.assetId,receipt=await this.object<ObjectReceipt|null>(authenticated,attempt,context,call,'OBJECT_RECEIPT',key,ref);if(!receipt)return null;
      const proof=this.receipt(receipt,key,ref),bytes=await this.object<Buffer>(authenticated,attempt,context,call,'OBJECT_READ',key,ref);requireCondition(bytes.length.toString()===ref.bytesLength&&sha256(bytes)===ref.sha256,'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');await this.register(authenticated,attempt,allocation,ref,proof);blobs.set(ref.blobId,bytes);
    }
    const checked=await this.lookup(authenticated,attempt,context);requireCondition(checked.available&&checked.allocation&&digest(checked.allocation)===digest(allocation)&&digest(rawCall(checked.callRef))===digest(call),'NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');
    requireCondition(digest(describeNativeBlobs(blobs,this.configuration.output))===digest(allocation.result.blobs),'NATIVE_CONTROL_RAW_MISMATCH',409,'WAIT');return {envelope:allocation.result,blobs};
  }
}
export function createCostedWindowsControllerPorts(options:{db:NativeControllerDatabase;configuration:WindowsJournalConfiguration;rawIo:WindowsCostedObjectIo;bucketRef:string;memory:NativeControllerMemoryOwner}):{journal:WindowsControllerJournalPort;raw:NativeControllerRawStore}{
  closed(options,['db','configuration','rawIo','bucketRef','memory']);const {db,configuration,bucketRef,memory}=options,rawIo=captureWindowsCostedObjectIo(options.rawIo);
  const denied=async():Promise<never>=>{throw new DomainError('WINDOWS_NATIVE_COST_SCOPE_REQUIRED',409,'WAIT');};
  const objects:ObjectStore=Object.freeze({bucket:rawIo.bucket,read:denied,receipt:denied,put:denied,remove:denied});
  const input={maxMetadataBytes:configuration.limits.maxMetadataBytes,maxBinaryBytes:configuration.limits.maxInputBytes,maxItems:configuration.limits.maxItems},output={maxMetadataBytes:configuration.limits.maxMetadataBytes,maxBinaryBytes:configuration.limits.maxOutputBytes,maxItems:configuration.limits.maxItems};
  const raw=new CostedWindowsControllerRawStore(db,{controllerId:configuration.controllerId,controllerInstanceId:configuration.controllerInstanceId,input,output},rawIo,bucketRef,objects);
  const {journal}=createWindowsControllerPorts({db,configuration,objects,bucketRef,memory});return {journal,raw};
}
