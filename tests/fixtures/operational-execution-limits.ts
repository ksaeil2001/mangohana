// 모든 수치·ID·측정 내역은 격리 검사 자료이며 실제 측정이나 운영 발급이 아니다.
import {randomUUID} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/intent.js';
import type {OperationalLimitIdentity,OperationalLimitProfile,OperationalMeasurement} from '../../packages/domain/src/operational-execution-limits.js';
export function operationalLimitFixture(now=new Date('2026-10-15T00:00:00.000Z'),identityOverride:Partial<OperationalLimitIdentity>={}){
  const identity:OperationalLimitIdentity={profileVersion:'p01b-fixture-v1',mediaProfileDigest:sha256('fixture-media'),environmentDigest:sha256('fixture-environment'),pipelineDigest:sha256('fixture-pipeline'),...identityOverride};
  const window={kind:'OPERATOR_EXPLICIT_WINDOW_V1' as const,policyId:'fixture-window-v1',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+7200000).toISOString()};
  const runs:OperationalMeasurement['runs']=(['OCR','TRANSLATE','CLEANUP','TYPESET'] as const).map(stage=>({
    stage,accountId:randomUUID(),requestId:randomUUID(),executionId:randomUUID(),inputDigest:sha256('fixture-input-'+stage),
    startEvidenceId:randomUUID(),endEvidenceId:randomUUID(),startedAt:new Date(now.valueOf()-2000).toISOString(),endedAt:new Date(now.valueOf()-1000).toISOString(),
    elapsedMilliseconds:1000,peakMemoryBytes:1024,costs:[{component:'FULL_PROCESS',unit:'CALL',quantity:'1',actualUsd:'0.01',basisVersion:'fixture-cost-v1',evidenceId:randomUUID()}],actualUsd:'0.01',boundUsd:'0.02'
  }));
  const measurement:OperationalMeasurement={kind:'EXECUTION_LIMIT_MEASUREMENT_V1',identity,runs,fullProcess:{boundUsd:'0.1',retryAllowanceUsd:'0.01',sharedAllowanceUsd:'0.01',evidenceIds:[randomUUID()]},policy:{maxSlots:1,requestLimitUsd:'0.2',dailyLimitUsd:'1',window}};
  const rawBytes=Buffer.from(JSON.stringify(measurement));
  const profile:OperationalLimitProfile={kind:'MEASURED_EXECUTION_LIMITS_V1',version:identity.profileVersion,maxSlots:1,requestLimitUsd:'0.2',dailyLimitUsd:'1',fullBoundUsd:'0.1',
    stages:Object.fromEntries(runs.map(run=>[run.stage,{boundUsd:run.boundUsd,component:'STAGE_TOTAL',evidenceRefs:run.costs.map(cost=>cost.evidenceId)}])) as OperationalLimitProfile['stages'],
    fullBoundEvidenceRefs:[...measurement.fullProcess.evidenceIds],window:structuredClone(window),identity:structuredClone(identity),evidence:{id:randomUUID(),sha256:sha256(rawBytes)}};
  return {identity,measurement,rawBytes,profile};
}

