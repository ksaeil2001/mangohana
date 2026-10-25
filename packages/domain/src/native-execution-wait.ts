import {randomUUID} from 'node:crypto';
import {digest} from '../../contracts/src/intent.js';
import type {Transaction} from '../../storage/src/database.js';
import type {NativeTermination} from '../../native/src/dto.js';
import type {RequestRow} from './model.js';
import {canonicalInput,outputEnvelope,type StageInput,type Observation} from './provider.js';

export const nativeExecutionHold='NATIVE_EXECUTION_UNCONFIRMED';
export type NativeExecutionPhase='INPUT'|'CHECKPOINT'|'VALIDATION'|'LOOKUP'|'DISPATCH';
export type NativeExecutionFault={code:string;termination:Readonly<NativeTermination>};
export type NativeExecutionWaitEvidence={version:1;phase:NativeExecutionPhase;currentRequestId:string;originExecutionId:string;inputDigest:string;inputFingerprint:string;errorCode:string;termination:NativeTermination;knownObservationDigest:string|null;knownObservationRef:string|null};

export function nativeExecutionCaptureDigest(phase:NativeExecutionPhase,currentRequestId:string,input:StageInput,observation?:Observation):string{
  return digest({version:1,phase,currentRequestId,originExecutionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),outputDigest:observation?digest(observation):null});
}

// Calculation completion is separate from capacity release, cost and publication.
// Successful native jobs remain unresolved in 0013 and must not hold a request
// merely because that release authority has not been implemented yet.
export async function nativeExecutionWaiting(tx:Transaction,request:RequestRow):Promise<boolean>{
  if(request.hold_reasons.includes(nativeExecutionHold))return true;
  // 원 DB finish의 불변 관측을 비교한다. 종류별 두 행까지만 읽어 중복을 거부한다.
  const pending=await tx.client.query(`SELECT 1 FROM native_job_intents i WHERE i.account_id=$1 AND
    ((i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=$2::uuid) OR
      (i.target_kind='EXECUTION' AND EXISTS(SELECT 1 FROM executions e WHERE e.account_id=i.account_id AND e.execution_id=i.target_id AND
        (e.request_id=$2::uuid OR EXISTS(SELECT 1 FROM request_steps s WHERE s.account_id=e.account_id AND s.request_id=$2::uuid AND s.current_execution_id=e.execution_id))))) AND
    (EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='ERROR') OR
      CASE WHEN EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND
        (o.protected_observation->'version' IS DISTINCT FROM '1'::jsonb OR o.protected_observation ? 'windowsRecordRef' OR
          o.protected_observation->'termination'->>'isolation'='WINDOWS_JOB_OBJECT' OR o.protected_observation->'termination'->>'kind'='WINDOWS_JOB_EMPTY'))
      THEN NOT EXISTS(
        SELECT 1 FROM
          (SELECT count(*) n,(jsonb_agg(o.protected_observation))->0 body,(array_agg(o.parent_instance_id))[1] parent_id,(array_agg(o.observation_digest))[1] seal
           FROM (SELECT protected_observation,parent_instance_id,observation_digest FROM native_job_observations WHERE account_id=i.account_id AND job_id=i.job_id AND event='RESULT' LIMIT 2) o) r
          CROSS JOIN
          (SELECT count(*) n,(jsonb_agg(o.protected_observation))->0 body,(array_agg(o.parent_instance_id))[1] parent_id,(array_agg(o.observation_digest))[1] seal
           FROM (SELECT protected_observation,parent_instance_id,observation_digest FROM native_job_observations WHERE account_id=i.account_id AND job_id=i.job_id AND event='TERMINATION' LIMIT 2) o) t
        WHERE r.n=1 AND t.n=1 AND r.parent_id=i.parent_instance_id AND t.parent_id=i.parent_instance_id
          AND r.body->'version'='2'::jsonb AND t.body->'version'='2'::jsonb
          AND r.body->>'event'='RESULT' AND t.body->>'event'='TERMINATION'
          AND r.body->>'code'='OK' AND t.body->>'code'='OK'
          AND r.body->'parentInstanceId'=to_jsonb(i.parent_instance_id::text) AND t.body->'parentInstanceId'=to_jsonb(i.parent_instance_id::text)
          AND r.body->'termination'=t.body->'termination'
          AND r.body->'termination'->'jobId'=to_jsonb(i.job_id::text)
          AND r.body->'termination'->'inputDigest'=to_jsonb(i.input_digest)
          AND r.body->'termination'->'profileDigest'=to_jsonb(i.profile_digest)
          AND r.body->'termination' @> '{"isolation":"WINDOWS_JOB_OBJECT","kind":"WINDOWS_JOB_EMPTY","goAttempted":true,"startedComputation":true,"directChildClosed":true,"subtreeTerminationConfirmed":true,"operationJoined":true}'::jsonb
          AND (r.body->'termination')-ARRAY['jobId','inputDigest','profileDigest','isolation','kind','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined']='{}'::jsonb
          AND jsonb_typeof(r.body->'resultDigest')='string' AND r.body->>'resultDigest'~'^[a-f0-9]{64}$' AND t.body->'resultDigest'='null'::jsonb
          AND r.body->'windowsRecordRef'=t.body->'windowsRecordRef' AND jsonb_typeof(r.body->'windowsRecordRef')='object'
          AND r.body->'windowsRecordRef' ?& ARRAY['recordId','recordDigest']
          AND (r.body->'windowsRecordRef')-ARRAY['recordId','recordDigest']='{}'::jsonb
          AND jsonb_typeof(r.body->'windowsRecordRef'->'recordId')='string'
          AND r.body->'windowsRecordRef'->>'recordId'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
          AND jsonb_typeof(r.body->'windowsRecordRef'->'recordDigest')='string'
          AND r.body->'windowsRecordRef'->>'recordDigest'~'^[a-f0-9]{64}$'
          AND r.body-ARRAY['version','parentInstanceId','event','code','resultDigest','termination','windowsRecordRef']='{}'::jsonb
          AND t.body-ARRAY['version','parentInstanceId','event','code','resultDigest','termination','windowsRecordRef']='{}'::jsonb
          AND r.seal=encode(sha256(convert_to(r.body::text,'UTF8')),'hex') AND t.seal=encode(sha256(convert_to(t.body::text,'UTF8')),'hex'))
      ELSE
        NOT EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='RESULT') OR
        NOT EXISTS(SELECT 1 FROM native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='TERMINATION' AND
          o.protected_observation->'termination'->>'operationJoined'='true' AND
          ((o.protected_observation->'termination'->>'kind'='NO_CHILD_CREATED' AND o.protected_observation->'termination'->>'goAttempted'='false') OR
           (o.protected_observation->'termination'->>'directChildClosed'='true' AND o.protected_observation->'termination'->>'kind' IN ('DIRECT_CHILD_ONLY','CGROUP_EMPTY'))))
      END)
    LIMIT 1`,[request.account_id,request.request_id]);
  return !!pending.rowCount;
}

export async function holdNativeExecution(tx:Transaction,request:RequestRow,stopRequested=false):Promise<void>{
  const reasons=[...new Set([...request.hold_reasons,nativeExecutionHold])];
  await tx.client.query(`UPDATE processing_requests SET state=CASE WHEN state IN ('COMPLETED','STOPPED','FAILED') THEN state WHEN state='STOP_REQUESTED' OR $4 THEN 'STOP_REQUESTED' ELSE 'WAITING' END,
    hold_reasons=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2`,[request.account_id,request.request_id,JSON.stringify(reasons),stopRequested]);
  request.hold_reasons=reasons;if(!['COMPLETED','STOPPED','FAILED'].includes(request.state))request.state=stopRequested||request.state==='STOP_REQUESTED'?'STOP_REQUESTED':'WAITING';
}

// A SOURCE retains the original protected observation, including its evidence ID
// and exact digest. It grants no provider outcome, checkpoint or publication.
export async function nativeExecutionSource(tx:Transaction,executionId:string,known:Observation):Promise<{id:string;digest:string}>{
  const knownDigest=digest(known);let id=(await tx.client.query<{evidence_id:string}>('SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_digest=$3 ORDER BY received_at,evidence_id LIMIT 1',[tx.account.account_id,executionId,knownDigest])).rows[0]?.evidence_id;
  if(!id){id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
    VALUES($1,$2,$3,'NATIVE_VALIDATION_SOURCE',$4,$2::uuid::text,$5,$6)`,[tx.account.account_id,id,executionId,knownDigest,tx.now,JSON.stringify(known)]);}
  return {id,digest:knownDigest};
}
export async function appendNativeExecutionWait(tx:Transaction,request:RequestRow,input:StageInput,phase:NativeExecutionPhase,fault:NativeExecutionFault,known?:Observation):Promise<void>{
  const knownObservationDigest=known?digest(known):null;let knownObservationRef:string|null=null;
  if(known)knownObservationRef=(await nativeExecutionSource(tx,input.executionId,known)).id;
  const evidence:NativeExecutionWaitEvidence={version:1,phase,currentRequestId:request.request_id,originExecutionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),errorCode:fault.code,termination:structuredClone(fault.termination),knownObservationDigest,knownObservationRef};
  const evidenceDigest=digest(evidence);
  if(!(await tx.client.query("SELECT 1 FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='NATIVE_VALIDATION_WAIT' AND evidence_digest=$3",[request.account_id,input.executionId,evidenceDigest])).rowCount){
    const evidenceId=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
      VALUES($1,$2,$3,'NATIVE_VALIDATION_WAIT',$4,$2::uuid::text,$5,$6)`,[request.account_id,evidenceId,input.executionId,evidenceDigest,tx.now,JSON.stringify(evidence)]);
  }
  await holdNativeExecution(tx,request);
}

export function nativeValidationUnknown(input:StageInput,known:Observation,fault?:NativeExecutionFault):Observation{
  const captured=fault??known.nativeFailure;
  const waiting:Observation={...known,evidenceId:randomUUID(),outcome:'UNKNOWN',data:null,outputAssetIds:[],assetDependencies:[],finishReason:nativeExecutionHold,
    ...(known.outcome==='SUCCESS'||known.providerOutcome==='SUCCESS'?{providerOutcome:'SUCCESS' as const}:{}),...(captured?{nativeFailure:{code:captured.code,termination:Object.freeze(structuredClone(captured.termination))}}:{})};
  delete waiting.cleanedAssetId;delete waiting.renderAssetId;delete waiting.cleanup;delete waiting.renderLayout;delete waiting.stageOutput;
  return {...waiting,stageOutput:outputEnvelope(input,waiting)};
}
