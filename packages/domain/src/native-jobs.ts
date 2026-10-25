import {types} from 'node:util';
import type {Database} from '../../storage/src/database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {nativeJsonBytes,nativeTasks,nativeTaskVersion,type NativeJob,type NativeTask,type NativeTermination,type NativeTerminationV2,type WindowsRecordRef,type WindowsEvidenceRef} from '../../native/src/dto.js';
import {validateNativeCapacityAdmission,type NativeCapacityAdmission} from './native-capacity.js';

export const nativeTargetKinds=['UPLOAD','RESTORE','RASTER','EXPORT','LIBRARY','EXECUTION','REQUEST_CHECKPOINT'] as const;
export type NativeTargetKind=typeof nativeTargetKinds[number];
export type NativeOwnerCapture={contextId:string|null;contextGeneration:string|null;ownerSessionId:string|null;ownerTabId:string|null;ownerRevision:string|null;workspaceRevision:string|null};
export type NativeJobClaim={generation:string;ownerId:string;workItemId:string|null};
export type NativeJobIntent={
  version:1;jobId:string;task:NativeTask;taskVersion:typeof nativeTaskVersion;profileDigest:string;inputDigest:string;operationInputDigest:string;parentInstanceId:string;
  targetKind:NativeTargetKind;targetId:string;semanticCaptureDigest:string;logicalOperationKey:string;protectedOwnerCapture:NativeOwnerCapture;claim:NativeJobClaim;
};
export type NativeJobObservation={
  version:1;parentInstanceId:string;event:'ERROR'|'RESULT'|'TERMINATION';code:string;resultDigest:string|null;
  termination:NativeTermination&{isolation:'OWNED_FIXTURE'|'LINUX_CGROUP_V2'};
};
export type NativeJobObservationV2=Omit<NativeJobObservation,'version'|'termination'>&{version:2;termination:NativeTerminationV2&{isolation:'WINDOWS_JOB_OBJECT'};windowsRecordRef:WindowsRecordRef};
export type NativeJobObservationAny=NativeJobObservation|NativeJobObservationV2;
export type NativeJobState={
  jobId:string;parentInstanceId:string;logicalOperationKey:string;go:'UNCONSUMED'|'CONSUMED';result:'UNOBSERVED'|'OBSERVED';
  termination:'UNCONFIRMED'|'NO_CHILD_CANDIDATE'|'UNTRUSTED_CGROUP_CANDIDATE';cost:'UNCONFIRMED';application:'UNCONFIRMED';unresolved:true;
  firstError:{observationId:string;digest:string;snapshot:NativeJobObservation;receivedAt:string}|null;
};
export type NativeJobStateV2=Omit<NativeJobState,'termination'|'firstError'>&{termination:'NO_CHILD_CANDIDATE'|'UNTRUSTED_WINDOWS_CANDIDATE';windowsEvidenceRef:WindowsEvidenceRef;firstError:{observationId:string;digest:string;snapshot:NativeJobObservationAny;receivedAt:string}|null};
export type NativeJobStateAny=NativeJobState|NativeJobStateV2;
type Decision={allowed:boolean;reason:string;intentDigest?:string;observationDigest?:string;capacityReservationId?:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const invalid=()=>requireCondition(false,'NATIVE_JOB_RECORD_INVALID',422);
function object(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value as object);
  if(Reflect.ownKeys(value as object).length!==keys.length||!keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]))invalid();
  return value as Record<string,unknown>;
}
function id(value:unknown):asserts value is string{if(typeof value!=='string'||!uuid.test(value))invalid();}
function hexadecimal(value:unknown):asserts value is string{if(typeof value!=='string'||!hash.test(value))invalid();}
function generation(value:unknown):asserts value is string{
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)>9223372036854775807n)invalid();
}
export function validateNativeOwnerCapture(value:unknown):NativeOwnerCapture{
  const capture=object(value,['contextId','contextGeneration','ownerSessionId','ownerTabId','ownerRevision','workspaceRevision']);
  for(const key of ['contextId','ownerSessionId','ownerTabId'])if(capture[key]!==null)id(capture[key]);
  for(const key of ['contextGeneration','ownerRevision','workspaceRevision'])if(capture[key]!==null)generation(capture[key]);
  if((capture.contextId===null)!==(capture.contextGeneration===null))invalid();
  return structuredClone(capture) as NativeOwnerCapture;
}
export function validateNativeJobClaim(value:unknown):NativeJobClaim{
  const claim=object(value,['generation','ownerId','workItemId']);generation(claim.generation);id(claim.ownerId);if(claim.workItemId!==null)id(claim.workItemId);
  return structuredClone(claim) as NativeJobClaim;
}

// The frame identity includes jobId. This distinct semantic identity must not
// change when a parent restarts, reclaims a worker lease or allocates output IDs.
export function nativeOperationInputDigest(job:NativeJob):string{
  nativeJsonBytes(job.metadata,0xffffffff);
  const metadata=structuredClone(job.metadata);
  if(job.task==='GEMINI_PREPARE'||job.task==='GEMINI_APPLY'){
    const input=metadata.input;
    requireCondition(input&&typeof input==='object'&&!Array.isArray(input),'NATIVE_JOB_RECORD_INVALID',422);
    delete (input as Record<string,unknown>).claimGeneration;
  }
  if(job.task==='GEMINI_APPLY'){
    requireCondition(Array.isArray(metadata.novelRegionIds),'NATIVE_JOB_RECORD_INVALID',422);
    metadata.novelRegionIds={count:metadata.novelRegionIds.length};
  }
  return digest({task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,metadata,blobs:job.blobs});
}
export function nativeLogicalOperationKey(value:Pick<NativeJobIntent,'targetKind'|'targetId'|'semanticCaptureDigest'|'task'|'taskVersion'|'profileDigest'|'operationInputDigest'>):string{
  if(!nativeTargetKinds.includes(value.targetKind)||!nativeTasks.includes(value.task)||value.taskVersion!==nativeTaskVersion)invalid();
  id(value.targetId);hexadecimal(value.semanticCaptureDigest);hexadecimal(value.profileDigest);hexadecimal(value.operationInputDigest);
  // Each member has a closed newline-free grammar; SQL uses this same encoding.
  return sha256(['native-logical-operation-v1',value.targetKind,value.targetId.toLowerCase(),value.semanticCaptureDigest,value.task,value.taskVersion,value.profileDigest,value.operationInputDigest].join('\n'));
}
export function validateNativeJobIntent(value:unknown):NativeJobIntent{
  const intent=object(value,['version','jobId','task','taskVersion','profileDigest','inputDigest','operationInputDigest','parentInstanceId','targetKind','targetId','semanticCaptureDigest','logicalOperationKey','protectedOwnerCapture','claim']);
  if(intent.version!==1||!nativeTasks.includes(intent.task as NativeTask)||intent.taskVersion!==nativeTaskVersion||!nativeTargetKinds.includes(intent.targetKind as NativeTargetKind))invalid();
  for(const key of ['jobId','parentInstanceId','targetId'])id(intent[key]);
  for(const key of ['profileDigest','inputDigest','operationInputDigest','semanticCaptureDigest','logicalOperationKey'])hexadecimal(intent[key]);
  validateNativeOwnerCapture(intent.protectedOwnerCapture);validateNativeJobClaim(intent.claim);
  if(intent.logicalOperationKey!==nativeLogicalOperationKey(intent as NativeJobIntent))invalid();
  return structuredClone(intent) as NativeJobIntent;
}
export function validateNativeJobObservation(value:NativeJobObservation):NativeJobObservation;
export function validateNativeJobObservation(value:NativeJobObservationV2):NativeJobObservationV2;
export function validateNativeJobObservation(value:{version:1}&Record<string,unknown>):NativeJobObservation;
export function validateNativeJobObservation(value:{version:2}&Record<string,unknown>):NativeJobObservationV2;
export function validateNativeJobObservation(value:unknown):NativeJobObservationAny;
export function validateNativeJobObservation(value:unknown):NativeJobObservationAny{
  if(!value||typeof value!=='object'||types.isProxy(value))invalid();
  const version=Object.getOwnPropertyDescriptor(value as object,'version')?.value;
  const keys=['version','parentInstanceId','event','code','resultDigest','termination'];
  const observation=object(value,version===2?[...keys,'windowsRecordRef']:keys);
  if((observation.version!==1&&observation.version!==2)||typeof observation.event!=='string'||!['ERROR','RESULT','TERMINATION'].includes(observation.event)||typeof observation.code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(observation.code))invalid();
  id(observation.parentInstanceId);
  if(observation.resultDigest!==null)hexadecimal(observation.resultDigest);
  if((observation.event==='RESULT')!==(observation.resultDigest!==null))invalid();
  const termination=object(observation.termination,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind','isolation']);
  id(termination.jobId);hexadecimal(termination.inputDigest);hexadecimal(termination.profileDigest);
  for(const key of ['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'])if(typeof termination[key]!=='boolean')invalid();
  if(termination.startedComputation&&!termination.goAttempted)invalid();
  if(observation.version===2){
    const ref=object(observation.windowsRecordRef,['recordId','recordDigest']);id(ref.recordId);hexadecimal(ref.recordDigest);
    if(termination.isolation!=='WINDOWS_JOB_OBJECT'||!['NO_CHILD_CREATED','WINDOWS_JOB_EMPTY','UNCONFIRMED'].includes(termination.kind as string))invalid();
    if(termination.kind==='WINDOWS_JOB_EMPTY'&&(!termination.operationJoined||!termination.directChildClosed||!termination.subtreeTerminationConfirmed))invalid();
    if(termination.kind!=='WINDOWS_JOB_EMPTY'&&termination.subtreeTerminationConfirmed)invalid();
    if(observation.event==='RESULT'&&(!termination.goAttempted||!termination.startedComputation||termination.kind==='NO_CHILD_CREATED'))invalid();
  }else{
    if(!['NO_CHILD_CREATED','DIRECT_CHILD_ONLY','CGROUP_EMPTY','UNCONFIRMED'].includes(termination.kind as string)||!['OWNED_FIXTURE','LINUX_CGROUP_V2'].includes(termination.isolation as string))invalid();
    if(termination.subtreeTerminationConfirmed&&(!termination.directChildClosed||!termination.operationJoined||termination.isolation!=='LINUX_CGROUP_V2'))invalid();
    if(termination.kind==='DIRECT_CHILD_ONLY'&&(!termination.operationJoined||!termination.directChildClosed||termination.subtreeTerminationConfirmed||termination.isolation!=='OWNED_FIXTURE'))invalid();
    if(termination.kind==='CGROUP_EMPTY'&&(!termination.operationJoined||!termination.directChildClosed||!termination.subtreeTerminationConfirmed||termination.isolation!=='LINUX_CGROUP_V2'))invalid();
  }
  if(termination.kind==='NO_CHILD_CREATED'&&(!termination.operationJoined||termination.goAttempted||termination.startedComputation||termination.directChildClosed||termination.subtreeTerminationConfirmed))invalid();
  return structuredClone(observation) as NativeJobObservationAny;
}

export function validateNativeJobObservationV2(value:unknown):NativeJobObservationV2{
  const checked=validateNativeJobObservation(value);if(checked.version!==2)invalid();return checked as NativeJobObservationV2;
}
export function validateNativeJobState(value:unknown,logicalOperationKey?:string):NativeJobStateAny{
  if(!value||typeof value!=='object'||types.isProxy(value))invalid();
  const windows=Object.hasOwn(value as object,'windowsEvidenceRef'),keys=['jobId','parentInstanceId','logicalOperationKey','go','result','termination','cost','application','unresolved','firstError'];
  const state=object(value,windows?[...keys,'windowsEvidenceRef']:keys);
  id(state.jobId);id(state.parentInstanceId);hexadecimal(state.logicalOperationKey);
  if(logicalOperationKey!==undefined&&state.logicalOperationKey!==logicalOperationKey)invalid();
  if(!['UNCONSUMED','CONSUMED'].includes(state.go as string)||!['UNOBSERVED','OBSERVED'].includes(state.result as string)||state.cost!=='UNCONFIRMED'||state.application!=='UNCONFIRMED'||state.unresolved!==true)invalid();
  if(windows){
    if(!['NO_CHILD_CANDIDATE','UNTRUSTED_WINDOWS_CANDIDATE'].includes(state.termination as string))invalid();
    const ref=object(state.windowsEvidenceRef,['recordId','recordDigest','linkId','linkDigest']);id(ref.recordId);hexadecimal(ref.recordDigest);id(ref.linkId);hexadecimal(ref.linkDigest);
  }else if(!['UNCONFIRMED','NO_CHILD_CANDIDATE','UNTRUSTED_CGROUP_CANDIDATE'].includes(state.termination as string))invalid();
  if(state.firstError!==null){
    const error=object(state.firstError,['observationId','digest','snapshot','receivedAt']);id(error.observationId);hexadecimal(error.digest);
    if(typeof error.receivedAt!=='string'||!Number.isFinite(Date.parse(error.receivedAt)))invalid();
    const observation=validateNativeJobObservation(error.snapshot);
    if(observation.event!=='ERROR'||observation.parentInstanceId!==state.parentInstanceId||observation.termination.jobId!==state.jobId)invalid();
    if(observation.version===2){
      if(!windows)invalid();const ref=state.windowsEvidenceRef as WindowsEvidenceRef;
      if(observation.windowsRecordRef.recordId!==ref.recordId||observation.windowsRecordRef.recordDigest!==ref.recordDigest)invalid();
    }
  }
  return structuredClone(state) as NativeJobStateAny;
}

// Parent-only hooks. The child receives no database credentials or references.
// Parent owning services still validate semantic capture, current owner and
// pipeline INPUT before these DB-only hooks. No observation releases capacity,
// confirms cost, applies a result or authorizes another logical invocation.
export class NativeJobStore{
  constructor(readonly db:Database,readonly accountId:string){id(accountId);}
  async beforeIntent(value:NativeJobIntent,receiptGuard=false,capacity?:NativeCapacityAdmission):Promise<Decision>{
    const intent=validateNativeJobIntent(value),configuration=capacity===undefined?undefined:validateNativeCapacityAdmission(capacity);
    return this.db.accountTransaction(this.accountId,async tx=>{
      const sql=configuration?'SELECT manga_web.native_capacity_create_intent($1::jsonb,$2,$3::jsonb) AS decision':receiptGuard?'SELECT manga_web.native_receipt_create_intent($1::jsonb) AS decision':'SELECT manga_web.native_job_create_intent($1::jsonb) AS decision';
      const decision=(await tx.client.query<{decision:Decision}>(sql,configuration?[JSON.stringify(intent),receiptGuard,JSON.stringify(configuration)]:[JSON.stringify(intent)])).rows[0].decision;
      requireCondition(decision.allowed,decision.reason,409,'WAIT');return decision;
    });
  }
  async beforeGo(jobId:string,parentInstanceId:string,claimValue:NativeJobClaim,captureValue:NativeOwnerCapture,capacity?:NativeCapacityAdmission):Promise<Decision>{
    id(jobId);id(parentInstanceId);const claim=validateNativeJobClaim(claimValue);const capture=validateNativeOwnerCapture(captureValue),configuration=capacity===undefined?undefined:validateNativeCapacityAdmission(capacity);
    return this.db.accountTransaction(this.accountId,async tx=>{
      const sql=configuration?'SELECT manga_web.native_capacity_consume_go($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS decision':'SELECT manga_web.native_job_consume_go($1,$2,$3::jsonb,$4::jsonb) AS decision';
      const values:unknown[]=[jobId,parentInstanceId,JSON.stringify(claim),JSON.stringify(capture)];if(configuration)values.push(JSON.stringify(configuration));
      const decision=(await tx.client.query<{decision:Decision}>(sql,values)).rows[0].decision;
      requireCondition(decision.allowed,decision.reason,409,'WAIT');return decision;
    });
  }
  async observe(observationId:string,value:NativeJobObservation):Promise<Decision>{
    id(observationId);const observation=validateNativeJobObservation(value);if(observation.version!==1)invalid();
    return this.db.accountTransaction(this.accountId,async tx=>{
      const decision=(await tx.client.query<{decision:Decision}>('SELECT manga_web.native_job_append_observation($1,$2::jsonb) AS decision',[observationId,JSON.stringify(observation)])).rows[0].decision;
      requireCondition(decision.allowed,decision.reason,409,'WAIT');return decision;
    },true);
  }
  async unresolved(logicalOperationKey:string):Promise<NativeJobStateAny[]>{
    hexadecimal(logicalOperationKey);
    return this.db.accountTransaction(this.accountId,async tx=>(await tx.client.query<{state:unknown}>('SELECT state FROM manga_web.native_job_unresolved($1)',[logicalOperationKey])).rows.map(row=>validateNativeJobState(row.state,logicalOperationKey)),true);
  }
}
