import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import {digest} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {assertWire} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import {canonicalInput,storedInput,type StageInput} from './provider.js';

export type PipelineEvidenceOwner='LEGACY'|'PIPELINE_V1'|'LOCAL_OCR_V1';
export type PipelineRecordKind='OPERATIONAL_SOURCE'|'OPERATIONAL_PLAN'|'OPERATIONAL_OUTPUT'|'OPERATIONAL_HOLD_PLAN'|'OPERATIONAL_NATIVE_FAILURE';
const candidateKind='OPERATIONAL_CANDIDATE',recordKinds=['OPERATIONAL_SOURCE','OPERATIONAL_PLAN','OPERATIONAL_OUTPUT','OPERATIONAL_HOLD_PLAN','OPERATIONAL_NATIVE_FAILURE'] as const;
export type PipelineStageCandidate={version:1;executionId:string;inputDigest:string;inputFingerprint:string;stage:string;claimGeneration:string;evidenceId:string;maskAssetId:string|null;cleanedAssetId:string|null;renderAssetId:string|null};
type ProtectedRecord<T>={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:T};
type EvidenceRow={evidence_id:string;evidence_digest:string;protected_observation:unknown};
type Bounds={maxRecordBytes:number;maxRecords:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/,generation=/^[1-9][0-9]{0,18}$/;
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));
function keys(value:unknown,expected:readonly string[]):void{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
  const properties=Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).length===expected.length&&expected.every(key=>properties[key]?.enumerable&&'value'in properties[key]),'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
}

// Only the owning worker's existing INPUT/evidence privileges are used. A
// candidate records first preparation, not a provider START, result approval,
// cost, current publication authority, native GO or resource release. The
// caller still owes ExecutionService/native/provider authorization. No external
// side effect is placed inside a database transaction/retry callback here.
export class PipelineEvidence{
  private readonly bounds:Readonly<Bounds>;
  constructor(readonly db:Database,bounds:Bounds,private readonly owner:PipelineEvidenceOwner='LEGACY'){
    keys(bounds,['maxRecordBytes','maxRecords']);
    requireCondition(['LEGACY','PIPELINE_V1','LOCAL_OCR_V1'].includes(owner)&&db.role==='trio_web_worker'&&Number.isSafeInteger(bounds.maxRecordBytes)&&bounds.maxRecordBytes>0&&bounds.maxRecordBytes<=2147483647&&Number.isSafeInteger(bounds.maxRecords)&&bounds.maxRecords>0&&bounds.maxRecords<2147483647,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
    this.bounds=Object.freeze({...bounds});
  }
  private capture(value:StageInput):StageInput{
    nativeJsonBytes(value,this.bounds.maxRecordBytes);const input=structuredClone(value);
    requireCondition(this.owner!=='LOCAL_OCR_V1'||input.stage==='OCR','PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
    requireCondition(input.accountId&&uuid.test(input.accountId)&&uuid.test(input.executionId)&&hash.test(input.inputDigest)&&['OCR','TRANSLATE','CLEANUP','TYPESET'].includes(input.stage)&&input.envelope,'INPUT_EVIDENCE_INVALID',409,'WAIT');
    assertWire('stageInputEnvelope',input.envelope);
    requireCondition(input.envelope.executionId===input.executionId&&input.envelope.requestId===input.requestId&&input.envelope.logicalStepId===input.stage&&input.envelope.inputDigest===input.inputDigest&&input.envelope.contextId===input.contextId&&digest(input.envelope.capturedSettings)===digest(input.settings),'INPUT_EVIDENCE_INVALID',409,'WAIT');return input;
  }
  private physicalKind(input:StageInput,kind:PipelineRecordKind|typeof candidateKind):string{
    if(input.stage!=='OCR'||this.owner==='LEGACY')return kind;
    return (this.owner==='PIPELINE_V1'?'P01C_PIPELINE_V1_':'LOCAL_OCR_V1_')+kind.slice('OPERATIONAL_'.length);
  }
  private async firstOwner(tx:Transaction,input:StageInput):Promise<void>{
    if(input.stage!=='OCR')return;
    const original=[candidateKind,...recordKinds];
    const owned=(prefix:string)=>original.map(kind=>prefix+kind.slice('OPERATIONAL_'.length));
    const forbidden=this.owner==='LEGACY'?[...owned('P01C_PIPELINE_V1_'),...owned('LOCAL_OCR_V1_')]:
      this.owner==='PIPELINE_V1'?[...original,...owned('LOCAL_OCR_V1_')]:original;
    const present=await tx.client.query('SELECT kind FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=ANY($3::text[]) LIMIT 1',[input.accountId,input.executionId,forbidden]);
    requireCondition(present.rows.length===0,'PIPELINE_DISPATCH_UNCONFIRMED',409,'WAIT');
    if(this.owner==='LOCAL_OCR_V1'){
      const outer=await this.readIn<PipelineStageCandidate>(tx,input,'P01C_PIPELINE_V1_CANDIDATE');
      requireCondition(outer.length===1,'PIPELINE_DISPATCH_UNCONFIRMED',409,'WAIT');
      const candidate=this.candidateShape(input,outer[0]);
      requireCondition(candidate.claimGeneration===input.claimGeneration,'PIPELINE_DISPATCH_UNCONFIRMED',409,'WAIT');
    }
  }
  private protected<T>(input:StageInput,kind:string,value:T):ProtectedRecord<T>{
    const record={version:1 as const,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),kind,value};
    nativeJsonBytes(record,this.bounds.maxRecordBytes);return structuredClone(record);
  }
  private async verify(tx:Transaction,input:StageInput):Promise<void>{
    requireCondition(tx.account.account_id===input.accountId&&fingerprint(await storedInput(tx,input.executionId))===fingerprint(input),'INPUT_EVIDENCE_INVALID',409,'WAIT');
  }
  private async readIn<T>(tx:Transaction,input:StageInput,kind:string):Promise<T[]>{
    const rows=(await tx.client.query<EvidenceRow>(`SELECT evidence_id,evidence_digest,protected_observation FROM execution_evidence
      WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id LIMIT $4`,[input.accountId,input.executionId,kind,this.bounds.maxRecords+1])).rows;
    requireCondition(rows.length<=this.bounds.maxRecords,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
    return rows.map(row=>{
      const value=row.protected_observation;nativeJsonBytes(value,this.bounds.maxRecordBytes);keys(value,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const record=value as ProtectedRecord<T>;
      requireCondition(uuid.test(row.evidence_id)&&hash.test(row.evidence_digest)&&digest(record)===row.evidence_digest&&record.version===1&&record.accountId===input.accountId&&record.executionId===input.executionId&&record.inputDigest===input.inputDigest&&record.inputFingerprint===fingerprint(input)&&record.kind===kind,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');return structuredClone(record.value);
    });
  }
  private candidateShape(input:StageInput,value:PipelineStageCandidate):PipelineStageCandidate{
    keys(value,['version','executionId','inputDigest','inputFingerprint','stage','claimGeneration','evidenceId','maskAssetId','cleanedAssetId','renderAssetId']);
    requireCondition(value.version===1&&value.executionId===input.executionId&&value.inputDigest===input.inputDigest&&value.inputFingerprint===fingerprint(input)&&value.stage===input.stage&&generation.test(value.claimGeneration)&&uuid.test(value.evidenceId),'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
    for(const key of ['maskAssetId','cleanedAssetId','renderAssetId'] as const){const present=key==='renderAssetId'?input.stage==='TYPESET':input.stage==='CLEANUP';requireCondition(present?typeof value[key]==='string'&&uuid.test(value[key]):value[key]===null,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');}
    const ids=[value.evidenceId,value.maskAssetId,value.cleanedAssetId,value.renderAssetId].filter((id):id is string=>id!==null);requireCondition(new Set(ids.map(id=>id.toLowerCase())).size===ids.length,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');return structuredClone(value);
  }
  private async insert<T>(tx:Transaction,record:ProtectedRecord<T>):Promise<void>{
    const id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
      VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT(account_id,execution_id,kind,evidence_digest) DO NOTHING`,[record.accountId,id,record.executionId,record.kind,digest(record),tx.now,JSON.stringify(record)]);
  }
  async candidate(value:StageInput):Promise<{created:boolean;candidate:PipelineStageCandidate}>{
    const input=this.capture(value);return this.db.accountTransaction(input.accountId!,async tx=>{
      await this.verify(tx,input);const existing=await this.readIn<PipelineStageCandidate>(tx,input,this.physicalKind(input,candidateKind));requireCondition(existing.length<=1,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
      if(existing[0])return {created:false,candidate:this.candidateShape(input,existing[0])};
      await this.firstOwner(tx,input);
      // A new claim generation after first preparation does not mint a new
      // candidate. Only a still-current, original DISPATCHING input can claim
      // its first record. It must not be created later by a status lookup.
      requireCondition(typeof input.claimGeneration==='string'&&generation.test(input.claimGeneration),'PIPELINE_DISPATCH_UNCONFIRMED',409,'WAIT');
      const eligible=(await tx.client.query(`SELECT e.execution_id FROM executions e JOIN request_steps s ON s.account_id=e.account_id AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id
        JOIN work_items w ON w.account_id=e.account_id AND w.kind='DISPATCH' AND w.target_ref->>'requestId'=e.request_id::text
        WHERE e.account_id=$1 AND e.execution_id=$2 AND e.state='DISPATCHING' AND e.dispatch_attempted_at IS NOT NULL AND e.claim_generation=$3
        AND s.current_execution_id=e.execution_id AND w.state='CLAIMED' AND w.claim_generation=e.claim_generation AND w.claim_owner IS NOT NULL AND w.lease_until>$4`,[input.accountId,input.executionId,input.claimGeneration,tx.now])).rows;
      requireCondition(eligible.length===1,'PIPELINE_DISPATCH_UNCONFIRMED',409,'WAIT');
      const candidate=this.candidateShape(input,{version:1,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),stage:input.stage,claimGeneration:input.claimGeneration,evidenceId:randomUUID(),maskAssetId:input.stage==='CLEANUP'?randomUUID():null,cleanedAssetId:input.stage==='CLEANUP'?randomUUID():null,renderAssetId:input.stage==='TYPESET'?randomUUID():null});
      await this.insert(tx,this.protected(input,this.physicalKind(input,candidateKind),candidate));return {created:true,candidate};
    });
  }
  async records<T>(value:StageInput,kind:PipelineRecordKind):Promise<T[]>{
    requireCondition(recordKinds.includes(kind),'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');const input=this.capture(value);
    return this.db.accountTransaction(input.accountId!,async tx=>{await this.verify(tx,input);return this.readIn<T>(tx,input,this.physicalKind(input,kind));},true);
  }
  async existingCandidate(value:StageInput):Promise<PipelineStageCandidate|null>{
    const input=this.capture(value);return this.db.accountTransaction(input.accountId!,async tx=>{
      await this.verify(tx,input);const candidates=await this.readIn<PipelineStageCandidate>(tx,input,this.physicalKind(input,candidateKind));requireCondition(candidates.length<=1,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');
      return candidates[0]?this.candidateShape(input,candidates[0]):null;
    },true);
  }
  async record<T>(value:StageInput,kind:PipelineRecordKind,payload:T):Promise<void>{
    requireCondition(recordKinds.includes(kind),'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');const input=this.capture(value),record=this.protected(input,this.physicalKind(input,kind),payload);
    await this.db.accountTransaction(input.accountId!,async tx=>{
      await this.verify(tx,input);const candidates=await this.readIn<PipelineStageCandidate>(tx,input,this.physicalKind(input,candidateKind));requireCondition(candidates.length===1,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');this.candidateShape(input,candidates[0]);
      const prior=await this.readIn<T>(tx,input,this.physicalKind(input,kind));if(prior.some(item=>digest(item)===digest(record.value)))return;
      requireCondition(prior.length<this.bounds.maxRecords,'PIPELINE_EVIDENCE_UNCONFIRMED',409,'WAIT');await this.insert(tx,record);
    },true);
  }
}
