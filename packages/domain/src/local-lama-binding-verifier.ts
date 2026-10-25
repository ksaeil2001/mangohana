import {types} from 'node:util';
import type {Database,Transaction} from '../../storage/src/database.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import type {LocalLaMaCapture} from '../../providers/src/local-lama.js';
import type {LocalLaMaInvocationBinding} from '../../providers/src/local-lama-executor.js';
import {canonicalInput,type StageInput} from './provider.js';
import type {NativeJobClaim} from './native-jobs.js';
import {FullStageCostCalculator,type FullStageCostBounds} from './full-stage-cost.js';
import type {FullStageCostBasis} from './full-stage-cost-journal.js';
import type {PipelineStageCandidate} from './pipeline-evidence.js';
import type {AssetDependency} from './model.js';

export type LocalLaMaBindingReaderBounds={maxRecordBytes:number;maxRecords:number;maxInFlightBytes:number;maxConcurrentReads:number;calculator:FullStageCostBounds};
export type LocalLaMaBindingCore={request_id:string;logical_step_id:string;input_digest:string;contract_version:string;execution_state:string;claim_generation:string;dispatch_attempted:boolean;context_id:string;request_generation:string;page_lineage_id:string;mode:'FREE'|'PAID';request_state:string;request_terminal:boolean;request_started:boolean;context_generation:string;lifecycle:string;scope_digest:string;captured_settings:unknown;native_hold:boolean};
type Fence={work_item_id:string;kind:string;state:string;claim_owner:string|null;claim_generation:string;lease_live:boolean;request_matches:boolean;pointer_matches:boolean;session_active:boolean;connected:boolean;page_current:boolean;cost_clear:boolean;wait_clear:boolean;native_clear:boolean};
export type LocalLaMaPreparedMaskDescriptor={sha256:string;bytesLength:string;mediaType:'image/png'};
export type LocalLaMaBindingEvidence={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};
type Protected={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};
type Source={version:1;candidate:PipelineStageCandidate;phase:string;value:unknown};
const code='LOCAL_LAMA_BINDING_UNCONFIRMED',capacity='LOCAL_LAMA_BINDING_CAPACITY',dispatch='LOCAL_LAMA_DISPATCH_UNCONFIRMED';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[0-9a-f]{64}$/,generation=/^[1-9][0-9]{0,18}$/;
const kinds=['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_CANDIDATE','OPERATIONAL_SOURCE'];
const phases=['PROVIDER_START','PROVIDER_RESULT','PROVIDER','LAMA_INPUT','LAMA_START','LAMA_OUTCOME','LAMA_RECONCILIATION','RENDER_START','RENDER_OUTCOME','NATIVE_FAILURE'];
export const fingerprint=(input:StageInput)=>digest(canonicalInput(input));
export function must(value:unknown,error=code):asserts value{requireCondition(value,error,409,'WAIT');}
export function closed(value:unknown,required:readonly string[],optional:readonly string[]=[]):void{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const keys=Reflect.ownKeys(value),fields=Object.getOwnPropertyDescriptors(value);
  must(keys.every(key=>typeof key==='string'&&[...required,...optional].includes(key)&&fields[key]?.enumerable&&'value'in fields[key])&&required.every(key=>Object.hasOwn(fields,key)));
}
export function id(value:unknown):asserts value is string{must(typeof value==='string'&&uuid.test(value));}
export function hexadecimal(value:unknown):asserts value is string{must(typeof value==='string'&&hash.test(value));}
function counter(value:unknown):asserts value is string{must(typeof value==='string'&&generation.test(value)&&BigInt(value)<=9223372036854775807n);}
export function own<T>(value:T,maxBytes:number):{value:T;bytes:number}{
  // Reject descriptors/prototypes before serialization. In particular arrays
  // have only dense own data elements, not hidden getters or toJSON hooks.
  const walk=(item:unknown,depth:number):void=>{
    must(!types.isProxy(item)&&depth<=64);if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number')return;
    must(item!==null&&typeof item==='object');
    if(Array.isArray(item)){
      must(Object.getPrototypeOf(item)===Array.prototype&&item.length<=maxBytes);const fields=Reflect.ownKeys(item);must(fields.length===item.length+1);
      for(let at=0;at<item.length;at++){const field=Object.getOwnPropertyDescriptor(item,String(at));must(field&&field.enumerable&&'value'in field);walk(field.value,depth+1);}
    }else{
      must(Object.getPrototypeOf(item)===Object.prototype);const fields=Reflect.ownKeys(item);must(fields.length<=maxBytes);
      for(const key of fields){const field=Object.getOwnPropertyDescriptor(item,key);must(typeof key==='string'&&field&&field.enumerable&&'value'in field);walk(field.value,depth+1);}
    }
  };
  try{walk(value,0);const encoded=nativeJsonBytes(value,maxBytes);return {value:JSON.parse(encoded.toString('utf8')) as T,bytes:encoded.length};}
  catch{throw new DomainError(code,409,'WAIT');}
}
function dependency(value:unknown):AssetDependency{
  closed(value,['assetId','sha256','bytesLength','mediaType']);const item=value as AssetDependency;id(item.assetId);hexadecimal(item.sha256);counter(item.bytesLength);must(typeof item.mediaType==='string'&&item.mediaType.length>0);return item;
}
export function localCapture(value:LocalLaMaCapture):LocalLaMaCapture{
  closed(value,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);
  must(value.version===1&&typeof value.profileId==='string'&&value.profileId.length>0&&value.profileId.length<=160);id(value.executionId);
  for(const field of ['inputDigest','profileDigest','imageSha256','maskSha256','captureDigest'] as const)hexadecimal(value[field]);
  for(const field of ['imageByteLength','maskByteLength'] as const)must(Number.isSafeInteger(value[field])&&value[field]>0);
  closed(value.identity,['codeCommit','weightsSha256','configSha256','weightsLicenseVerified','runtimeVerified']);must(typeof value.identity.codeCommit==='string'&&/^[0-9a-f]{40}$/.test(value.identity.codeCommit));hexadecimal(value.identity.weightsSha256);hexadecimal(value.identity.configSha256);must(typeof value.identity.weightsLicenseVerified==='boolean'&&typeof value.identity.runtimeVerified==='boolean');
  const {captureDigest,...body}=value;must(digest(body)===captureDigest);return value;
}

// Internal shared verifier. It owns no mutation callback or engine capability.
export class LocalLaMaBindingVerifier{
  readonly bounds:Readonly<LocalLaMaBindingReaderBounds>;
  readonly transaction:Database['accountTransaction'];readonly reservation:number;
  constructor(db:Database,bounds:LocalLaMaBindingReaderBounds){
    closed(bounds,['maxRecordBytes','maxRecords','maxInFlightBytes','maxConcurrentReads','calculator']);closed(bounds.calculator,['maxInputBytes','maxOutputBytes','maxComponents','maxEvidenceRefs','maxStringBytes']);
    must([bounds.maxRecordBytes,bounds.maxRecords,bounds.maxInFlightBytes,bounds.maxConcurrentReads].every(value=>Number.isSafeInteger(value)&&value>0),capacity);
    must(bounds.maxRecordBytes<=2147483647&&bounds.maxRecords<2147483647&&bounds.maxRecordBytes*(bounds.maxRecords+1)<=2147483647,capacity);
    try{new FullStageCostCalculator(null,bounds.calculator);}catch{throw new DomainError(capacity,409,'WAIT');}this.bounds=Object.freeze({...bounds,calculator:Object.freeze({...bounds.calculator})});
    this.reservation=8*(bounds.maxRecordBytes*(bounds.maxRecords+4)+bounds.calculator.maxInputBytes+bounds.calculator.maxOutputBytes);
    must(Number.isSafeInteger(this.reservation)&&this.reservation<=bounds.maxInFlightBytes,capacity);
    must(db!==null&&typeof db==='object'&&!types.isProxy(db));const role=Object.getOwnPropertyDescriptor(db,'role');must(role&&'value'in role&&role.value==='trio_web_worker');
    const prototype=Object.getPrototypeOf(db);must(!types.isProxy(prototype));const method=Object.getOwnPropertyDescriptor(db,'accountTransaction')??(prototype?Object.getOwnPropertyDescriptor(prototype,'accountTransaction'):undefined);
    must(method&&'value'in method&&typeof method.value==='function'&&!types.isProxy(method.value));this.transaction=Function.prototype.bind.call(method.value,db) as Database['accountTransaction'];
  }
  input(value:StageInput):StageInput{
    closed(value,['executionId','requestId','stage','inputDigest','settings','scope','originalAssetId','initialData','previousData','width','height','accountId','contextId','assetDependencies','envelope'],['claimGeneration','currentCleanedAssetId','currentRenderAssetId','previousOutputAssetIds','paintInclusion','paintStrokes']);
    id(value.accountId);id(value.contextId);id(value.executionId);id(value.requestId);id(value.originalAssetId);hexadecimal(value.inputDigest);must(value.stage==='CLEANUP'&&value.envelope&&Number.isSafeInteger(value.width)&&value.width>0&&Number.isSafeInteger(value.height)&&value.height>0);
    try{assertWire('stageInputEnvelope',value.envelope);}catch{throw new DomainError(code,409,'WAIT');}const envelope=value.envelope;
    must(envelope.executionId===value.executionId&&envelope.requestId===value.requestId&&envelope.logicalStepId===value.stage&&envelope.inputDigest===value.inputDigest&&envelope.contextId===value.contextId&&envelope.stageContract===value.settings.contractVersion&&digest(envelope.capturedSettings)===digest(value.settings));
    must(Array.isArray(value.assetDependencies)&&new Set(value.assetDependencies.map(item=>dependency(item).assetId.toLowerCase())).size===value.assetDependencies.length&&digest(envelope.assetIds)===digest(value.assetDependencies.map(item=>item.assetId)));
    if(value.currentCleanedAssetId!==undefined&&value.currentCleanedAssetId!==null)id(value.currentCleanedAssetId);if(value.currentRenderAssetId!==undefined&&value.currentRenderAssetId!==null)id(value.currentRenderAssetId);return value;
  }
  async core(tx:Transaction,input:StageInput,lockCurrent=false):Promise<LocalLaMaBindingCore>{
    must(tx.account.account_id===input.accountId);
    const rows=(await tx.client.query<LocalLaMaBindingCore>(`SELECT e.request_id,
      CASE WHEN octet_length(e.logical_step_id)<=9 THEN e.logical_step_id ELSE NULL END AS logical_step_id,
      CASE WHEN octet_length(e.input_digest)<=64 THEN e.input_digest ELSE NULL END AS input_digest,
      CASE WHEN octet_length(e.contract_version)<=$3 THEN e.contract_version ELSE NULL END AS contract_version,
      CASE WHEN octet_length(e.state)<=11 THEN e.state ELSE NULL END AS execution_state,e.claim_generation::text,e.dispatch_attempted_at IS NOT NULL AS dispatch_attempted,
      r.context_id,r.context_generation::text AS request_generation,r.page_lineage_id,
      CASE WHEN octet_length(r.mode)<=4 THEN r.mode ELSE NULL END AS mode,
      CASE WHEN octet_length(r.state)<=14 THEN r.state ELSE NULL END AS request_state,
      r.terminal_at IS NOT NULL AS request_terminal,r.first_start_at IS NOT NULL AS request_started,
      c.generation::text AS context_generation,CASE WHEN octet_length(c.lifecycle)<=7 THEN c.lifecycle ELSE NULL END AS lifecycle,
      CASE WHEN octet_length(r.scope_digest)<=64 THEN r.scope_digest ELSE NULL END AS scope_digest,
      CASE WHEN octet_length(sr.captured_settings::text)<=$3 THEN sr.captured_settings ELSE NULL END AS captured_settings,
      r.hold_reasons @> '["NATIVE_EXECUTION_UNCONFIRMED"]'::jsonb AS native_hold
      FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
      JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
      JOIN settings_revisions sr ON sr.account_id=r.account_id AND sr.context_id=r.context_id AND sr.settings_revision=r.settings_revision
      WHERE e.account_id=$1 AND e.execution_id=$2 LIMIT 2 FOR UPDATE OF ${lockCurrent?'e,r,c':'e'}`,[input.accountId,input.executionId,this.bounds.maxRecordBytes])).rows;
    must(Array.isArray(rows)&&!types.isProxy(rows)&&rows.length===1);const result=own(rows[0],this.bounds.maxRecordBytes).value;
    closed(result,['request_id','logical_step_id','input_digest','contract_version','execution_state','claim_generation','dispatch_attempted','context_id','request_generation','page_lineage_id','mode','request_state','request_terminal','request_started','context_generation','lifecycle','scope_digest','captured_settings','native_hold']);
    must(result.request_id===input.requestId&&result.logical_step_id===input.stage&&result.input_digest===input.inputDigest&&result.contract_version===input.settings.contractVersion&&result.context_id===input.contextId&&result.request_generation===input.envelope!.contextGeneration&&result.page_lineage_id===input.envelope!.pageLineageId&&result.scope_digest===digest(input.scope)&&digest(result.captured_settings)===digest(input.settings));
    must(['FREE','PAID'].includes(result.mode)&&['PREPARED','DISPATCHING','RUNNING','UNKNOWN','SUCCEEDED','REJECTED','FAILED'].includes(result.execution_state)&&['ACCEPTED','ACTIVE','WAITING','STOP_REQUESTED','COMPLETED','STOPPED','FAILED'].includes(result.request_state)&&['OPEN','EXITING','CLOSED'].includes(result.lifecycle));
    counter(result.claim_generation);counter(result.request_generation);counter(result.context_generation);for(const flag of ['dispatch_attempted','request_terminal','request_started','native_hold'] as const)must(typeof result[flag]==='boolean');return result;
  }
  async records(tx:Transaction,input:StageInput,all=false):Promise<LocalLaMaBindingEvidence[]>{
    // One total LIMIT across all four kinds, not four separately bounded reads.
    // Oversized payload/ref/digest remains a visible NULL row and holds the
    // result before any prefix return. Request/context JSON is never selected.
    const rows=(await tx.client.query<LocalLaMaBindingEvidence>(`SELECT evidence_id,CASE WHEN octet_length(kind)<=64 THEN kind ELSE NULL END AS kind,
      CASE WHEN octet_length(evidence_digest)<=64 THEN evidence_digest ELSE NULL END AS evidence_digest,
      CASE WHEN octet_length(protected_evidence_ref)<=36 THEN protected_evidence_ref ELSE NULL END AS protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=$4 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND ${all?'($3::text[] IS NOT NULL)':'kind=ANY($3::text[])'}
      ORDER BY received_at,evidence_id LIMIT $5`,[input.accountId,input.executionId,kinds,this.bounds.maxRecordBytes,this.bounds.maxRecords+1])).rows;
    must(Array.isArray(rows)&&!types.isProxy(rows)&&rows.length<=this.bounds.maxRecords);let total=0;const ids=new Set<string>(),digests=new Set<string>();
    return rows.map(row=>{
      const owned=own(row,this.bounds.maxRecordBytes);total+=owned.bytes;must(total<=this.bounds.maxRecordBytes*this.bounds.maxRecords);const item=owned.value;closed(item,['evidence_id','kind','evidence_digest','protected_evidence_ref','protected_observation']);
      id(item.evidence_id);hexadecimal(item.evidence_digest);must(typeof item.kind==='string'&&item.kind.length>0&&(all||kinds.includes(item.kind))&&item.protected_evidence_ref===item.evidence_id&&item.protected_observation!==null&&digest(item.protected_observation)===item.evidence_digest&&!ids.has(item.evidence_id.toLowerCase())&&!digests.has(item.kind+':'+item.evidence_digest));ids.add(item.evidence_id.toLowerCase());digests.add(item.kind+':'+item.evidence_digest);
      if(item.kind==='INPUT'){const stored=this.input(item.protected_observation as StageInput);must(!Object.hasOwn(stored,'claimGeneration')&&digest(stored)===fingerprint(input));}
      else if(kinds.includes(item.kind)){closed(item.protected_observation,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const record=item.protected_observation as Protected;must(record.version===1&&record.accountId===input.accountId&&record.executionId===input.executionId&&record.inputDigest===input.inputDigest&&record.inputFingerprint===fingerprint(input)&&record.kind===item.kind);}
      return item;
    });
  }
  private basis(input:StageInput,capture:LocalLaMaCapture,core:LocalLaMaBindingCore,value:FullStageCostBasis):FullStageCostBasis{
    closed(value,['version','capture','captureDigest','snapshot','snapshotDigest']);closed(value.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    try{
      // The immutable full-stage basis has its own profile. It need not be the
      // Local model/media profile; neither profile is replaced by today's one.
      const normalized=new FullStageCostCalculator(value.snapshot,this.bounds.calculator).calculate({accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),stage:'CLEANUP',profileDigest:value.capture.profileDigest,mode:core.mode},{provider:null,quantities:null,allocation:null});
      must(value.version===1&&digest(value.capture)===digest(normalized.capture)&&value.captureDigest===normalized.captureDigest&&value.snapshotDigest===normalized.snapshotDigest&&digest(value.snapshot)===digest(normalized.snapshot)&&value.captureDigest!==capture.captureDigest);return value;
    }catch{throw new DomainError(code,409,'WAIT');}
  }
  private candidate(input:StageInput,value:PipelineStageCandidate):PipelineStageCandidate{
    closed(value,['version','executionId','inputDigest','inputFingerprint','stage','claimGeneration','evidenceId','maskAssetId','cleanedAssetId','renderAssetId']);
    must(value.version===1&&value.executionId===input.executionId&&value.inputDigest===input.inputDigest&&value.inputFingerprint===fingerprint(input)&&value.stage==='CLEANUP'&&value.renderAssetId===null);counter(value.claimGeneration);id(value.evidenceId);id(value.maskAssetId);id(value.cleanedAssetId);
    const ids=[value.evidenceId,value.maskAssetId,value.cleanedAssetId].map(id=>id.toLowerCase());must(new Set(ids).size===ids.length&&ids.every(id=>!input.assetDependencies!.some(item=>item.assetId.toLowerCase()===id)));return value;
  }
  original(input:StageInput,capture:LocalLaMaCapture,core:LocalLaMaBindingCore,records:LocalLaMaBindingEvidence[],preparedMask?:LocalLaMaPreparedMaskDescriptor):LocalLaMaInvocationBinding|null{
    if(preparedMask){closed(preparedMask,['sha256','bytesLength','mediaType']);hexadecimal(preparedMask.sha256);counter(preparedMask.bytesLength);must(preparedMask.mediaType==='image/png');}
    const values=(kind:string)=>records.filter(row=>row.kind===kind).map(row=>(row.protected_observation as Protected).value);
    must(records.filter(row=>row.kind==='INPUT').length===1);const bases=values('OPERATIONAL_COST_BASIS'),candidates=values('OPERATIONAL_CANDIDATE'),sources=values('OPERATIONAL_SOURCE') as Source[];must(bases.length<=1&&candidates.length<=1);
    const basis=bases.length?this.basis(input,capture,core,bases[0] as FullStageCostBasis):null,candidate=candidates.length?this.candidate(input,candidates[0] as PipelineStageCandidate):null;let prepared=0;
    for(const source of sources){
      closed(source,['version','candidate','phase','value']);must(source.version===1&&typeof source.phase==='string'&&phases.includes(source.phase)&&basis&&candidate&&digest(this.candidate(input,source.candidate))===digest(candidate));
      must(!['PROVIDER_START','PROVIDER_RESULT','PROVIDER','RENDER_START','RENDER_OUTCOME'].includes(source.phase));
      if(source.phase==='LAMA_INPUT'){
        prepared++;closed(source.value,['capture','image','mask']);const plan=source.value as {capture:LocalLaMaCapture;image:AssetDependency;mask:AssetDependency};localCapture(plan.capture);must(digest(plan.capture)===digest(capture));const image=dependency(plan.image),mask=dependency(plan.mask),original=input.assetDependencies!.find(item=>item.assetId===(input.currentCleanedAssetId??input.originalAssetId));
        must(original&&digest(image)===digest(original)&&image.mediaType==='image/png'&&image.sha256===capture.imageSha256&&image.bytesLength===String(capture.imageByteLength)&&mask.assetId===candidate.maskAssetId&&mask.mediaType==='image/png'&&mask.sha256===capture.maskSha256&&mask.bytesLength===String(capture.maskByteLength));
        if(preparedMask)must(mask.sha256===preparedMask.sha256&&mask.bytesLength===preparedMask.bytesLength&&mask.mediaType===preparedMask.mediaType);
      }
      if(source.phase==='LAMA_START'){closed(source.value,['evidenceId','captureDigest']);const fact=source.value as {evidenceId:string;captureDigest:string};id(fact.evidenceId);must(fact.evidenceId!==candidate.evidenceId&&fact.captureDigest===capture.captureDigest);}
    }
    must(prepared<=1);if(sources.some(source=>['LAMA_START','LAMA_OUTCOME','LAMA_RECONCILIATION'].includes(source.phase)))must(prepared===1);
    if(!basis||!candidate||prepared===0)return null;
    return {version:1,accountId:input.accountId!,requestId:input.requestId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,mode:core.mode};
  }
  async dispatchFence(tx:Transaction,input:StageInput,claim:NativeJobClaim,core:LocalLaMaBindingCore,lockCurrent=false):Promise<void>{
    must(tx.account.access_state==='ACTIVE'&&core.execution_state==='DISPATCHING'&&core.dispatch_attempted&&input.claimGeneration===claim.generation&&core.claim_generation===claim.generation&&!core.request_terminal&&(['ACCEPTED','ACTIVE','WAITING'].includes(core.request_state)||(core.request_state==='STOP_REQUESTED'&&core.request_started))&&core.lifecycle!=='CLOSED'&&core.context_generation===core.request_generation&&claim.workItemId!==null&&!core.native_hold,dispatch);
    const rows=(await tx.client.query<Fence>(`SELECT w.work_item_id,
      CASE WHEN octet_length(w.kind)<=9 THEN w.kind ELSE NULL END AS kind,
      CASE WHEN octet_length(w.state)<=7 THEN w.state ELSE NULL END AS state,
      CASE WHEN octet_length(w.claim_owner)<=36 THEN w.claim_owner ELSE NULL END AS claim_owner,w.claim_generation::text,
      w.lease_until>$4 AS lease_live,w.target_ref->>'requestId'=$3::uuid::text AS request_matches,
      s.current_execution_id=$2::uuid AS pointer_matches,
      EXISTS(SELECT 1 FROM app_sessions a JOIN login_bindings b USING(account_id,binding_id)
        JOIN workspace_contexts c ON c.account_id=a.account_id AND c.owner_session_id=a.session_id
        WHERE c.account_id=w.account_id AND c.context_id=$7 AND b.state='ACTIVE' AND a.revoked_at IS NULL AND a.absolute_expires_at>$4 AND a.auth_generation=$8) AS session_active,
      NOT EXISTS(SELECT 1 FROM connection_rounds c WHERE c.account_id=w.account_id AND c.context_id=$7 AND c.closed_at IS NULL) AS connected,
      EXISTS(SELECT 1 FROM processing_requests r JOIN workspace_pages p ON p.account_id=r.account_id AND p.context_id=r.context_id AND p.page_lineage_id=r.page_lineage_id
        JOIN active_page_requests a ON a.account_id=r.account_id AND a.project_lineage_id=r.project_lineage_id AND a.page_lineage_id=r.page_lineage_id
        WHERE r.account_id=w.account_id AND r.request_id=$3 AND a.request_id=r.request_id AND NOT p.excluded AND p.result_revision=r.expected_result_revision) AS page_current,
      NOT EXISTS(SELECT 1 FROM cost_items c WHERE c.account_id=w.account_id AND(c.state='UNCONFIRMED' OR c.evidence_conflict)) AS cost_clear,
      NOT EXISTS(SELECT 1 FROM provider_wait_rounds p WHERE p.account_id=w.account_id AND p.request_id=$3 AND p.logical_step_id=$6 AND p.closed_at IS NULL AND p.deadline<=$4) AS wait_clear,
      NOT EXISTS(SELECT 1 FROM native_job_intents i WHERE i.account_id=w.account_id AND
        ((i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=$3::uuid) OR(i.target_kind='EXECUTION' AND EXISTS(SELECT 1 FROM executions e WHERE e.account_id=i.account_id AND e.execution_id=i.target_id AND(e.request_id=$3::uuid OR EXISTS(SELECT 1 FROM request_steps s WHERE s.account_id=e.account_id AND s.request_id=$3::uuid AND s.current_execution_id=e.execution_id))))) AND
        (EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='ERROR') OR
         NOT EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='RESULT') OR
         NOT EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='TERMINATION' AND o.protected_observation->'termination'->>'operationJoined'='true' AND
           ((o.protected_observation->'termination'->>'kind'='NO_CHILD_CREATED' AND o.protected_observation->'termination'->>'goAttempted'='false') OR(o.protected_observation->'termination'->>'directChildClosed'='true' AND o.protected_observation->'termination'->>'kind' IN('DIRECT_CHILD_ONLY','CGROUP_EMPTY')))))) AS native_clear
      FROM work_items w JOIN request_steps s ON s.account_id=w.account_id AND s.request_id=$3 AND s.logical_step_id=$6
      WHERE w.account_id=$1 AND w.work_item_id=$5 LIMIT 2 ${lockCurrent?'FOR UPDATE OF w,s':''}`,[input.accountId,input.executionId,input.requestId,tx.now,claim.workItemId,input.stage,input.contextId,tx.account.auth_generation])).rows;
    must(Array.isArray(rows)&&!types.isProxy(rows)&&rows.length===1,dispatch);const fence=own(rows[0],this.bounds.maxRecordBytes).value;
    closed(fence,['work_item_id','kind','state','claim_owner','claim_generation','lease_live','request_matches','pointer_matches','session_active','connected','page_current','cost_clear','wait_clear','native_clear']);
    must(fence.work_item_id===claim.workItemId&&fence.claim_owner===claim.ownerId&&fence.claim_generation===claim.generation&&fence.kind==='DISPATCH'&&fence.state==='CLAIMED'&&['lease_live','request_matches','pointer_matches','session_active','connected','page_current','cost_clear','wait_clear','native_clear'].every(key=>fence[key as keyof Fence]===true),dispatch);
  }
}
