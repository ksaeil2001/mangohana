import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import Decimal from 'decimal.js';
import type { Database, Transaction } from '../../storage/src/database.js';
import { digest } from '../../contracts/src/intent.js';
import { money,assertWire } from '../../contracts/src/validation.js';
import type {Checkpoint,StageInputEnvelope} from '../../contracts/src/wire.generated.js';
import { requireCondition,DomainError } from '../../contracts/src/errors.js';
import { type ContextRow, type EditData, type PageRow, type RequestRow,type AssetDependency, bumpWorkspace, contextRow, resultRow, settingsRow } from './model.js';
import { invalidateChangedHistory } from './manual.js';
import { type RequestPolicy, queueWork } from './requests.js';
import { finalizeSafe, sweepAccount } from './liveness.js';
import { type Observation, type ProviderAdapter, type ProviderCallContext, type StageInput, unknownObservation,normalizeObservation,outputEnvelope,persistInput,storedInput,canonicalInput } from './provider.js';
import {advanceBatch} from './batch.js';
import {mergeScopedData,validateEditData,painted} from './scope.js';
import {prepareExecutionLimits,reserveExecutionLimits,reconcileExecutionLimits,releaseRequestExecutionBudget,validateCapturedExecutionLimitReference} from './execution-limits.js';
import type {NativeGateway} from '../../native/src/gateway.js';
import type {NativeJobClaim} from './native-jobs.js';
import {NativeJobError,nativeJsonBytes} from '../../native/src/dto.js';
import {NativeJobErrorV2} from '../../native/src/controller-remote.js';
import {appendNativeExecutionWait,holdNativeExecution,nativeExecutionCaptureDigest,nativeExecutionHold,nativeExecutionSource,nativeExecutionWaiting,nativeValidationUnknown,type NativeExecutionFault,type NativeExecutionPhase} from './native-execution-wait.js';
import {nativeContextForInput,isLocalLaMaContextReadWait} from './native-gateway.js';
import type {OperationalStageCost} from './pipeline-stage-cost.js';
import type {CheckpointValidationPurpose,CheckpointValidationAttempt,CheckpointValidationTarget} from './checkpoint-validation.js';
import {NativeCostedWindowsGateway,windowsExecutionCostPorts,isWindowsExecutionContextWait,isWindowsExecutionInfrastructureError,type WindowsExecutionCostPorts} from './native-remote-gateway.js';
import type {WindowsNativeCostOwner,WindowsNativeCostRef} from './windows-native-cost.js';

type ExecutionRow=QueryResultRow&{account_id:string;execution_id:string;request_id:string;logical_step_id:string;state:string;input_digest:string;claim_generation:string;
  dispatch_attempted_at:Date|null;start_confirmed_at:Date|null;output_envelope:Observation|null};
type WorkRow=QueryResultRow&{account_id:string;work_item_id:string;kind:string;claim_generation:string;lease_until:Date|null;state:string;due_at:Date;target_ref:Record<string,string>;claim_owner:string|null};
export type Claim={accountId:string;workId:string;generation:string;kind:string;ref:Record<string,string>;checkpointDigests?:Record<string,string>};
type Hooks={beforeValidateInput?:(input:StageInput,claim:NativeJobClaim)=>Promise<void>;afterPrepare?:(input:StageInput)=>Promise<void>;afterDispatch?:(input:StageInput)=>Promise<void>;leaseMilliseconds?:number;heartbeatMilliseconds?:number};
const terminal=(state:string)=>['COMPLETED','STOPPED','FAILED'].includes(state);

export class ExecutionService {
  readonly workerId=randomUUID();
  private acceptingClaims=true;
  constructor(readonly db:Database,readonly provider:ProviderAdapter,readonly policy:RequestPolicy,readonly hooks:Hooks={},readonly nativeGateway?:NativeGateway,readonly operationalCost?:OperationalStageCost) {}
  stopClaims():void {this.acceptingClaims=false;}
  private dispatchConfigured():boolean {
    if(this.provider.synthetic===true&&this.policy.synthetic===true)return true;
    const reference=this.policy.executionLimit;
    // Existing owned limit/capacity admission is not measured production authority.
    // Require the installed original-input preparation and validation ports too.
    if(this.provider.synthetic!==false||this.policy.synthetic!==false||!this.policy.realProviderEnabled||this.db.role!=='trio_web_worker'||!reference||!this.nativeGateway||typeof this.provider.validateInput!=='function'||typeof this.provider.validateObservation!=='function'||typeof this.hooks.beforeValidateInput!=='function')return false;
    const verified=validateCapturedExecutionLimitReference(reference),profile=this.policy.parameterProfileVersion;
    return typeof profile==='string'&&profile!=='synthetic-fixtures-v1'&&profile===verified.profileVersion;
  }
  private capturedDispatchReady(request:RequestRow):boolean {
    if(this.provider.synthetic===true&&this.policy.synthetic===true)return true;
    const captured=request.captured_input;
    // Operational paid settlement remains unimplemented. Original retry captures
    // are checked, never upgraded to the current profile or synthetic defaults.
    if(request.mode!=='FREE'||captured.parameterProfileVersion!==this.policy.parameterProfileVersion||!captured.executionLimit||!this.policy.executionLimit||typeof captured.minReadableFontSizePx!=='number'||captured.minReadableFontSizePx<=0||captured.minReadableFontSizePx!==this.policy.minReadableFontSizePx)return false;
    return digest(validateCapturedExecutionLimitReference(captured.executionLimit))===digest(validateCapturedExecutionLimitReference(this.policy.executionLimit));
  }
  private boundedInputReady(input:StageInput):boolean {
    if(this.provider.synthetic===true&&this.policy.synthetic===true)return true;
    const envelope=input.envelope;
    if(!this.dispatchConfigured()||!envelope||envelope.parameterProfileVersion!==this.policy.parameterProfileVersion||envelope.costBoundUsd===null)return false;
    money(envelope.costBoundUsd);return new Decimal(envelope.costBoundUsd).greaterThan(0);
  }

  async claim():Promise<Claim|null> {
    if(!this.acceptingClaims)return null;
    const candidates=(await this.db.pool.query<WorkRow>('SELECT * FROM manga_web.dispatch_candidates()')).rows;
    for(const candidate of candidates) {
      if(!this.acceptingClaims)return null;
      const claimed=await this.db.accountTransaction(candidate.account_id,async(tx)=>{
        const work=(await tx.client.query<WorkRow>('SELECT * FROM work_items WHERE account_id=$1 AND work_item_id=$2 FOR UPDATE',[candidate.account_id,candidate.work_item_id])).rows[0];
        if(!this.acceptingClaims || !work || work.state==='DONE' || work.due_at>tx.now || (work.lease_until && work.lease_until>tx.now)) return null;
        const generation=(BigInt(work.claim_generation)+1n).toString();
        await tx.client.query("UPDATE work_items SET state='CLAIMED',claim_generation=$3,claim_owner=$4,lease_until=$5,revision=revision+1 WHERE account_id=$1 AND work_item_id=$2",[work.account_id,work.work_item_id,generation,this.workerId,new Date(tx.now.valueOf()+(this.hooks.leaseMilliseconds??30000))]);
        return {accountId:work.account_id,workId:work.work_item_id,generation,kind:work.kind,ref:work.target_ref};
      },true);
      if(claimed) return claimed;
    }
    return null;
  }
  async finish(claim:Claim,done:boolean,delay=0):Promise<void> {
    await this.db.accountTransaction(claim.accountId,async(tx)=>{
      await tx.client.query("UPDATE work_items SET state=$4,due_at=$5,lease_until=NULL,claim_owner=NULL,revision=revision+1 WHERE account_id=$1 AND work_item_id=$2 AND claim_generation=$3 AND state='CLAIMED' AND claim_owner=$6 AND lease_until>$7",
        [claim.accountId,claim.workId,claim.generation,done?'DONE':'READY',new Date(tx.now.valueOf()+delay),this.workerId,tx.now]);
    },true);
  }
  async claimCurrent(tx:Transaction,claim:Claim):Promise<boolean> {
    const work=(await tx.client.query<WorkRow>('SELECT * FROM work_items WHERE account_id=$1 AND work_item_id=$2 FOR UPDATE',[claim.accountId,claim.workId])).rows[0];
    return !!work&&work.state==='CLAIMED'&&work.claim_owner===this.workerId&&work.claim_generation===claim.generation&&!!work.lease_until&&tx.now<work.lease_until;
  }
  async renew(claim:Claim):Promise<boolean> {
    return this.db.accountTransaction(claim.accountId,async tx=>{const result=await tx.client.query(`UPDATE work_items SET lease_until=$5,revision=revision+1 WHERE account_id=$1 AND work_item_id=$2 AND claim_generation=$3 AND state='CLAIMED' AND claim_owner=$4 AND lease_until>$6 RETURNING work_item_id`,[claim.accountId,claim.workId,claim.generation,this.workerId,new Date(tx.now.valueOf()+(this.hooks.leaseMilliseconds??30000)),tx.now]);return !!result.rowCount;},true);
  }
  async verifyAssets(tx:Transaction,dependencies:AssetDependency[],requiredIds:string[]=[]):Promise<void> {
    requireCondition(new Set(dependencies.map(d=>d.assetId)).size===dependencies.length&&requiredIds.every(id=>dependencies.some(d=>d.assetId===id)),'STAGE_PROPOSAL_INVALID',422);
    if(!dependencies.length)return;
    const rows=(await tx.client.query<{asset_id:string;sha256:string;bytes_length:string;media_type:string;purpose:string;deletion_state:string}>('SELECT asset_id,sha256,bytes_length,media_type,purpose,deletion_state FROM assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[])',[tx.account.account_id,dependencies.map(d=>d.assetId)])).rows;
    requireCondition(rows.length===dependencies.length&&dependencies.every(d=>rows.some(row=>row.asset_id===d.assetId&&row.sha256===d.sha256&&row.bytes_length===d.bytesLength&&row.media_type===d.mediaType&&['LIVE','FONT'].includes(row.purpose)&&row.deletion_state!=='CONFIRMED')),'STAGE_PROPOSAL_INVALID',422);
    requireCondition(requiredIds.every(id=>rows.some(row=>row.asset_id===id&&row.purpose==='LIVE'&&row.media_type==='image/png')),'STAGE_PROPOSAL_INVALID',422);
  }

  private windowsCostPorts():WindowsExecutionCostPorts|null{
    const gateway=this.nativeGateway;if(!gateway)return null;
    const ports=windowsExecutionCostPorts(gateway,this.db);
    if(gateway instanceof NativeCostedWindowsGateway&&!ports)requireCondition(false,'WINDOWS_NATIVE_COST_OWNER_UNCONFIRMED',409,'WAIT');
    if(ports&&!this.operationalCost)ports.unconfirmed();
    return ports;
  }
  private rethrowWindowsFailure(error:unknown,readingContext=false,readingAssets=false):void{
    const gateway=this.nativeGateway;
    if(gateway&&windowsExecutionCostPorts(gateway,this.db)&&(readingContext||error instanceof NativeJobErrorV2||isWindowsExecutionInfrastructureError(error,gateway)||(readingAssets&&!(error instanceof DomainError))))throw error;
  }
  private async windowsInputRefIn(tx:Transaction,input:StageInput,ports:WindowsExecutionCostPorts):Promise<WindowsNativeCostRef>{
    const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:StageInput}>(`SELECT evidence_id,evidence_digest,protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=131072 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT' LIMIT 2`,[input.accountId,input.executionId])).rows;
    if(rows.length!==1)ports.unconfirmed();const row=rows[0];
    if(!row.protected_observation||row.protected_evidence_ref!==row.evidence_id||row.evidence_digest!==digest(canonicalInput(input))||digest(row.protected_observation)!==row.evidence_digest)ports.unconfirmed();
    nativeJsonBytes(row.protected_observation,131072);return {evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest};
  }
  private async enrollWindowsInputIn(tx:Transaction,input:StageInput):Promise<void>{
    const ports=this.windowsCostPorts();if(!ports)return;
    const ref=await this.windowsInputRefIn(tx,input,ports);if(!await ports.enrollInputIn(tx,ref))ports.unconfirmed();
  }
  private async windowsOwnerIn(tx:Transaction,claim:Claim,input:StageInput,ports:WindowsExecutionCostPorts):Promise<WindowsNativeCostOwner>{
    if(!await this.claimCurrent(tx,claim)||input.accountId!==claim.accountId)ports.unconfirmed();
    const original=await storedInput(tx,input.executionId);if(digest(canonicalInput(original))!==digest(canonicalInput(input)))ports.unconfirmed();
    const ref=await this.windowsInputRefIn(tx,original,ports),view=await this.operationalCost!.readIn(tx,original);
    const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown}>(`SELECT evidence_id,evidence_digest,protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=131072 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_BASIS' LIMIT 2`,[input.accountId,input.executionId])).rows;
    if(!view.basis||rows.length!==1)ports.unconfirmed();const row=rows[0],wrapper=row.protected_observation as {version?:unknown;accountId?:unknown;executionId?:unknown;inputDigest?:unknown;inputFingerprint?:unknown;kind?:unknown;value?:unknown}|null;
    if(!wrapper||Object.keys(wrapper).length!==7||wrapper.version!==1||wrapper.accountId!==input.accountId||wrapper.executionId!==input.executionId||wrapper.inputDigest!==input.inputDigest||wrapper.inputFingerprint!==ref.evidenceDigest||wrapper.kind!=='OPERATIONAL_COST_BASIS'||row.protected_evidence_ref!==row.evidence_id||digest(wrapper)!==row.evidence_digest||digest(wrapper.value)!==digest(view.basis))ports.unconfirmed();
    nativeJsonBytes(wrapper,131072);
    return {executionId:input.executionId,inputEvidenceId:ref.evidenceId,inputFingerprint:ref.evidenceDigest,basisRef:{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest},claim:{generation:claim.generation,ownerId:this.workerId,workItemId:claim.workId},validationAttemptRef:null};
  }
  private async activateWindowsRoot(claim:Claim,input:StageInput,ports:WindowsExecutionCostPorts):Promise<void>{
    await this.db.accountTransaction(claim.accountId,async tx=>{
      const owner=await this.windowsOwnerIn(tx,claim,input,ports),request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,input.requestId])).rows[0];
      if(!request||request.state==='STOP_REQUESTED'||terminal(request.state)||!await this.requestCurrent(tx,await contextRow(tx,request.context_id),request))ports.unconfirmed();
      if(!await ports.activateRootIn(tx,owner))ports.unconfirmed();
    },true);
  }
  private async preserveWindowsContext(claim:Claim,input:StageInput,known?:Observation):Promise<void>{
    if(!known)return;
    await this.db.accountTransaction(claim.accountId,async tx=>{
      const original=await storedInput(tx,input.executionId);
      requireCondition(digest(canonicalInput(original))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      if(await this.claimCurrent(tx,claim))await nativeExecutionSource(tx,input.executionId,known);
    },true);
  }
  async nativeCallContext(claim:Claim,input:StageInput,phase:NativeExecutionPhase,currentRequestId=input.requestId,observation?:Observation,validation?:{consumer:StageInput;attempt:CheckpointValidationAttempt;target:CheckpointValidationTarget}):Promise<ProviderCallContext|undefined>{
    const gateway=this.nativeGateway;if(!gateway)return undefined;
    const ports=this.windowsCostPorts(),db=this.db,ownedClaim=structuredClone(claim),executionId=input.executionId,inputFingerprint=digest(canonicalInput(input)),known=observation?structuredClone(observation):undefined,ownedValidation=validation?structuredClone(validation):undefined;
    const captured=await db.accountTransaction(ownedClaim.accountId,async tx=>{
      const check=(condition:unknown,code='NATIVE_PARENT_FENCE_REJECTED'):void=>{if(!condition&&ports)ports.unconfirmed();requireCondition(condition,code,409,'WAIT');};
      check(await this.claimCurrent(tx,ownedClaim));
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[ownedClaim.accountId,currentRequestId])).rows[0];
      check(request);if(this.operationalCost&&phase!=='LOOKUP')check(request.state!=='STOP_REQUESTED'&&await this.requestCurrent(tx,await contextRow(tx,request.context_id),request));
      const original=structuredClone(await storedInput(tx,executionId));check(digest(canonicalInput(original))===inputFingerprint,'INPUT_EVIDENCE_INVALID');
      const inputEvidence=(await tx.client.query<{evidence_id:string}>("SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[ownedClaim.accountId,original.executionId])).rows;
      check(inputEvidence.length===1,'INPUT_EVIDENCE_INVALID');
      if(phase==='CHECKPOINT')check((await tx.client.query(`SELECT 1 FROM request_steps s JOIN checkpoints c ON c.account_id=s.account_id AND (c.checkpoint_id=s.reuse_checkpoint_id OR (s.reuse_checkpoint_id IS NULL AND c.execution_id=s.current_execution_id))
        WHERE s.account_id=$1 AND s.request_id=$2 AND c.execution_id=$3`,[ownedClaim.accountId,currentRequestId,executionId])).rowCount,'CHECKPOINT_DEPENDENCY_INVALID');
      else check(request.request_id===original.requestId);
      const context=await contextRow(tx,request.context_id);check(context.generation===request.context_generation);
      const target={accountId:ownedClaim.accountId,targetKind:phase==='CHECKPOINT'?'REQUEST_CHECKPOINT' as const:'EXECUTION' as const,targetId:phase==='CHECKPOINT'?currentRequestId:original.executionId,
        semanticCaptureDigest:nativeExecutionCaptureDigest(phase,currentRequestId,original,ports&&phase!=='CHECKPOINT'?undefined:known),
        protectedOwnerCapture:{contextId:request.context_id,contextGeneration:request.context_generation,ownerSessionId:context.owner_session_id,ownerTabId:context.owner_tab_id,ownerRevision:context.owner_revision,workspaceRevision:context.workspace_revision},
        claim:{generation:ownedClaim.generation,ownerId:this.workerId,workItemId:ownedClaim.workId},sourceInput:{executionId:original.executionId,inputEvidenceId:inputEvidence[0].evidence_id,stageInputDigest:original.inputDigest}};
      if(!ports)return {input:original,target,owner:null,targetDigest:null};
      if(phase!=='CHECKPOINT')return {input:original,target,owner:await this.windowsOwnerIn(tx,ownedClaim,original,ports),targetDigest:null};
      if(!ownedValidation)return ports.unconfirmed();const {consumer,attempt,target:validationTarget}=ownedValidation;
      const owner=await this.windowsOwnerIn(tx,ownedClaim,consumer,ports);
      check(consumer.requestId===currentRequestId&&attempt.consumerExecutionId===consumer.executionId&&attempt.consumerRequestId===currentRequestId&&attempt.inputEvidenceId===owner.inputEvidenceId&&attempt.inputFingerprint===owner.inputFingerprint&&attempt.basisEvidenceId===owner.basisRef.evidenceId&&attempt.basisEvidenceDigest===owner.basisRef.evidenceDigest&&attempt.claimGeneration===ownedClaim.generation&&digest(attempt.owner)===digest(target.protectedOwnerCapture));
      const targetDigest=digest(validationTarget);check(attempt.targets.filter(item=>digest(item)===targetDigest).length===1&&validationTarget.sourceExecutionId===original.executionId&&validationTarget.inputFingerprint===inputFingerprint&&validationTarget.outputDigest===(known?digest(known):null));
      const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown}>(`SELECT evidence_id,evidence_digest,protected_evidence_ref,
        CASE WHEN octet_length(protected_observation::text)<=1048576 THEN protected_observation ELSE NULL END AS protected_observation
        FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'attemptId'=$3 LIMIT 2`,[claim.accountId,consumer.executionId,attempt.attemptId])).rows;
      check(rows.length===1);const row=rows[0],wrapper=row.protected_observation as {version?:unknown;accountId?:unknown;executionId?:unknown;inputFingerprint?:unknown;kind?:unknown;value?:unknown}|null;
      check(wrapper&&wrapper.version===1&&wrapper.accountId===consumer.accountId&&wrapper.executionId===consumer.executionId&&wrapper.inputFingerprint===owner.inputFingerprint&&wrapper.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&row.protected_evidence_ref===row.evidence_id&&row.evidence_digest===digest(wrapper)&&digest(wrapper.value)===digest(attempt));
      return {input:original,target,owner:{...owner,validationAttemptRef:{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}},targetDigest};
    },true);
    return {native:ports?ports.forCostOwner(captured.target,captured.owner!,phase,captured.targetDigest):await nativeContextForInput(gateway,db,captured.target,captured.input,phase,currentRequestId,known)};
  }
  async nativeWait(claim:Claim,input:StageInput,phase:NativeExecutionPhase,fault:NativeExecutionFault,known?:Observation,currentRequestId=input.requestId):Promise<void>{
    await this.db.accountTransaction(claim.accountId,async tx=>{
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,currentRequestId])).rows[0];
      requireCondition(request,'INPUT_EVIDENCE_INVALID',409,'WAIT');const original=await storedInput(tx,input.executionId);
      requireCondition(digest(canonicalInput(original))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      await appendNativeExecutionWait(tx,request,original,phase,fault,known);
    },true);
  }
  async nativeContextWait(claim:Claim,input:StageInput,known?:Observation,currentRequestId=input.requestId):Promise<void>{
    await this.db.accountTransaction(claim.accountId,async tx=>{
      requireCondition(claim.accountId===input.accountId&&(claim.kind==='RECONCILE'?claim.ref.executionId===input.executionId:claim.ref.requestId===currentRequestId),'NATIVE_PARENT_FENCE_REJECTED',409,'WAIT');
      const original=await storedInput(tx,input.executionId);
      requireCondition(digest(original)===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,currentRequestId])).rows[0];
      requireCondition(request&&request.context_id===original.contextId&&request.context_generation===original.envelope!.contextGeneration,'NATIVE_PARENT_FENCE_REJECTED',409,'WAIT');
      if(currentRequestId!==original.requestId)requireCondition((await tx.client.query(`SELECT 1 FROM request_steps s JOIN checkpoints c ON c.account_id=s.account_id AND (c.checkpoint_id=s.reuse_checkpoint_id OR (s.reuse_checkpoint_id IS NULL AND c.execution_id=s.current_execution_id))
        WHERE s.account_id=$1 AND s.request_id=$2 AND c.execution_id=$3`,[claim.accountId,currentRequestId,original.executionId])).rowCount,'CHECKPOINT_DEPENDENCY_INVALID',409,'WAIT');
      // SOURCE ACK comes first. Unknown storage acknowledgement aborts the
      // caller before observe/finish. No native WAIT/termination is fabricated.
      if(known)await nativeExecutionSource(tx,original.executionId,known);
      if(await this.claimCurrent(tx,claim)&&!terminal(request.state))await holdNativeExecution(tx,request);
    },true);
  }

  private async checkpointIoCurrent(claim:Claim,input:StageInput):Promise<boolean>{
    if(!this.operationalCost)return true;
    return this.db.accountTransaction(claim.accountId,async tx=>{
      if(input.accountId!==claim.accountId||!await this.claimCurrent(tx,claim))return false;
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,input.requestId])).rows[0];
      if(!request||request.state==='STOP_REQUESTED'||!await this.requestCurrent(tx,await contextRow(tx,request.context_id),request))return false;
      requireCondition(digest(canonicalInput(await storedInput(tx,input.executionId)))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      if((await this.operationalCost!.readIn(tx,input)).basis===null)return false;
      if((await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[claim.accountId,input.executionId])).rowCount)return false;
      return !await this.operationalCost!.hasPendingOtherIn(tx,input.executionId);
    },true);
  }
  private async validateOperationalCheckpoints(claim:Claim,input:StageInput,purpose:CheckpointValidationPurpose):Promise<boolean>{
    const cost=this.operationalCost;if(!cost)return this.validateCheckpoints(claim);
    if(!await this.checkpointIoCurrent(claim,input))return false;
    const attempt=await this.db.accountTransaction(claim.accountId,tx=>cost.checkpoints.beginIn(tx,input,purpose),true);
    const prior=await this.db.accountTransaction(claim.accountId,tx=>cost.checkpoints.lookupIn(tx,input,purpose),true);
    if(prior.state==='VERIFIED')return true;
    // Source INPUT/native captures remain original; this attempt owns new I/O.
    if(!await this.validateCheckpoints(claim,false,input,this.windowsCostPorts()?attempt:undefined))return false;
    return this.db.accountTransaction(claim.accountId,async tx=>{
      const facts=await cost.collectCheckpointIn(tx,input,attempt);if(!facts)return false;
      return (await cost.checkpoints.recordIn(tx,input,attempt,facts)).state==='VERIFIED';
    },true);
  }
  async reconcileOperationalCostIn(tx:Transaction,input:StageInput,createPending=false):Promise<void>{
    const port=this.operationalCost;if(!port)return;
    requireCondition(input.accountId===tx.account.account_id&&digest(canonicalInput(await storedInput(tx,input.executionId)))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    const view=await port.readIn(tx,input),sealed=view.sealedCalculation;
    const record=sealed?view.calculations.find(item=>item.evidenceId===sealed.evidenceId&&item.evidenceDigest===sealed.evidenceDigest):undefined;
    const confirmed=view.state==='CONFIRMED'&&view.costUsd!==null&&record?.result.state==='CONFIRMED'&&record.result.actualUsd===view.costUsd;
    const conflict=view.state==='CONFLICT'||view.state==='CONFIRMED'&&!confirmed;
    // 충돌은 새 비용의 확정 근거가 아니다. 기존 actual은 아래 COALESCE로 보존한다.
    const amount=confirmed?view.costUsd:null;
    if(!createPending&&amount===null&&!conflict)return;
    const usageRef=amount!==null&&record?'execution-evidence:'+record.evidenceId+':'+record.evidenceDigest:null;
    const rateVersion=amount!==null?record?.result.basisVersion??null:null;
    const cost=(await tx.client.query<{cost_item_id:string;actual_usd:string|null;evidence_conflict:boolean;usage_ref:string|null;rate_version:string|null}>(`INSERT INTO cost_items(account_id,cost_item_id,execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at)
      VALUES($1,$2,$3,'STAGE_TOTAL',0,$4,$5,$6,$7,$8) ON CONFLICT(account_id,execution_id,component,ordinal) DO UPDATE
      SET state=CASE WHEN cost_items.state='CONFIRMED' THEN cost_items.state ELSE EXCLUDED.state END,
          actual_usd=COALESCE(cost_items.actual_usd,EXCLUDED.actual_usd),usage_ref=COALESCE(cost_items.usage_ref,EXCLUDED.usage_ref),
          rate_version=COALESCE(cost_items.rate_version,EXCLUDED.rate_version),confirmed_at=COALESCE(cost_items.confirmed_at,EXCLUDED.confirmed_at)
      RETURNING cost_item_id,actual_usd,evidence_conflict,usage_ref,rate_version`,[input.accountId,randomUUID(),input.executionId,amount!==null?'CONFIRMED':'UNCONFIRMED',amount,usageRef,rateVersion,amount!==null?tx.now:null])).rows[0];
    if(conflict||(amount!==null&&cost.actual_usd!==null&&(!new Decimal(cost.actual_usd).equals(amount)||cost.usage_ref!==usageRef||cost.rate_version!==rateVersion)))await tx.client.query('UPDATE cost_items SET evidence_conflict=true WHERE account_id=$1 AND cost_item_id=$2',[input.accountId,cost.cost_item_id]);
    await reconcileExecutionLimits(tx,input.executionId);
  }

  async validateCheckpoints(claim:Claim,metadataOnly=false,consumer?:StageInput,attempt?:CheckpointValidationAttempt):Promise<boolean> {
    // Semantic checkpoint validation may perform native work. Check current
    // ownership, profile and unknown costs before entering those callbacks.
    if(!this.dispatchConfigured())return false;
    const captured=await this.db.accountTransaction(claim.accountId,async tx=>{
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,claim.ref.requestId])).rows[0];if(!request||terminal(request.state)||!await this.claimCurrent(tx,claim))return null;
      if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return null;}
      if(!this.policy.synthetic&&!await this.requestCurrent(tx,await contextRow(tx,request.context_id),request))return null;
      const costs=this.policy.synthetic?[]:await this.pendingCosts(tx,request);
      if(costs.some(cost=>cost.evidence_conflict!==false||cost.state!=='UNCONFIRMED')){await this.updateCostHold(tx,claim,request,true);return null;}
      if(!this.policy.synthetic&&!costs.length&&request.hold_reasons.includes('COST_UNCONFIRMED'))await this.updateCostHold(tx,claim,request,false);
      try {
        const checkpoints=(await tx.client.query<{checkpoint_id:string;execution_id:string;output_envelope:Observation;verification_state:string;ordinal:number;logical_step_id:string;reuse_checkpoint_id:string|null;execution_state:string|null}>(`SELECT c.checkpoint_id,c.execution_id,c.output_envelope,c.verification_state,s.ordinal,s.logical_step_id,s.reuse_checkpoint_id,e.state AS execution_state FROM request_steps s LEFT JOIN executions e ON e.account_id=s.account_id AND e.execution_id=s.current_execution_id JOIN checkpoints c ON c.account_id=s.account_id AND(c.checkpoint_id=s.reuse_checkpoint_id OR(s.reuse_checkpoint_id IS NULL AND c.execution_id=e.execution_id)) WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal`,[claim.accountId,request.request_id])).rows;
        // Cost uncertainty blocks new work, not a fully captured successful result.
        // Conflicts and current owner/native/input safeguards remain mandatory.
        const completed=costs.length>0&&request.captured_stage_order.length>0&&checkpoints.length===request.captured_stage_order.length&&checkpoints.every((checkpoint,ordinal)=>checkpoint.ordinal===ordinal&&checkpoint.logical_step_id===request.captured_stage_order[ordinal]&&checkpoint.verification_state==='VERIFIED'&&checkpoint.output_envelope.outcome==='SUCCESS'&&(checkpoint.reuse_checkpoint_id!==null||checkpoint.execution_state==='SUCCEEDED'));
        if(costs.length&&!completed){await this.updateCostHold(tx,claim,request,true);return null;}
        const verified: {checkpointId:string;outputDigest:string;input:StageInput;observation:Observation}[]=[];
        for(const checkpoint of checkpoints){const input=await storedInput(tx,checkpoint.execution_id);if(!this.boundedInputReady(input))return null;const observation=normalizeObservation(input,checkpoint.output_envelope);requireCondition(observation.outcome==='SUCCESS'&&observation.stageOutput?.checkpointId===checkpoint.checkpoint_id&&digest(observation)===digest(checkpoint.output_envelope),'CHECKPOINT_DEPENDENCY_INVALID');await this.verifyAssets(tx,observation.assetDependencies??[],[...(observation.outputAssetIds??[]),observation.cleanedAssetId,observation.renderAssetId].filter((id):id is string=>!!id));verified.push({checkpointId:checkpoint.checkpoint_id,outputDigest:digest(checkpoint.output_envelope),input,observation});}
        return verified;
      }catch(error){this.rethrowWindowsFailure(error,false,true);await finalizeSafe(tx,request,'FAILED','CHECKPOINT_DEPENDENCY_INVALID');return null;}
    },true);
    if(!captured)return false;
    if(!metadataOnly&&this.provider.validateObservation)for(const item of captured){
      const validationTarget=attempt?.targets.find(target=>target.checkpointId===item.checkpointId&&target.sourceExecutionId===item.input.executionId&&target.outputDigest===item.outputDigest);if(attempt&&!validationTarget)continue;
      if(consumer&&!await this.checkpointIoCurrent(claim,consumer))return false;
      const gateway=this.nativeGateway;let readingContext=false;
      try{readingContext=true;const context=await this.nativeCallContext(claim,item.input,'CHECKPOINT',claim.ref.requestId,item.observation,consumer&&attempt&&validationTarget?{consumer,attempt,target:validationTarget}:undefined);readingContext=false;await this.provider.validateObservation(item.input,item.observation,context);}
      catch(error){if(isWindowsExecutionContextWait(error,gateway)){await this.preserveWindowsContext(claim,item.input,item.observation);return false;}this.rethrowWindowsFailure(error,readingContext,true);if(readingContext&&isLocalLaMaContextReadWait(error,gateway)){await this.nativeContextWait(claim,item.input,item.observation,claim.ref.requestId);throw error;}if(error instanceof NativeJobError){await this.nativeWait(claim,item.input,'CHECKPOINT',error,item.observation,claim.ref.requestId);return false;}
        await this.db.accountTransaction(claim.accountId,async tx=>{if(!await this.claimCurrent(tx,claim))return;const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,claim.ref.requestId])).rows[0];if(request&&!terminal(request.state))await finalizeSafe(tx,request,'FAILED','CHECKPOINT_DEPENDENCY_INVALID');},true);return false;}
    }
    claim.checkpointDigests=Object.fromEntries(captured.map(item=>[item.checkpointId,item.outputDigest]));return true;
  }
  async authorize(claim:Claim):Promise<StageInput|null> {
    if(!this.dispatchConfigured())return null;
    if(!await this.validateCheckpoints(claim,!!this.operationalCost))return null;
    return this.db.accountTransaction(claim.accountId,async(tx)=>{
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,claim.ref.requestId])).rows[0];
      if(!request || terminal(request.state)) return null;
      if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return null;}
      const context=await contextRow(tx,request.context_id);
      const work=(await tx.client.query<WorkRow>('SELECT * FROM work_items WHERE account_id=$1 AND work_item_id=$2',[claim.accountId,claim.workId])).rows[0];
      if(!work || work.state!=='CLAIMED' || work.claim_owner!==this.workerId || work.claim_generation!==claim.generation || !work.lease_until || tx.now>=work.lease_until) return null;
      if(!this.policy.synthetic&&!await this.requestCurrent(tx,context,request))return null;
      const settings=await settingsRow(tx,context,request.settings_revision);
      const steps=(await tx.client.query<{logical_step_id:string;current_execution_id:string|null;reuse_checkpoint_id:string|null;execution_state:string|null;output_envelope:Observation|null;
        checkpoint_id:string|null;origin_execution_id:string|null;origin_request_id:string|null;checkpoint_output:Observation|null;dependency_digest:string|null;stage_contract:string|null;verification_state:string|null}>(
        `SELECT s.logical_step_id,s.current_execution_id,s.reuse_checkpoint_id,e.state AS execution_state,e.output_envelope,c.checkpoint_id,c.execution_id AS origin_execution_id,origin.request_id AS origin_request_id,c.output_envelope AS checkpoint_output,c.dependency_digest,c.stage_contract,c.verification_state
         FROM request_steps s LEFT JOIN executions e ON e.account_id=s.account_id AND e.execution_id=s.current_execution_id
         LEFT JOIN checkpoints c ON c.account_id=s.account_id AND (c.checkpoint_id=s.reuse_checkpoint_id OR(s.reuse_checkpoint_id IS NULL AND c.execution_id=e.execution_id))
         LEFT JOIN executions origin ON origin.account_id=c.account_id AND origin.execution_id=c.execution_id
         WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal`,[claim.accountId,request.request_id])).rows;
      let previous:EditData|null=null;
      let previousObservation:Observation|null=null;
      let cleanedAssetId=request.captured_input.currentCleanedAssetId??null;let renderAssetId=request.captured_input.currentRenderAssetId??null;
      let assetDependencies=request.captured_input.assetDependencies??[];let previousOutputAssetIds:string[]=[];const checkpointDependencies:Checkpoint[]=[];
      let step:typeof steps[number]|undefined;
      const dependency=(stage:string)=>digest({stage,stageOrder:request.captured_stage_order,scope:request.captured_scope,settings,initial:request.captured_input,previous,cleanedAssetId,renderAssetId,assetDependencies,previousOutputAssetIds});
      for(const current of steps) {
        if(current.reuse_checkpoint_id||current.execution_state==='SUCCEEDED') {
          try {
            requireCondition(current.checkpoint_id&&current.origin_execution_id&&current.origin_request_id&&current.verification_state==='VERIFIED'&&current.stage_contract===settings.contractVersion&&current.dependency_digest===dependency(current.logical_step_id)&&current.checkpoint_output?.data&&claim.checkpointDigests?.[current.checkpoint_id]===digest(current.checkpoint_output),'CHECKPOINT_DEPENDENCY_INVALID');
            const priorInput=await storedInput(tx,current.origin_execution_id);const observation=normalizeObservation(priorInput,current.checkpoint_output);
            requireCondition(observation.stageOutput?.checkpointId===current.checkpoint_id&&digest(observation)===digest(current.checkpoint_output)&&digest(priorInput.settings)===digest(settings)&&digest(priorInput.previousData)===digest(previous)&&priorInput.inputDigest===current.dependency_digest,'CHECKPOINT_DEPENDENCY_INVALID');
            await this.verifyAssets(tx,observation.assetDependencies??[],[...(observation.outputAssetIds??[]),observation.cleanedAssetId,observation.renderAssetId].filter((id):id is string=>!!id));
            previous=observation.data;previousObservation=observation;cleanedAssetId=observation.cleanedAssetId??cleanedAssetId;renderAssetId=observation.renderAssetId??renderAssetId;
            assetDependencies=[...new Map([...assetDependencies,...(observation.assetDependencies??[])].map(d=>[d.assetId,d])).values()];previousOutputAssetIds=[...new Set([...previousOutputAssetIds,...(observation.outputAssetIds??[])])];
            checkpointDependencies.push({checkpointId:current.checkpoint_id,originRequestId:current.origin_request_id,originExecutionId:current.origin_execution_id,logicalStepId:current.logical_step_id,stageContract:current.stage_contract,modelContract:['CLEANUP','TYPESET'].includes(current.logical_step_id)?null:settings.contractVersion,inputDigest:priorInput.inputDigest,dependencyDigest:current.dependency_digest,assetIds:observation.outputAssetIds??[]});
            continue;
          } catch {await finalizeSafe(tx,request,'FAILED','CHECKPOINT_DEPENDENCY_INVALID');return null;}
        }
        step=current;break;
      }
      if(!step) {
        if(!this.policy.synthetic&&(await this.pendingCosts(tx,request)).some(cost=>cost.evidence_conflict!==false||cost.state!=='UNCONFIRMED'))return null;
        if(this.operationalCost){
          const last=checkpointDependencies.at(-1);
          if(!last||last.originRequestId!==request.request_id)return null;
          const consumer=await storedInput(tx,last.originExecutionId);
          await this.reconcileOperationalCostIn(tx,consumer);
          if(await this.operationalCost.checkpoints.finalCommitIn(tx,consumer)!=='ELIGIBLE')return null;
          if((await this.operationalCost.readIn(tx,consumer)).state!=='CONFIRMED')return null;
        }
        await this.applyComplete(tx,context,request,previous??request.captured_input.data,previousObservation);await releaseRequestExecutionBudget(tx,request.request_id);return null;
      }
      if(step.current_execution_id && ['DISPATCHING','RUNNING','UNKNOWN'].includes(step.execution_state??'')) {
        await queueWork(tx,'RECONCILE',{executionId:step.current_execution_id});return null;
      }
      if(context.lifecycle==='CLOSED') {await finalizeSafe(tx,request,'STOPPED','CONTEXT_CLOSED_CONFIRMED_SAFE');return null;}
      if(step.execution_state==='FAILED') {await finalizeSafe(tx,request,'FAILED','CONFIRMED_STAGE_FAILURE');return null;}
      const wait=(await tx.client.query<{deadline:Date}>('SELECT deadline FROM provider_wait_rounds WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND closed_at IS NULL',[claim.accountId,request.request_id,step.logical_step_id])).rows[0];
      if(wait && tx.now>=wait.deadline) {await finalizeSafe(tx,request,'STOPPED','PROVIDER_WAIT_EXPIRED');return null;}
      if(!await this.canDispatch(tx,context,request,step.execution_state==='PREPARED'?step.current_execution_id:null)){if((await this.pendingCosts(tx,request)).length)await this.updateCostHold(tx,claim,request,true);return null;}
      const inputDigest=dependency(step.logical_step_id);
      let executionId=step.current_execution_id;
      // An existing INPUT is immutable, including a legacy null cost bound.
      if(executionId&&step.execution_state==='PREPARED'&&(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[claim.accountId,executionId])).rowCount){
        const captured=await storedInput(tx,executionId);requireCondition(captured.inputDigest===inputDigest,'INPUT_EVIDENCE_INVALID',409,'WAIT');
        if(!this.boundedInputReady(captured))return null;
        if(this.operationalCost&&(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[claim.accountId,executionId])).rowCount)return null;
        await tx.client.query("UPDATE executions SET claim_generation=$3 WHERE account_id=$1 AND execution_id=$2 AND state='PREPARED' AND dispatch_attempted_at IS NULL",[claim.accountId,executionId,claim.generation]);
        await this.enrollWindowsInputIn(tx,captured);return {...captured,claimGeneration:claim.generation};
      }
      let costBoundUsd:string|null=null;
      if(request.captured_input.executionLimit){
        const limit=await prepareExecutionLimits(tx,request.request_id);
        if(!limit.allowed){await tx.client.query('UPDATE processing_requests SET hold_reasons=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2',[claim.accountId,request.request_id,JSON.stringify([...new Set([...request.hold_reasons,limit.reason])])]);return null;}
        costBoundUsd=limit.stageBounds?.[step.logical_step_id]?.boundUsd??null;
        requireCondition(costBoundUsd!==null,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
      }
      if(!executionId || step.execution_state==='REJECTED') {
        executionId=randomUUID();
        await tx.client.query(`INSERT INTO executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED',0)`,[claim.accountId,executionId,request.request_id,step.logical_step_id,settings.contractVersion,inputDigest,JSON.stringify(assetDependencies.map(d=>d.assetId)),claim.generation]);
        await tx.client.query('UPDATE request_steps SET current_execution_id=$4,execution_generation=execution_generation+1,revision=revision+1 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[claim.accountId,request.request_id,step.logical_step_id,executionId]);
        if(wait) await tx.client.query('UPDATE provider_wait_rounds SET linked_execution_id=$4 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND closed_at IS NULL',[claim.accountId,request.request_id,step.logical_step_id,executionId]);
      } else await tx.client.query("UPDATE executions SET claim_generation=$3 WHERE account_id=$1 AND execution_id=$2 AND state='PREPARED' AND dispatch_attempted_at IS NULL",[claim.accountId,executionId,claim.generation]);
      const envelope:StageInputEnvelope={executionId,requestId:request.request_id,logicalStepId:step.logical_step_id,contextId:request.context_id,contextGeneration:request.context_generation,pageLineageId:request.page_lineage_id,stageContract:settings.contractVersion,inputDigest,assetIds:assetDependencies.map(d=>d.assetId),regionIds:(previous??request.captured_input.data).blocks.filter(block=>request.captured_scope.kind==='PAGE'||(request.captured_scope.kind==='REGIONS'?request.captured_scope.regionIds.includes(block.regionId):!!request.captured_input.paintInclusion&&painted(block,request.captured_input.paintStrokes??[],request.captured_input.paintInclusion))).map(block=>block.regionId),capturedSettings:settings,checkpointDependencies,costBoundUsd,parameterProfileVersion:request.captured_input.parameterProfileVersion??'synthetic-fixtures-v1'};
      assertWire('stageInputEnvelope',envelope);await this.verifyAssets(tx,assetDependencies);
      const input:StageInput={executionId,requestId:request.request_id,stage:step.logical_step_id,inputDigest,settings,scope:request.captured_scope,accountId:claim.accountId,contextId:request.context_id,claimGeneration:claim.generation,currentCleanedAssetId:cleanedAssetId,currentRenderAssetId:renderAssetId,assetDependencies,previousOutputAssetIds,envelope,
        originalAssetId:request.captured_input.originalAssetId,initialData:request.captured_input.data,previousData:previous,width:request.captured_input.width,height:request.captured_input.height,
        ...(request.captured_input.paintStrokes?{paintStrokes:request.captured_input.paintStrokes,paintInclusion:request.captured_input.paintInclusion}:{})};
      await persistInput(tx,input);await this.enrollWindowsInputIn(tx,input);if(this.operationalCost)await queueWork(tx,'RECONCILE',{executionId:input.executionId},5000);return input;
    },true);
  }
  private async requestCurrent(tx:Transaction,context:ContextRow,request:RequestRow):Promise<boolean> {
    if(terminal(request.state) || tx.account.access_state!=='ACTIVE' || context.lifecycle==='CLOSED' || context.generation!==request.context_generation) return false;
    if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return false;}
    const session=(await tx.client.query<{absolute_expires_at:Date;revoked_at:Date|null;auth_generation:string;binding_state:string}>(`SELECT s.absolute_expires_at,s.revoked_at,s.auth_generation,b.state AS binding_state FROM app_sessions s JOIN login_bindings b USING(account_id,binding_id) WHERE s.account_id=$1 AND s.session_id=$2`,[request.account_id,context.owner_session_id])).rows[0];
    if(!session || session.binding_state!=='ACTIVE' || session.revoked_at || tx.now>=session.absolute_expires_at || session.auth_generation!==tx.account.auth_generation) return false;
    if((await tx.client.query('SELECT 1 FROM connection_rounds WHERE account_id=$1 AND context_id=$2 AND closed_at IS NULL',[context.account_id,context.context_id])).rowCount) return false;
    if(request.state==='STOP_REQUESTED' && !request.first_start_at) return false;
    const page=(await tx.client.query<{result_revision:string;excluded:boolean;request_id:string|null}>(`SELECT p.result_revision,p.excluded,a.request_id FROM workspace_pages p LEFT JOIN active_page_requests a USING(account_id,project_lineage_id,page_lineage_id) WHERE p.account_id=$1 AND p.context_id=$2 AND p.page_lineage_id=$3`,[request.account_id,request.context_id,request.page_lineage_id])).rows[0];
    if(!page || page.excluded || page.result_revision!==request.expected_result_revision || page.request_id!==request.request_id) return false;
    if(!this.dispatchConfigured()||!this.capturedDispatchReady(request))return false;
    return true;
  }
  private async updateCostHold(tx:Transaction,claim:Claim,request:RequestRow,pending:boolean):Promise<void> {
    if(claim.kind!=='DISPATCH'||claim.accountId!==request.account_id||tx.account.account_id!==request.account_id||claim.ref.requestId!==request.request_id)return;
    const current=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,request.request_id])).rows[0];
    if(!current||terminal(current.state)||!await this.claimCurrent(tx,claim)||!await this.requestCurrent(tx,await contextRow(tx,current.context_id),current))return;
    const reasons=pending?[...new Set([...current.hold_reasons,'COST_UNCONFIRMED'])]:current.hold_reasons.filter(reason=>reason!=='COST_UNCONFIRMED');
    if(digest(reasons)!==digest(current.hold_reasons))await tx.client.query('UPDATE processing_requests SET hold_reasons=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2',[current.account_id,current.request_id,JSON.stringify(reasons)]);
    if(pending&&current.state!=='WAITING'&&current.state!=='STOP_REQUESTED')await tx.client.query("UPDATE processing_requests SET state=CASE WHEN state='STOP_REQUESTED' THEN state ELSE 'WAITING' END,revision=revision+1 WHERE account_id=$1 AND request_id=$2",[current.account_id,current.request_id]);
  }
  private async pendingCosts(tx:Transaction,request:RequestRow):Promise<{state:string;evidence_conflict:boolean}[]> {
    return (await tx.client.query<{state:string;evidence_conflict:boolean}>("SELECT state,evidence_conflict FROM cost_items WHERE account_id=$1 AND (state='UNCONFIRMED' OR evidence_conflict)",[request.account_id])).rows;
  }
  async canDispatch(tx:Transaction,context:ContextRow,request:RequestRow,currentExecutionId:string|null=null):Promise<boolean> {
    if(!await this.requestCurrent(tx,context,request))return false;
    if(this.operationalCost&&await this.operationalCost.hasPendingOtherIn(tx,currentExecutionId))return false;
    if((await tx.client.query("SELECT 1 FROM cost_items WHERE account_id=$1 AND (state='UNCONFIRMED' OR evidence_conflict)",[request.account_id])).rowCount) return false;
    if(request.mode==='PAID') {
      const pending=(await tx.client.query('SELECT 1 FROM cost_items c LEFT JOIN settlements s USING(account_id,cost_item_id) WHERE c.account_id=$1 AND s.cost_item_id IS NULL',[request.account_id])).rowCount;
      if(pending || !this.policy.paidEnabled || new Decimal(tx.account.balance_credit).lessThan('10')) return false;
    }
    return true;
  }
  private async preparedInputCurrent(claim:Claim,input:StageInput):Promise<boolean>{
    if(!this.boundedInputReady(input))return false;
    // Read fence after preparation. The opt-in cost path commits INPUT/basis
    // before checkpoint I/O; final preflight retains dispatch admission.
    return this.db.accountTransaction(claim.accountId,async tx=>{
      if(claim.kind!=='DISPATCH'||claim.ref.requestId!==input.requestId||!await this.claimCurrent(tx,claim))return false;
      requireCondition(input.accountId===claim.accountId,'INPUT_EVIDENCE_INVALID',409,'WAIT');
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,input.requestId])).rows[0];
      if(!request||terminal(request.state)||request.context_id!==input.contextId)return false;
      const context=await contextRow(tx,request.context_id);
      if(context.generation!==request.context_generation||input.envelope?.contextGeneration!==request.context_generation)return false;
      const execution=(await tx.client.query<ExecutionRow>('SELECT * FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[claim.accountId,input.executionId])).rows[0];
      const pointer=(await tx.client.query<{current_execution_id:string|null}>('SELECT current_execution_id FROM request_steps WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 FOR UPDATE',[claim.accountId,input.requestId,input.stage])).rows[0];
      if(!execution||execution.state!=='PREPARED'||execution.dispatch_attempted_at!==null||execution.start_confirmed_at!==null||execution.request_id!==input.requestId||execution.logical_step_id!==input.stage||execution.claim_generation!==claim.generation||execution.input_digest!==input.inputDigest||pointer?.current_execution_id!==input.executionId)return false;
      const wait=(await tx.client.query<{deadline:Date}>('SELECT deadline FROM provider_wait_rounds WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND closed_at IS NULL',[claim.accountId,input.requestId,input.stage])).rows[0];
      if(wait&&tx.now>=wait.deadline)return false;
      if(this.operationalCost&&((await this.operationalCost.readIn(tx,input)).basis===null||(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[claim.accountId,input.executionId])).rowCount))return false;
      if(!await this.canDispatch(tx,context,request,input.executionId)){if((await this.pendingCosts(tx,request)).length)await this.updateCostHold(tx,claim,request,true);return false;}
      const original=await storedInput(tx,input.executionId);
      requireCondition(digest(canonicalInput(original))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      return true;
    },true);
  }
  async preflight(claim:Claim,input:StageInput):Promise<boolean> {
    if(!this.boundedInputReady(input))return false;
    return this.db.accountTransaction(claim.accountId,async(tx)=>{
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[claim.accountId,input.requestId])).rows[0];
      if(!request) return false;
      if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return false;}
      const context=await contextRow(tx,request.context_id);
      const execution=(await tx.client.query<ExecutionRow>('SELECT * FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[claim.accountId,input.executionId])).rows[0];
      const work=(await tx.client.query<WorkRow>('SELECT * FROM work_items WHERE account_id=$1 AND work_item_id=$2',[claim.accountId,claim.workId])).rows[0];
      const pointer=(await tx.client.query<{current_execution_id:string|null}>('SELECT current_execution_id FROM request_steps WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[claim.accountId,input.requestId,input.stage])).rows[0];
      const wait=(await tx.client.query<{deadline:Date}>('SELECT deadline FROM provider_wait_rounds WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND closed_at IS NULL',[claim.accountId,input.requestId,input.stage])).rows[0];
      const expired=!!wait && tx.now>=wait.deadline;
      const costReady=!this.operationalCost||((await this.operationalCost.readIn(tx,input)).basis!==null&&!(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[claim.accountId,input.executionId])).rowCount);
      const allowed=!expired && costReady && await this.canDispatch(tx,context,request,input.executionId);
      if(!expired&&!allowed&&(await this.pendingCosts(tx,request)).length)await this.updateCostHold(tx,claim,request,true);
      if(!execution || execution.state!=='PREPARED' || execution.request_id!==input.requestId || pointer?.current_execution_id!==input.executionId || execution.claim_generation!==claim.generation || execution.input_digest!==input.inputDigest || !work || work.state!=='CLAIMED' || work.claim_generation!==claim.generation || work.claim_owner!==this.workerId || !work.lease_until || tx.now>=work.lease_until || !allowed) {
        if(execution?.state==='PREPARED' && execution.claim_generation===claim.generation && !allowed) await tx.client.query("UPDATE executions SET state='REJECTED',safe_error_code='LOCAL_ABORT_BEFORE_TRANSPORT',revision=revision+1 WHERE account_id=$1 AND execution_id=$2",[claim.accountId,input.executionId]);
        if(expired) await finalizeSafe(tx,request,'STOPPED','PROVIDER_WAIT_EXPIRED');
        return false;
      }
      try {requireCondition(digest(await storedInput(tx,input.executionId))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID');}
      catch {await tx.client.query("UPDATE executions SET state='REJECTED',safe_error_code='INPUT_EVIDENCE_INVALID',revision=revision+1 WHERE account_id=$1 AND execution_id=$2 AND state='PREPARED'",[claim.accountId,input.executionId]);await finalizeSafe(tx,request,'FAILED','INPUT_EVIDENCE_INVALID');return false;}
      if(this.policy.executionLimit||request.captured_input.executionLimit){
        const limit=await reserveExecutionLimits(tx,input.executionId,claim.workId,claim.generation,this.workerId,this.policy.executionLimit);
        if(!limit.allowed)await tx.client.query('UPDATE processing_requests SET hold_reasons=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2',[claim.accountId,request.request_id,JSON.stringify([...new Set([...request.hold_reasons,limit.reason])])]);
        return limit.allowed;
      }
      await tx.client.query("UPDATE executions SET state='DISPATCHING',dispatch_attempted_at=$3,revision=revision+1 WHERE account_id=$1 AND execution_id=$2",[claim.accountId,input.executionId,tx.now]);
      return true;
    },true);
  }
  async refreshHolds(tx:Transaction,request:RequestRow):Promise<void> {
    const reasons=request.hold_reasons.filter(reason=>!['COST_UNCONFIRMED','EXECUTION_UNKNOWN','PROVIDER_LIMIT_WAIT'].includes(reason));
    const nativeWaiting=await nativeExecutionWaiting(tx,request);if(nativeWaiting&&!reasons.includes(nativeExecutionHold))reasons.push(nativeExecutionHold);
    if((await tx.client.query("SELECT 1 FROM cost_items c JOIN executions e USING(account_id,execution_id) WHERE e.account_id=$1 AND e.request_id=$2 AND (c.state='UNCONFIRMED' OR c.evidence_conflict)",[request.account_id,request.request_id])).rowCount) reasons.push('COST_UNCONFIRMED');
    if(!nativeWaiting&&(await tx.client.query("SELECT 1 FROM executions WHERE account_id=$1 AND request_id=$2 AND state IN ('DISPATCHING','RUNNING','UNKNOWN')",[request.account_id,request.request_id])).rowCount) reasons.push('EXECUTION_UNKNOWN');
    if((await tx.client.query('SELECT 1 FROM provider_wait_rounds WHERE account_id=$1 AND request_id=$2 AND closed_at IS NULL',[request.account_id,request.request_id])).rowCount) reasons.push('PROVIDER_LIMIT_WAIT');
    await tx.client.query('UPDATE processing_requests SET hold_reasons=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2',[request.account_id,request.request_id,JSON.stringify([...new Set(reasons)])]);
  }
  async started(accountId:string,executionId:string,evidenceId:string,claim?:Claim):Promise<void> {
    await this.observe(accountId,executionId,{evidenceId,outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'START_CONFIRMED',providerRef:executionId,data:null},true,claim);
  }
  async observe(accountId:string,executionId:string,observation:Observation,startOnly=false,claim?:Claim):Promise<void> {
    if(observation.costUsd!==null) money(observation.costUsd);
    const syntheticCost=!this.operationalCost&&this.provider.synthetic===true&&this.policy.synthetic===true;
    await this.db.accountTransaction(accountId,async(tx)=>{
      const execution=(await tx.client.query<ExecutionRow>('SELECT * FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[accountId,executionId])).rows[0];
      requireCondition(execution,'INPUT_INVALID',422);
      if(this.operationalCost)await this.reconcileOperationalCostIn(tx,await storedInput(tx,executionId));
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[accountId,execution.request_id])).rows[0];
      if(observation.outcome==='SUCCESS'&&await nativeExecutionWaiting(tx,request)){
        await nativeExecutionSource(tx,executionId,observation);observation=nativeValidationUnknown(await storedInput(tx,executionId),observation);await holdNativeExecution(tx,request);
      }
      const pointer=(await tx.client.query<{current_execution_id:string|null}>('SELECT current_execution_id FROM request_steps WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[accountId,execution.request_id,execution.logical_step_id])).rows[0];
      const fenced=!claim||(await this.claimCurrent(tx,claim)&&pointer?.current_execution_id===executionId&&(claim.kind!=='DISPATCH'||execution.claim_generation===claim.generation));
      const checkpointId=observation.outcome==='SUCCESS'&&fenced&&!['SUCCEEDED','FAILED','REJECTED'].includes(execution.state)?randomUUID():null;
      if(checkpointId&&observation.stageOutput)observation={...observation,stageOutput:{...observation.stageOutput,checkpointId}};
      const evidenceId=fenced?observation.evidenceId:randomUUID();const kind=fenced?(startOnly?'START':'OUTCOME'):(startOnly?'STALE_START':'STALE_OUTCOME');
      const inserted=await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
        VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT DO NOTHING RETURNING evidence_id`,[accountId,evidenceId,executionId,kind,digest(observation),tx.now,JSON.stringify(observation)]);
      if(!inserted.rowCount){await reconcileExecutionLimits(tx,executionId);return;}
      if(observation.started) {
        if(request.batch_id)await tx.client.query("UPDATE batches SET started_page_ids=CASE WHEN started_page_ids @> $3::jsonb THEN started_page_ids ELSE started_page_ids||$3::jsonb END WHERE account_id=$1 AND batch_id=$2",[accountId,request.batch_id,JSON.stringify([request.page_lineage_id])]);
        await tx.client.query('UPDATE executions SET start_confirmed_at=COALESCE(start_confirmed_at,$3),revision=revision+1 WHERE account_id=$1 AND execution_id=$2',[accountId,executionId,tx.now]);
        await tx.client.query("UPDATE processing_requests SET first_start_at=COALESCE(first_start_at,$3),state=CASE WHEN state IN ('STOP_REQUESTED','COMPLETED','STOPPED','FAILED') THEN state WHEN hold_reasons @> '[\"NATIVE_EXECUTION_UNCONFIRMED\"]'::jsonb THEN 'WAITING' ELSE 'ACTIVE' END,revision=revision+1 WHERE account_id=$1 AND request_id=$2",[accountId,request.request_id,tx.now]);
        if(request.mode==='FREE') {
          const start=await tx.client.query('INSERT INTO free_starts(account_id,request_id,execution_id,confirmed_at,unit_count) VALUES($1,$2,$3,$4,1) ON CONFLICT(account_id,request_id) DO NOTHING RETURNING request_id',[accountId,request.request_id,executionId,tx.now]);
          if(start.rowCount) await tx.client.query('UPDATE accounts SET free_started_count=free_started_count+1,revision=revision+1 WHERE account_id=$1',[accountId]);
          await tx.client.query("UPDATE free_reservations SET state='CONVERTED',revision=revision+1 WHERE account_id=$1 AND request_id=$2 AND state='HELD'",[accountId,request.request_id]);
        }
        await tx.client.query('UPDATE provider_wait_rounds SET closed_at=$4,close_evidence_ref=$5 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND linked_execution_id=$6 AND closed_at IS NULL',[accountId,request.request_id,execution.logical_step_id,tx.now,observation.evidenceId,executionId]);
      }
      if(this.operationalCost)await this.reconcileOperationalCostIn(tx,await storedInput(tx,executionId),true);
      // Preserve raw reported usage/cost in evidence. The existing fixture price
      // basis cannot confirm actual provider/host cost or authorize settlement.
      const confirmed=syntheticCost&&observation.usageConfirmed&&observation.costUsd!==null;
      const local=syntheticCost&&(observation.costBasis==='LOCAL_SYNTHETIC'||['CLEANUP','TYPESET'].includes(execution.logical_step_id));
      const cost=(await tx.client.query<{cost_item_id:string;state:string;actual_usd:string|null;evidence_conflict:boolean}>(`INSERT INTO cost_items(account_id,cost_item_id,execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at)
        VALUES($1,$2,$3,$9,0,$4,$5,$6,$7,$8) ON CONFLICT(account_id,execution_id,component,ordinal) DO UPDATE
        SET state=CASE WHEN cost_items.state='CONFIRMED' THEN cost_items.state ELSE EXCLUDED.state END,
            actual_usd=COALESCE(cost_items.actual_usd,EXCLUDED.actual_usd),usage_ref=COALESCE(cost_items.usage_ref,EXCLUDED.usage_ref),
            rate_version=COALESCE(cost_items.rate_version,EXCLUDED.rate_version),confirmed_at=COALESCE(cost_items.confirmed_at,EXCLUDED.confirmed_at)
        RETURNING cost_item_id,state,actual_usd,evidence_conflict`,[accountId,randomUUID(),executionId,confirmed?'CONFIRMED':'UNCONFIRMED',confirmed?observation.costUsd:null,confirmed?observation.evidenceId:null,confirmed?(local?'synthetic-local-no-external-charge-v1':'synthetic-cost-v1'):null,confirmed?tx.now:null,local?'LOCAL_SYNTHETIC':'STAGE_TOTAL'])).rows[0];
      if(confirmed && cost.actual_usd!==null && !new Decimal(cost.actual_usd).equals(observation.costUsd!)) {
        await tx.client.query('UPDATE cost_items SET evidence_conflict=true WHERE account_id=$1 AND cost_item_id=$2',[accountId,cost.cost_item_id]);
        await reconcileExecutionLimits(tx,executionId);
        await this.refreshHolds(tx,request);await queueWork(tx,'RECONCILE',{executionId},5000);return;
      }
      if(syntheticCost&&cost.state==='CONFIRMED'&&!cost.evidence_conflict)await queueWork(tx,'SETTLE',{costItemId:cost.cost_item_id});
      await reconcileExecutionLimits(tx,executionId);
      if(!fenced){await queueWork(tx,'RECONCILE',{executionId},5000);await this.refreshHolds(tx,request);return;}
      if(startOnly) {
        if(!['SUCCEEDED','FAILED','REJECTED'].includes(execution.state)) await tx.client.query("UPDATE executions SET state='RUNNING' WHERE account_id=$1 AND execution_id=$2",[accountId,executionId]);
        await queueWork(tx,'RECONCILE',{executionId},5000);await this.refreshHolds(tx,request);return;
      }
      const finalAlready=['SUCCEEDED','FAILED','REJECTED'].includes(execution.state);
      if(!finalAlready) {
        const state={SUCCESS:'SUCCEEDED',NOT_STARTED:'REJECTED',FAILURE:'FAILED',UNKNOWN:'UNKNOWN'}[observation.outcome];
        if(observation.outcome==='SUCCESS') requireCondition(observation.data,'INPUT_INVALID',422);
        await tx.client.query('UPDATE executions SET state=$3,provider_ref=COALESCE(provider_ref,$4),output_envelope=$5,finished_confirmed_at=$6,revision=revision+1 WHERE account_id=$1 AND execution_id=$2',[accountId,executionId,state,observation.providerRef,JSON.stringify(observation),state==='UNKNOWN'?null:tx.now]);
        if(observation.outcome==='NOT_STARTED' && observation.finishReason==='RATE_LIMIT') {
          const existing=(await tx.client.query('SELECT 1 FROM provider_wait_rounds WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 AND closed_at IS NULL',[accountId,request.request_id,execution.logical_step_id])).rowCount;
          if(!existing) await tx.client.query('INSERT INTO provider_wait_rounds(account_id,wait_round_id,request_id,logical_step_id,linked_execution_id,started_at,deadline) VALUES($1,$2,$3,$4,$5,$6,$7)',[accountId,randomUUID(),request.request_id,execution.logical_step_id,executionId,tx.now,new Date(tx.now.valueOf()+600000)]);
          if(!terminal(request.state)) await tx.client.query("UPDATE processing_requests SET state=CASE WHEN state='STOP_REQUESTED' THEN state ELSE 'WAITING' END,revision=revision+1 WHERE account_id=$1 AND request_id=$2",[accountId,request.request_id]);
        } else if(observation.outcome==='SUCCESS') {
          const settings=await settingsRow(tx,await contextRow(tx,request.context_id),request.settings_revision);
          await tx.client.query(`INSERT INTO checkpoints(account_id,checkpoint_id,execution_id,stage_contract,dependency_digest,protected_manifest_ref,verification_state,output_envelope)
            VALUES($1,$2,$3,$4,$5,$3::uuid::text,'VERIFIED',$6) ON CONFLICT DO NOTHING`,[accountId,checkpointId??randomUUID(),executionId,settings.contractVersion,execution.input_digest,JSON.stringify(observation)]);
        } else if(observation.outcome==='FAILURE' || observation.outcome==='NOT_STARTED') await finalizeSafe(tx,request,'FAILED','CONFIRMED_STAGE_FAILURE');
      }
      if(observation.outcome==='UNKNOWN' || cost.state==='UNCONFIRMED' || cost.evidence_conflict) await queueWork(tx,'RECONCILE',{executionId},5000);
      await this.refreshHolds(tx,request);
      await releaseRequestExecutionBudget(tx,request.request_id);
    },true);
  }

  private async finishCostAttempt(input:StageInput):Promise<void>{
    const port=this.operationalCost;if(!port)return;
    await port.finishAttempt(structuredClone(input));
    await this.db.accountTransaction(input.accountId!,async tx=>{
      await this.reconcileOperationalCostIn(tx,input);
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[input.accountId,input.requestId])).rows[0];
      if(request)await this.refreshHolds(tx,request);
    },true);
  }

  async reconciled(accountId:string,executionId:string):Promise<boolean> {
    return this.db.accountTransaction(accountId,async(tx)=>{const row=(await tx.client.query<{state:string;pending:boolean;request_id:string}>(`SELECT e.state,e.request_id,EXISTS(SELECT 1 FROM cost_items c WHERE c.account_id=e.account_id AND c.execution_id=e.execution_id AND (c.state='UNCONFIRMED' OR c.evidence_conflict)) AS pending FROM executions e WHERE e.account_id=$1 AND e.execution_id=$2`,[accountId,executionId])).rows[0];
      if(!row)return false;
      if(this.operationalCost){
        const input=await storedInput(tx,executionId);await this.reconcileOperationalCostIn(tx,input);
        const view=await this.operationalCost.readIn(tx,input);if(view.state!=='CONFIRMED'||(await tx.client.query("SELECT 1 FROM cost_items WHERE account_id=$1 AND execution_id=$2 AND (state='UNCONFIRMED' OR evidence_conflict) LIMIT 1",[accountId,executionId])).rowCount)return false;
      }else if(row.pending)return false;
      if(!['SUCCEEDED','FAILED','REJECTED'].includes(row.state)){
        if(!this.operationalCost||row.state!=='PREPARED')return false;
        const ended=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[accountId,row.request_id])).rows[0];if(!ended||!terminal(ended.state))return false;
      }
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[accountId,row.request_id])).rows[0];return !!request&&!await nativeExecutionWaiting(tx,request);},true);
  }
  async settle(accountId:string,costItemId:string):Promise<boolean> {
    // This fixture-only USD-to-credit basis is not an operational price policy.
    // Actual C-cost/credit settlement needs its own captured verified authority.
    if(this.operationalCost||this.provider.synthetic!==true||this.policy.synthetic!==true)return false;
    return this.db.accountTransaction(accountId,async(tx)=>{
      const cost=(await tx.client.query<{state:string;actual_usd:string|null;mode:'FREE'|'PAID';evidence_conflict:boolean}>(`SELECT c.state,c.actual_usd,c.evidence_conflict,r.mode FROM cost_items c JOIN executions e USING(account_id,execution_id)
        JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id WHERE c.account_id=$1 AND c.cost_item_id=$2`,[accountId,costItemId])).rows[0];
      if(!cost || cost.state!=='CONFIRMED' || cost.evidence_conflict || cost.actual_usd===null) return false;
      if((await tx.client.query('SELECT 1 FROM settlements WHERE account_id=$1 AND cost_item_id=$2',[accountId,costItemId])).rowCount) return true;
      const debit=cost.mode==='FREE'?new Decimal(0):new Decimal(cost.actual_usd).mul('10').toDecimalPlaces(12,Decimal.ROUND_HALF_UP);
      const next=new Decimal(tx.account.balance_credit).minus(debit); if(next.isNegative()) return false;
      const ledgerId=cost.mode==='FREE'?null:randomUUID();
      if(ledgerId) {
        await tx.client.query("INSERT INTO ledger_entries(account_id,ledger_entry_id,kind,credit_delta,basis_version,created_at) VALUES($1,$2,'SETTLEMENT',$3,'synthetic-settlement-v1',$4)",[accountId,ledgerId,debit.negated().toFixed(12),tx.now]);
        await tx.client.query('UPDATE accounts SET balance_credit=$2,revision=revision+1 WHERE account_id=$1',[accountId,next.toFixed(12)]);
      }
      await tx.client.query("INSERT INTO settlements(account_id,cost_item_id,ledger_entry_id,debit_credit,mode,basis_version,confirmed_at) VALUES($1,$2,$3,$4,$5,'synthetic-settlement-v1',$6)",[accountId,costItemId,ledgerId,debit.toFixed(12),cost.mode,tx.now]);
      return true;
    },true);
  }
  async applyComplete(tx:Transaction,context:ContextRow,request:RequestRow,data:EditData,observation:Observation|null=null):Promise<void> {
    request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[request.account_id,request.request_id])).rows[0];
    requireCondition(request,'CHECKPOINT_DEPENDENCY_INVALID');
    if((await tx.client.query('SELECT 1 FROM result_applications WHERE account_id=$1 AND request_id=$2',[request.account_id,request.request_id])).rowCount) return;
    context=await contextRow(tx,request.context_id);
    const steps=(await tx.client.query<{logical_step_id:string;ordinal:number;reuse_checkpoint_id:string|null;execution_id:string|null;execution_request_id:string|null;execution_state:string|null;
      execution_stage:string|null;contract_version:string|null;input_digest:string|null;verification_state:string|null;stage_contract:string|null;dependency_digest:string|null}>(
      `SELECT s.logical_step_id,s.ordinal,s.reuse_checkpoint_id,e.execution_id,e.request_id AS execution_request_id,e.state AS execution_state,e.logical_step_id AS execution_stage,e.contract_version,e.input_digest,c.verification_state,c.stage_contract,c.dependency_digest
       FROM request_steps s LEFT JOIN checkpoints c ON c.account_id=s.account_id AND(c.checkpoint_id=s.reuse_checkpoint_id OR(s.reuse_checkpoint_id IS NULL AND c.execution_id=s.current_execution_id))
       LEFT JOIN executions e ON e.account_id=c.account_id AND e.execution_id=c.execution_id
       WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal FOR SHARE OF s`,[request.account_id,request.request_id])).rows;
    requireCondition(steps.length>0&&steps.length===request.captured_stage_order.length&&steps.every((step,ordinal)=>step.ordinal===ordinal&&step.logical_step_id===request.captured_stage_order[ordinal]&&
      step.execution_id&&step.execution_request_id&&step.execution_stage===step.logical_step_id&&step.execution_state==='SUCCEEDED'&&step.verification_state==='VERIFIED'&&
      step.stage_contract===step.contract_version&&step.dependency_digest===step.input_digest&&(step.reuse_checkpoint_id!==null||step.execution_request_id===request.request_id)),'CHECKPOINT_DEPENDENCY_INVALID');
    requireCondition(!(await tx.client.query("SELECT 1 FROM executions WHERE account_id=$1 AND request_id=$2 AND state IN ('DISPATCHING','RUNNING','UNKNOWN') FOR SHARE",[request.account_id,request.request_id])).rowCount,'CHECKPOINT_DEPENDENCY_INVALID');
    if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return;}
    const last=steps[steps.length-1];const originRequestId=last.execution_request_id===request.request_id?null:last.execution_request_id;
    if(this.operationalCost){
      if(originRequestId!==null)return;
      const consumer=await storedInput(tx,last.execution_id!);
      if(await this.operationalCost.checkpoints.finalCommitIn(tx,consumer)!=='ELIGIBLE')return;
      await this.reconcileOperationalCostIn(tx,consumer);
      if((await this.operationalCost.readIn(tx,consumer)).state!=='CONFIRMED'||await this.operationalCost.hasPendingOtherIn(tx,consumer.executionId))return;
    }
    const page=(await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE',[request.account_id,request.context_id,request.page_lineage_id])).rows[0];
    if(!page) return;
    try{const merged=mergeScopedData(request.captured_input.data,data,request.captured_scope,request.captured_input.paintStrokes,request.captured_input.paintInclusion);merged.cleanupQa=data.cleanupQa;if(request.captured_stage_order.includes('TYPESET'))requireCondition(observation?.renderAssetId&&digest(observation.data)===digest(merged),'STAGE_PROPOSAL_INVALID',422);data=merged;validateEditData(data,request.captured_input.width,request.captured_input.height);await this.verifyAssets(tx,observation?.assetDependencies??[],[observation?.cleanedAssetId,observation?.renderAssetId].filter((id):id is string=>!!id));}catch(error){if(!(error instanceof DomainError))throw error;await finalizeSafe(tx,request,'FAILED','STAGE_PROPOSAL_INVALID');return;}
    const applicable=context.lifecycle!=='CLOSED' && context.generation===request.context_generation && page.result_revision===request.expected_result_revision;
    const revision=((await tx.client.query<{revision:string}>('SELECT COALESCE(max(result_revision),0)+1 AS revision FROM results WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id])).rows[0].revision); const resultId=randomUUID();
    await tx.client.query(`INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,cleaned_asset_id,render_asset_id,protected_edit_data_ref,origin,edit_data)
      VALUES($1,$2,$3,$4,$5,$6,$8,$9,$2::uuid::text,'AI_APPLIED',$7)`,[request.account_id,resultId,request.context_id,request.page_lineage_id,revision,request.captured_input.originalAssetId,JSON.stringify(data),observation?.cleanedAssetId??request.captured_input.currentCleanedAssetId??null,observation?.renderAssetId??null]);
    await tx.client.query(`INSERT INTO result_applications(account_id,application_id,request_id,execution_id,result_id,context_id,page_lineage_id,outcome,applied_at,origin_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[request.account_id,randomUUID(),request.request_id,last.execution_id,resultId,request.context_id,request.page_lineage_id,applicable?'APPLIED':'NOT_APPLICABLE',applicable?tx.now:null,originRequestId]);
    if(applicable) {
      const before=await resultRow(tx,page);await invalidateChangedHistory(tx,page,before,data);
      await tx.client.query('UPDATE workspace_pages SET current_result_id=$4,result_revision=$5,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[request.account_id,request.context_id,request.page_lineage_id,resultId,revision]);
      await bumpWorkspace(tx,context);
      await queueWork(tx,'STORE',{resultId});
    }
    await finalizeSafe(tx,request,'COMPLETED','ALL_STAGES_CONFIRMED_SUCCESS');
  }
  private async finishWindowsPublication(claim:Claim,input:StageInput):Promise<boolean>{
    const ports=this.windowsCostPorts();
    if(!ports||!this.operationalCost||claim.kind!=='DISPATCH'||input.accountId!==claim.accountId||claim.ref.requestId!==input.requestId)return false;
    // 이 명목 실패만 거래 밖에서 WAIT로 바꾼다. SQL·COMMIT ACK 오류는 그대로 전달한다.
    const leaseLost=new Error('WINDOWS_PUBLICATION_CLAIM_UNCONFIRMED');
    try{return await this.db.accountTransaction(claim.accountId,async tx=>{
      const live=async()=>!!(await tx.client.query("SELECT 1 FROM work_items WHERE account_id=$1 AND work_item_id=$2 AND kind='DISPATCH' AND state='CLAIMED' AND claim_owner=$3 AND claim_generation=$4 AND target_ref->>'requestId'=$5 AND lease_until>clock_timestamp() FOR UPDATE",[claim.accountId,claim.workId,this.workerId,claim.generation,input.requestId])).rowCount;
      if(tx.account.account_id!==claim.accountId||tx.account.access_state!=='ACTIVE'||!await live())return false;
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[claim.accountId,input.requestId])).rows[0];
      if(!request||request.context_id!==input.contextId||request.context_generation!==input.envelope?.contextGeneration||request.page_lineage_id!==input.envelope?.pageLineageId||request.captured_stage_order.at(-1)!==input.stage)return false;
      const context=await contextRow(tx,request.context_id);
      const page=(await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE',[claim.accountId,request.context_id,request.page_lineage_id])).rows[0];
      if(!page)return false;
      // 재시도마다 원 INPUT과 마지막 단계·generation을 다시 읽는다.
      const original=await storedInput(tx,input.executionId);
      requireCondition(digest(canonicalInput(original))===digest(canonicalInput(input)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      await this.windowsInputRefIn(tx,original,ports);
      if(!this.boundedInputReady(original))return false;
      const execution=(await tx.client.query<ExecutionRow>('SELECT * FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[claim.accountId,original.executionId])).rows[0];
      const step=(await tx.client.query<{current_execution_id:string|null;reuse_checkpoint_id:string|null;ordinal:number}>('SELECT current_execution_id,reuse_checkpoint_id,ordinal FROM request_steps WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3 FOR UPDATE',[claim.accountId,request.request_id,original.stage])).rows[0];
      if(!execution||execution.request_id!==request.request_id||execution.logical_step_id!==original.stage||execution.claim_generation!==claim.generation||execution.input_digest!==original.inputDigest||execution.state!=='SUCCEEDED'||
        step?.current_execution_id!==original.executionId||step.reuse_checkpoint_id!==null||step.ordinal!==request.captured_stage_order.length-1)return false;
      const raw=execution.output_envelope;
      if(!raw||raw.outcome!=='SUCCESS'||!raw.data||!raw.stageOutput?.checkpointId)return false;
      const observation=normalizeObservation(original,raw),outputDigest=digest(raw);
      if(digest(observation)!==outputDigest)return false;
      const evidence=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:Observation}>("SELECT evidence_id,evidence_digest,protected_evidence_ref,protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME' AND evidence_id=$3",[claim.accountId,original.executionId,observation.evidenceId])).rows;
      if(evidence.length!==1||evidence[0].evidence_id!==observation.evidenceId||evidence[0].protected_evidence_ref!==evidence[0].evidence_id||evidence[0].evidence_digest!==outputDigest||digest(evidence[0].protected_observation)!==outputDigest)return false;
      const checkpoint=(await tx.client.query<{checkpoint_id:string;execution_id:string;stage_contract:string;dependency_digest:string;verification_state:string;output_envelope:Observation}>('SELECT checkpoint_id,execution_id,stage_contract,dependency_digest,verification_state,output_envelope FROM checkpoints WHERE account_id=$1 AND execution_id=$2 AND checkpoint_id=$3',[claim.accountId,original.executionId,observation.stageOutput!.checkpointId])).rows;
      if(checkpoint.length!==1||checkpoint[0].checkpoint_id!==observation.stageOutput!.checkpointId||checkpoint[0].execution_id!==original.executionId||checkpoint[0].verification_state!=='VERIFIED'||
        checkpoint[0].stage_contract!==original.settings.contractVersion||checkpoint[0].dependency_digest!==original.inputDigest||digest(checkpoint[0].output_envelope)!==outputDigest)return false;
      const application=async()=> (await tx.client.query<{execution_id:string;result_id:string;outcome:string;request_state:string}>('SELECT a.execution_id,a.result_id,a.outcome,q.state AS request_state FROM result_applications a JOIN processing_requests q ON q.account_id=a.account_id AND q.request_id=a.request_id JOIN results r ON r.account_id=a.account_id AND r.result_id=a.result_id AND r.context_id=a.context_id AND r.page_lineage_id=a.page_lineage_id WHERE a.account_id=$1 AND a.request_id=$2 AND a.context_id=$3 AND a.page_lineage_id=$4',[claim.accountId,request.request_id,request.context_id,request.page_lineage_id])).rows;
      const existing=await application();
      if(existing.length){
        if(existing.length!==1||existing[0].execution_id!==original.executionId||existing[0].outcome!=='APPLIED'||existing[0].request_state!=='COMPLETED')return false;
        // 이미 저장된 같은 원 적용을 읽을 뿐 새 결과·STORE·비용을 만들지 않는다.
        if(!await live())throw leaseLost;
        return true;
      }
      if(request.state==='STOP_REQUESTED'||terminal(request.state)||request.hold_reasons.length)return false;
      if(!await this.requestCurrent(tx,context,request)){if(!await live())throw leaseLost;return false;}
      // FINAL·원 consumer 비용·전체 단계·자산·범위 검증은 기존 적용 경로가 소유한다.
      await this.applyComplete(tx,context,request,observation.data!,observation);
      const applied=await application();
      const done=applied.length===1&&applied[0].execution_id===original.executionId&&applied[0].outcome==='APPLIED'&&applied[0].request_state==='COMPLETED';
      if(done)await releaseRequestExecutionBudget(tx,request.request_id);
      // 모든 publication·STORE·예산 쓰기 뒤 마지막 DB 판정이다.
      // false를 반환해 부분 쓰기를 COMMIT하지 않으며 tx.now를 재사용하지 않는다.
      if(!await live())throw leaseLost;
      return done;
    },true);}catch(error){if(error===leaseLost)return false;throw error;}
  }

  async validated(input:StageInput,observation:Observation,claim?:Claim):Promise<Observation> {
    if(observation.nativeFailure)return nativeValidationUnknown(input,observation,observation.nativeFailure);
    const gateway=this.nativeGateway;let readingContext=false,readingAssets=false;
    try {const normalized=normalizeObservation(input,observation);if(normalized.outcome==='SUCCESS'){readingAssets=true;await this.db.accountTransaction(input.accountId!,tx=>this.verifyAssets(tx,normalized.assetDependencies??[],[...(normalized.outputAssetIds??[]),normalized.cleanedAssetId,normalized.renderAssetId].filter((id):id is string=>!!id)),true);readingAssets=false;if(this.provider.validateObservation){readingContext=!!claim;const context=claim?await this.nativeCallContext(claim,input,'VALIDATION',input.requestId,observation):undefined;readingContext=false;await this.provider.validateObservation(input,observation,context);}}return normalized;}
    catch(error){if(isWindowsExecutionContextWait(error,gateway)){if(claim)await this.preserveWindowsContext(claim,input,observation);return nativeValidationUnknown(input,observation);}this.rethrowWindowsFailure(error,readingContext,readingAssets);if(readingContext&&isLocalLaMaContextReadWait(error,gateway)){
        if(claim)await this.nativeContextWait(claim,input,observation);
        return nativeValidationUnknown(input,observation);
      }if(error instanceof NativeJobError){if(claim)await this.nativeWait(claim,input,'VALIDATION',error,observation);return nativeValidationUnknown(input,observation,error);}
      const failure:Observation={...observation,outcome:'FAILURE',data:null,...(observation.outcome==='SUCCESS'?{providerOutcome:'SUCCESS' as const}:{}),finishReason:'STAGE_PROPOSAL_INVALID',outputAssetIds:[],assetDependencies:[]};delete failure.cleanedAssetId;delete failure.renderAssetId;delete failure.cleanup;delete failure.stageOutput;return {...failure,stageOutput:outputEnvelope(input,failure)};}
  }
  async runOnce():Promise<boolean> {
    const claim=await this.claim();if(!claim) return false;
    await sweepAccount(this.db,claim.accountId);
    if(claim.kind==='BATCH'){const done=await this.db.accountTransaction(claim.accountId,tx=>advanceBatch(tx,claim.ref.batchId,this.policy),true);await this.finish(claim,done,done?0:500);return true;}
    if(claim.kind==='SETTLE') {const done=await this.settle(claim.accountId,claim.ref.costItemId);await this.finish(claim,done,done?0:5000);return true;}
    const ports=this.windowsCostPorts();return ports?this.runWindowsClaim(claim,ports):this.runStageClaim(claim);
  }

  private async runWindowsClaim(claim:Claim,ports:WindowsExecutionCostPorts):Promise<boolean>{
    let input:StageInput|null=null,costAttempted=false,acceptRenewal=true,renewalFailed=false,timer:ReturnType<typeof setInterval>|undefined;
    const renewals=new Set<Promise<void>>(),errors:unknown[]=[];let result=false,finishIntent:{done:boolean;delay:number}|null=null;
    const start=(value:StageInput)=>{input=value;if(timer)return;timer=setInterval(()=>{
      if(!acceptRenewal)return;const pending=this.renew(claim).then(ok=>{if(!ok){renewalFailed=true;try{ports.unconfirmed();}catch(error){errors.push(error);}}},error=>{errors.push(error);});
      renewals.add(pending);void pending.finally(()=>renewals.delete(pending));
    },this.hooks.heartbeatMilliseconds??10000);};
    const lifetime={ports,start,costFinishing:()=>{costAttempted=true;},finish:async(done:boolean,delay=0)=>{finishIntent={done,delay};}};
    try{result=await this.runStageClaim(claim,lifetime);}catch(error){errors.unshift(error);}
    finally{
      try{if(input&&!costAttempted){costAttempted=true;await this.finishCostAttempt(input);}}catch(error){errors.push(error);}
      acceptRenewal=false;await Promise.allSettled([...renewals]);
      try{if(!errors.length&&!renewalFailed&&input&&claim.kind==='DISPATCH'&&await this.finishWindowsPublication(claim,input))finishIntent={done:true,delay:0};}catch(error){errors.push(error);}
      try{
        const intent=finishIntent as {done:boolean;delay:number}|null;
        if(input||intent)await this.finish(claim,errors.length||renewalFailed?false:intent?.done??false,errors.length||renewalFailed?5000:intent?.delay??5000);
      }catch(error){errors.push(error);}
      finally{if(timer)clearInterval(timer);}
    }
    if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'WINDOWS_EXECUTION_ATTEMPT_UNCONFIRMED');return result;
  }

  private async runStageClaim(claim:Claim,windows?:{ports:WindowsExecutionCostPorts;start(input:StageInput):void;costFinishing():void;finish(done:boolean,delay?:number):Promise<void>}):Promise<boolean>{
    const finish=(done:boolean,...delay:[]|[number])=>windows?windows.finish(done,...delay):this.finish(claim,done,...delay);
    if(claim.kind==='RECONCILE') {
      let input:StageInput|null=null,costFinished=false;
      const renewal=windows?undefined:setInterval(()=>{void this.renew(claim).catch(()=>false);},this.hooks.heartbeatMilliseconds??10000);try {
        let observed:Observation|null=null;
        const gateway=this.nativeGateway;let readingContext=false;
        try{
          input=await this.db.accountTransaction(claim.accountId,tx=>storedInput(tx,claim.ref.executionId),true);windows?.start(input);
          if(this.operationalCost){
            const ready=await this.db.accountTransaction(claim.accountId,async tx=>{await this.reconcileOperationalCostIn(tx,input!);const view=await this.operationalCost!.readIn(tx,input!);const execution=(await tx.client.query<ExecutionRow>('SELECT * FROM executions WHERE account_id=$1 AND execution_id=$2',[claim.accountId,input!.executionId])).rows[0];return {basis:view.basis!==null,closed:(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[claim.accountId,input!.executionId])).rowCount!==0,terminal:!!execution&&['SUCCEEDED','FAILED','REJECTED','PREPARED'].includes(execution.state)};},true);
            if(!ready.basis||ready.closed||ready.terminal){windows?.costFinishing();await this.finishCostAttempt(input);costFinished=true;const done=ready.basis&&await this.reconciled(claim.accountId,input.executionId);await finish(done,done?0:5000);return true;}
          }
          const blocked=await this.db.accountTransaction(claim.accountId,async tx=>{const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[claim.accountId,input!.requestId])).rows[0];if(!request)return true;if(await nativeExecutionWaiting(tx,request)){await holdNativeExecution(tx,request);return true;}return false;},true);
          if(blocked){await finish(false,5000);return true;}
          if(windows)await this.activateWindowsRoot(claim,input,windows.ports);readingContext=true;const context=await this.nativeCallContext(claim,input,'LOOKUP');readingContext=false;observed=await this.provider.lookup(claim.ref.executionId,input,context);
          if(observed?.nativeFailure)await this.nativeWait(claim,input,'LOOKUP',observed.nativeFailure,observed);
        }catch(error){if(isWindowsExecutionContextWait(error,gateway)){await finish(false,5000);return true;}if(windows)throw error;if(readingContext&&isLocalLaMaContextReadWait(error,gateway)){if(input)await this.nativeContextWait(claim,input);throw error;}if(error instanceof NativeJobError&&input){await this.nativeWait(claim,input,'LOOKUP',error);await finish(false,5000);return true;}observed=null;}
        if(observed&&input)await this.observe(claim.accountId,claim.ref.executionId,await this.validated(input,observed,claim),false,claim);
        const done=await this.reconciled(claim.accountId,claim.ref.executionId);await finish(done,done?0:5000);return true;
      } finally {if(renewal)clearInterval(renewal);if(!windows&&input&&!costFinished)await this.finishCostAttempt(input);}
    }
    const input=await this.authorize(claim);
    if(!input) {
      const state=await this.db.accountTransaction(claim.accountId,async(tx)=>(await tx.client.query<{state:string}>('SELECT state FROM processing_requests WHERE account_id=$1 AND request_id=$2',[claim.accountId,claim.ref.requestId])).rows[0]?.state,true);
      await finish(!state || terminal(state),5000);return true;
    }
    windows?.start(input);
    try {
    if(this.operationalCost)await this.operationalCost.prepare(structuredClone(input),{generation:claim.generation,ownerId:this.workerId,workItemId:claim.workId});
    if(windows)await this.activateWindowsRoot(claim,input,windows.ports);
    if(this.hooks.beforeValidateInput){
      // authorize has acknowledged the committed INPUT. Give the private
      // preparation port separate owned data; its return value has no authority.
      // Its error (including an unknown basis COMMIT ACK) must not become an
      // input-validation failure or erase the original committed evidence.
      await this.hooks.beforeValidateInput(structuredClone(input),{generation:claim.generation,ownerId:this.workerId,workItemId:claim.workId});
      if(!await this.preparedInputCurrent(claim,input)){await finish(false,5000);return true;}
    }
    if(this.operationalCost){
      if(!await this.preparedInputCurrent(claim,input)||!await this.validateOperationalCheckpoints(claim,input,'PRE_DISPATCH')||!await this.preparedInputCurrent(claim,input)){await finish(false,5000);return true;}
    }
    const inputGateway=this.nativeGateway;let readingInputContext=false;
    try{if(this.provider.validateInput){readingInputContext=true;const context=await this.nativeCallContext(claim,input,'INPUT');readingInputContext=false;await this.provider.validateInput(input,context);}}
    catch(error){if(isWindowsExecutionContextWait(error,inputGateway)){await finish(false,5000);return true;}this.rethrowWindowsFailure(error,readingInputContext);if(readingInputContext&&isLocalLaMaContextReadWait(error,inputGateway)){await this.nativeContextWait(claim,input);throw error;}if(error instanceof NativeJobError){await this.nativeWait(claim,input,'INPUT',error);await finish(false,5000);return true;}
      await this.db.accountTransaction(claim.accountId,async tx=>{if(await this.claimCurrent(tx,claim)){const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[claim.accountId,input.requestId])).rows[0];await finalizeSafe(tx,request,'FAILED','INPUT_DEPENDENCY_INVALID');}},true);await finish(true);return true;}
    if(this.hooks.afterPrepare) await this.hooks.afterPrepare(input);
    if(!await this.preflight(claim,input)) {await finish(false,5000);return true;}
    const renewal=windows?undefined:setInterval(()=>{void this.renew(claim).catch(()=>false);},this.hooks.heartbeatMilliseconds??10000);
    try {
      let observation:Observation;
      const dispatchGateway=this.nativeGateway;let readingDispatchContext=false;
      try {readingDispatchContext=true;const context=await this.nativeCallContext(claim,input,'DISPATCH');readingDispatchContext=false;observation=await this.provider.dispatch(input,(evidenceId)=>this.started(claim.accountId,input.executionId,evidenceId,claim),context);}
      catch(error){if(isWindowsExecutionContextWait(error,dispatchGateway)){await finish(false,5000);return true;}this.rethrowWindowsFailure(error,readingDispatchContext);if(readingDispatchContext&&isLocalLaMaContextReadWait(error,dispatchGateway)){await this.nativeContextWait(claim,input);throw error;}if(error instanceof NativeJobError){await this.nativeWait(claim,input,'DISPATCH',error);await finish(false,5000);return true;}observation=unknownObservation();}
      if(observation.nativeFailure)await this.nativeWait(claim,input,'DISPATCH',observation.nativeFailure,observation);
      observation=await this.validated(input,observation,claim);
      if(this.hooks.afterDispatch) await this.hooks.afterDispatch(input);
      await this.observe(claim.accountId,input.executionId,observation,false,claim);
      if(this.operationalCost&&observation.outcome==='SUCCESS'){
        const final=await this.db.accountTransaction(claim.accountId,async tx=>{const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[claim.accountId,input.requestId])).rows[0];return request?.captured_stage_order.at(-1)===input.stage;},true);
        if(final)await this.validateOperationalCheckpoints(claim,input,'FINAL_COMMIT');
      }
      await finish(false,observation.outcome==='NOT_STARTED'?(observation.retryAfterMilliseconds??5000):observation.outcome==='UNKNOWN'?5000:0);
      return true;
    }finally{if(renewal)clearInterval(renewal);}
    }finally{if(!windows)await this.finishCostAttempt(input);}
  }
}
