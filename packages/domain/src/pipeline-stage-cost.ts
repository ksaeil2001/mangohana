import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type {Database,Transaction} from '../../storage/src/database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import {WindowsStageCostReader,isWindowsStageCostReader} from './windows-stage-cost-reader.js';
import {canonicalInput,storedInput,type StageInput} from './provider.js';
import type {NativeJobClaim} from './native-jobs.js';
import type {FullStageCostFacts} from './full-stage-cost.js';
import type {FullStageCostPreparation} from './full-stage-cost-preparation.js';
import type {FullStageCostBasis,FullStageCostJournal,FullStageCostJournalView} from './full-stage-cost-journal.js';
import type {CheckpointValidationAttempt,CheckpointValidationFacts,CheckpointValidationJournal} from './checkpoint-validation.js';

export type CostEvidenceRef={evidenceId:string;evidenceDigest:string};
export type OperationalStageCostView=FullStageCostJournalView&{sealedCalculation:CostEvidenceRef|null};
export type OperationalStageCostWorkSet={version:1;executionId:string;inputFingerprint:string;captureDigest:string;completion:'EXECUTION'|'TERMINAL_PREPARATION';
  joinedEvidence:CostEvidenceRef[];terminationEvidence:CostEvidenceRef[];
  sources:{sourceOperationId:string;sourceEventId:string;target:'PROVIDER'|'QUANTITY'|'ALLOCATION';componentId:string|null;evidence:CostEvidenceRef[]}[];facts:FullStageCostFacts};
// Parent-owned DB-only capability. Return null unless the entire original
// INPUT/provider/native/composite/validation/storage work set is enumerated,
// its raw source/GO/receipt/termination and operation/event joins are verified,
// and no further I/O is possible. Neither CLOSED nor an execution state proves
// this. Checkpoint facts must identify actual semantic/storage attempt events.
// Historical work enumeration must remain independent of current publication,
// context/owner authority and asset deletion/retention. A closed original is
// revalidated from immutable source/termination facts, never current asset I/O.
// There is deliberately no default or operational reader/activation here.
export interface OperationalStageCostReader{
  workSetIn(tx:Transaction,input:StageInput,basis:FullStageCostBasis):Promise<OperationalStageCostWorkSet|null>;
  checkpointFactsIn(tx:Transaction,input:StageInput,attempt:CheckpointValidationAttempt):Promise<CheckpointValidationFacts|null>;
}
export type OperationalStageCostBounds={maxRecordBytes:number;maxRecords:number;maxSources:number;maxExecutions:number;maxInFlight:number};
export type OperationalStageCostOptions={db:Database;preparation:FullStageCostPreparation;journal:FullStageCostJournal;reader:OperationalStageCostReader;checkpoints:CheckpointValidationJournal;bounds:OperationalStageCostBounds};
type Closure={version:1;basisEvidenceId:string;basisEvidenceDigest:string;workSetDigest:string;workSet:OperationalStageCostWorkSet;calculationEvidenceId:string;calculationEvidenceDigest:string;factsDigest:string};
type RecordRow={evidence_id:string;evidence_digest:string;execution_id:string;kind:string;protected_evidence_ref:string;protected_observation:unknown};
type Protected={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};
type Saved<T>={evidenceId:string;evidenceDigest:string;value:T};
const invalid='OPERATIONAL_STAGE_COST_UNCONFIRMED',duplicate='OPERATIONAL_STAGE_COST_DUPLICATE_SOURCE',conflict='OPERATIONAL_STAGE_COST_CLOSURE_CONFLICT';
const closureKind='OPERATIONAL_COST_CLOSURE',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));
function must(condition:unknown,code=invalid):asserts condition{requireCondition(condition,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):void{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const fields=Object.getOwnPropertyDescriptors(value);must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]));
}
function data(value:object,key:string):unknown{must(value!==null&&typeof value==='object'&&!types.isProxy(value));const field=Object.getOwnPropertyDescriptor(value,key);must(field&&'value'in field);return field.value;}
function method<T extends object,K extends keyof T>(owner:T,key:K):T[K]{
  must(owner!==null&&typeof owner==='object'&&!types.isProxy(owner));let at:object|null=owner;
  for(let depth=0;at&&depth<8;depth++){
    must(!types.isProxy(at));const field=Object.getOwnPropertyDescriptor(at,key);
    if(field){must('value'in field&&typeof field.value==='function'&&!types.isProxy(field.value));return Function.prototype.bind.call(field.value,owner) as T[K];}
    at=Object.getPrototypeOf(at);
  }
  must(false);
}
// Refuse array side properties and non-data descriptors before stringify can
// invoke a hidden toJSON/getter. Bound the walk as well as the encoded bytes.
function copy<T>(value:T,maxBytes:number):T{
  let nodes=0;const active=new Set<object>();
  const walk=(item:unknown,depth:number):void=>{
    must(!types.isProxy(item)&&depth<=64&&++nodes<=maxBytes);
    if(item===null||typeof item!=='object')return;must(!active.has(item));active.add(item);
    const keys=Reflect.ownKeys(item);must(keys.length<=maxBytes);
    if(Array.isArray(item))must(Object.getPrototypeOf(item)===Array.prototype&&keys.length===item.length+1&&keys.every(key=>typeof key==='string'&&(key==='length'||/^(0|[1-9][0-9]*)$/.test(key))));
    else must(Object.getPrototypeOf(item)===Object.prototype);
    for(const key of keys){if(Array.isArray(item)&&key==='length')continue;const field=Object.getOwnPropertyDescriptor(item,key);must(typeof key==='string'&&field?.enumerable&&'value'in field);walk(field.value,depth+1);}active.delete(item);
  };
  walk(value,0);return JSON.parse(nativeJsonBytes(value,maxBytes).toString('utf8')) as T;
}

export class OperationalStageCost{
  static windows(options:Omit<OperationalStageCostOptions,'reader'>&{reader:WindowsStageCostReader}):OperationalStageCost{
    closed(options,['db','preparation','journal','reader','checkpoints','bounds']);must(isWindowsStageCostReader(options.reader,options.db));const cost=new OperationalStageCost(options);
    cost.windowsPorts={prepare:method(options.reader,'prepareCandidate'),seal:method(options.reader,'sealIn'),completion:method(options.reader,'sealedCompletionIn')};return cost;
  }
  readonly checkpoints!:CheckpointValidationJournal;
  private readonly bounds:Readonly<OperationalStageCostBounds>;
  private readonly transaction:Database['accountTransaction'];
  private readonly prepareBasis:FullStageCostPreparation['prepare'];
  private readonly journalRead:FullStageCostJournal['lookupIn'];
  private readonly append:FullStageCostJournal['append'];
  private readonly workSetIn:OperationalStageCostReader['workSetIn'];
  private readonly checkpointFactsIn:OperationalStageCostReader['checkpointFactsIn'];
  private readonly finalCommitIn:CheckpointValidationJournal['finalCommitIn'];
  private readonly sealedFinalCostIn:CheckpointValidationJournal['sealedFinalCostIn'];
  private windowsPorts:{prepare:WindowsStageCostReader['prepareCandidate'];seal:WindowsStageCostReader['sealIn'];completion:WindowsStageCostReader['sealedCompletionIn']}|null=null;
  private readonly pending=new Set<Promise<void>>();
  constructor(options:OperationalStageCostOptions){
    closed(options,['db','preparation','journal','reader','checkpoints','bounds']);closed(options.bounds,['maxRecordBytes','maxRecords','maxSources','maxExecutions','maxInFlight']);
    for(const value of Object.values(options.bounds))must(Number.isSafeInteger(value)&&value>0&&value<2147483647);
    must(Number.isSafeInteger(options.bounds.maxRecordBytes*(options.bounds.maxRecords+1))&&options.bounds.maxRecordBytes*(options.bounds.maxRecords+1)<=2147483647);
    must(Number.isSafeInteger(options.bounds.maxRecordBytes*(options.bounds.maxExecutions+1))&&options.bounds.maxRecordBytes*(options.bounds.maxExecutions+1)<=2147483647);
    must(data(options.db,'role')==='trio_web_worker'&&data(options.journal,'db')===options.db);
    this.bounds=Object.freeze({...options.bounds});this.transaction=method(options.db,'accountTransaction');this.prepareBasis=method(options.preparation,'prepare');
    this.journalRead=method(options.journal,'lookupIn');this.append=method(options.journal,'append');this.workSetIn=method(options.reader,'workSetIn');this.checkpointFactsIn=method(options.reader,'checkpointFactsIn');
    this.finalCommitIn=method(options.checkpoints,'finalCommitIn');this.sealedFinalCostIn=method(options.checkpoints,'sealedFinalCostIn');Object.defineProperty(this,'checkpoints',{value:options.checkpoints,enumerable:true,writable:false,configurable:false});
  }
  private own(input:StageInput):StageInput{
    const owned=copy(input,this.bounds.maxRecordBytes);must(owned.accountId&&uuid.test(owned.accountId)&&uuid.test(owned.executionId)&&hash.test(owned.inputDigest)&&owned.envelope);return owned;
  }
  private run(action:()=>Promise<void>):Promise<void>{
    must(this.pending.size<this.bounds.maxInFlight);const task=action();this.pending.add(task);task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
  }
  async prepare(value:StageInput,claim:NativeJobClaim):Promise<void>{
    const owned=copy({input:value,claim},this.bounds.maxRecordBytes),input=this.own(owned.input);
    await this.run(async()=>{await this.prepareBasis(input,owned.claim);});
  }
  async collectCheckpointIn(tx:Transaction,value:StageInput,attempt:CheckpointValidationAttempt):Promise<CheckpointValidationFacts|null>{
    const owned=copy({input:value,attempt},this.bounds.maxRecordBytes);
    const result=copy(await this.checkpointFactsIn(tx,owned.input,owned.attempt),this.bounds.maxRecordBytes);
    if(result!==null)must(Array.isArray(result.operations)&&result.operations.length<=this.bounds.maxRecords);return result;
  }
  private async rows(tx:Transaction,input:StageInput,kind:string):Promise<Saved<unknown>[]>{
    must(tx.account.account_id===input.accountId);
    const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,execution_id,kind,protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=$5 THEN protected_observation ELSE NULL END AS protected_observation
      FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id LIMIT $4`,[input.accountId,input.executionId,kind,this.bounds.maxRecords+1,this.bounds.maxRecordBytes])).rows;
    must(rows.length<=this.bounds.maxRecords);
    return rows.map(row=>{
      const record=copy(row.protected_observation,this.bounds.maxRecordBytes);closed(record,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const item=record as Protected;
      must(uuid.test(row.evidence_id)&&hash.test(row.evidence_digest)&&row.protected_evidence_ref===row.evidence_id&&digest(record)===row.evidence_digest&&item.version===1&&item.accountId===input.accountId&&item.executionId===input.executionId&&item.inputDigest===input.inputDigest&&item.inputFingerprint===fingerprint(input)&&item.kind===kind);
      return {evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest,value:item.value};
    });
  }
  private closure(input:StageInput,value:unknown):Closure{
    closed(value,['version','basisEvidenceId','basisEvidenceDigest','workSetDigest','workSet','calculationEvidenceId','calculationEvidenceDigest','factsDigest']);const item=value as Closure;
    must(item.version===1&&uuid.test(item.basisEvidenceId)&&hash.test(item.basisEvidenceDigest)&&hash.test(item.workSetDigest)&&uuid.test(item.calculationEvidenceId)&&hash.test(item.calculationEvidenceDigest)&&hash.test(item.factsDigest));
    must(item.workSet.executionId===input.executionId&&item.workSet.inputFingerprint===fingerprint(input)&&digest(item.workSet)===item.workSetDigest&&digest(item.workSet.facts)===item.factsDigest);return item;
  }
  private references(value:unknown):CostEvidenceRef[]{
    must(Array.isArray(value)&&value.length>0&&value.length<=this.bounds.maxRecords);const seen=new Set<string>();
    for(const ref of value){closed(ref,['evidenceId','evidenceDigest']);must(uuid.test(ref.evidenceId)&&hash.test(ref.evidenceDigest)&&!seen.has(ref.evidenceId));seen.add(ref.evidenceId);}return value;
  }
  private async originalWork(tx:Transaction,input:StageInput,basis:FullStageCostBasis,supplied?:OperationalStageCostWorkSet|null):Promise<OperationalStageCostWorkSet|null>{
    const result=copy(supplied===undefined?await this.workSetIn(tx,structuredClone(input),structuredClone(basis)):supplied,this.bounds.maxRecordBytes);if(result===null)return null;
    closed(result,['version','executionId','inputFingerprint','captureDigest','completion','joinedEvidence','terminationEvidence','sources','facts']);
    must(result.version===1&&result.executionId===input.executionId&&result.inputFingerprint===fingerprint(input)&&result.captureDigest===basis.captureDigest&&['EXECUTION','TERMINAL_PREPARATION'].includes(result.completion));
    const joined=this.references(result.joinedEvidence),termination=this.references(result.terminationEvidence),refs=new Map<string,CostEvidenceRef>();
    const add=(ref:CostEvidenceRef)=>{const prior=refs.get(ref.evidenceId);must(!prior||prior.evidenceDigest===ref.evidenceDigest);refs.set(ref.evidenceId,ref);must(refs.size<=this.bounds.maxRecords);};for(const ref of joined)add(ref);
    // Ending work requires a distinct original event, even when the digest is
    // identical. This is separate from operation/event allocation uniqueness.
    for(const ref of termination){must(!refs.has(ref.evidenceId));add(ref);}
    must(Array.isArray(result.sources)&&result.sources.length<=this.bounds.maxSources);const identities=new Set<string>(),assigned=new Set<string>();
    for(const source of result.sources){
      closed(source,['sourceOperationId','sourceEventId','target','componentId','evidence']);
      for(const id of [source.sourceOperationId,source.sourceEventId]){must(typeof id==='string'&&id.length>0&&id.trim()===id);must(!identities.has(id),duplicate);identities.add(id);}
      must(['PROVIDER','QUANTITY','ALLOCATION'].includes(source.target)&&(source.target==='QUANTITY'?typeof source.componentId==='string'&&source.componentId.length>0:source.componentId===null));
      for(const ref of this.references(source.evidence)){must(!assigned.has(ref.evidenceId),duplicate);assigned.add(ref.evidenceId);must(joined.some(item=>item.evidenceId===ref.evidenceId&&item.evidenceDigest===ref.evidenceDigest));add(ref);}
    }
    closed(result.facts,['provider','quantities','allocation']);
    const match=(fact:{evidenceRefs:string[]}|null,target:string,componentId:string|null)=>{if(fact===null)return;must(Array.isArray(fact.evidenceRefs));const allowed=new Set(result.sources.filter(source=>source.target===target&&source.componentId===componentId).flatMap(source=>source.evidence.map(ref=>ref.evidenceId)));must(fact.evidenceRefs.every(ref=>allowed.has(ref)));};
    match(result.facts.provider,'PROVIDER',null);match(result.facts.allocation,'ALLOCATION',null);
    must(result.facts.quantities===null||Array.isArray(result.facts.quantities));for(const fact of result.facts.quantities??[])match(fact,'QUANTITY',fact.componentId);
    for(const ref of refs.values()){
      const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,kind,protected_evidence_ref,
        CASE WHEN octet_length(protected_observation::text)<=$4 THEN protected_observation ELSE NULL END AS protected_observation
        FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3`,[input.accountId,input.executionId,ref.evidenceId,this.bounds.maxRecordBytes])).rows;
      must(rows.length===1);const row=rows[0],raw=copy(row.protected_observation,this.bounds.maxRecordBytes);
      must(raw!==null&&row.evidence_digest===ref.evidenceDigest&&digest(raw)===ref.evidenceDigest&&row.protected_evidence_ref===row.evidence_id&&!['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION',closureKind].includes(row.kind));
    }
    return result;
  }
  private async completionIn(tx:Transaction,input:StageInput,work:OperationalStageCostWorkSet):Promise<'TERMINAL'|'EXECUTION'|null>{
    const rows=(await tx.client.query<{state:string;dispatch_attempted_at:Date|null;start_confirmed_at:Date|null;request_state:string}>(`SELECT e.state,e.dispatch_attempted_at,e.start_confirmed_at,r.state AS request_state FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id WHERE e.account_id=$1 AND e.execution_id=$2`,[input.accountId,input.executionId])).rows;must(rows.length===1);const row=rows[0];
    if(work.completion==='TERMINAL_PREPARATION')return row.dispatch_attempted_at===null&&row.start_confirmed_at===null&&(['REJECTED','FAILED'].includes(row.state)||row.state==='PREPARED'&&['STOPPED','FAILED'].includes(row.request_state))?'TERMINAL':null;
    if(row.state==='PREPARED'||row.dispatch_attempted_at===null)return null;
    if(row.state==='REJECTED')return row.start_confirmed_at===null?'TERMINAL':null;
    return row.state==='FAILED'?'TERMINAL':'EXECUTION';
  }
  private async finalReady(tx:Transaction,input:StageInput,work:OperationalStageCostWorkSet):Promise<boolean>{
    const completion=await this.completionIn(tx,input,work);
    // A failed original still incurs its measured cost without a success FINAL.
    // The work reader and raw termination proof remain mandatory for both paths.
    return completion!==null&&(input.stage!=='TYPESET'||completion==='TERMINAL'||await this.finalCommitIn(tx,structuredClone(input))==='ELIGIBLE');
  }
  private async windowsHistoricalReady(tx:Transaction,input:StageInput,basis:FullStageCostBasis,work:OperationalStageCostWorkSet):Promise<boolean>{
    must(this.windowsPorts);if(await this.windowsPorts.completion(tx,structuredClone(input),structuredClone(basis),structuredClone(work))!=='VERIFIED')return false;
    if(input.stage!=='TYPESET'||work.completion==='TERMINAL_PREPARATION')return true;
    // Disposition comes from the immutable seal's original OUTCOME refs. A later
    // mutable execution/request/owner state cannot reauthorize historical cost.
    const seals=await this.rows(tx,input,'WINDOWS_STAGE_COST_SEAL');must(seals.length===1&&work.terminationEvidence.some(ref=>ref.evidenceId===seals[0].evidenceId&&ref.evidenceDigest===seals[0].evidenceDigest));
    const completion=data(seals[0].value as object,'completion');closed(completion,['kind','refs']);const c=completion as {kind:unknown;refs:unknown};must(c.kind==='EXECUTION');const outcomes=new Set<string>();
    const joined=[...work.joinedEvidence,...work.terminationEvidence];for(const ref of this.references(c.refs)){
      must(joined.some(r=>r.evidenceId===ref.evidenceId&&r.evidenceDigest===ref.evidenceDigest));
      const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,kind,protected_evidence_ref,CASE WHEN octet_length(protected_observation::text)<=$4 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3 LIMIT 2`,[input.accountId,input.executionId,ref.evidenceId,this.bounds.maxRecordBytes])).rows;
      must(rows.length===1);const row=rows[0],raw=copy(row.protected_observation,this.bounds.maxRecordBytes);must(row.evidence_id===ref.evidenceId&&row.protected_evidence_ref===ref.evidenceId&&row.evidence_digest===ref.evidenceDigest&&raw!==null&&digest(raw)===ref.evidenceDigest);
      if(row.kind!=='OUTCOME')continue;const outcome=data(raw as object,'outcome');if(outcome==='UNKNOWN')continue;must(['SUCCESS','FAILURE','NOT_STARTED'].includes(String(outcome)));if(outcome==='NOT_STARTED')must(data(raw as object,'started')===false);outcomes.add(String(outcome));
    }
    if(outcomes.size!==1)return false;return !outcomes.has('SUCCESS')||await this.sealedFinalCostIn(tx,structuredClone(input),structuredClone(work.joinedEvidence))==='VERIFIED';
  }
  private async windowsFirstWork(input:StageInput):Promise<OperationalStageCostWorkSet|null>{
    must(this.windowsPorts);const ports=this.windowsPorts;
    const initial=await this.transaction(input.accountId!,async tx=>{
      const view=await this.journalRead(tx,input);if(view.basis===null)return null;
      const existing=await this.originalWork(tx,input,view.basis);
      if(existing){if(!await this.windowsHistoricalReady(tx,input,view.basis,existing))return null;await this.uniqueIn(tx,input,existing);return {basis:view.basis,work:existing};}
      if((await this.rows(tx,input,'WINDOWS_STAGE_COST_SEAL')).length||(await this.rows(tx,input,closureKind)).length)return null;
      return {basis:view.basis,work:null};
    },true);
    if(initial===null)return null;if(initial.work)return initial.work;
    const candidate=await ports.prepare(structuredClone(input),structuredClone(initial.basis));if(candidate===null)return null;
    return this.transaction(input.accountId!,async tx=>{
      const view=await this.journalRead(tx,input);if(view.basis===null||digest(view.basis)!==digest(initial.basis))return null;
      const current=await this.originalWork(tx,input,view.basis,candidate);if(current===null||!await this.finalReady(tx,input,current))return null;
      // 위 검증 사본과 구분해 원 private 후보 객체를 봉인에 전달한다.
      const sealed=await ports.seal(tx,structuredClone(input),structuredClone(view.basis),candidate);if(sealed===null)return null;
      const work=await this.originalWork(tx,input,view.basis,sealed);if(!work||!await this.windowsHistoricalReady(tx,input,view.basis,work))return null;
      await this.uniqueIn(tx,input,work);return work;
    },true);
  }
  private async uniqueIn(tx:Transaction,input:StageInput,work:OperationalStageCostWorkSet):Promise<void>{
    const used=new Set(work.sources.flatMap(source=>[source.sourceOperationId,source.sourceEventId]));
    const check=async(row:RecordRow):Promise<void>=>{
      const original=await storedInput(tx,row.execution_id);await this.journalRead(tx,original);
      const raw=copy(row.protected_observation,this.bounds.maxRecordBytes);closed(raw,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const item=raw as Protected;
      must(row.protected_evidence_ref===row.evidence_id&&digest(raw)===row.evidence_digest&&item.version===1&&item.accountId===input.accountId&&item.executionId===original.executionId&&item.inputDigest===original.inputDigest&&item.inputFingerprint===fingerprint(original)&&item.kind===closureKind);
      const closure=this.closure(original,item.value);must(Array.isArray(closure.workSet.sources)&&closure.workSet.sources.length<=this.bounds.maxSources);
      for(const source of closure.workSet.sources)must(!used.has(source.sourceOperationId)&&!used.has(source.sourceEventId),duplicate);
    };
    if(this.windowsPorts){
      type Metadata=Omit<RecordRow,'protected_observation'>&{record_bytes:number};
      const metadata=(await tx.client.query<Metadata>(`SELECT evidence_id,evidence_digest,execution_id,kind,protected_evidence_ref,
        octet_length(protected_observation::text) AS record_bytes FROM execution_evidence
        WHERE account_id=$1 AND execution_id<>$2 AND kind='OPERATIONAL_COST_CLOSURE' ORDER BY execution_id,evidence_id LIMIT $3`,[input.accountId,input.executionId,this.bounds.maxExecutions+1])).rows;
      must(metadata.length<=this.bounds.maxExecutions);
      const captured=metadata.map(row=>copy(row,this.bounds.maxRecordBytes));
      for(const row of captured){
        closed(row,['evidence_id','evidence_digest','execution_id','kind','protected_evidence_ref','record_bytes']);
        must(uuid.test(row.evidence_id)&&hash.test(row.evidence_digest)&&uuid.test(row.execution_id)&&row.execution_id!==input.executionId&&row.kind===closureKind&&row.protected_evidence_ref===row.evidence_id&&Number.isSafeInteger(row.record_bytes)&&row.record_bytes>0&&row.record_bytes<=this.bounds.maxRecordBytes);
      }
      for(const expected of captured){
        const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,execution_id,kind,protected_evidence_ref,
          CASE WHEN octet_length(protected_observation::text)<=$5 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence
          WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3 AND evidence_digest=$4 AND kind='OPERATIONAL_COST_CLOSURE' LIMIT 2`,[input.accountId,expected.execution_id,expected.evidence_id,expected.evidence_digest,this.bounds.maxRecordBytes])).rows;
        must(rows.length===1);const row=rows[0];
        for(const key of ['evidence_id','evidence_digest','execution_id','kind','protected_evidence_ref'] as const)must(row[key]===expected[key]);
        must(row.protected_observation!==null);await check(row);
      }
      return;
    }
    const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,execution_id,kind,protected_evidence_ref,
      CASE WHEN octet_length(protected_observation::text)<=$3 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence
      WHERE account_id=$1 AND execution_id<>$2 AND kind='OPERATIONAL_COST_CLOSURE' ORDER BY execution_id,evidence_id LIMIT $4`,[input.accountId,input.executionId,this.bounds.maxRecordBytes,this.bounds.maxExecutions+1])).rows;must(rows.length<=this.bounds.maxExecutions);
    for(const row of rows)await check(row);
  }
  private held(view:FullStageCostJournalView,reason?:string):OperationalStageCostView{
    if(view.state==='CONFLICT')return {...view,sealedCalculation:null};
    return {...view,state:reason?'CONFLICT':'UNCONFIRMED',costUsd:null,conflicts:reason?[...new Set([...view.conflicts,reason])].sort():view.conflicts,sealedCalculation:null};
  }
  async readIn(tx:Transaction,value:StageInput):Promise<OperationalStageCostView>{
    const input=this.own(value),view:OperationalStageCostView={...copy(await this.journalRead(tx,input),this.bounds.maxRecordBytes),sealedCalculation:null};if(view.state==='CONFLICT')return view;
    const records=await this.rows(tx,input,closureKind);must(records.length<=1);if(!records.length)return this.held(view);must(view.basis);
    const closure=this.closure(input,records[0].value),basis=await this.rows(tx,input,'OPERATIONAL_COST_BASIS');
    must(basis.length===1&&basis[0].evidenceId===closure.basisEvidenceId&&basis[0].evidenceDigest===closure.basisEvidenceDigest&&closure.workSet.captureDigest===view.basis.captureDigest);
    const calculation=view.calculations.find(record=>record.evidenceId===closure.calculationEvidenceId&&record.evidenceDigest===closure.calculationEvidenceDigest&&record.result.factsDigest===closure.factsDigest);must(calculation&&calculation.result.state==='CONFIRMED');
    const current=await this.originalWork(tx,input,view.basis);if(!current)return this.held(view,this.windowsPorts?conflict:undefined);
    if(digest(current)!==closure.workSetDigest)return this.held(view,conflict);
    if(this.windowsPorts){if(!await this.windowsHistoricalReady(tx,input,view.basis,current))return this.held(view);}
    else if(input.stage==='TYPESET'){
      const completion=await this.completionIn(tx,input,current);
      if(completion===null||completion==='EXECUTION'&&await this.sealedFinalCostIn(tx,structuredClone(input),structuredClone(closure.workSet.joinedEvidence))!=='VERIFIED')return this.held(view);
    }
    await this.uniqueIn(tx,input,current);return view.state==='CONFIRMED'&&view.costUsd===calculation.result.actualUsd?{...view,sealedCalculation:{evidenceId:calculation.evidenceId,evidenceDigest:calculation.evidenceDigest}}:this.held(view,conflict);
  }
  async finishAttempt(value:StageInput):Promise<void>{
    const input=this.own(value);await this.run(async()=>{
      const ready=this.windowsPorts?await this.windowsFirstWork(input):await this.transaction(input.accountId!,async tx=>{
        const view=await this.journalRead(tx,input);if(view.basis===null)return null;const work=await this.originalWork(tx,input,view.basis);
        if(!work||!await this.finalReady(tx,input,work))return null;
        await this.uniqueIn(tx,input,work);return work;
      },true);
      if(!ready)return;const appended=await this.append(structuredClone(input),structuredClone(ready.facts));if(appended.view.state!=='CONFIRMED')return;
      await this.transaction(input.accountId!,async tx=>{
        const view=await this.journalRead(tx,input);must(view.basis);const current=await this.originalWork(tx,input,view.basis);
        must(current&&digest(current)===digest(ready));if(this.windowsPorts?!await this.windowsHistoricalReady(tx,input,view.basis,current):!await this.finalReady(tx,input,current))return;
        await this.uniqueIn(tx,input,current);if(view.state!=='CONFIRMED')return;
        const factsDigest=digest(current.facts),calculation=view.calculations.find(record=>record.result.state==='CONFIRMED'&&record.result.factsDigest===factsDigest);must(calculation);
        const basis=await this.rows(tx,input,'OPERATIONAL_COST_BASIS');must(basis.length===1);
        const closure:Closure={version:1,basisEvidenceId:basis[0].evidenceId,basisEvidenceDigest:basis[0].evidenceDigest,workSetDigest:digest(current),workSet:current,calculationEvidenceId:calculation.evidenceId,calculationEvidenceDigest:calculation.evidenceDigest,factsDigest};
        const existing=await this.rows(tx,input,closureKind);must(existing.length<=1);if(existing.length){must(digest(this.closure(input,existing[0].value))===digest(closure),conflict);return;}
        const record:Protected={version:1,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),kind:closureKind,value:closure};nativeJsonBytes(record,this.bounds.maxRecordBytes);
        const id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT(account_id,execution_id,kind,evidence_digest) DO NOTHING`,[input.accountId,id,input.executionId,closureKind,digest(record),tx.now,JSON.stringify(record)]);
      },true);
    });
  }
  async hasPendingOtherIn(tx:Transaction,currentExecutionId:string|null):Promise<boolean>{
    must(uuid.test(tx.account.account_id)&&(currentExecutionId===null||uuid.test(currentExecutionId)));
    const rows=(await tx.client.query<{execution_id:string;pending_cost:boolean}>(`SELECT e.execution_id,EXISTS(SELECT 1 FROM cost_items c WHERE c.account_id=e.account_id AND c.execution_id=e.execution_id AND(c.state='UNCONFIRMED' OR c.evidence_conflict)) AS pending_cost
      FROM executions e WHERE e.account_id=$1 AND($2::uuid IS NULL OR e.execution_id<>$2) AND(EXISTS(SELECT 1 FROM execution_evidence z WHERE z.account_id=e.account_id AND z.execution_id=e.execution_id AND z.kind IN('INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')) OR EXISTS(SELECT 1 FROM cost_items c WHERE c.account_id=e.account_id AND c.execution_id=e.execution_id)) ORDER BY e.execution_id LIMIT $3`,[tx.account.account_id,currentExecutionId,this.bounds.maxExecutions+1])).rows;
    if(rows.length>this.bounds.maxExecutions)return true;
    for(const row of rows){if(row.pending_cost)return true;const input=await storedInput(tx,row.execution_id),view=await this.readIn(tx,input);if(view.state!=='CONFIRMED'||view.costUsd===null)return true;
      const projected=(await tx.client.query<{component:string;ordinal:number;state:string;evidence_conflict:boolean;matches:boolean|null}>(`SELECT component,ordinal,state,evidence_conflict,actual_usd=$3::numeric AS matches FROM cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY component,ordinal,cost_item_id LIMIT $4`,[tx.account.account_id,row.execution_id,view.costUsd,this.bounds.maxRecords+1])).rows;
      if(projected.length!==1||projected[0].component!=='STAGE_TOTAL'||projected[0].ordinal!==0||projected[0].state!=='CONFIRMED'||projected[0].evidence_conflict||projected[0].matches!==true)return true;
    }
    return false;
  }
  async idle():Promise<void>{const results=await Promise.allSettled([...this.pending]),failed=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed.length)throw new AggregateError(failed.map(result=>result.reason),invalid);}
}
