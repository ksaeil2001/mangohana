import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import Decimal from 'decimal.js';
import type {Database,Transaction} from '../../storage/src/database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import {canonicalInput,storedInput,type StageInput} from './provider.js';
import {validateNativeJobClaim,type NativeJobClaim} from './native-jobs.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostFacts,type FullStageCostResult,type FullStageCostSnapshot,type FullStageExecutionCapture} from './full-stage-cost.js';

export type FullStageCostJournalBounds={maxRecordBytes:number;maxRecords:number;calculator:FullStageCostBounds};
export type FullStageCostBasis={version:1;capture:FullStageCostResult['capture'];captureDigest:string;snapshot:FullStageCostSnapshot|null;snapshotDigest:string|null};
export type FullStageCostCalculationRecord={evidenceId:string;evidenceDigest:string;result:FullStageCostResult};
export type FullStageCostJournalView={basis:FullStageCostBasis|null;state:'UNCONFIRMED'|'CONFIRMED'|'CONFLICT';costUsd:string|null;conflicts:string[];calculations:FullStageCostCalculationRecord[]};
type Kind='OPERATIONAL_COST_BASIS'|'OPERATIONAL_COST_CALCULATION';
type Protected<T>={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:Kind;value:T};
type Row={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown};
const code='FULL_STAGE_COST_JOURNAL_UNCONFIRMED',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/,generation=/^[1-9][0-9]{0,18}$/;
// Every compared fact is NUMERIC(28,12); caller Decimal defaults cannot turn a
// small known amount into zero or make two different confirmed facts equal.
const CostEquality=Decimal.clone({precision:64,minE:-64,maxE:64,rounding:Decimal.ROUND_HALF_UP});
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));
const mutableSnapshot=(value:FullStageCostResult['snapshot'])=>structuredClone(value) as FullStageCostSnapshot|null;
const mutableFacts=(value:FullStageCostResult['facts'])=>structuredClone(value) as FullStageCostFacts;
function closed(value:unknown,keys:readonly string[]):void{
  requireCondition(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,code,409,'WAIT');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]),code,409,'WAIT');
}

// Owning worker's original INPUT and existing append-only evidence privileges.
// This records a private reader's supplied cost facts; it does not independently
// prove measurement, rates, source authenticity, stage START, payment policy,
// native GO/release, or activation. No external I/O occurs in DB callbacks.
export class FullStageCostJournal{
  private readonly bounds:Readonly<FullStageCostJournalBounds>;
  constructor(readonly db:Database,bounds:FullStageCostJournalBounds){
    closed(bounds,['maxRecordBytes','maxRecords','calculator']);
    requireCondition(db.role==='trio_web_worker'&&Number.isSafeInteger(bounds.maxRecordBytes)&&bounds.maxRecordBytes>0&&bounds.maxRecordBytes<=2147483647&&Number.isSafeInteger(bounds.maxRecords)&&bounds.maxRecords>0&&bounds.maxRecords<2147483647&&Number.isSafeInteger(bounds.maxRecordBytes*(bounds.maxRecords+1))&&bounds.maxRecordBytes*(bounds.maxRecords+1)<=2147483647,code,409,'WAIT');
    new FullStageCostCalculator(null,bounds.calculator);
    this.bounds=Object.freeze({...bounds,calculator:Object.freeze(structuredClone(bounds.calculator))});
  }
  private own(input:StageInput):StageInput{
    nativeJsonBytes(input,this.bounds.maxRecordBytes);const value=structuredClone(input);
    requireCondition(value.accountId&&uuid.test(value.accountId)&&uuid.test(value.executionId)&&hash.test(value.inputDigest)&&value.envelope&&['OCR','TRANSLATE','CLEANUP','TYPESET'].includes(value.stage),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    assertWire('stageInputEnvelope',value.envelope);
    requireCondition(value.envelope.executionId===value.executionId&&value.envelope.requestId===value.requestId&&value.envelope.logicalStepId===value.stage&&value.envelope.inputDigest===value.inputDigest&&value.envelope.contextId===value.contextId&&digest(value.envelope.capturedSettings)===digest(value.settings),'INPUT_EVIDENCE_INVALID',409,'WAIT');return value;
  }
  private async verify(tx:Transaction,input:StageInput):Promise<'FREE'|'PAID'>{
    requireCondition(tx.account.account_id===input.accountId&&fingerprint(await storedInput(tx,input.executionId))===fingerprint(input),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    const rows=(await tx.client.query<{mode:'FREE'|'PAID'}>(`SELECT r.mode FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id WHERE e.account_id=$1 AND e.execution_id=$2`,[input.accountId,input.executionId])).rows;
    requireCondition(rows.length===1&&['FREE','PAID'].includes(rows[0].mode),code,409,'WAIT');return rows[0].mode;
  }
  private rawCapture(input:StageInput,mode:'FREE'|'PAID',profileDigest:string):FullStageExecutionCapture{
    requireCondition(typeof profileDigest==='string'&&hash.test(profileDigest),code,409,'WAIT');return {accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),stage:input.stage as FullStageExecutionCapture['stage'],profileDigest,mode};
  }
  private calculator(snapshot:FullStageCostSnapshot|null):FullStageCostCalculator{return new FullStageCostCalculator(snapshot,this.bounds.calculator);}
  private basis(input:StageInput,mode:'FREE'|'PAID',value:FullStageCostBasis):FullStageCostBasis{
    closed(value,['version','capture','captureDigest','snapshot','snapshotDigest']);
    closed(value.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const normalized=this.calculator(value.snapshot).calculate(this.rawCapture(input,mode,value.capture.profileDigest),{provider:null,quantities:null,allocation:null});
    requireCondition(value.version===1&&digest(value.capture)===digest(normalized.capture)&&value.captureDigest===normalized.captureDigest&&value.snapshotDigest===normalized.snapshotDigest&&digest(value.snapshot)===digest(normalized.snapshot),code,409,'WAIT');
    return structuredClone({version:1,capture:normalized.capture,captureDigest:normalized.captureDigest,snapshot:mutableSnapshot(normalized.snapshot),snapshotDigest:normalized.snapshotDigest});
  }
  private wrap<T>(input:StageInput,kind:Kind,value:T):Protected<T>{
    const record={version:1 as const,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),kind,value};
    nativeJsonBytes(record,this.bounds.maxRecordBytes);return structuredClone(record);
  }
  private async read<T>(tx:Transaction,input:StageInput,kind:Kind):Promise<{id:string;digest:string;value:T}[]>{
    // Bound the JSON returned by PG before its driver materializes the payload.
    // Oversized rows remain visible as NULL and hold the read; none are hidden.
    const rows=(await tx.client.query<Row>(`SELECT evidence_id,evidence_digest,protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=$5 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id LIMIT $4`,[input.accountId,input.executionId,kind,this.bounds.maxRecords+1,this.bounds.maxRecordBytes])).rows;
    requireCondition(rows.length<=this.bounds.maxRecords,code,409,'WAIT');
    return rows.map(row=>{
      nativeJsonBytes(row.protected_observation,this.bounds.maxRecordBytes);closed(row.protected_observation,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const record=row.protected_observation as Protected<T>;
      requireCondition(uuid.test(row.evidence_id)&&row.protected_evidence_ref===row.evidence_id&&hash.test(row.evidence_digest)&&digest(record)===row.evidence_digest&&record.version===1&&record.accountId===input.accountId&&record.executionId===input.executionId&&record.inputDigest===input.inputDigest&&record.inputFingerprint===fingerprint(input)&&record.kind===kind,code,409,'WAIT');
      return {id:row.evidence_id,digest:row.evidence_digest,value:structuredClone(record.value)};
    });
  }
  private async insert<T>(tx:Transaction,input:StageInput,kind:Kind,value:T):Promise<void>{
    const record=this.wrap(input,kind,value),id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
      VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT(account_id,execution_id,kind,evidence_digest) DO NOTHING`,[input.accountId,id,input.executionId,kind,digest(record),tx.now,JSON.stringify(record)]);
  }
  private async readBasis(tx:Transaction,input:StageInput,mode:'FREE'|'PAID'):Promise<FullStageCostBasis|null>{
    const rows=await this.read<FullStageCostBasis>(tx,input,'OPERATIONAL_COST_BASIS');requireCondition(rows.length<=1,code,409,'WAIT');return rows[0]?this.basis(input,mode,rows[0].value):null;
  }
  private async calculations(tx:Transaction,input:StageInput,basis:FullStageCostBasis):Promise<FullStageCostCalculationRecord[]>{
    const records=await this.read<FullStageCostResult>(tx,input,'OPERATIONAL_COST_CALCULATION'),calculator=this.calculator(basis.snapshot);
    return records.map(record=>{
      nativeJsonBytes(record.value,this.bounds.calculator.maxOutputBytes);closed(record.value,['version','scope','state','reasons','capture','captureDigest','snapshot','snapshotDigest','facts','factsDigest','basisVersion','usdScale','rounding','breakdown','exactTotalUsd','actualUsd']);
      const result=calculator.calculate(this.rawCapture(input,basis.capture.mode,basis.capture.profileDigest),mutableFacts(record.value.facts));
      requireCondition(result.captureDigest===basis.captureDigest&&result.snapshotDigest===basis.snapshotDigest&&digest(result)===digest(record.value),code,409,'WAIT');
      return {evidenceId:record.id,evidenceDigest:record.digest,result};
    });
  }
  private view(basis:FullStageCostBasis|null,calculations:FullStageCostCalculationRecord[]):FullStageCostJournalView{
    const conflicts=new Set<string>(),known=new Map<string,string>();
    const observe=(key:string,amount:string|null)=>{if(amount===null)return;const previous=known.get(key);if(previous!==undefined&&!new CostEquality(previous).equals(amount))conflicts.add(key);else known.set(key,amount);};
    for(const {result} of calculations){
      if(result.breakdown.provider.confirmed)observe('PROVIDER_COST_CONFLICT',result.facts.provider?.actualUsd??null);
      const allocation=result.facts.allocation;
      if(allocation?.state==='CONFIRMED'&&allocation.evidenceRefs.length)observe('ALLOCATION_COST_CONFLICT',allocation.actualUsd);
      for(const quantity of result.facts.quantities??[])if(quantity.state==='CONFIRMED'&&quantity.evidenceRefs.length)observe('QUANTITY_CONFLICT:'+quantity.componentId,quantity.quantity);
      if(result.state==='CONFIRMED')observe('TOTAL_COST_CONFLICT',result.actualUsd);
    }
    const confirmed=calculations.find(record=>record.result.state==='CONFIRMED');
    return structuredClone({basis,state:conflicts.size?'CONFLICT':confirmed?'CONFIRMED':'UNCONFIRMED',costUsd:conflicts.size?null:confirmed?.result.actualUsd??null,conflicts:[...conflicts].sort(),calculations});
  }
  async prepare(value:StageInput,snapshot:FullStageCostSnapshot|null,profileDigest:string,firstClaim?:NativeJobClaim):Promise<{created:boolean;basis:FullStageCostBasis}>{
    const input=this.own(value);nativeJsonBytes(snapshot,this.bounds.maxRecordBytes);requireCondition(typeof profileDigest==='string'&&hash.test(profileDigest),code,409,'WAIT');const calculator=this.calculator(structuredClone(snapshot));
    if(firstClaim!==undefined)nativeJsonBytes(firstClaim,this.bounds.maxRecordBytes);const ownedClaim=firstClaim===undefined?null:validateNativeJobClaim(firstClaim);
    return this.db.accountTransaction(input.accountId!,async tx=>{
      const mode=await this.verify(tx,input),result=calculator.calculate(this.rawCapture(input,mode,profileDigest),{provider:null,quantities:null,allocation:null});
      const basis:FullStageCostBasis={version:1,capture:result.capture,captureDigest:result.captureDigest,snapshot:mutableSnapshot(result.snapshot),snapshotDigest:result.snapshotDigest},existing=await this.readBasis(tx,input,mode);
      if(existing){requireCondition(digest(existing)===digest(basis),code,409,'WAIT');return {created:false,basis:existing};}
      requireCondition((await this.read(tx,input,'OPERATIONAL_COST_CALCULATION')).length===0,code,409,'WAIT');
      requireCondition(typeof input.claimGeneration==='string'&&generation.test(input.claimGeneration),'FULL_STAGE_COST_CAPTURE_UNCONFIRMED',409,'WAIT');
      requireCondition(ownedClaim&&ownedClaim.workItemId!==null&&ownedClaim.generation===input.claimGeneration,'FULL_STAGE_COST_CAPTURE_UNCONFIRMED',409,'WAIT');
      // The first basis belongs before input/checkpoint validation, whose native
      // work can precede preflight and the main START acknowledgement. A late
      // DISPATCHING record or a prior owning intent cannot adopt today's rates.
      // Existing immutable bases above remain readable after claim/ACK loss.
      const eligible=(await tx.client.query(`SELECT e.execution_id FROM executions e JOIN request_steps s ON s.account_id=e.account_id AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id
        JOIN work_items w ON w.account_id=e.account_id AND w.kind='DISPATCH' AND w.target_ref->>'requestId'=e.request_id::text
        WHERE e.account_id=$1 AND e.execution_id=$2 AND e.state='PREPARED' AND e.dispatch_attempted_at IS NULL AND e.start_confirmed_at IS NULL AND e.claim_generation=$3
        AND s.current_execution_id=e.execution_id AND w.state='CLAIMED' AND w.claim_generation=e.claim_generation AND w.work_item_id=$5 AND w.claim_owner=$6 AND w.lease_until>$4
        AND NOT EXISTS(SELECT 1 FROM execution_evidence z WHERE z.account_id=e.account_id AND z.execution_id=e.execution_id AND z.kind IN ('START','STALE_START','OPERATIONAL_SOURCE'))
        AND NOT EXISTS(SELECT 1 FROM native_job_intents j WHERE j.account_id=e.account_id AND ((j.target_kind='EXECUTION' AND j.target_id=e.execution_id)
          OR(j.target_kind='REQUEST_CHECKPOINT' AND j.target_id=e.request_id AND j.protected_intent->'claim'->>'workItemId'=w.work_item_id::text AND j.protected_intent->'claim'->>'generation'=e.claim_generation::text)))
        AND NOT EXISTS(SELECT 1 FROM native_capacity_reservations n WHERE n.account_id=e.account_id AND (n.source_execution_id=e.execution_id OR n.base_execution_id=e.execution_id))`,[input.accountId,input.executionId,input.claimGeneration,tx.now,ownedClaim.workItemId,ownedClaim.ownerId])).rows;
      requireCondition(eligible.length===1,'FULL_STAGE_COST_CAPTURE_UNCONFIRMED',409,'WAIT');await this.insert(tx,input,'OPERATIONAL_COST_BASIS',basis);return {created:true,basis:structuredClone(basis)};
    },true);
  }
  async append(value:StageInput,facts:FullStageCostFacts):Promise<{appended:boolean;view:FullStageCostJournalView}>{
    const input=this.own(value);nativeJsonBytes(facts,this.bounds.calculator.maxInputBytes);const ownedFacts=structuredClone(facts);
    return this.db.accountTransaction(input.accountId!,async tx=>{
      const mode=await this.verify(tx,input),basis=await this.readBasis(tx,input,mode);requireCondition(basis,code,409,'WAIT');
      const result=this.calculator(basis.snapshot).calculate(this.rawCapture(input,mode,basis.capture.profileDigest),ownedFacts),prior=await this.calculations(tx,input,basis);
      if(prior.some(record=>record.result.factsDigest===result.factsDigest))return {appended:false,view:this.view(basis,prior)};
      requireCondition(prior.length<this.bounds.maxRecords,code,409,'WAIT');await this.insert(tx,input,'OPERATIONAL_COST_CALCULATION',result);
      return {appended:true,view:this.view(basis,await this.calculations(tx,input,basis))};
    },true);
  }
  async lookupIn(tx:Transaction,value:StageInput):Promise<FullStageCostJournalView>{
    const input=this.own(value),mode=await this.verify(tx,input),basis=await this.readBasis(tx,input,mode);
    if(!basis)requireCondition((await this.read(tx,input,'OPERATIONAL_COST_CALCULATION')).length===0,code,409,'WAIT');
    return this.view(basis,basis?await this.calculations(tx,input,basis):[]);
  }
  async lookup(value:StageInput):Promise<FullStageCostJournalView>{
    const input=this.own(value);return this.db.accountTransaction(input.accountId!,tx=>this.lookupIn(tx,input),true);
  }
}
