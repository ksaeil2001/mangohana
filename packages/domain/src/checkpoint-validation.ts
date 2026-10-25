import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type {Database,Transaction} from '../../storage/src/database.js';
import {DomainError} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {canonicalInput,normalizeObservation,type StageInput,type Observation} from './provider.js';
import type {AssetDependency} from './model.js';
import {closed,own,id,hexadecimal,must} from './local-lama-binding-verifier.js';
import {nativeExecutionCaptureDigest} from './native-execution-wait.js';
import {validateNativeJobIntent,validateNativeJobObservation,type NativeJobIntent} from './native-jobs.js';
import type {NativeOwnerCapture} from '../../native/src/gateway.js';
import {validateNativeReceiptCandidate,validateNativeReceiptCandidateV2,validateWindowsNativeEvidenceBundle,validateWindowsNativeOriginalKey,type NativeSealedReceipt,type NativeSealedReceiptV2,type WindowsNativeOriginalKey} from './native-receipts.js';
import {validateWindowsNativeCostOwner,validateWindowsNativeCostScope,type WindowsNativeCostOwner,type WindowsNativeCostScope} from './windows-native-cost.js';
import {nativeFacadeVerificationVersion} from '../../native/src/semantic-cache.js';
import {nativeTaskVersion,type NativeJob} from '../../native/src/dto.js';
import {validateNativeProfile} from '../../native/src/jobs.js';
import {selectedCleanupRegions} from './scope.js';

export const checkpointValidationVersion='checkpoint-validation-v1' as const;
export type CheckpointValidationPurpose='PRE_DISPATCH'|'FINAL_COMMIT';
export type CheckpointValidationBounds={maxRecordBytes:number;maxRecords:number;maxTargets:number;maxJobs:number};
type Ref={evidenceId:string;evidenceDigest:string};
type ReadMode='CURRENT'|'PREDECESSOR'|'COST_HISTORY';
type AssetSnapshot=AssetDependency&{objectKey:string;objectCreatedAt:string;verifiedAt:string;accessDeadline:string|null};
export type CheckpointValidationTarget={checkpointId:string;sourceRequestId:string;sourceExecutionId:string;logicalStepId:string;inputDigest:string;inputFingerprint:string;input:Ref;basis:Ref;outputDigest:string;stageContract:string;assets:AssetSnapshot[]};
export type CheckpointValidationAttempt={version:1;attemptId:string;attemptDigest:string;purpose:CheckpointValidationPurpose;consumerExecutionId:string;consumerRequestId:string;inputFingerprint:string;inputEvidenceId:string;inputEvidenceDigest:string;basisEvidenceId:string;basisEvidenceDigest:string;validationVersion:typeof checkpointValidationVersion;owner:NativeOwnerCapture;claimGeneration:string;expectedResultRevision:string;targets:CheckpointValidationTarget[]};
export type CheckpointValidationFacts={attemptId:string;operations:Ref[]};
export type CheckpointValidationView={state:'VERIFIED'|'WAIT';attempt:CheckpointValidationAttempt|null;evidenceIds:string[];jobIds:string[]};
export type CheckpointValidationOperation={version:1;operationId:string;attemptId:string;attemptDigest:string;validationVersion:typeof checkpointValidationVersion;targetDigest:string;sourceInputFingerprint:string;outputDigest:string;semantic:{eventId:string;kind:'SEMANTIC_VALIDATION';outcome:'RETURNED'};storage:{eventId:string;kind:'OBJECT_READ';assetId:string;sha256:string;bytesLength:string;outcome:'RETURNED'}[];native:(NativeSealedReceipt|NativeSealedReceiptV2)[]};
type WindowsCheckpointRaw={kind:string;id:string;ref:Ref|null;contentDigest:string;completedAt:string|null};
type WindowsCheckpointOriginal={key:WindowsNativeOriginalKey|null;scopeRef:Ref|null;callRef:Ref|null;componentId:string|null;sourceOperation:Ref|null;sourceTermination:Ref|null;classification:'FRESH'|'CACHE'|'UNCONFIRMED'};
type WindowsCheckpointData={owner:WindowsNativeCostOwner;components:{task:string;componentId:string}[];scopes:WindowsNativeCostScope[];rows:WindowsCheckpointRaw[];originals:WindowsCheckpointOriginal[]};
type WindowsCheckpointEntry={key:WindowsNativeOriginalKey;origins:Set<'FRESH'|'CACHE'>;scopes:WindowsNativeCostScope[]};
type WindowsCheckpointSet={entries:Map<string,WindowsCheckpointEntry>;data:WindowsCheckpointData};
type Evidence={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};
type Core={request_id:string;logical_step_id:string;input_digest:string;contract_version:string;state:string;claim_generation:string;context_id:string;context_generation:string;page_lineage_id:string;expected_result_revision:string;captured_stage_order:string[];captured_settings:unknown;owner:NativeOwnerCapture;current:boolean};
type Step={ordinal:number;logical_step_id:string;checkpoint_id:string|null;execution_id:string;origin_request_id:string;dependency_digest:string;stage_contract:string;verification_state:string|null;execution_state:string;output_envelope:Observation|null};
type State={input:StageInput;core:Core;rows:Evidence[];inputRef:Ref;basisRef:Ref};
type Budget={records:number;bytes:number;history:Map<string,Evidence[]>;states:Map<string,State>;outputs:Map<string,Observation>};
const beginKind='CHECKPOINT_VALIDATION_ATTEMPT',doneKind='CHECKPOINT_VALIDATION_VERIFIED',operationKind='CHECKPOINT_VALIDATION_OPERATION',code='CHECKPOINT_VALIDATION_UNCONFIRMED';
const wait=(attempt:CheckpointValidationAttempt|null=null):CheckpointValidationView=>({state:'WAIT',attempt,evidenceIds:[],jobIds:[]});
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));

// DB-only fixed port: no native, storage, model or callback capability. The
// trusted reader's immutable raw event is indispensable: native receipts alone
// cannot prove this attempt's actual storage read or semantic callback return.
export class CheckpointValidationJournal{
  readonly bounds:Readonly<CheckpointValidationBounds>;
  constructor(db:Database,bounds:CheckpointValidationBounds){
    closed(bounds,['maxRecordBytes','maxRecords','maxTargets','maxJobs']);
    must(db.role==='trio_web_worker'&&Object.values(bounds).every(n=>Number.isSafeInteger(n)&&n>0&&n<2147483647)&&bounds.maxRecordBytes*(bounds.maxRecords+1)<=2147483647,code);
    this.bounds=Object.freeze({...bounds});Object.defineProperty(this,'bounds',{writable:false,configurable:false});
  }
  #budget():Budget{return {records:0,bytes:0,history:new Map(),states:new Map(),outputs:new Map()};}
  #own<T>(value:T):T{
    // Bound graph work before the common JSON encoder. Repeated aliases are
    // visited for each occurrence because encoding expands every occurrence.
    const limit=this.bounds.maxRecordBytes;let nodes=0,bytes=0;
    const charge=(text:string)=>{must(text.length<=limit,code);bytes+=Buffer.byteLength(text);must(bytes<=limit,code);};
    const visit=(item:unknown,depth:number):void=>{
      must(++nodes<=limit&&depth<=64&&!types.isProxy(item),code);
      if(typeof item==='string'){charge(item);return;}
      if(item===null||typeof item==='boolean'||typeof item==='number'){bytes++;must(bytes<=limit,code);return;}
      must(typeof item==='object'&&item!==null,code);const array=Array.isArray(item);
      must(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype),code);
      if(array)must((item as unknown[]).length<=limit-nodes,code);
      const keys=Reflect.ownKeys(item);must(keys.length<=limit-nodes+1,code);
      for(const key of keys){if(array&&key==='length')continue;must(typeof key==='string',code);charge(key);const field=Object.getOwnPropertyDescriptor(item,key);must(field&&field.enumerable&&'value'in field,code);visit(field.value,depth+1);}
    };
    visit(value,0);return own(value,limit).value;
  }
  #rows<T>(rows:T[],budget:Budget,maximum=this.bounds.maxRecords):T[]{
    must(Array.isArray(rows)&&rows.length<=maximum,code);const result:T[]=[];
    for(const row of rows){const owned=own(this.#own(row),this.bounds.maxRecordBytes);budget.records++;budget.bytes+=owned.bytes;must(budget.records<=this.bounds.maxRecords&&budget.bytes<=this.bounds.maxRecordBytes*this.bounds.maxRecords,code);result.push(owned.value);}return result;
  }
  #input(value:StageInput):StageInput{
    const input=this.#own(canonicalInput(this.#own(value)));id(input.accountId);id(input.executionId);id(input.requestId);id(input.contextId);hexadecimal(input.inputDigest);must(input.envelope&&['OCR','TRANSLATE','CLEANUP','TYPESET'].includes(input.stage),code);assertWire('stageInputEnvelope',input.envelope);
    const e=input.envelope;must(e.executionId===input.executionId&&e.requestId===input.requestId&&e.contextId===input.contextId&&e.logicalStepId===input.stage&&e.inputDigest===input.inputDigest&&e.stageContract===input.settings.contractVersion&&digest(e.capturedSettings)===digest(input.settings)&&Array.isArray(input.assetDependencies)&&digest(e.assetIds)===digest(input.assetDependencies.map(a=>a.assetId)),code);return input;
  }
  async #history(tx:Transaction,executionId:string,budget:Budget):Promise<Evidence[]>{
    const known=budget.history.get(executionId);if(known)return known;
    const rows=this.#rows((await tx.client.query<Evidence>(`/* checkpoint-validation:evidence */ SELECT evidence_id,
      CASE WHEN octet_length(kind)<=64 THEN kind ELSE NULL END AS kind,
      CASE WHEN octet_length(evidence_digest)=64 THEN evidence_digest ELSE NULL END AS evidence_digest,
      CASE WHEN octet_length(protected_evidence_ref)<=36 THEN protected_evidence_ref ELSE NULL END AS protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=$3 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY received_at,evidence_id LIMIT $4`,[tx.account.account_id,executionId,this.bounds.maxRecordBytes,this.bounds.maxRecords+1])).rows,budget);
    const ids=new Set<string>();for(const row of rows){closed(row,['evidence_id','evidence_digest','protected_evidence_ref','kind','protected_observation']);id(row.evidence_id);hexadecimal(row.evidence_digest);must(row.protected_evidence_ref===row.evidence_id&&row.protected_observation!==null&&digest(row.protected_observation)===row.evidence_digest&&!ids.has(row.evidence_id)&&typeof row.kind==='string',code);ids.add(row.evidence_id);}budget.history.set(executionId,rows);return rows;
  }
  #value<T>(row:Evidence,input:StageInput,kind:string):T{
    must(row.kind===kind,code);const w=this.#own(row.protected_observation) as {version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:T};closed(w,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
    must(w.version===1&&w.accountId===input.accountId&&w.executionId===input.executionId&&w.inputDigest===input.inputDigest&&w.inputFingerprint===fingerprint(input)&&w.kind===kind,code);return w.value;
  }
  async #state(tx:Transaction,inputValue:StageInput,budget:Budget):Promise<State>{
    const input=this.#input(inputValue);must(tx.account.account_id===input.accountId,code);const known=budget.states.get(input.executionId);if(known){must(fingerprint(known.input)===fingerprint(input),code);return known;}
    const rows=await this.#history(tx,input.executionId,budget),inputs=rows.filter(r=>r.kind==='INPUT'),bases=rows.filter(r=>r.kind==='OPERATIONAL_COST_BASIS');must(inputs.length===1&&bases.length===1&&digest(this.#input(inputs[0].protected_observation as StageInput))===fingerprint(input)&&!Object.hasOwn(inputs[0].protected_observation as object,'claimGeneration'),code);
    const cores=this.#rows((await tx.client.query<Core>(`/* checkpoint-validation:core */ SELECT e.request_id,e.logical_step_id,e.input_digest,e.contract_version,e.state,e.claim_generation::text,
      r.context_id,r.context_generation::text,r.page_lineage_id,r.expected_result_revision::text,
      CASE WHEN octet_length(r.captured_stage_order::text)<=$3 THEN r.captured_stage_order ELSE NULL END AS captured_stage_order,
      CASE WHEN octet_length(sr.captured_settings::text)<=$3 THEN sr.captured_settings ELSE NULL END AS captured_settings,
      jsonb_build_object('contextId',c.context_id,'contextGeneration',c.generation::text,'ownerSessionId',c.owner_session_id,'ownerTabId',c.owner_tab_id,'ownerRevision',c.owner_revision::text,'workspaceRevision',c.workspace_revision::text) AS owner,
      (c.generation=r.context_generation AND c.lifecycle<>'CLOSED' AND r.terminal_at IS NULL AND r.state IN('ACCEPTED','ACTIVE','WAITING')
       AND EXISTS(SELECT 1 FROM app_sessions a JOIN login_bindings b USING(account_id,binding_id) WHERE a.account_id=c.account_id AND a.session_id=c.owner_session_id AND a.revoked_at IS NULL AND a.absolute_expires_at>$4 AND a.auth_generation=$5 AND b.state='ACTIVE')
       AND NOT EXISTS(SELECT 1 FROM connection_rounds n WHERE n.account_id=c.account_id AND n.context_id=c.context_id AND n.closed_at IS NULL)
       AND EXISTS(SELECT 1 FROM workspace_pages p JOIN active_page_requests a ON a.account_id=p.account_id AND a.page_lineage_id=p.page_lineage_id AND a.project_lineage_id=r.project_lineage_id WHERE p.account_id=r.account_id AND p.context_id=r.context_id AND p.page_lineage_id=r.page_lineage_id AND a.request_id=r.request_id AND NOT p.excluded AND p.result_revision=r.expected_result_revision)) AS current
      FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
      JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
      JOIN settings_revisions sr ON sr.account_id=r.account_id AND sr.context_id=r.context_id AND sr.settings_revision=r.settings_revision
      WHERE e.account_id=$1 AND e.execution_id=$2 LIMIT 2 FOR UPDATE OF e,r,c`,[input.accountId,input.executionId,this.bounds.maxRecordBytes,tx.now,tx.account.auth_generation])).rows,budget,1);must(cores.length===1,code);const core=cores[0];
    must(core.request_id===input.requestId&&core.logical_step_id===input.stage&&core.input_digest===input.inputDigest&&core.contract_version===input.settings.contractVersion&&core.context_id===input.contextId&&core.context_generation===input.envelope!.contextGeneration&&core.page_lineage_id===input.envelope!.pageLineageId&&digest(core.captured_settings)===digest(input.settings)&&Array.isArray(core.captured_stage_order)&&core.captured_stage_order.length<=this.bounds.maxTargets,code);
    const basis=this.#value<{version:1;capture:Record<string,unknown>;captureDigest:string;snapshot:unknown;snapshotDigest:string|null}>(bases[0],input,'OPERATIONAL_COST_BASIS');closed(basis,['version','capture','captureDigest','snapshot','snapshotDigest']);closed(basis.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);const {captureDigest,...body}=basis.capture;
    must(basis.version===1&&captureDigest===digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture:body})&&basis.captureDigest===captureDigest&&basis.capture.accountId===input.accountId&&basis.capture.executionId===input.executionId&&basis.capture.inputDigest===input.inputDigest&&basis.capture.inputFingerprint===fingerprint(input)&&basis.capture.stage===input.stage&&(basis.snapshot===null?basis.snapshotDigest===null:basis.snapshotDigest===digest(basis.snapshot)),code);
    const state={input,core,rows,inputRef:{evidenceId:inputs[0].evidence_id,evidenceDigest:inputs[0].evidence_digest},basisRef:{evidenceId:bases[0].evidence_id,evidenceDigest:bases[0].evidence_digest}};budget.states.set(input.executionId,state);return state;
  }
  async #source(tx:Transaction,executionId:string,budget:Budget):Promise<State>{const rows=await this.#history(tx,executionId,budget),inputs=rows.filter(r=>r.kind==='INPUT');must(inputs.length===1,code);return this.#state(tx,inputs[0].protected_observation as StageInput,budget);}
  #dependencies(input:StageInput,output:Observation):AssetDependency[]{
    const values=new Map<string,AssetDependency>();for(const item of [...input.assetDependencies??[],...output.assetDependencies??[]]){closed(item,['assetId','sha256','bytesLength','mediaType']);id(item.assetId);hexadecimal(item.sha256);must(/^[1-9][0-9]{0,15}$/.test(item.bytesLength)&&typeof item.mediaType==='string'&&item.mediaType.length>0,code);const old=values.get(item.assetId);must(!old||digest(old)===digest(item),code);values.set(item.assetId,item);}
    const required=[...output.outputAssetIds??[],output.cleanedAssetId,output.renderAssetId].filter((v):v is string=>!!v);must(required.every(a=>values.has(a)),code);must(values.size<=this.bounds.maxTargets,code);return [...values.values()].sort((a,b)=>a.assetId.localeCompare(b.assetId));
  }
  async #assets(tx:Transaction,deps:AssetDependency[],budget:Budget):Promise<AssetSnapshot[]>{
    if(!deps.length)return [];const rows=this.#rows((await tx.client.query<{asset_id:string;sha256:string;bytes_length:string;media_type:string;object_key:string;purpose:string;deletion_state:string;object_created_at:string|null;verified_at:string|null;access_deadline:string|null}>(`/* checkpoint-validation:assets */ SELECT asset_id,sha256,bytes_length::text,
      CASE WHEN octet_length(media_type)<=64 THEN media_type ELSE NULL END AS media_type,
      CASE WHEN octet_length(object_key)<=256 THEN object_key ELSE NULL END AS object_key,purpose,deletion_state,object_created_at::text,verified_at::text,access_deadline::text
      FROM assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY asset_id LIMIT $3`,[tx.account.account_id,deps.map(a=>a.assetId),this.bounds.maxTargets+1])).rows,budget,this.bounds.maxTargets);
    must(rows.length===deps.length,code);return deps.map(dep=>{const found=rows.filter(row=>row.asset_id===dep.assetId);must(found.length===1,code);const row=found[0];must(row.sha256===dep.sha256&&row.bytes_length===dep.bytesLength&&row.media_type===dep.mediaType&&row.object_key===tx.account.account_id+'/'+dep.assetId&&['LIVE','FONT'].includes(row.purpose)&&row.deletion_state==='NOT_DUE'&&row.object_created_at!==null&&Number.isFinite(Date.parse(row.object_created_at))&&row.verified_at!==null&&Number.isFinite(Date.parse(row.verified_at))&&(row.access_deadline===null||Number.isFinite(Date.parse(row.access_deadline))&&Date.parse(row.access_deadline)>tx.now.valueOf()),code);return {...dep,objectKey:row.object_key,objectCreatedAt:row.object_created_at,verifiedAt:row.verified_at,accessDeadline:row.access_deadline};});
  }
  #sealedAssets(accountId:string,deps:AssetDependency[],snapshot:AssetSnapshot[]):AssetSnapshot[]{
    const assets=this.#own(snapshot);must(Array.isArray(assets)&&assets.length===deps.length&&assets.length<=this.bounds.maxTargets,code);
    for(const [at,asset]of assets.entries()){
      closed(asset,['assetId','sha256','bytesLength','mediaType','objectKey','objectCreatedAt','verifiedAt','accessDeadline']);const {objectKey,objectCreatedAt,verifiedAt,accessDeadline,...dep}=asset;
      must(digest(dep)===digest(deps[at])&&objectKey===accountId+'/'+dep.assetId&&typeof objectCreatedAt==='string'&&Number.isFinite(Date.parse(objectCreatedAt))&&typeof verifiedAt==='string'&&Number.isFinite(Date.parse(verifiedAt))&&(accessDeadline===null||typeof accessDeadline==='string'&&Number.isFinite(Date.parse(accessDeadline))),code);
    }
    return assets;
  }
  async #targets(tx:Transaction,state:State,purpose:CheckpointValidationPurpose,budget:Budget,snapshots?:CheckpointValidationTarget[]):Promise<CheckpointValidationTarget[]>{
    const input=state.input,order=state.core.captured_stage_order,index=order.indexOf(input.stage);must(index>=0&&order.lastIndexOf(input.stage)===index,code);
    const rows=this.#rows((await tx.client.query<Step>(`/* checkpoint-validation:targets */ SELECT s.ordinal,s.logical_step_id,c.checkpoint_id,coalesce(c.execution_id,s.current_execution_id) AS execution_id,e.request_id AS origin_request_id,c.dependency_digest,c.stage_contract,c.verification_state,e.state AS execution_state,
      CASE WHEN octet_length(c.output_envelope::text)<=$3 THEN c.output_envelope ELSE NULL END AS output_envelope
      FROM request_steps s LEFT JOIN checkpoints c ON c.account_id=s.account_id AND(c.checkpoint_id=s.reuse_checkpoint_id OR(s.reuse_checkpoint_id IS NULL AND c.execution_id=s.current_execution_id))
      LEFT JOIN executions e ON e.account_id=s.account_id AND e.execution_id=coalesce(c.execution_id,s.current_execution_id)
      WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal LIMIT $4`,[input.accountId,input.requestId,this.bounds.maxRecordBytes,this.bounds.maxTargets+1])).rows,budget,this.bounds.maxTargets);
    must(rows.length===order.length&&rows.every((r,n)=>r.ordinal===n&&r.logical_step_id===order[n]),code);const deps=input.envelope!.checkpointDependencies;
    must(deps.length===index&&deps.length<=this.bounds.maxTargets&&new Set(deps.map(d=>d.checkpointId)).size===deps.length,code);
    if(purpose==='FINAL_COMMIT')must(index===order.length-1&&state.core.state==='SUCCEEDED',code);
    const selected=rows.slice(0,purpose==='FINAL_COMMIT'?rows.length:index),targets:CheckpointValidationTarget[]=[];
    for(const row of selected){
      must(row.checkpoint_id&&row.execution_id&&row.verification_state==='VERIFIED'&&row.execution_state==='SUCCEEDED'&&row.output_envelope,code);const source=await this.#source(tx,row.execution_id,budget),original=source.input,output=normalizeObservation(original,row.output_envelope);
      must(source.core.state==='SUCCEEDED'&&original.executionId===row.execution_id&&original.requestId===row.origin_request_id&&original.stage===row.logical_step_id&&original.settings.contractVersion===row.stage_contract&&row.stage_contract===input.settings.contractVersion&&original.inputDigest===row.dependency_digest&&output.outcome==='SUCCESS'&&output.stageOutput?.checkpointId===row.checkpoint_id&&digest(output)===digest(row.output_envelope)&&digest(original.settings)===digest(input.settings),code);
      if(row.ordinal<index){const dep=deps[row.ordinal];must(dep.checkpointId===row.checkpoint_id&&dep.originExecutionId===original.executionId&&dep.originRequestId===original.requestId&&dep.logicalStepId===original.stage&&dep.stageContract===row.stage_contract&&dep.inputDigest===original.inputDigest&&dep.dependencyDigest===row.dependency_digest&&digest(dep.assetIds)===digest(output.outputAssetIds??[]),code);}
      else must(original.executionId===input.executionId,code);
      const sourceDeps=original.envelope!.checkpointDependencies;must(sourceDeps.length===row.ordinal&&sourceDeps.every((dep,n)=>dep.checkpointId===targets[n]?.checkpointId&&dep.originExecutionId===targets[n]?.sourceExecutionId&&dep.dependencyDigest===targets[n]?.inputDigest),code);
      const assetDeps=this.#dependencies(original,output),sealed=snapshots?.filter(target=>target.checkpointId===row.checkpoint_id);if(sealed)must(sealed.length===1,code);
      const assets=sealed?this.#sealedAssets(input.accountId!,assetDeps,sealed[0].assets):await this.#assets(tx,assetDeps,budget);budget.outputs.set(row.checkpoint_id,output);targets.push({checkpointId:row.checkpoint_id,sourceRequestId:original.requestId,sourceExecutionId:original.executionId,logicalStepId:original.stage,inputDigest:original.inputDigest,inputFingerprint:fingerprint(original),input:source.inputRef,basis:source.basisRef,outputDigest:digest(output),stageContract:row.stage_contract,assets});
    }
    if(snapshots)must(snapshots.length===targets.length,code);return targets;
  }
  async #description(tx:Transaction,state:State,purpose:CheckpointValidationPurpose,budget:Budget,historical?:CheckpointValidationAttempt,mode:ReadMode='CURRENT'):Promise<Omit<CheckpointValidationAttempt,'attemptId'|'attemptDigest'>>{
    must(['PRE_DISPATCH','FINAL_COMMIT'].includes(purpose)&&(historical||tx.account.access_state==='ACTIVE'&&state.core.current===true),code);const {core,input}=state;
    return {version:1,purpose,consumerExecutionId:input.executionId,consumerRequestId:input.requestId,inputFingerprint:fingerprint(input),inputEvidenceId:state.inputRef.evidenceId,inputEvidenceDigest:state.inputRef.evidenceDigest,basisEvidenceId:state.basisRef.evidenceId,basisEvidenceDigest:state.basisRef.evidenceDigest,validationVersion:checkpointValidationVersion,owner:historical?.owner??core.owner,claimGeneration:historical?.claimGeneration??core.claim_generation,expectedResultRevision:historical?.expectedResultRevision??core.expected_result_revision,targets:await this.#targets(tx,state,purpose,budget,mode==='COST_HISTORY'?historical?.targets:undefined)};
  }
  #attempt(row:Evidence,state:State):CheckpointValidationAttempt{
    const value=this.#value<CheckpointValidationAttempt>(row,state.input,beginKind);closed(value,['version','attemptId','attemptDigest','purpose','consumerExecutionId','consumerRequestId','inputFingerprint','inputEvidenceId','inputEvidenceDigest','basisEvidenceId','basisEvidenceDigest','validationVersion','owner','claimGeneration','expectedResultRevision','targets']);id(value.attemptId);hexadecimal(value.attemptDigest);const {attemptDigest,...body}=value;must(digest(body)===attemptDigest&&value.validationVersion===checkpointValidationVersion,code);return value;
  }
  async #insert(tx:Transaction,state:State,kind:string,value:unknown,budget:Budget):Promise<Evidence>{
    must(budget.records<this.bounds.maxRecords,code);const wrapper=this.#own({version:1,accountId:state.input.accountId,executionId:state.input.executionId,inputDigest:state.input.inputDigest,inputFingerprint:fingerprint(state.input),kind,value}),evidenceId=randomUUID(),evidenceDigest=digest(wrapper);
    const result=await tx.client.query<{evidence_id:string}>(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id`,[state.input.accountId,evidenceId,state.input.executionId,kind,evidenceDigest,tx.now,JSON.stringify(wrapper)]);must(result.rowCount===1&&result.rows.length===1&&result.rows[0].evidence_id===evidenceId,code);
    return {evidence_id:evidenceId,evidence_digest:evidenceDigest,protected_evidence_ref:evidenceId,kind,protected_observation:wrapper};
  }
  async beginIn(tx:Transaction,consumer:StageInput,purpose:CheckpointValidationPurpose):Promise<CheckpointValidationAttempt>{
    const budget=this.#budget(),state=await this.#state(tx,consumer,budget),description=await this.#description(tx,state,purpose,budget),existing=state.rows.filter(r=>r.kind===beginKind&&this.#attempt(r,state).purpose===purpose);must(existing.length<=1,code);
    if(existing.length){const attempt=this.#attempt(existing[0],state),{attemptId:_id,attemptDigest:_digest,...body}=attempt;must(digest(body)===digest(description),code);return this.#own(attempt);}
    const body={...description,attemptId:randomUUID()},attempt:CheckpointValidationAttempt={...body,attemptDigest:digest(body)};await this.#insert(tx,state,beginKind,attempt,budget);return this.#own(attempt);
  }
  async #windowsSet(tx:Transaction,state:State,attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget,budget:Budget):Promise<WindowsCheckpointSet|null>{
    const selector={executionId:state.input.executionId,inputEvidenceId:state.inputRef.evidenceId,inputFingerprint:state.inputRef.evidenceDigest,basisRef:state.basisRef};
    const result=this.#rows((await tx.client.query<{value:WindowsCheckpointData|null;overflow:boolean}>(`/* checkpoint-validation:windows-set */ WITH census AS MATERIALIZED(
      SELECT manga_web.windows_stage_cost_lookup($1::jsonb,$2::integer) AS value
    ), scoped AS MATERIALIZED(SELECT value,manga_web.windows_native_cost_lookup(value->'owner',64) AS scopes FROM census WHERE value IS NOT NULL)
    SELECT CASE WHEN octet_length(reply::text)<=least($3::integer,1572864) THEN reply ELSE NULL END AS value,(octet_length(reply::text)>least($3::integer,1572864)) AS overflow FROM(
      SELECT jsonb_build_object('owner',value->'owner','components',value->'root'->'components','scopes',scopes->'scopes',
        'originals',value->'originals','rows',(SELECT coalesce(jsonb_agg(item ORDER BY item->>'kind',item->>'id'),'[]'::jsonb)
          FROM jsonb_array_elements(value->'rows') item WHERE item->>'kind' IN('SCOPE','CALL','BINDING','CACHE_USE','INTENT'))) AS reply FROM scoped
    ) selected UNION ALL SELECT NULL::jsonb,false WHERE NOT EXISTS(SELECT 1 FROM scoped)`,[JSON.stringify({version:1,mode:'CENSUS',owner:selector}),Math.min(64,this.bounds.maxJobs),this.bounds.maxRecordBytes])).rows,budget,1);
    must(result.length===1&&result[0].overflow!==true,code);
    if(result[0].value===null){
      const source=await this.#source(tx,target.sourceExecutionId,budget),output=budget.outputs.get(target.checkpointId);must(output,code);
      // 조회 실패를 빈 집합으로 바꾸지 않는다. 기존 공개 metadata로 관련
      // Windows/불명 작업이 없음을 확인한 경우에만 v1 경로를 유지한다.
      const related=this.#rows((await tx.client.query<{job_id:string;native_kind:string}>(`/* checkpoint-validation:windows-absence */ SELECT i.job_id,
        CASE WHEN EXISTS(SELECT 1 FROM native_job_observations v WHERE v.account_id=i.account_id AND v.job_id=i.job_id AND v.protected_observation->>'version'='2')
          OR EXISTS(SELECT 1 FROM execution_evidence v WHERE v.account_id=i.account_id AND v.kind='WINDOWS_NATIVE_OPERATION' AND v.protected_observation->'value'->'binding'->>'jobId'=i.job_id::text) THEN 'WINDOWS'
          WHEN EXISTS(SELECT 1 FROM native_job_observations v WHERE v.account_id=i.account_id AND v.job_id=i.job_id AND v.protected_observation->>'version'='1') THEN 'V1' ELSE 'UNKNOWN' END AS native_kind
        FROM native_job_intents i LEFT JOIN native_capacity_reservations n USING(account_id,job_id)
        WHERE i.account_id=$1 AND((i.target_kind='EXECUTION' AND i.target_id=ANY($2::uuid[])) OR n.source_execution_id=ANY($2::uuid[]) OR n.base_execution_id=$3
          OR(i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=$4 AND i.semantic_capture_digest=$5)
          OR EXISTS(SELECT 1 FROM native_capacity_adoptions a WHERE a.account_id=i.account_id AND a.reservation_id=n.reservation_id AND a.execution_id=$3))
        ORDER BY i.job_id LIMIT $6`,[state.input.accountId,[state.input.executionId,target.sourceExecutionId],state.input.executionId,state.input.requestId,nativeExecutionCaptureDigest('CHECKPOINT',state.input.requestId,source.input,output),this.bounds.maxJobs+1])).rows,budget,this.bounds.maxJobs);
      must(related.every(row=>row.native_kind==='V1'),code);return null;
    }
    const data=this.#own(result[0].value);
    closed(data,['owner','components','scopes','rows','originals']);const root=validateWindowsNativeCostOwner(data.owner);
    const identity=({executionId,inputEvidenceId,inputFingerprint,basisRef}:WindowsNativeCostOwner)=>({executionId,inputEvidenceId,inputFingerprint,basisRef});
    must(digest(identity(root))===digest(selector)&&Array.isArray(data.scopes)&&data.scopes.length<=64&&Array.isArray(data.components)&&data.components.length<=64&&Array.isArray(data.rows)&&data.rows.length<=this.bounds.maxRecords&&Array.isArray(data.originals)&&data.originals.length<=this.bounds.maxJobs,code);
    const scopes=data.scopes.map(validateWindowsNativeCostScope),allScopes=new Map(scopes.map(scope=>[scope.scopeId,scope]));must(allScopes.size===scopes.length,code);
    const begin=state.rows.filter(row=>row.kind===beginKind&&this.#attempt(row,state).attemptId===attempt.attemptId);must(begin.length===1,code);
    const attemptRef={evidenceId:begin[0].evidence_id,evidenceDigest:begin[0].evidence_digest},selected=new Map<string,WindowsNativeCostScope>();
    const source=await this.#source(tx,target.sourceExecutionId,budget),output=budget.outputs.get(target.checkpointId);must(output,code);
    for(const scope of scopes){
      must(digest(identity(scope.owner))===digest(selector),code);
      if(digest(scope.owner.validationAttemptRef)===digest(attemptRef)&&scope.validationTargetDigest===digest(target)){
        must(scope.phase==='CHECKPOINT'&&scope.owner.claim.generation===attempt.claimGeneration&&scope.target.targetKind==='REQUEST_CHECKPOINT'&&scope.target.targetId===state.input.requestId&&scope.target.semanticCaptureDigest===nativeExecutionCaptureDigest('CHECKPOINT',state.input.requestId,source.input,output)&&digest(scope.target.protectedOwnerCapture)===digest(attempt.owner)&&digest(scope.target.claim)===digest(scope.owner.claim)&&digest(scope.target.sourceInput)===digest({executionId:target.sourceExecutionId,inputEvidenceId:target.input.evidenceId,stageInputDigest:target.inputDigest}),code);
        selected.set(scope.scopeId,scope);
      }
    }
    const rawIds=new Set<string>();for(const row of data.rows){closed(row,['kind','id','ref','contentDigest','completedAt']);must(typeof row.kind==='string'&&typeof row.id==='string'&&!rawIds.has(row.kind+'/'+row.id),code);rawIds.add(row.kind+'/'+row.id);hexadecimal(row.contentDigest);if(row.ref!==null){closed(row.ref,['evidenceId','evidenceDigest']);id(row.ref.evidenceId);hexadecimal(row.ref.evidenceDigest);}}
    for(const scope of scopes)must(data.rows.filter(row=>row.kind==='SCOPE'&&row.id===scope.scopeId&&row.contentDigest===scope.scopeDigest&&row.ref?.evidenceId===scope.scopeId&&row.ref.evidenceDigest===scope.scopeDigest).length===1,code);
    for(const item of data.components){closed(item,['task','componentId']);must(typeof item.task==='string'&&typeof item.componentId==='string',code);}must(new Set(data.components.map(item=>item.task)).size===data.components.length,code);
    const entries=new Map<string,WindowsCheckpointEntry>(),originals=new Map<string,WindowsCheckpointOriginal>();
    for(const original of data.originals){closed(original,['key','scopeRef','callRef','componentId','sourceOperation','sourceTermination','classification']);must(['FRESH','CACHE','UNCONFIRMED'].includes(original.classification),code);if(original.key===null){must(!original.scopeRef||!selected.has(original.scopeRef.evidenceId),code);continue;}const key=validateWindowsNativeOriginalKey(original.key);must(!originals.has(key.binding.jobId),code);originals.set(key.binding.jobId,{...original,key});}
    const add=(jobId:string,origin:'FRESH'|'CACHE',scope:WindowsNativeCostScope)=>{const original=originals.get(jobId);must(original&&original.key&&original.classification!=='UNCONFIRMED',code);const old=entries.get(jobId);if(old){old.origins.add(origin);old.scopes.push(scope);}else entries.set(jobId,{key:original.key,origins:new Set([origin]),scopes:[scope]});};
    for(const [jobId,original]of originals){if(!original.scopeRef||!selected.has(original.scopeRef.evidenceId))continue;must(original.classification==='FRESH'&&original.callRef&&data.rows.some(row=>row.kind==='CALL'&&digest(row.ref)===digest(original.callRef))&&data.rows.some(row=>row.kind==='BINDING'&&row.id===jobId),code);add(jobId,'FRESH',selected.get(original.scopeRef.evidenceId)!);}
    const uses=data.rows.filter(row=>row.kind==='CACHE_USE');
    if(uses.length){
      const jobs=[...new Set(uses.map(row=>{const parts=row.id.split('/');must(parts.length===2,code);id(parts[0]);id(parts[1]);return parts[1];}))];must(jobs.length<=this.bounds.maxJobs,code);
      const metadata=this.#rows((await tx.client.query<{job_id:string;intent:NativeJobIntent;kernel_digest:string|null}>(`/* checkpoint-validation:windows-meta */ SELECT i.job_id,CASE WHEN octet_length(i.protected_intent::text)<=$3 THEN i.protected_intent ELSE NULL END AS intent,c.kernel_implementation_digest AS kernel_digest
        FROM native_job_intents i LEFT JOIN native_result_candidates c USING(account_id,job_id) WHERE i.account_id=$1 AND i.job_id=ANY($2::uuid[]) ORDER BY i.job_id LIMIT $4`,[state.input.accountId,jobs,this.bounds.maxRecordBytes,this.bounds.maxJobs+1])).rows,budget,this.bounds.maxJobs);
      must(metadata.length===jobs.length&&new Set(metadata.map(row=>row.job_id)).size===jobs.length,code);
      for(const use of uses){
        const [callId,jobId]=use.id.split('/'),meta=metadata.filter(row=>row.job_id===jobId);must(meta.length===1,code);const intent=validateNativeJobIntent(meta[0].intent);must(intent.jobId===jobId,code);hexadecimal(meta[0].kernel_digest);
        const component=data.components.filter(item=>item.task===intent.task),call=data.rows.filter(row=>row.kind==='CALL'&&row.id===callId);must(component.length===1&&call.length===1&&call[0].ref,code);
        const matches=scopes.filter(scope=>{const body={version:1,callId,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:intent.task,taskVersion:intent.taskVersion,profileDigest:intent.profileDigest,kernelDigest:meta[0].kernel_digest,operationInputDigest:intent.operationInputDigest,componentId:component[0].componentId};return digest(body)===call[0].contentDigest&&call[0].ref!.evidenceId===callId&&call[0].ref!.evidenceDigest===call[0].contentDigest;});
        must(matches.length===1,code);if(selected.has(matches[0].scopeId))add(jobId,'CACHE',matches[0]);
      }
    }
    return {entries,data};
  }
  async #windowsReceipt(tx:Transaction,state:State,attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget,sealed:NativeSealedReceiptV2,entry:WindowsCheckpointEntry,budget:Budget,mode:ReadMode):Promise<void>{
    const frames={maxMetadataBytes:this.bounds.maxRecordBytes,maxBinaryBytes:2147483647,maxItems:this.bounds.maxTargets},{candidate,result}=validateNativeReceiptCandidateV2(sealed.candidate,frames),intent=validateNativeJobIntent(sealed.intent),raw=JSON.parse(candidate.inputCanonical) as NativeJob;
    must(candidate.verificationVersion===nativeFacadeVerificationVersion&&intent.taskVersion===nativeTaskVersion&&intent.task===result.task&&intent.profileDigest===result.profileDigest&&intent.jobId===candidate.jobId&&intent.parentInstanceId===candidate.parentInstanceId&&intent.inputDigest===result.inputDigest&&intent.operationInputDigest===candidate.operationInputDigest&&entry.origins.has(sealed.origin),code);
    const profile=raw.metadata.profile as {id?:string}|undefined;validateNativeProfile(profile);
    if(raw.task==='DECODE_IMAGE'){closed(raw.metadata,['profile','sourceBlobId']);must(raw.blobs.length===1&&raw.blobs[0].id===raw.metadata.sourceBlobId,code);}
    must(profile?.id===(await this.#source(tx,target.sourceExecutionId,budget)).input.envelope!.parameterProfileVersion&&digest(profile)===intent.profileDigest&&raw.blobs.every(blob=>target.assets.some(asset=>asset.sha256===blob.sha256&&asset.bytesLength===String(blob.byteLength))),code);
    if(raw.metadata.input!==undefined)must(fingerprint(this.#input(raw.metadata.input as StageInput))===target.inputFingerprint,code);
    if(raw.blobs.length===0){const source=(await this.#source(tx,target.sourceExecutionId,budget)).input,data=source.previousData??source.initialData,selected=selectedCleanupRegions(data,source.scope,source.paintStrokes,source.paintInclusion);must(raw.task==='POLYGON_MASK'&&raw.metadata.width===source.width&&raw.metadata.height===source.height&&digest(raw.metadata.polygons)===digest(data.blocks.filter(block=>selected.includes(block.regionId)).map(block=>block.geometry.polygon)),code);}
    const receipt=sealed.receipt;closed(receipt,['version','candidateId','kernelImplementationDigest','verificationVersion','blobs','windowsEvidenceRef']);closed(receipt.windowsEvidenceRef,['recordId','recordDigest','linkId','linkDigest']);
    must(receipt.version===2&&receipt.candidateId===candidate.candidateId&&receipt.kernelImplementationDigest===candidate.kernelImplementationDigest&&receipt.verificationVersion===candidate.verificationVersion&&digest(receipt.windowsEvidenceRef)===digest(candidate.windowsEvidenceRef)&&Array.isArray(receipt.blobs)&&receipt.blobs.length===candidate.blobs.length,code);
    for(const [at,blob]of receipt.blobs.entries()){closed(blob,['blobId','receipt']);closed(blob.receipt,['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds']);const ref=candidate.blobs[at];must(blob.blobId===ref.blobId&&blob.receipt.key===state.input.accountId+'/'+ref.assetId&&blob.receipt.sha256===ref.sha256&&blob.receipt.bytesLength===ref.bytesLength&&typeof blob.receipt.completedAt==='string'&&Number.isFinite(Date.parse(blob.receipt.completedAt))&&new Date(blob.receipt.completedAt).toISOString()===blob.receipt.completedAt&&[1,1000].includes(blob.receipt.completedAtPrecisionMilliseconds)&&(blob.receipt.completedAtPrecisionMilliseconds!==1000||Date.parse(blob.receipt.completedAt)%1000===0),code);}
    const key=validateWindowsNativeOriginalKey(entry.key);must(key.binding.jobId===candidate.jobId&&key.binding.parentInstanceId===candidate.parentInstanceId&&key.binding.kernelDigest===candidate.kernelImplementationDigest&&digest(key.expected)===digest(candidate.windowsEvidenceRef),code);
    const rows=this.#rows((await tx.client.query<{bundle:unknown}>(`/* checkpoint-validation:windows-bundle */ WITH original AS MATERIALIZED(SELECT manga_web.windows_native_evidence_lookup($1::jsonb) AS value) SELECT CASE WHEN octet_length(value::text)<=least($2::integer,1572864) THEN value ELSE NULL END AS bundle FROM original`,[JSON.stringify(key),this.bounds.maxRecordBytes])).rows,budget,1);must(rows.length===1&&rows[0].bundle!==null,code);
    const bundle=this.#own(rows[0].bundle) as {original:{protectedIntent:unknown};job:NativeJob},facts=validateWindowsNativeEvidenceBundle(bundle,key,'trio_web_worker');
    must(digest(bundle.original.protectedIntent)===digest(intent)&&digest(bundle.job)===digest({...raw,inputDigest:result.inputDigest})&&facts.source.input.executionId===target.sourceExecutionId&&facts.source.input.inputEvidenceId===target.input.evidenceId&&facts.source.input.stageInputDigest===target.inputDigest&&digest(facts.source.inputEvidence)===digest(target.input)&&facts.source.inputFingerprint===target.inputFingerprint&&digest(facts.source.basisRef)===digest(target.basis)&&digest(facts.windowsEvidenceRef)===digest(candidate.windowsEvidenceRef)&&facts.rawResult?.resultDigest===candidate.resultDigest&&facts.observations.result?.evidenceId===candidate.resultObservationId&&facts.observations.result.evidenceDigest===candidate.resultObservationDigest&&digest(facts.termination)===digest(sealed.termination)&&facts.termination.kind==='WINDOWS_JOB_EMPTY',code);
    if(sealed.origin==='FRESH')must(entry.scopes.some(scope=>digest(scope.target.claim)===digest(intent.claim)&&digest(scope.target.protectedOwnerCapture)===digest(intent.protectedOwnerCapture)&&scope.target.targetKind===intent.targetKind&&scope.target.targetId===intent.targetId&&scope.target.semanticCaptureDigest===intent.semanticCaptureDigest),code);
    else must(['EXECUTION','REQUEST_CHECKPOINT'].includes(intent.targetKind)&&intent.protectedOwnerCapture.contextId===(await this.#source(tx,target.sourceExecutionId,budget)).input.contextId,code);
    if(mode==='CURRENT')for(const scope of entry.scopes){
      const claim=scope.owner.claim;must(claim.generation===attempt.claimGeneration,code);
      const current=this.#rows((await tx.client.query<{work_item_id:string}>(`/* checkpoint-validation:windows-current */ SELECT w.work_item_id FROM work_items w JOIN executions e ON e.account_id=w.account_id AND e.execution_id=$2
        WHERE w.account_id=$1 AND w.work_item_id=$3 AND w.claim_owner=$4 AND w.claim_generation::text=$5 AND e.claim_generation=w.claim_generation AND w.state='CLAIMED' AND w.lease_until>clock_timestamp() LIMIT 2 FOR UPDATE OF w`,[state.input.accountId,state.input.executionId,claim.workItemId,claim.ownerId,claim.generation])).rows,budget,1);must(current.length===1&&current[0].work_item_id===claim.workItemId,code);
    }
    const proof=this.#rows((await tx.client.query<{candidate_digest:string;receipt_digest:string;result_observation_id:string;termination_observation_id:string}>(`/* checkpoint-validation:windows-receipt */ SELECT c.candidate_digest,r.receipt_digest,o.observation_id AS result_observation_id,t.observation_id AS termination_observation_id
      FROM native_result_candidates c JOIN native_result_receipts r USING(account_id,candidate_id) JOIN native_job_intents i ON i.account_id=c.account_id AND i.job_id=c.job_id
      JOIN native_job_observations o ON o.account_id=i.account_id AND o.job_id=i.job_id AND o.observation_id=$7
      JOIN native_job_observations t ON t.account_id=i.account_id AND t.job_id=i.job_id AND t.observation_id=$8
      WHERE c.account_id=$1 AND c.candidate_id=$2 AND c.job_id=$3 AND i.owner_service='trio_web_worker'
       AND c.candidate_digest=encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex') AND r.receipt_digest=encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex') AND i.protected_intent=$6::jsonb
       AND c.operation_input_digest=$9 AND c.kernel_implementation_digest=$10 AND c.verification_version=$11 AND c.asset_purpose='LIVE' AND c.related_context_id=$12
       AND($13::boolean OR c.access_deadline IS NULL OR c.access_deadline>$14) AND o.observation_digest=$15 AND t.observation_digest=$16
       AND o.event='RESULT' AND t.event='TERMINATION' LIMIT 2`,[state.input.accountId,candidate.candidateId,candidate.jobId,JSON.stringify(candidate),JSON.stringify(receipt),JSON.stringify(intent),candidate.resultObservationId,facts.observations.termination.evidenceId,candidate.operationInputDigest,candidate.kernelImplementationDigest,candidate.verificationVersion,(await this.#source(tx,target.sourceExecutionId,budget)).input.contextId,mode==='COST_HISTORY',tx.now,candidate.resultObservationDigest,facts.observations.termination.evidenceDigest])).rows,budget,1);
    must(proof.length===1&&proof[0].result_observation_id===candidate.resultObservationId&&proof[0].termination_observation_id===facts.observations.termination.evidenceId,code);hexadecimal(proof[0].candidate_digest);hexadecimal(proof[0].receipt_digest);
  }
  async #native(tx:Transaction,state:State,attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget,operations:(NativeSealedReceipt|NativeSealedReceiptV2)[],budget:Budget,mode:ReadMode='CURRENT'):Promise<string[]>{
    must(Array.isArray(operations)&&operations.length<=this.bounds.maxJobs,code);const ids:string[]=[],legacy:NativeSealedReceipt[]=[],windows:NativeSealedReceiptV2[]=[];
    for(const value of operations){const sealed=this.#own(value);closed(sealed,['candidate','receipt','intent','termination','origin']);must(sealed.candidate&&sealed.receipt&&['FRESH','CACHE'].includes(sealed.origin),code);const intent=validateNativeJobIntent(sealed.intent);must(!ids.includes(intent.jobId),code);ids.push(intent.jobId);if(sealed.candidate.version===2){must(sealed.receipt.version===2,code);windows.push(sealed as NativeSealedReceiptV2);}else{must(sealed.candidate.version===1&&sealed.receipt.version===1,code);legacy.push(sealed as NativeSealedReceipt);}}
    const set=await this.#windowsSet(tx,state,attempt,target,budget);must(set!==null||windows.length===0,code);
    const required=set?.entries??new Map<string,WindowsCheckpointEntry>();must(required.size===windows.length&&windows.every(item=>required.has(item.intent.jobId)),code);
    for(const sealed of windows){const entry=required.get(sealed.intent.jobId)!;if(sealed.origin==='CACHE'){
      const uses=set!.data.rows.filter(row=>row.kind==='CACHE_USE'&&row.id.endsWith('/'+sealed.intent.jobId)&&row.contentDigest===digest(sealed)&&row.ref?.evidenceDigest===digest({callId:row.id.split('/')[0],source:sealed}));
      must(uses.some(use=>{const callId=use.id.split('/')[0];return entry.scopes.some(scope=>{const component=set!.data.components.find(item=>item.task===sealed.intent.task);if(!component)return false;const call={version:1,callId,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:sealed.intent.task,taskVersion:sealed.intent.taskVersion,profileDigest:sealed.intent.profileDigest,kernelDigest:sealed.candidate.kernelImplementationDigest,operationInputDigest:sealed.candidate.operationInputDigest,componentId:component.componentId};return set!.data.rows.some(row=>row.kind==='CALL'&&row.id===callId&&row.contentDigest===digest(call));});}),code);
    }await this.#windowsReceipt(tx,state,attempt,target,sealed,entry,budget,mode);}
    await this.#nativeV1(tx,state,attempt,target,legacy,budget,mode==='COST_HISTORY');return ids;
  }
  async #nativeV1(tx:Transaction,state:State,attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget,operations:NativeSealedReceipt[],budget:Budget,costHistory=false):Promise<string[]>{
    must(Array.isArray(operations)&&operations.length<=this.bounds.maxJobs,code);const source=await this.#source(tx,target.sourceExecutionId,budget),output=budget.outputs.get(target.checkpointId);must(output&&digest(output)===target.outputDigest,code);
    const semantic=nativeExecutionCaptureDigest('CHECKPOINT',state.input.requestId,source.input,output);
    const jobs=this.#rows((await tx.client.query<{job_id:string;native_kind?:string}>(`/* checkpoint-validation:jobs */ SELECT i.job_id,'V1'::text AS native_kind FROM native_job_intents i WHERE i.account_id=$1 AND i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=$2 AND i.semantic_capture_digest=$3 AND NOT EXISTS(SELECT 1 FROM native_job_observations v WHERE v.account_id=i.account_id AND v.job_id=i.job_id AND v.protected_observation->>'version'='2') ORDER BY i.job_id LIMIT $4`,[state.input.accountId,state.input.requestId,semantic,this.bounds.maxJobs+1])).rows.filter(row=>row.native_kind!=='WINDOWS'),budget,this.bounds.maxJobs);
    const ids=operations.map(item=>{closed(item,['candidate','receipt','intent','termination','origin']);return validateNativeJobIntent(item.intent).jobId;});must(new Set(ids).size===ids.length&&jobs.every(row=>ids.includes(row.job_id)),code);
    for(const value of operations){
      const sealed=this.#own(value);closed(sealed,['candidate','receipt','intent','termination','origin']);must(['FRESH','CACHE'].includes(sealed.origin),code);
      const frames={maxMetadataBytes:this.bounds.maxRecordBytes,maxBinaryBytes:2147483647,maxItems:this.bounds.maxTargets},{candidate,result}=validateNativeReceiptCandidate(sealed.candidate,frames),intent=validateNativeJobIntent(sealed.intent),raw=JSON.parse(candidate.inputCanonical) as NativeJob;
      must(candidate.verificationVersion===nativeFacadeVerificationVersion&&intent.taskVersion===nativeTaskVersion&&intent.task===result.task&&intent.profileDigest===result.profileDigest&&intent.jobId===candidate.jobId&&intent.parentInstanceId===candidate.parentInstanceId&&intent.inputDigest===result.inputDigest&&intent.operationInputDigest===candidate.operationInputDigest,code);
      const profile=raw.metadata.profile as {id?:string}|undefined;
      validateNativeProfile(profile);
      if(raw.task==='DECODE_IMAGE'){closed(raw.metadata,['profile','sourceBlobId']);must(raw.blobs.length===1&&raw.blobs[0].id===raw.metadata.sourceBlobId,code);}
      must(profile?.id===source.input.envelope!.parameterProfileVersion&&digest(profile)===intent.profileDigest&&raw.blobs.every(blob=>target.assets.some(asset=>asset.sha256===blob.sha256&&asset.bytesLength===String(blob.byteLength))),code);
      if(raw.metadata.input!==undefined)must(fingerprint(this.#input(raw.metadata.input as StageInput))===target.inputFingerprint,code);
      if(raw.blobs.length===0){
        const data=source.input.previousData??source.input.initialData,selected=selectedCleanupRegions(data,source.input.scope,source.input.paintStrokes,source.input.paintInclusion);
        must(raw.task==='POLYGON_MASK'&&raw.metadata.width===source.input.width&&raw.metadata.height===source.input.height&&digest(raw.metadata.polygons)===digest(data.blocks.filter(block=>selected.includes(block.regionId)).map(block=>block.geometry.polygon)),code);
      }
      if(sealed.origin==='FRESH')must(intent.targetKind==='REQUEST_CHECKPOINT'&&intent.targetId===state.input.requestId&&intent.semanticCaptureDigest===semantic&&digest(intent.protectedOwnerCapture)===digest(attempt.owner),code);
      else {
        // Cache keeps the original target/claim. Only immutable source facts
        // are joined below; the original claim never grants current authority.
        must(['EXECUTION','REQUEST_CHECKPOINT'].includes(intent.targetKind)&&intent.protectedOwnerCapture.contextId===source.input.contextId&&intent.protectedOwnerCapture.contextGeneration===source.input.envelope!.contextGeneration,code);
        if(intent.targetKind==='EXECUTION')must(intent.targetId===source.input.executionId,code);
      }
      const observed=validateNativeJobObservation({version:1,parentInstanceId:intent.parentInstanceId,event:'TERMINATION',code:'OK',resultDigest:null,termination:{...sealed.termination,isolation:sealed.termination.kind==='CGROUP_EMPTY'?'LINUX_CGROUP_V2':'OWNED_FIXTURE'}});must(observed.event==='TERMINATION',code);const termination=observed.termination;
      must(termination.jobId===intent.jobId&&termination.inputDigest===intent.inputDigest&&termination.profileDigest===intent.profileDigest&&termination.operationJoined&&termination.directChildClosed&&termination.goAttempted&&['DIRECT_CHILD_ONLY','CGROUP_EMPTY'].includes(termination.kind),code);
      closed(sealed.receipt,['version','candidateId','kernelImplementationDigest','verificationVersion','blobs']);must(sealed.receipt.version===1&&sealed.receipt.candidateId===candidate.candidateId&&sealed.receipt.kernelImplementationDigest===candidate.kernelImplementationDigest&&sealed.receipt.verificationVersion===candidate.verificationVersion&&sealed.receipt.blobs.length===candidate.blobs.length,code);
      for(const [at,blob]of sealed.receipt.blobs.entries()){closed(blob,['blobId','receipt']);closed(blob.receipt,['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds']);const ref=candidate.blobs[at];must(blob.blobId===ref.blobId&&blob.receipt.key===state.input.accountId+'/'+ref.assetId&&blob.receipt.sha256===ref.sha256&&blob.receipt.bytesLength===ref.bytesLength&&typeof blob.receipt.completedAt==='string'&&Number.isFinite(Date.parse(blob.receipt.completedAt))&&[1,1000].includes(blob.receipt.completedAtPrecisionMilliseconds),code);}
      // SQL jsonb digests preserve the existing worker's column grants:
      // protected_candidate/protected_receipt are never SELECTed here.
      const proof=this.#rows((await tx.client.query<{candidate_digest:string;receipt_digest:string;result_observation_id:string;termination_observation_id:string}>(`/* checkpoint-validation:receipt */ SELECT c.candidate_digest,r.receipt_digest,o.observation_id AS result_observation_id,t.observation_id AS termination_observation_id
        FROM native_result_candidates c JOIN native_result_receipts r USING(account_id,candidate_id)
        JOIN native_job_intents i ON i.account_id=c.account_id AND i.job_id=c.job_id
        JOIN native_job_observations o ON o.account_id=i.account_id AND o.job_id=i.job_id AND o.observation_id=$7
        JOIN native_job_observations t ON t.account_id=i.account_id AND t.job_id=i.job_id AND t.event='TERMINATION'
        WHERE c.account_id=$1 AND c.candidate_id=$2 AND c.job_id=$3 AND i.owner_service='trio_web_worker'
          AND c.candidate_digest=encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex') AND r.receipt_digest=encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex') AND i.protected_intent=$6::jsonb
          AND c.operation_input_digest=$8 AND c.kernel_implementation_digest=$9 AND c.verification_version=$10 AND c.asset_purpose='LIVE' AND c.related_context_id=$18 AND($19::boolean OR c.access_deadline IS NULL OR c.access_deadline>$17)
          AND o.event='RESULT' AND o.observation_digest=$11 AND o.protected_observation->>'code'='OK' AND o.protected_observation->>'resultDigest'=$12
          AND t.protected_observation->>'code'='OK' AND (t.protected_observation->'termination')-'isolation'=$13::jsonb
          AND EXISTS(SELECT 1 FROM native_job_go_consumptions g WHERE g.account_id=i.account_id AND g.job_id=i.job_id AND g.parent_instance_id=i.parent_instance_id)
          AND EXISTS(SELECT 1 FROM native_capacity_reservations n WHERE n.account_id=i.account_id AND n.job_id=i.job_id AND n.source_execution_id=$14 AND n.source_input_evidence_id=$15)
          AND NOT EXISTS(SELECT 1 FROM native_job_observations x WHERE x.account_id=i.account_id AND x.job_id=i.job_id AND x.event='ERROR')
        ORDER BY t.received_at,t.observation_id LIMIT $16`,[state.input.accountId,candidate.candidateId,candidate.jobId,JSON.stringify(candidate),JSON.stringify(sealed.receipt),JSON.stringify(intent),candidate.resultObservationId,candidate.operationInputDigest,candidate.kernelImplementationDigest,candidate.verificationVersion,candidate.resultObservationDigest,candidate.resultDigest,JSON.stringify(sealed.termination),source.input.executionId,source.inputRef.evidenceId,this.bounds.maxRecords+1,tx.now,source.input.contextId,costHistory])).rows,budget);
      must(proof.length>0&&proof.every(r=>r.result_observation_id===candidate.resultObservationId),code);for(const p of proof){hexadecimal(p.candidate_digest);hexadecimal(p.receipt_digest);id(p.termination_observation_id);}
    }
    return ids;
  }
  async #facts(tx:Transaction,state:State,attempt:CheckpointValidationAttempt,factsValue:CheckpointValidationFacts,budget:Budget,mode:ReadMode='CURRENT'):Promise<{evidenceIds:string[];jobIds:string[]}>{
    const facts=this.#own(factsValue);closed(facts,['attemptId','operations']);must(facts.attemptId===attempt.attemptId&&Array.isArray(facts.operations)&&facts.operations.length===attempt.targets.length&&facts.operations.length<=this.bounds.maxTargets,code);
    const evidenceIds:string[]=[],jobIds:string[]=[],eventIds=new Set<string>(),targets=new Set<string>();
    for(const ref of facts.operations){closed(ref,['evidenceId','evidenceDigest']);id(ref.evidenceId);hexadecimal(ref.evidenceDigest);must(!evidenceIds.includes(ref.evidenceId),code);const records=state.rows.filter(r=>r.evidence_id===ref.evidenceId&&r.evidence_digest===ref.evidenceDigest&&r.kind===operationKind);must(records.length===1,code);
      const operation=this.#value<CheckpointValidationOperation>(records[0],state.input,operationKind);closed(operation,['version','operationId','attemptId','attemptDigest','validationVersion','targetDigest','sourceInputFingerprint','outputDigest','semantic','storage','native']);id(operation.operationId);must(!eventIds.has(operation.operationId),code);eventIds.add(operation.operationId);
      const matches=attempt.targets.filter(t=>digest(t)===operation.targetDigest);must(matches.length===1&&!targets.has(operation.targetDigest),code);const target=matches[0];targets.add(operation.targetDigest);
      must(operation.version===1&&operation.attemptId===attempt.attemptId&&operation.attemptDigest===attempt.attemptDigest&&operation.validationVersion===checkpointValidationVersion&&operation.sourceInputFingerprint===target.inputFingerprint&&operation.outputDigest===target.outputDigest,code);
      closed(operation.semantic,['eventId','kind','outcome']);id(operation.semantic.eventId);must(operation.semantic.kind==='SEMANTIC_VALIDATION'&&operation.semantic.outcome==='RETURNED'&&!eventIds.has(operation.semantic.eventId),code);eventIds.add(operation.semantic.eventId);
      must(Array.isArray(operation.storage)&&operation.storage.length===target.assets.length,code);const assets=new Set<string>();
      for(const event of operation.storage){closed(event,['eventId','kind','assetId','sha256','bytesLength','outcome']);id(event.eventId);const dep=target.assets.find(a=>a.assetId===event.assetId);must(dep&&event.kind==='OBJECT_READ'&&event.outcome==='RETURNED'&&event.sha256===dep.sha256&&event.bytesLength===dep.bytesLength&&!eventIds.has(event.eventId)&&!assets.has(event.assetId),code);eventIds.add(event.eventId);assets.add(event.assetId);}
      const verified=await this.#native(tx,state,attempt,target,operation.native,budget,mode);jobIds.push(...verified);must(jobIds.length<=this.bounds.maxJobs,code);evidenceIds.push(ref.evidenceId);
    }
    return {evidenceIds,jobIds:[...new Set(jobIds)]};
  }
  async #lookup(tx:Transaction,state:State,purpose:CheckpointValidationPurpose,budget:Budget,mode:ReadMode='CURRENT'):Promise<CheckpointValidationView>{
    const begins=state.rows.filter(r=>r.kind===beginKind&&this.#attempt(r,state).purpose===purpose);must(begins.length<=1,code);if(!begins.length)return wait();
    const attempt=this.#attempt(begins[0],state),description=await this.#description(tx,state,purpose,budget,mode!=='CURRENT'?attempt:undefined,mode),{attemptId:_id,attemptDigest:_digest,...body}=attempt;must(digest(body)===digest(description),code);
    const dones=state.rows.filter(r=>r.kind===doneKind&&this.#value<{attemptId:string}>(r,state.input,doneKind).attemptId===attempt.attemptId);must(dones.length<=1,code);if(!dones.length)return wait(attempt);
    const done=this.#value<{version:1;attemptId:string;attemptDigest:string;facts:CheckpointValidationFacts}>(dones[0],state.input,doneKind);closed(done,['version','attemptId','attemptDigest','facts']);must(done.version===1&&done.attemptDigest===attempt.attemptDigest,code);const verified=await this.#facts(tx,state,attempt,done.facts,budget,mode);
    return {state:'VERIFIED',attempt,evidenceIds:[begins[0].evidence_id,...verified.evidenceIds,dones[0].evidence_id],jobIds:verified.jobIds};
  }
  async recordIn(tx:Transaction,consumer:StageInput,attemptValue:CheckpointValidationAttempt,facts:CheckpointValidationFacts):Promise<CheckpointValidationView>{
    try{const budget=this.#budget(),state=await this.#state(tx,consumer,budget),attempt=this.#own(attemptValue),description=await this.#description(tx,state,attempt.purpose,budget),rows=state.rows.filter(r=>r.kind===beginKind&&this.#attempt(r,state).attemptId===attempt.attemptId);must(rows.length===1&&digest(this.#attempt(rows[0],state))===digest(attempt),code);const {attemptId:_id,attemptDigest:_digest,...body}=attempt;must(digest(body)===digest(description),code);
      const dones=state.rows.filter(r=>r.kind===doneKind&&this.#value<{attemptId:string}>(r,state.input,doneKind).attemptId===attempt.attemptId);if(dones.length)return await this.#lookup(tx,state,attempt.purpose,budget);
      const verified=await this.#facts(tx,state,attempt,facts,budget),done=await this.#insert(tx,state,doneKind,{version:1,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,facts:this.#own(facts)},budget);return {state:'VERIFIED',attempt,evidenceIds:[rows[0].evidence_id,...verified.evidenceIds,done.evidence_id],jobIds:verified.jobIds};
    }catch(error){if(error instanceof DomainError)return wait();throw error;}
  }
  async lookupIn(tx:Transaction,consumer:StageInput,purpose:CheckpointValidationPurpose):Promise<CheckpointValidationView>{try{const budget=this.#budget(),state=await this.#state(tx,consumer,budget);return await this.#lookup(tx,state,purpose,budget);}catch(error){if(error instanceof DomainError)return wait();throw error;}}
  async verifiedPredecessorsIn(tx:Transaction,input:StageInput):Promise<{evidenceIds:string[];jobIds:string[]}>{
    const budget=this.#budget(),state=await this.#state(tx,input,budget),evidenceIds:string[]=[],jobIds:string[]=[],seen=new Set<string>();
    const walk=async(current:State):Promise<void>=>{for(const dep of current.input.envelope!.checkpointDependencies){if(seen.has(dep.originExecutionId))continue;seen.add(dep.originExecutionId);must(seen.size<=this.bounds.maxTargets,code);const source=await this.#source(tx,dep.originExecutionId,budget);must(source.core.state==='SUCCEEDED',code);await walk(source);const view=await this.#lookup(tx,source,'PRE_DISPATCH',budget,'PREDECESSOR');must(view.state==='VERIFIED',code);evidenceIds.push(...view.evidenceIds);jobIds.push(...view.jobIds);}};
    await this.#targets(tx,state,'PRE_DISPATCH',budget);await walk(state);const currentBegins=state.rows.filter(r=>r.kind===beginKind);if(currentBegins.length){const current=await this.#lookup(tx,state,'PRE_DISPATCH',budget);must(current.state==='VERIFIED',code);evidenceIds.push(...current.evidenceIds);jobIds.push(...current.jobIds);}
    must(evidenceIds.length<=this.bounds.maxRecords&&jobIds.length<=this.bounds.maxJobs,code);return {evidenceIds:[...new Set(evidenceIds)],jobIds:[...new Set(jobIds)]};
  }
  async sealedFinalCostIn(tx:Transaction,consumer:StageInput,joinedEvidence:Ref[]):Promise<'VERIFIED'|'WAIT'>{
    try{
      const refs=this.#own(joinedEvidence);must(Array.isArray(refs)&&refs.length<=this.bounds.maxRecords,code);const ids=new Set<string>();
      for(const ref of refs){closed(ref,['evidenceId','evidenceDigest']);id(ref.evidenceId);hexadecimal(ref.evidenceDigest);must(!ids.has(ref.evidenceId),code);ids.add(ref.evidenceId);}
      const budget=this.#budget(),state=await this.#state(tx,consumer,budget),view=await this.#lookup(tx,state,'FINAL_COMMIT',budget,'COST_HISTORY');must(view.state==='VERIFIED',code);
      for(const evidenceId of view.evidenceIds){const rows=state.rows.filter(row=>row.evidence_id===evidenceId);must(rows.length===1&&refs.some(ref=>ref.evidenceId===evidenceId&&ref.evidenceDigest===rows[0].evidence_digest),code);}
      return 'VERIFIED';
    }catch(error){if(error instanceof DomainError)return 'WAIT';throw error;}
  }
  async finalCommitIn(tx:Transaction,input:StageInput):Promise<'ELIGIBLE'|'WAIT'>{const view=await this.lookupIn(tx,input,'FINAL_COMMIT');return view.state==='VERIFIED'?'ELIGIBLE':'WAIT';}
}
