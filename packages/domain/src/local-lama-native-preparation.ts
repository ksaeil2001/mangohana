import {randomUUID} from 'node:crypto';
import {CheckpointValidationJournal} from './checkpoint-validation.js';
import type {Database,Transaction} from '../../storage/src/database.js';
import {digest} from '../../contracts/src/intent.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {nativeTaskVersion,type NativeBlob,type NativeJob} from '../../native/src/dto.js';
import {nativeDimensions,validateNativeProfile,validateNativeInput} from '../../native/src/jobs.js';
import {nativeFacadeVerificationVersion} from '../../native/src/semantic-cache.js';
import type {NativeOwnerCapture,NativeTarget} from '../../native/src/gateway.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest,validateNativeJobClaim,validateNativeOwnerCapture,validateNativeJobIntent,type NativeJobClaim} from './native-jobs.js';
import {validateNativeReceiptCandidate} from './native-receipts.js';
import {nativeExecutionCaptureDigest} from './native-execution-wait.js';
import {selectedCleanupRegions} from './scope.js';
import type {StageInput} from './provider.js';
import type {AssetDependency} from './model.js';
import {FullStageCostCalculator} from './full-stage-cost.js';
import type {FullStageCostBasis} from './full-stage-cost-journal.js';
import {LocalLaMaBindingVerifier,closed,fingerprint,hexadecimal,id,localCapture,must,own,type LocalLaMaBindingCore,type LocalLaMaBindingEvidence,type LocalLaMaBindingReaderBounds} from './local-lama-binding-verifier.js';

export const lamaPreparationCaptureKind='LAMA_PREPARATION_CAPTURE';
export const lamaPreparationJoinKind='LAMA_PREPARATION_NATIVE_JOIN';
export const lamaPreparationPrecheckKind='LAMA_PREPARATION_PRECHECK';
const unconfirmed='LOCAL_LAMA_PREPARATION_UNCONFIRMED',capacity='LOCAL_LAMA_PREPARATION_CAPACITY';
type EvidenceRef={evidenceId:string;evidenceDigest:string};
export type LocalLaMaExpectedNativeOperation={
  phase:'INPUT'|'DISPATCH';task:'DECODE_IMAGE'|'POLYGON_MASK'|'COMPOSITE_MASKED';taskVersion:typeof nativeTaskVersion;
  semanticCaptureDigest:string;profileDigest:string;operationInputDigest:string;logicalOperationKey:string;
  metadata:Record<string,unknown>;blobs:NativeBlob[];dependencies:AssetDependency[];
};
export type LocalLaMaPrecheckRequirement={
  version:1;phase:'DISPATCH';task:'COMPOSITE_MASKED';image:AssetDependency;
  maskLogicalOperationKey:string;proposalMatchesImage:true;
};
export type LocalLaMaPreparationCapture={
  version:1;preparationId:string;preparationDigest:string;input:EvidenceRef;inputFingerprint:string;
  basis:EvidenceRef;fullStageCaptureDigest:string;originalClaim:NativeJobClaim;originalOwner:NativeOwnerCapture;
  nativeProfile:MediaProfile;profileDigest:string;kernelImplementationDigest:string;
  taskVersion:typeof nativeTaskVersion;facadeVerificationVersion:typeof nativeFacadeVerificationVersion;
  expectedOperations:LocalLaMaExpectedNativeOperation[];precheckRequirement:LocalLaMaPrecheckRequirement;
};
export type LocalLaMaPreparationCaptureRecord=EvidenceRef&{value:LocalLaMaPreparationCapture};
export type LocalLaMaPreparationView={version:1;capture:LocalLaMaPreparationCaptureRecord|null};
type Wrapper<T>={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:T};
export type LocalLaMaPreparationOriginalState={input:StageInput;inputRef:EvidenceRef;basis:FullStageCostBasis;basisRef:EvidenceRef;rows:LocalLaMaBindingEvidence[];core:LocalLaMaBindingCore};
export type LocalLaMaPreparationReservation={release:()=>void};
const verifierMethods=Object.getOwnPropertyDescriptors(LocalLaMaBindingVerifier.prototype);
const leases=new WeakMap<LocalLaMaPreparationReservation,LocalLaMaNativePreparation>();

function nativeProfile(value:MediaProfile,maxBytes:number):MediaProfile{
  const p=own(value,maxBytes).value;
  validateNativeProfile(p);
  return p;
}

// Operation identity excludes job UUID. Dependency tuples remain separate from
// the unique pure operation when the same PNG bytes appear under multiple IDs.
export function expectedLaMaPreparationOperations(input:StageInput,profile:MediaProfile,maxBytes:number):LocalLaMaExpectedNativeOperation[]{
  const data=own(input,maxBytes).value,p=nativeProfile(profile,maxBytes),result:LocalLaMaExpectedNativeOperation[]=[];
  must(data.stage==='CLEANUP'&&p.id===data.envelope?.parameterProfileVersion&&Array.isArray(data.assetDependencies),unconfirmed);
  nativeDimensions(data.width,data.height,p,unconfirmed);
  const depIds=new Set<string>();
  for(const dep of data.assetDependencies!){closed(dep,['assetId','sha256','bytesLength','mediaType']);id(dep.assetId);hexadecimal(dep.sha256);must(typeof dep.bytesLength==='string'&&/^[1-9][0-9]{0,15}$/.test(dep.bytesLength)&&typeof dep.mediaType==='string'&&dep.mediaType.length>0&&!depIds.has(dep.assetId.toLowerCase()),unconfirmed);depIds.add(dep.assetId.toLowerCase());}
  const add=(phase:'INPUT'|'DISPATCH',task:'DECODE_IMAGE'|'POLYGON_MASK',metadata:Record<string,unknown>,blobs:NativeBlob[],dependencies:AssetDependency[])=>{
    const frame={version:1 as const,jobId:'00000000-0000-4000-8000-000000000001',task,taskVersion:nativeTaskVersion,profileDigest:digest(p),metadata,blobs};
    const operationInputDigest=nativeOperationInputDigest({...frame,inputDigest:digest(frame)} as NativeJob),semanticCaptureDigest=nativeExecutionCaptureDigest(phase,data.requestId,data);
    const item:LocalLaMaExpectedNativeOperation={phase,task,taskVersion:nativeTaskVersion,semanticCaptureDigest,profileDigest:frame.profileDigest,operationInputDigest,logicalOperationKey:nativeLogicalOperationKey({targetKind:'EXECUTION',targetId:data.executionId,task,taskVersion:nativeTaskVersion,profileDigest:frame.profileDigest,semanticCaptureDigest,operationInputDigest}),metadata,blobs,dependencies};
    const existing=result.find(value=>value.logicalOperationKey===item.logicalOperationKey);
    if(existing)existing.dependencies.push(...dependencies);else result.push(item);
  };
  for(const dep of data.assetDependencies!)if(dep.mediaType==='image/png'){
    const n=Number(dep.bytesLength);must(Number.isSafeInteger(n)&&n>0&&n<=p.maxImageBytes,unconfirmed);
    add('INPUT','DECODE_IMAGE',{profile:p,sourceBlobId:'source'},[{id:'source',sha256:dep.sha256,byteLength:n}],[dep]);
  }
  const edit=data.previousData??data.initialData,selected=selectedCleanupRegions(edit,data.scope,data.paintStrokes,data.paintInclusion);
  const metadata={profile:p,polygons:edit.blocks.filter(block=>selected.includes(block.regionId)).map(block=>block.geometry.polygon),width:data.width,height:data.height};
  validateNativeInput('POLYGON_MASK',metadata,new Map());
  add('DISPATCH','POLYGON_MASK',metadata,[],[]);
  own(result,maxBytes);return result;
}

function precheckRequirement(input:StageInput,expected:LocalLaMaExpectedNativeOperation[]):LocalLaMaPrecheckRequirement{
  const image=input.assetDependencies!.find(item=>item.assetId===(input.currentCleanedAssetId??input.originalAssetId)),masks=expected.filter(item=>item.task==='POLYGON_MASK');
  must(image?.mediaType==='image/png'&&masks.length===1,unconfirmed);
  return {version:1,phase:'DISPATCH',task:'COMPOSITE_MASKED',image:structuredClone(image),maskLogicalOperationKey:masks[0].logicalOperationKey,proposalMatchesImage:true};
}

// This component creates the original pre-native plan and exposes bounded data.
// It deliberately has no public JOIN writer or external completion callback.
export class LocalLaMaNativePreparation{
  readonly bounds:Readonly<LocalLaMaBindingReaderBounds>;readonly reservation:number;
  #checkpoints:CheckpointValidationJournal;
  #db:Database;#verifier:LocalLaMaBindingVerifier;#profile:MediaProfile;#kernel:string;#calls=0;#heldBytes=0;
  constructor(db:Database,bounds:LocalLaMaBindingReaderBounds,profile:MediaProfile,kernelImplementationDigest:string){
    this.#db=db;this.#verifier=new LocalLaMaBindingVerifier(db,bounds);this.bounds=this.#verifier.bounds;
    this.#checkpoints=new CheckpointValidationJournal(db,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:bounds.maxRecords,maxJobs:bounds.maxRecords});
    for(const [key,descriptor]of Object.entries(verifierMethods))if(key!=='constructor')Object.defineProperty(this.#verifier,key,{...descriptor,writable:false,configurable:false});
    Object.freeze(this.#verifier);
    Object.defineProperty(this,'bounds',{value:this.bounds,enumerable:true,writable:false,configurable:false});
    this.#profile=nativeProfile(profile,bounds.maxRecordBytes);hexadecimal(kernelImplementationDigest);this.#kernel=kernelImplementationDigest;
    this.reservation=this.#verifier.reservation+16*bounds.maxRecordBytes*(bounds.maxRecords+4);
    must(Number.isSafeInteger(this.reservation)&&this.reservation<=bounds.maxInFlightBytes,capacity);
    Object.defineProperty(this,'reservation',{value:this.reservation,enumerable:true,writable:false,configurable:false});
  }
  acquire(extraBytes=0):LocalLaMaPreparationReservation{
    must(Number.isSafeInteger(extraBytes)&&extraBytes>=0,capacity);const bytes=this.reservation+extraBytes;
    must(Number.isSafeInteger(bytes)&&this.#calls<this.bounds.maxConcurrentReads&&this.#heldBytes<=this.bounds.maxInFlightBytes-bytes,capacity);
    this.#calls++;this.#heldBytes+=bytes;let live=true;
    const token=Object.freeze({release:()=>{if(live){live=false;leases.delete(token);this.#calls--;this.#heldBytes-=bytes;}}});
    leases.set(token,this);return token;
  }
  #assertReservation(value:LocalLaMaPreparationReservation):void{must(leases.get(value)===this,capacity);}
  #wrap<T>(input:StageInput,kind:string,value:T):Wrapper<T>{
    return own({version:1 as const,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),kind,value},this.bounds.maxRecordBytes).value;
  }
  #body<T>(row:LocalLaMaBindingEvidence,input:StageInput,kind:string):T{
    must(row.kind===kind,unconfirmed);const w=own(row.protected_observation,this.bounds.maxRecordBytes).value as Wrapper<T>;
    closed(w,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
    must(w.version===1&&w.accountId===input.accountId&&w.executionId===input.executionId&&w.inputDigest===input.inputDigest&&w.inputFingerprint===fingerprint(input)&&w.kind===kind&&digest(w)===row.evidence_digest&&row.protected_evidence_ref===row.evidence_id,unconfirmed);return w.value;
  }
  #basis(value:FullStageCostBasis,input:StageInput,mode:'FREE'|'PAID'):FullStageCostBasis{
    closed(value,['version','capture','captureDigest','snapshot','snapshotDigest']);
    closed(value.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const normalized=new FullStageCostCalculator(value.snapshot,this.bounds.calculator).calculate({accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),stage:'CLEANUP',profileDigest:value.capture.profileDigest,mode},{provider:null,quantities:null,allocation:null});
    must(value.version===1&&digest(value.capture)===digest(normalized.capture)&&value.captureDigest===normalized.captureDigest&&value.snapshotDigest===normalized.snapshotDigest&&digest(value.snapshot)===digest(normalized.snapshot),unconfirmed);return value;
  }
  async #originalsIn(tx:Transaction,inputValue:StageInput,reservation:LocalLaMaPreparationReservation|undefined,rowsValue?:LocalLaMaBindingEvidence[]):Promise<LocalLaMaPreparationOriginalState>{
    if(reservation)this.#assertReservation(reservation);const input=this.#verifier.input(own(inputValue,this.bounds.maxRecordBytes).value);
    const core=await this.#verifier.core(tx,input),rows=rowsValue??await this.#verifier.records(tx,input,true),inputs=rows.filter(row=>row.kind==='INPUT'),bases=rows.filter(row=>row.kind==='OPERATIONAL_COST_BASIS');
    must(inputs.length===1&&bases.length===1,unconfirmed);
    const stored=this.#verifier.input(own(inputs[0].protected_observation,this.bounds.maxRecordBytes).value as StageInput);
    must(!Object.hasOwn(stored,'claimGeneration')&&digest(stored)===fingerprint(input),unconfirmed);
    return {input:stored,inputRef:{evidenceId:inputs[0].evidence_id,evidenceDigest:inputs[0].evidence_digest},
      basis:this.#basis(this.#body<FullStageCostBasis>(bases[0],stored,'OPERATIONAL_COST_BASIS'),stored,core.mode),
      basisRef:{evidenceId:bases[0].evidence_id,evidenceDigest:bases[0].evidence_digest},rows,core};
  }
  #captureIn(state:LocalLaMaPreparationOriginalState):LocalLaMaPreparationCaptureRecord|null{
    const captures=state.rows.filter(row=>row.kind===lamaPreparationCaptureKind);must(captures.length<=1,unconfirmed);
    if(!captures.length)return null;
    const row=captures[0],c=this.#body<LocalLaMaPreparationCapture>(row,state.input,lamaPreparationCaptureKind);
    closed(c,['version','preparationId','preparationDigest','input','inputFingerprint','basis','fullStageCaptureDigest','originalClaim','originalOwner','nativeProfile','profileDigest','kernelImplementationDigest','taskVersion','facadeVerificationVersion','expectedOperations','precheckRequirement']);
    closed(c.input,['evidenceId','evidenceDigest']);closed(c.basis,['evidenceId','evidenceDigest']);id(c.preparationId);
    for(const ref of [c.input,c.basis]){id(ref.evidenceId);hexadecimal(ref.evidenceDigest);}
    const p=nativeProfile(c.nativeProfile,this.bounds.maxRecordBytes);validateNativeJobClaim(c.originalClaim);validateNativeOwnerCapture(c.originalOwner);
    hexadecimal(c.kernelImplementationDigest);hexadecimal(c.preparationDigest);
    must(c.version===1&&c.taskVersion===nativeTaskVersion&&c.facadeVerificationVersion===nativeFacadeVerificationVersion&&digest(c.input)===digest(state.inputRef)&&digest(c.basis)===digest(state.basisRef)&&c.inputFingerprint===fingerprint(state.input)&&c.fullStageCaptureDigest===state.basis.captureDigest&&c.profileDigest===digest(p)&&c.originalOwner.contextId===state.input.contextId&&c.originalOwner.contextGeneration===state.input.envelope!.contextGeneration&&c.originalClaim.workItemId!==null,unconfirmed);
    must(digest(c.expectedOperations)===digest(expectedLaMaPreparationOperations(state.input,p,this.bounds.maxRecordBytes))&&c.expectedOperations.length<=this.bounds.maxRecords,unconfirmed);
    must(digest(c.precheckRequirement)===digest(precheckRequirement(state.input,c.expectedOperations)),unconfirmed);
    const {preparationDigest,...body}=c;must(digest(body)===preparationDigest,unconfirmed);
    return {evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest,value:own(c,this.bounds.maxRecordBytes).value};
  }
  async #firstFence(tx:Transaction,state:LocalLaMaPreparationOriginalState,claim:NativeJobClaim):Promise<NativeOwnerCapture>{
    const input=state.input,core=state.core;
    must(tx.account.access_state==='ACTIVE'&&core.execution_state==='PREPARED'&&!core.dispatch_attempted&&!core.request_terminal&&['ACCEPTED','ACTIVE','WAITING'].includes(core.request_state)&&core.lifecycle!=='CLOSED'&&core.context_generation===core.request_generation&&!core.native_hold&&claim.workItemId!==null&&claim.generation===core.claim_generation,unconfirmed);
    must(state.rows.every(row=>['INPUT','OPERATIONAL_COST_BASIS'].includes(row.kind)),unconfirmed);
    const checkpoint=input.envelope!.checkpointDependencies.length?await this.#checkpoints.verifiedPredecessorsIn(tx,input):{evidenceIds:[],jobIds:[]};
    const rows=(await tx.client.query<{capture:NativeOwnerCapture}>(`SELECT jsonb_build_object('contextId',c.context_id,'contextGeneration',c.generation::text,'ownerSessionId',c.owner_session_id,'ownerTabId',c.owner_tab_id,'ownerRevision',c.owner_revision::text,'workspaceRevision',c.workspace_revision::text) AS capture
      FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
      JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
      JOIN request_steps s ON s.account_id=e.account_id AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id
      JOIN work_items w ON w.account_id=e.account_id AND w.work_item_id=$5
      WHERE e.account_id=$1 AND e.execution_id=$2 AND e.state='PREPARED' AND e.dispatch_attempted_at IS NULL AND e.start_confirmed_at IS NULL
      AND e.claim_generation=$3 AND s.current_execution_id=e.execution_id AND w.kind='DISPATCH' AND w.state='CLAIMED' AND w.claim_generation=e.claim_generation
      AND w.claim_owner=$6 AND w.lease_until>$4 AND w.target_ref->>'requestId'=r.request_id::text
      AND EXISTS(SELECT 1 FROM app_sessions a JOIN login_bindings b USING(account_id,binding_id) WHERE a.account_id=c.account_id AND a.session_id=c.owner_session_id AND b.state='ACTIVE' AND a.revoked_at IS NULL AND a.absolute_expires_at>$4 AND a.auth_generation=$7)
      AND NOT EXISTS(SELECT 1 FROM connection_rounds n WHERE n.account_id=c.account_id AND n.context_id=c.context_id AND n.closed_at IS NULL)
      AND EXISTS(SELECT 1 FROM workspace_pages p JOIN active_page_requests a ON a.account_id=p.account_id AND a.page_lineage_id=p.page_lineage_id AND a.project_lineage_id=r.project_lineage_id WHERE p.account_id=r.account_id AND p.context_id=r.context_id AND p.page_lineage_id=r.page_lineage_id AND a.request_id=r.request_id AND NOT p.excluded AND p.result_revision=r.expected_result_revision)
      AND NOT EXISTS(SELECT 1 FROM cost_items k WHERE k.account_id=e.account_id AND(k.state='UNCONFIRMED' OR k.evidence_conflict))
      AND NOT EXISTS(SELECT 1 FROM provider_wait_rounds p WHERE p.account_id=e.account_id AND p.request_id=e.request_id AND p.logical_step_id=e.logical_step_id AND p.closed_at IS NULL AND p.deadline<=$4)
      AND NOT EXISTS(SELECT 1 FROM execution_evidence z WHERE z.account_id=e.account_id AND z.execution_id=e.execution_id AND z.kind IN('START','STALE_START'))
      AND NOT EXISTS(SELECT 1 FROM native_job_intents i WHERE i.account_id=e.account_id AND((i.target_kind='EXECUTION' AND i.target_id=e.execution_id) OR(i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=e.request_id)) AND NOT(i.job_id=ANY($8::uuid[])))
      AND NOT EXISTS(SELECT 1 FROM native_capacity_reservations n WHERE n.account_id=e.account_id AND(n.source_execution_id=e.execution_id OR n.base_execution_id=e.execution_id))
      LIMIT 2 FOR UPDATE OF e,r,c,w,s`,[input.accountId,input.executionId,claim.generation,tx.now,claim.workItemId,claim.ownerId,tx.account.auth_generation,checkpoint.jobIds])).rows;
    must(Array.isArray(rows)&&rows.length===1,unconfirmed);
    const row=own(rows[0],this.bounds.maxRecordBytes).value;closed(row,['capture']);return validateNativeOwnerCapture(row.capture);
  }
  async prepare(value:StageInput,claimValue:NativeJobClaim):Promise<LocalLaMaPreparationView&{created:boolean}>{
    const hold=this.acquire();try{
      const input=this.#verifier.input(own(value,this.bounds.maxRecordBytes).value),claim=validateNativeJobClaim(own(claimValue,this.bounds.maxRecordBytes).value);
      must(input.claimGeneration===claim.generation,unconfirmed);
      return await this.#verifier.transaction(input.accountId!,async tx=>{
        const state=await this.#originalsIn(tx,input,hold),existing=this.#captureIn(state);
        if(existing)return {version:1,capture:existing,created:false};
        const owner=await this.#firstFence(tx,state,claim),expectedOperations=expectedLaMaPreparationOperations(state.input,this.#profile,this.bounds.maxRecordBytes);
        must(state.rows.length<this.bounds.maxRecords&&expectedOperations.length<=this.bounds.maxRecords,capacity);
        const body={version:1 as const,preparationId:randomUUID(),input:state.inputRef,inputFingerprint:fingerprint(state.input),basis:state.basisRef,fullStageCaptureDigest:state.basis.captureDigest,originalClaim:claim,originalOwner:owner,nativeProfile:this.#profile,profileDigest:digest(this.#profile),kernelImplementationDigest:this.#kernel,taskVersion:nativeTaskVersion,facadeVerificationVersion:nativeFacadeVerificationVersion,expectedOperations,precheckRequirement:precheckRequirement(state.input,expectedOperations)};
        const capture:LocalLaMaPreparationCapture={...body,preparationDigest:digest(body)},wrapper=this.#wrap(state.input,lamaPreparationCaptureKind,capture),evidenceId=randomUUID(),evidenceDigest=digest(wrapper);
        // Re-read the complete bounded history in the same account transaction
        // immediately before INSERT; never return a truncated prefix as proof.
        const history=await this.#verifier.records(tx,input,true);must(history.length<this.bounds.maxRecords&&digest(history)===digest(state.rows),capacity);
        const inserted=await tx.client.query<{evidence_id:string}>(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
          VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id`,[input.accountId,evidenceId,input.executionId,lamaPreparationCaptureKind,evidenceDigest,tx.now,JSON.stringify(wrapper)]);
        must(inserted.rowCount===1&&inserted.rows.length===1&&inserted.rows[0].evidence_id===evidenceId,unconfirmed);
        return {version:1,capture:{evidenceId,evidenceDigest,value:own(capture,this.bounds.maxRecordBytes).value},created:true};
      },true);
    }finally{hold.release();}
  }
  async lookup(value:StageInput):Promise<LocalLaMaPreparationView>{
    const hold=this.acquire();try{
      const input=this.#verifier.input(own(value,this.bounds.maxRecordBytes).value);
      return await this.#verifier.transaction(input.accountId!,async tx=>({version:1,capture:this.#captureIn(await this.#originalsIn(tx,input,hold))}),true);
    }finally{hold.release();}
  }
  async #inputForTarget(tx:Transaction,target:NativeTarget,hold:LocalLaMaPreparationReservation):Promise<StageInput|null>{
    this.#assertReservation(hold);if(target.targetKind!=='EXECUTION')return null;
    const rows=(await tx.client.query<{protected_observation:unknown}>(`SELECT CASE WHEN octet_length(protected_observation::text)<=$3 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT' LIMIT 2`,[target.accountId,target.targetId,this.bounds.maxRecordBytes])).rows;
    must(Array.isArray(rows)&&rows.length===1,unconfirmed);const input=own(rows[0].protected_observation,this.bounds.maxRecordBytes).value as StageInput;
    if(input.stage!=='CLEANUP')return null;return this.#verifier.input(input);
  }
  sameDatabase(db:Database):boolean{return this.#db===db;}
  async readIn(tx:Transaction,value:StageInput,hold:LocalLaMaPreparationReservation):Promise<{state:LocalLaMaPreparationOriginalState;capture:LocalLaMaPreparationCaptureRecord|null}>{const state=await this.#originalsIn(tx,value,hold);return {state,capture:this.#captureIn(state)};}
  // Context selection owns no task buffers and uses the journal's bounded read
  // resources, independently of preparation native admission capacity.
  async readContextIn(tx:Transaction,value:StageInput):Promise<{state:LocalLaMaPreparationOriginalState;capture:LocalLaMaPreparationCaptureRecord|null}>{
    const state=await this.#originalsIn(tx,value,undefined);return {state,capture:this.#captureIn(state)};
  }
  async #operationFence(tx:Transaction,state:LocalLaMaPreparationOriginalState,target:NativeTarget):Promise<void>{
    const input=state.input,owner=target.protectedOwnerCapture,claim=target.claim;
    must(tx.account.access_state==='ACTIVE'&&claim.workItemId!==null&&state.core.claim_generation===claim.generation&&!state.core.request_terminal&&!state.core.native_hold&&state.core.context_generation===state.core.request_generation&&state.core.lifecycle!=='CLOSED',unconfirmed);
    const rows=(await tx.client.query<{current:boolean}>(`SELECT true AS current FROM executions e
      JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
      JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
      JOIN request_steps s ON s.account_id=e.account_id AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id
      JOIN work_items w ON w.account_id=e.account_id AND w.work_item_id=$3
      WHERE e.account_id=$1 AND e.execution_id=$2 AND e.claim_generation=$4 AND s.current_execution_id=e.execution_id
      AND e.state IN('PREPARED','DISPATCHING') AND e.start_confirmed_at IS NULL AND w.state='CLAIMED' AND w.claim_generation=$4
      AND w.claim_owner=$5 AND w.lease_until>$6 AND w.target_ref->>'requestId'=r.request_id::text
      AND c.context_id=$7 AND c.generation=$8 AND c.owner_session_id IS NOT DISTINCT FROM $9::uuid
      AND c.owner_tab_id IS NOT DISTINCT FROM $10::uuid AND c.owner_revision=$11 AND c.workspace_revision=$12
      LIMIT 2 FOR UPDATE OF e,r,c,w,s`,[input.accountId,input.executionId,claim.workItemId,claim.generation,claim.ownerId,tx.now,owner.contextId,owner.contextGeneration,owner.ownerSessionId,owner.ownerTabId,owner.ownerRevision,owner.workspaceRevision])).rows;
    must(Array.isArray(rows)&&rows.length===1&&rows[0].current===true,unconfirmed);
  }
  async forOperationIn(tx:Transaction,targetValue:NativeTarget,task:import('../../native/src/dto.js').NativeTask,metadata:Record<string,unknown>,blobs:import('../../native/src/dto.js').NativeBlob[],hold:LocalLaMaPreparationReservation):Promise<{input:StageInput;capture:LocalLaMaPreparationCaptureRecord;expected:LocalLaMaExpectedNativeOperation}>{
    this.#assertReservation(hold);const target=own(targetValue,this.bounds.maxRecordBytes).value;
    must(target.targetKind==='EXECUTION',unconfirmed);
    const input=await this.#inputForTarget(tx,target,hold);must(input,unconfirmed);
    const state=await this.#originalsIn(tx,input,hold),capture=this.#captureIn(state);
    // A context classified before the first original must HOLD after a race.
    // It cannot silently become an ordinary path for the same task call.
    must(!state.rows.some(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL'||row.kind==='LAMA_ATTEMPT_METADATA')&&capture!==null&&capture.value.kernelImplementationDigest===this.#kernel&&capture.value.profileDigest===digest(this.#profile),unconfirmed);
    must(target.sourceInput?.executionId===input.executionId&&target.sourceInput.inputEvidenceId===state.inputRef.evidenceId&&target.sourceInput.stageInputDigest===input.inputDigest,unconfirmed);
    const operationInputDigest=nativeOperationInputDigest({version:1,jobId:'00000000-0000-4000-8000-000000000001',task,taskVersion:nativeTaskVersion,profileDigest:digest(metadata.profile),metadata,blobs,inputDigest:'0'.repeat(64)});
    let expected=capture.value.expectedOperations.find(item=>item.task===task&&item.operationInputDigest===operationInputDigest&&item.semanticCaptureDigest===target.semanticCaptureDigest);
    if(task==='COMPOSITE_MASKED'){
      must(state.core.execution_state==='DISPATCHING'&&state.core.dispatch_attempted,unconfirmed);
      const base=await validateLaMaPreparationJoins(tx,input,capture,state.rows,this.bounds,false),proof=await deriveLaMaPreparationPrecheck(tx,input,capture,state.rows,base,this.bounds,true);
      const source=state.rows.find(row=>row.evidence_id===proof.source.evidenceId)!;
      const captured=(source.protected_observation as Wrapper<{value:{capture:import('../../providers/src/local-lama.js').LocalLaMaCapture}}>).value.value.capture;
      must(this.#verifier.original(input,localCapture(captured),state.core,state.rows,base.mask)!==null,unconfirmed);
      expected=proof.expected;
      must(expected.operationInputDigest===operationInputDigest&&expected.semanticCaptureDigest===target.semanticCaptureDigest&&digest(expected.metadata)===digest(metadata)&&digest(expected.blobs)===digest(blobs),unconfirmed);
      await this.#operationFence(tx,state,target);
      const existing=readLaMaPreparationPrecheck(input,capture,state.rows,proof,this.bounds);
      if(!existing){
        must(state.rows.length<this.bounds.maxRecords,capacity);
        const history=await this.#verifier.records(tx,input,true);must(history.length<this.bounds.maxRecords&&digest(history)===digest(state.rows),capacity);
        const body={...proof,precheckId:randomUUID()},precheck:LocalLaMaPreparationPrecheck={...body,precheckDigest:digest(body)},wrapper=this.#wrap(input,lamaPreparationPrecheckKind,precheck),evidenceId=randomUUID();
        const inserted=await tx.client.query<{evidence_id:string}>('INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id',[input.accountId,evidenceId,input.executionId,lamaPreparationPrecheckKind,digest(wrapper),tx.now,JSON.stringify(wrapper)]);
        must(inserted.rowCount===1&&inserted.rows.length===1&&inserted.rows[0].evidence_id===evidenceId,unconfirmed);
      }
    }
    must(expected&&digest(expected.metadata)===digest(metadata)&&digest(expected.blobs)===digest(blobs)&&target.protectedOwnerCapture.contextId===input.contextId&&target.protectedOwnerCapture.contextGeneration===input.envelope!.contextGeneration,unconfirmed);
    await this.#operationFence(tx,state,target);return {input,capture,expected};
  }
  async forOperation(targetValue:NativeTarget,task:import('../../native/src/dto.js').NativeTask,metadata:Record<string,unknown>,blobs:import('../../native/src/dto.js').NativeBlob[],hold:LocalLaMaPreparationReservation):Promise<{input:StageInput;capture:LocalLaMaPreparationCaptureRecord;expected:LocalLaMaExpectedNativeOperation}|null>{
    this.#assertReservation(hold);const target=own(targetValue,this.bounds.maxRecordBytes).value;
    return this.#verifier.transaction(target.accountId,tx=>this.forOperationIn(tx,target,task,metadata,blobs,hold),true);
  }
}

export type LocalLaMaPreparationSqlReceipt={
  candidateDigest:string;receiptDigest:string;resultObservation:{id:string;digest:string};
  terminationObservation:{id:string;digest:string};
};
export type LocalLaMaPreparationJoin={
  version:1;joinId:string;preparationId:string;preparationDigest:string;capture:EvidenceRef;
  input:EvidenceRef;basis:EvidenceRef;inputFingerprint:string;fullStageCaptureDigest:string;
  expected:LocalLaMaExpectedNativeOperation;sealed:import('./native-receipts.js').NativeSealedReceipt;
  sqlReceipt:LocalLaMaPreparationSqlReceipt;joinDigest:string;
};
export type LocalLaMaPreparationJoins={
  rows:LocalLaMaBindingEvidence[];jobIds:string[];mask:{sha256:string;bytesLength:string;mediaType:'image/png'};precheck:LocalLaMaBindingEvidence|null;
};
type PublishedPrecheckAsset={assetId:string;objectKey:string;sha256:string;bytesLength:string;mediaType:string;purpose:string;objectCreatedAt:string;verifiedAt:string;accessDeadline:string|null};
type PrecheckBody={
  version:1;preparationId:string;preparationDigest:string;capture:EvidenceRef;input:EvidenceRef;basis:EvidenceRef;
  inputFingerprint:string;fullStageCaptureDigest:string;requirement:LocalLaMaPrecheckRequirement;
  maskJoin:EvidenceRef;maskSqlReceipt:LocalLaMaPreparationSqlReceipt;source:EvidenceRef;candidate:EvidenceRef;
  image:AssetDependency;mask:AssetDependency;publishedAssets:PublishedPrecheckAsset[];expected:LocalLaMaExpectedNativeOperation;
};
export type LocalLaMaPreparationPrecheck=PrecheckBody&{precheckId:string;precheckDigest:string};

// Protected candidate/receipt JSON is not SELECTed. SQL jsonb digests match the
// privately read bounded records; these are intentionally not JS digest().
export async function verifyLaMaPreparationReceipt(tx:Transaction,input:StageInput,capture:LocalLaMaPreparationCaptureRecord,expected:LocalLaMaExpectedNativeOperation,value:import('./native-receipts.js').NativeSealedReceipt,bounds:Readonly<LocalLaMaBindingReaderBounds>):Promise<LocalLaMaPreparationSqlReceipt>{
  const sealed=own(value,bounds.maxRecordBytes).value;closed(sealed,['candidate','receipt','intent','termination','origin']);
  must(['FRESH','CACHE'].includes(sealed.origin),unconfirmed);
  const profile=capture.value.nativeProfile,maximum=Math.max(profile.maxImageBytes,profile.maxPixels*4+profile.maxHeight*4+65536);
  const {candidate,result}=validateNativeReceiptCandidate(sealed.candidate,{maxMetadataBytes:bounds.maxRecordBytes,maxBinaryBytes:maximum+(expected.task==='POLYGON_MASK'?profile.maxPixels:0),maxItems:expected.task==='POLYGON_MASK'?2:1},{maxMetadataBytes:bounds.maxRecordBytes,maxBinaryBytes:maximum*Math.max(1,expected.blobs.length),maxItems:Math.max(1,expected.blobs.length)});
  const intent=validateNativeJobIntent(sealed.intent),raw=JSON.parse(candidate.inputCanonical) as NativeJob;
  must(candidate.kernelImplementationDigest===capture.value.kernelImplementationDigest&&candidate.verificationVersion===capture.value.facadeVerificationVersion&&candidate.operationInputDigest===expected.operationInputDigest&&result.task===expected.task&&result.taskVersion===expected.taskVersion&&result.profileDigest===expected.profileDigest&&digest(raw.metadata)===digest(expected.metadata)&&digest(raw.blobs)===digest(expected.blobs)&&intent.jobId===candidate.jobId&&intent.parentInstanceId===candidate.parentInstanceId&&intent.inputDigest===result.inputDigest&&intent.operationInputDigest===expected.operationInputDigest,unconfirmed);
  closed(sealed.receipt,['version','candidateId','kernelImplementationDigest','verificationVersion','blobs']);
  must(sealed.receipt.version===1&&sealed.receipt.candidateId===candidate.candidateId&&sealed.receipt.kernelImplementationDigest===candidate.kernelImplementationDigest&&sealed.receipt.verificationVersion===candidate.verificationVersion&&sealed.receipt.blobs.length===candidate.blobs.length,unconfirmed);
  for(const [index,blob]of sealed.receipt.blobs.entries()){
    closed(blob,['blobId','receipt']);const ref=candidate.blobs[index],receipt=blob.receipt;closed(receipt,['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds']);
    must(blob.blobId===ref.blobId&&receipt.key===input.accountId+'/'+ref.assetId&&receipt.sha256===ref.sha256&&receipt.bytesLength===ref.bytesLength&&typeof receipt.completedAt==='string'&&new Date(receipt.completedAt).toISOString()===receipt.completedAt&&[1,1000].includes(receipt.completedAtPrecisionMilliseconds),unconfirmed);
  }
  must(sealed.termination.jobId===candidate.jobId&&sealed.termination.inputDigest===intent.inputDigest&&sealed.termination.profileDigest===intent.profileDigest&&sealed.termination.operationJoined&&sealed.termination.directChildClosed&&['DIRECT_CHILD_ONLY','CGROUP_EMPTY'].includes(sealed.termination.kind),unconfirmed);
  const rows=(await tx.client.query<{candidate_digest:string;receipt_digest:string;result_observation_id:string;result_observation_digest:string;termination_observation_id:string;termination_observation_digest:string}>(`SELECT c.candidate_digest,r.receipt_digest,o.observation_id AS result_observation_id,o.observation_digest AS result_observation_digest,
      t.observation_id AS termination_observation_id,t.observation_digest AS termination_observation_digest
    FROM native_result_candidates c JOIN native_result_receipts r USING(account_id,candidate_id)
    JOIN native_job_intents i ON i.account_id=c.account_id AND i.job_id=c.job_id
    JOIN native_job_observations o ON o.account_id=i.account_id AND o.job_id=i.job_id AND o.observation_id=$7
    JOIN native_job_observations t ON t.account_id=i.account_id AND t.job_id=i.job_id AND t.event='TERMINATION'
    WHERE c.account_id=$1 AND c.candidate_id=$2 AND c.job_id=$3
      AND c.candidate_digest=encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex')
      AND r.receipt_digest=encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex') AND i.protected_intent=$6::jsonb
      AND c.operation_input_digest=$8 AND c.kernel_implementation_digest=$9 AND c.verification_version=$10
      AND o.event='RESULT' AND o.observation_digest=$11 AND o.protected_observation->>'code'='OK'
      AND o.protected_observation->>'resultDigest'=$12
      AND t.protected_observation->>'code'='OK' AND (t.protected_observation->'termination')- 'isolation'=$13::jsonb
      AND NOT EXISTS(SELECT 1 FROM native_job_observations x WHERE x.account_id=i.account_id AND x.job_id=i.job_id AND x.event='ERROR')
      AND EXISTS(SELECT 1 FROM native_job_go_consumptions g WHERE g.account_id=i.account_id AND g.job_id=i.job_id)
    ORDER BY t.received_at,t.observation_id LIMIT $14`,[input.accountId,candidate.candidateId,candidate.jobId,JSON.stringify(candidate),JSON.stringify(sealed.receipt),JSON.stringify(intent),candidate.resultObservationId,expected.operationInputDigest,candidate.kernelImplementationDigest,candidate.verificationVersion,candidate.resultObservationDigest,candidate.resultDigest,JSON.stringify(sealed.termination),bounds.maxRecords+1])).rows;
  must(Array.isArray(rows)&&rows.length>0&&rows.length<=bounds.maxRecords,unconfirmed);
  const row=own(rows[0],bounds.maxRecordBytes).value;closed(row,['candidate_digest','receipt_digest','result_observation_id','result_observation_digest','termination_observation_id','termination_observation_digest']);
  for(const key of ['candidate_digest','receipt_digest','result_observation_digest','termination_observation_digest'] as const)hexadecimal(row[key]);id(row.result_observation_id);id(row.termination_observation_id);
  must(row.result_observation_id===candidate.resultObservationId&&row.result_observation_digest===candidate.resultObservationDigest,unconfirmed);
  return {candidateDigest:row.candidate_digest,receiptDigest:row.receipt_digest,resultObservation:{id:row.result_observation_id,digest:row.result_observation_digest},terminationObservation:{id:row.termination_observation_id,digest:row.termination_observation_digest}};
}

export async function confirmCurrentLaMaPreparationReceipt(tx:Transaction,target:NativeTarget,capture:LocalLaMaPreparationCaptureRecord,expected:LocalLaMaExpectedNativeOperation,sealed:import('./native-receipts.js').NativeSealedReceipt,maxBytes:number):Promise<void>{
  const lookup={version:1,targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:target.protectedOwnerCapture,claim:target.claim,task:expected.task,taskVersion:expected.taskVersion,profileDigest:expected.profileDigest,operationInputDigest:expected.operationInputDigest,kernelImplementationDigest:capture.value.kernelImplementationDigest};
  const rows=(await tx.client.query<{state:unknown}>(`WITH receipt_lookup AS MATERIALIZED(SELECT manga_web.native_receipt_lookup($1::jsonb) AS value)
    SELECT CASE WHEN octet_length(value::text)<=$2 THEN value ELSE NULL END AS state FROM receipt_lookup`,[JSON.stringify(lookup),maxBytes])).rows;
  must(rows.length===1&&rows[0].state!==null,unconfirmed);const read=own(rows[0].state,maxBytes).value as {state:string;candidate?:unknown;receipt?:unknown;intent?:unknown};
  must(read.state==='VERIFIED'&&digest(read.candidate)===digest(sealed.candidate)&&digest(read.receipt)===digest(sealed.receipt)&&digest(read.intent)===digest(sealed.intent),unconfirmed);
}

function preparationValue<T>(row:LocalLaMaBindingEvidence,input:StageInput,kind:string,bounds:Readonly<LocalLaMaBindingReaderBounds>):T{
  const wrapper=own(row.protected_observation,bounds.maxRecordBytes).value as Wrapper<T>;
  closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
  must(row.kind===kind&&wrapper.version===1&&wrapper.accountId===input.accountId&&wrapper.executionId===input.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===fingerprint(input)&&wrapper.kind===kind&&digest(wrapper)===row.evidence_digest&&row.protected_evidence_ref===row.evidence_id,unconfirmed);return wrapper.value;
}

async function deriveLaMaPreparationPrecheck(tx:Transaction,input:StageInput,capture:LocalLaMaPreparationCaptureRecord,rows:LocalLaMaBindingEvidence[],base:LocalLaMaPreparationJoins,bounds:Readonly<LocalLaMaBindingReaderBounds>,current:boolean):Promise<PrecheckBody>{
  const maskRows=base.rows.filter(row=>preparationValue<LocalLaMaPreparationJoin>(row,input,lamaPreparationJoinKind,bounds).expected.task==='POLYGON_MASK');must(maskRows.length===1,unconfirmed);
  const maskRow=maskRows[0],maskJoin=preparationValue<LocalLaMaPreparationJoin>(maskRow,input,lamaPreparationJoinKind,bounds);
  must(maskJoin.expected.logicalOperationKey===capture.value.precheckRequirement.maskLogicalOperationKey,unconfirmed);
  const candidates=rows.filter(row=>row.kind==='OPERATIONAL_CANDIDATE'),sources=rows.filter(row=>row.kind==='OPERATIONAL_SOURCE'&&((row.protected_observation as {value?:{phase?:unknown}}).value?.phase==='LAMA_INPUT'));
  must(candidates.length===1&&sources.length===1,unconfirmed);
  const candidate=preparationValue<import('./pipeline-evidence.js').PipelineStageCandidate>(candidates[0],input,'OPERATIONAL_CANDIDATE',bounds);
  const source=preparationValue<{version:1;candidate:typeof candidate;phase:'LAMA_INPUT';value:{capture:import('../../providers/src/local-lama.js').LocalLaMaCapture;image:AssetDependency;mask:AssetDependency}}>(sources[0],input,'OPERATIONAL_SOURCE',bounds);
  closed(source,['version','candidate','phase','value']);closed(source.value,['capture','image','mask']);const local=localCapture(source.value.capture);
  const image=source.value.image,mask=source.value.mask;
  must(source.version===1&&source.phase==='LAMA_INPUT'&&digest(source.candidate)===digest(candidate)&&digest(image)===digest(capture.value.precheckRequirement.image)&&mask.assetId===candidate.maskAssetId&&mask.sha256===base.mask.sha256&&mask.bytesLength===base.mask.bytesLength&&mask.mediaType==='image/png'&&local.executionId===input.executionId&&local.inputDigest===input.inputDigest&&local.imageSha256===image.sha256&&local.imageByteLength===Number(image.bytesLength)&&local.maskSha256===mask.sha256&&local.maskByteLength===Number(mask.bytesLength),unconfirmed);
  const assetRows=(await tx.client.query<{value:PublishedPrecheckAsset|null;eligible:boolean}>(`SELECT CASE WHEN octet_length(object_key)<=256 AND octet_length(sha256)<=64 AND octet_length(media_type)<=64 AND octet_length(purpose)<=32 THEN
    jsonb_build_object('assetId',asset_id,'objectKey',object_key,'sha256',sha256,'bytesLength',bytes_length::text,'mediaType',media_type,'purpose',purpose,
      'objectCreatedAt',object_created_at::text,'verifiedAt',verified_at::text,'accessDeadline',access_deadline::text) ELSE NULL END AS value,
    (deletion_state='NOT_DUE' AND (access_deadline IS NULL OR access_deadline>$4) AND object_created_at IS NOT NULL AND verified_at IS NOT NULL) AS eligible
    FROM assets WHERE account_id=$1 AND asset_id IN($2,$3) ORDER BY asset_id LIMIT 3`,[input.accountId,image.assetId,mask.assetId,tx.now])).rows;
  must(assetRows.length===2&&image.assetId!==mask.assetId,unconfirmed);const publishedAssets:PublishedPrecheckAsset[]=[];
  for(const row of assetRows){
    must(row.value!==null&&(!current||row.eligible===true),unconfirmed);const value=own(row.value,bounds.maxRecordBytes).value;
    closed(value,['assetId','objectKey','sha256','bytesLength','mediaType','purpose','objectCreatedAt','verifiedAt','accessDeadline']);
    const dep=[image,mask].find(item=>item.assetId===value.assetId);
    must(dep&&value.objectKey===input.accountId+'/'+dep.assetId&&value.sha256===dep.sha256&&value.bytesLength===dep.bytesLength&&value.mediaType===dep.mediaType&&typeof value.objectCreatedAt==='string'&&Number.isFinite(Date.parse(value.objectCreatedAt))&&typeof value.verifiedAt==='string'&&Number.isFinite(Date.parse(value.verifiedAt))&&(value.accessDeadline===null||typeof value.accessDeadline==='string'&&Number.isFinite(Date.parse(value.accessDeadline))),unconfirmed);
    publishedAssets.push(value);
  }
  const profile=capture.value.nativeProfile,metadata={profile,sourceBlobId:'source',maskBlobId:'mask',proposalBlobId:'proposal'},blobs=[{id:'source',sha256:image.sha256,byteLength:Number(image.bytesLength)},{id:'mask',sha256:mask.sha256,byteLength:Number(mask.bytesLength)},{id:'proposal',sha256:image.sha256,byteLength:Number(image.bytesLength)}];
  const task='COMPOSITE_MASKED',operationInputDigest=nativeOperationInputDigest({version:1,jobId:'00000000-0000-4000-8000-000000000001',task,taskVersion:nativeTaskVersion,profileDigest:capture.value.profileDigest,metadata,blobs,inputDigest:'0'.repeat(64)}),semanticCaptureDigest=nativeExecutionCaptureDigest('DISPATCH',input.requestId,input);
  const expected:LocalLaMaExpectedNativeOperation={phase:'DISPATCH',task,taskVersion:nativeTaskVersion,profileDigest:capture.value.profileDigest,operationInputDigest,semanticCaptureDigest,logicalOperationKey:nativeLogicalOperationKey({targetKind:'EXECUTION',targetId:input.executionId,task,taskVersion:nativeTaskVersion,profileDigest:capture.value.profileDigest,operationInputDigest,semanticCaptureDigest}),metadata,blobs,dependencies:[image,mask]};
  return own({version:1 as const,preparationId:capture.value.preparationId,preparationDigest:capture.value.preparationDigest,capture:{evidenceId:capture.evidenceId,evidenceDigest:capture.evidenceDigest},input:capture.value.input,basis:capture.value.basis,inputFingerprint:capture.value.inputFingerprint,fullStageCaptureDigest:capture.value.fullStageCaptureDigest,requirement:capture.value.precheckRequirement,maskJoin:{evidenceId:maskRow.evidence_id,evidenceDigest:maskRow.evidence_digest},maskSqlReceipt:maskJoin.sqlReceipt,source:{evidenceId:sources[0].evidence_id,evidenceDigest:sources[0].evidence_digest},candidate:{evidenceId:candidates[0].evidence_id,evidenceDigest:candidates[0].evidence_digest},image,mask,publishedAssets,expected},bounds.maxRecordBytes).value;
}

function readLaMaPreparationPrecheck(input:StageInput,capture:LocalLaMaPreparationCaptureRecord,rows:LocalLaMaBindingEvidence[],proof:PrecheckBody,bounds:Readonly<LocalLaMaBindingReaderBounds>):LocalLaMaBindingEvidence|null{
  const matches=rows.filter(row=>row.kind===lamaPreparationPrecheckKind);must(matches.length<=1,unconfirmed);if(!matches.length)return null;
  const value=preparationValue<LocalLaMaPreparationPrecheck>(matches[0],input,lamaPreparationPrecheckKind,bounds);
  closed(value,['version','preparationId','preparationDigest','capture','input','basis','inputFingerprint','fullStageCaptureDigest','requirement','maskJoin','maskSqlReceipt','source','candidate','image','mask','publishedAssets','expected','precheckId','precheckDigest']);
  id(value.precheckId);hexadecimal(value.precheckDigest);const {precheckId:_id,precheckDigest,...body}=value;
  must(digest({...body,precheckId:_id})===precheckDigest&&value.preparationId===capture.value.preparationId&&digest(body)===digest(proof),unconfirmed);return matches[0];
}

export async function validateLaMaPreparationJoins(tx:Transaction,input:StageInput,capture:LocalLaMaPreparationCaptureRecord,rows:LocalLaMaBindingEvidence[],bounds:Readonly<LocalLaMaBindingReaderBounds>,includePrecheck=true,current=false):Promise<LocalLaMaPreparationJoins>{
  const joined=rows.filter(row=>row.kind===lamaPreparationJoinKind),keys=new Set<string>(),jobIds:string[]=[],baseRows:LocalLaMaBindingEvidence[]=[];let mask:LocalLaMaPreparationJoins['mask']|undefined;
  const baseOperations=capture.value.expectedOperations;const remaining:LocalLaMaBindingEvidence[]=[];
  for(const row of joined){
    const wrapper=own(row.protected_observation,bounds.maxRecordBytes).value as Wrapper<LocalLaMaPreparationJoin>;
    closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
    must(wrapper.version===1&&wrapper.accountId===input.accountId&&wrapper.executionId===input.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===fingerprint(input)&&wrapper.kind===lamaPreparationJoinKind&&digest(wrapper)===row.evidence_digest&&row.protected_evidence_ref===row.evidence_id,unconfirmed);
    const join=wrapper.value;closed(join,['version','joinId','preparationId','preparationDigest','capture','input','basis','inputFingerprint','fullStageCaptureDigest','expected','sealed','sqlReceipt','joinDigest']);
    id(join.joinId);hexadecimal(join.joinDigest);
    const expected=baseOperations.find(item=>item.logicalOperationKey===join.expected.logicalOperationKey);
    if(!expected){remaining.push(row);continue;}
    must(join.version===1&&join.preparationId===capture.value.preparationId&&join.preparationDigest===capture.value.preparationDigest&&digest(join.capture)===digest({evidenceId:capture.evidenceId,evidenceDigest:capture.evidenceDigest})&&digest(join.input)===digest(capture.value.input)&&digest(join.basis)===digest(capture.value.basis)&&join.inputFingerprint===capture.value.inputFingerprint&&join.fullStageCaptureDigest===capture.value.fullStageCaptureDigest&&expected&&digest(join.expected)===digest(expected)&&!keys.has(expected.logicalOperationKey),unconfirmed);
    keys.add(expected.logicalOperationKey);baseRows.push(row);const {joinDigest,...body}=join;must(digest(body)===joinDigest,unconfirmed);
    const verified=await verifyLaMaPreparationReceipt(tx,input,capture,expected,join.sealed,bounds);must(digest(verified)===digest(join.sqlReceipt),unconfirmed);
    jobIds.push(join.sealed.intent.jobId);
    if(expected.task==='POLYGON_MASK'){
      const result=JSON.parse(join.sealed.candidate.resultCanonical) as import('../../native/src/dto.js').NativeResult;
      const png=result.blobs.find(blob=>blob.id==='mask-png'),pixels=result.blobs.find(blob=>blob.id==='mask-pixels');
      must(png&&pixels&&result.metadata.pngBlobId===png.id&&result.metadata.pixelsBlobId===pixels.id&&result.metadata.pngByteLength===png.byteLength&&result.metadata.pixelsByteLength===pixels.byteLength&&pixels.byteLength===input.width*input.height,unconfirmed);
      // LocalLaMa.capture uses the PNG bytes, not the binary pixel descriptor.
      mask={sha256:png.sha256,bytesLength:String(png.byteLength),mediaType:'image/png'};
    }
  }
  must(mask&&baseRows.length===baseOperations.length,unconfirmed);
  const base:LocalLaMaPreparationJoins={rows:baseRows,jobIds,mask,precheck:null};
  if(!includePrecheck){must(remaining.length<=1,unconfirmed);return base;}
  const proof=await deriveLaMaPreparationPrecheck(tx,input,capture,rows,base,bounds,current),precheck=readLaMaPreparationPrecheck(input,capture,rows,proof,bounds);must(precheck&&remaining.length===1,unconfirmed);
  const row=remaining[0],join=preparationValue<LocalLaMaPreparationJoin>(row,input,lamaPreparationJoinKind,bounds),expected=proof.expected;
  closed(join,['version','joinId','preparationId','preparationDigest','capture','input','basis','inputFingerprint','fullStageCaptureDigest','expected','sealed','sqlReceipt','joinDigest']);id(join.joinId);hexadecimal(join.joinDigest);
  const {joinDigest,...body}=join;
  must(join.version===1&&join.preparationId===capture.value.preparationId&&join.preparationDigest===capture.value.preparationDigest&&digest(join.capture)===digest(proof.capture)&&digest(join.input)===digest(proof.input)&&digest(join.basis)===digest(proof.basis)&&join.inputFingerprint===proof.inputFingerprint&&join.fullStageCaptureDigest===proof.fullStageCaptureDigest&&digest(join.expected)===digest(expected)&&digest(body)===joinDigest,unconfirmed);
  const verified=await verifyLaMaPreparationReceipt(tx,input,capture,expected,join.sealed,bounds);must(digest(verified)===digest(join.sqlReceipt),unconfirmed);
  jobIds.push(join.sealed.intent.jobId);return {rows:[...baseRows,row],jobIds,mask,precheck};
}
