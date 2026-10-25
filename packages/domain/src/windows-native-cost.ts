import {types} from 'node:util';
import type {PoolClient} from 'pg';
import type {Database,Transaction} from '../../storage/src/database.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {nativeJsonBytes,nativeTasks,nativeTaskVersion,type NativeTask} from '../../native/src/dto.js';
import type {ObjectReceipt} from '../../storage/src/objects.js';
import type {NativeTarget} from '../../native/src/gateway.js';
import {validateNativeJobClaim,validateNativeOwnerCapture,validateNativeJobIntent,type NativeJobClaim,type NativeJobIntent} from './native-jobs.js';
import {validateNativeSourceInput,validateNativeCapacityAdmission,type NativeCapacityAdmission} from './native-capacity.js';
import type {NativeExecutionPhase} from './native-execution-wait.js';
import {NativeCapacityOperator,type NativeCapacityDecision} from './native-capacity.js';
import {validateWindowsNativeOriginalKey,validateWindowsNativeEvidenceBundle,type WindowsNativeOriginalKey,type WindowsNativeEvidenceFacts,type WindowsNativeOperationValue,type WindowsNativeTerminationValue,type WindowsNativeProofMetadata,type WindowsNativeCostRef} from './native-receipts.js';

export type {WindowsNativeOriginalKey,WindowsNativeEvidenceFacts,WindowsNativeOperationValue,WindowsNativeTerminationValue,WindowsNativeProofMetadata,WindowsNativeCostRef} from './native-receipts.js';
export type WindowsNativeEvidenceView=Readonly<{state:'VERIFIED'|'WAIT';operation:Readonly<WindowsNativeCostRef>|null;termination:Readonly<WindowsNativeCostRef>|null}>;
export type WindowsNativeCostBounds={maxRecordBytes:number;maxRecords:number};
type Wrapper<T>={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:'WINDOWS_NATIVE_OPERATION'|'WINDOWS_NATIVE_TERMINATION';value:T};
const bundleMaximum=1572864,valueMaximum=16384,minimumRecordBytes=32768;
const windowsCostJournals=new WeakMap<object,Database>();
const invalid='WINDOWS_NATIVE_COST_UNCONFIRMED',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
const waiting:WindowsNativeEvidenceView=Object.freeze({state:'WAIT',operation:null,termination:null});
function must(value:unknown,code=invalid):asserts value{requireCondition(value,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const actual=Reflect.ownKeys(value),fields=Object.getOwnPropertyDescriptors(value);must(actual.length===keys.length&&keys.every(k=>fields[k]?.enumerable&&'value'in fields[k]));return value as Record<string,unknown>;
}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function data(value:unknown,key:string):unknown{must(value!==null&&typeof value==='object'&&!types.isProxy(value));const field=Object.getOwnPropertyDescriptor(value,key);must(field?.enumerable&&'value'in field);return field.value;}
async function row(client:Pick<PoolClient,'query'>,sql:string,values:unknown[],column:string,maxBytes:number):Promise<unknown>{
  const result=await client.query(sql,values);must(Array.isArray(result.rows)&&result.rows.length===1);const item=closed(result.rows[0],[column])[column];if(item===null)return null;
  nativeJsonBytes(item,maxBytes);return item;
}
function values(facts:WindowsNativeEvidenceFacts):{operation:WindowsNativeOperationValue;termination:WindowsNativeTerminationValue}{
  const operation:WindowsNativeOperationValue={version:1,binding:facts.binding,adoptionId:facts.adoptionId,capacityRef:facts.capacity.reference,source:facts.source,originDigest:facts.originDigest,intentDigest:facts.intentDigest,windowsEvidenceRef:facts.windowsEvidenceRef,goGrantRef:facts.goGrantRef,rawResult:facts.rawResult,observations:facts.observations,accounting:facts.accounting,records:facts.records};
  const termination:WindowsNativeTerminationValue={version:1,jobId:facts.binding.jobId,parentInstanceId:facts.binding.parentInstanceId,capacityReservationId:facts.binding.capacityReservationId,source:facts.source,originDigest:facts.originDigest,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,termination:facts.termination,records:facts.records};
  nativeJsonBytes(operation,valueMaximum);nativeJsonBytes(termination,valueMaximum);return {operation,termination};
}
function wrap<T>(facts:WindowsNativeEvidenceFacts,kind:Wrapper<T>['kind'],value:T):Wrapper<T>{
  return {version:1,accountId:facts.binding.accountId,executionId:facts.source.input.executionId,inputDigest:facts.source.input.stageInputDigest,inputFingerprint:facts.source.inputFingerprint,kind,value};
}
function reference(value:unknown,expectedDigest:string):Readonly<WindowsNativeCostRef>{
  const ref=closed(value,['evidenceId','evidenceDigest']);must(typeof ref.evidenceId==='string'&&uuid.test(ref.evidenceId)&&typeof ref.evidenceDigest==='string'&&hash.test(ref.evidenceDigest)&&ref.evidenceDigest===expectedDigest);return Object.freeze({evidenceId:ref.evidenceId,evidenceDigest:ref.evidenceDigest});
}
function view(value:unknown,operation:unknown,termination:unknown):WindowsNativeEvidenceView{
  const item=closed(value,['state','operation','termination']);if(item.state==='WAIT'){must(item.operation===null&&item.termination===null);return waiting;}
  must(item.state==='VERIFIED');const op=reference(item.operation,digest(operation)),term=reference(item.termination,digest(termination));must(op.evidenceId!==term.evidenceId);return Object.freeze({state:'VERIFIED',operation:op,termination:term});
}
function proofMetadata(facts:WindowsNativeEvidenceFacts):WindowsNativeProofMetadata{
  const metadata:WindowsNativeProofMetadata={version:2,kind:'WINDOWS_JOB_OBJECT',binding:facts.binding,adoptionId:facts.adoptionId,capacityRef:facts.capacity.reference,source:facts.source,originDigest:facts.originDigest,intentDigest:facts.intentDigest,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,accountingDigest:facts.accounting===null?null:digest(facts.accounting.value)};
  nativeJsonBytes(metadata,valueMaximum);return metadata;
}
function decision(value:unknown,reservationId:string,proofId?:string):NativeCapacityDecision{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value));const keys=['allowed','reason',...(Object.hasOwn(value,'capacityReservationId')?['capacityReservationId']:[]),...(Object.hasOwn(value,'proofId')?['proofId']:[])],item=closed(value,keys);
  must(typeof item.allowed==='boolean'&&typeof item.reason==='string'&&item.reason.length>0&&item.reason.length<=128);must(item.allowed,item.reason);
  must(item.capacityReservationId===reservationId&&typeof item.proofId==='string'&&uuid.test(item.proofId)&&(!proofId||proofId===item.proofId));return freeze(structuredClone(item)) as NativeCapacityDecision;
}

// These records retain provenance only. They grant no billing allocation,
// complete-work-set closure, publication, execution budget or new native GO.
export class WindowsNativeCostJournal{
  private readonly bounds:Readonly<WindowsNativeCostBounds>;
  constructor(private readonly db:Database,bounds:WindowsNativeCostBounds){
    closed(bounds,['maxRecordBytes','maxRecords']);must(Number.isSafeInteger(bounds.maxRecordBytes)&&bounds.maxRecordBytes>=minimumRecordBytes&&bounds.maxRecordBytes<=2147483647&&Number.isSafeInteger(bounds.maxRecords)&&bounds.maxRecords>=2&&bounds.maxRecords<=2147483647);
    must(data(db,'role')==='trio_web_worker');this.bounds=Object.freeze({...bounds});windowsCostJournals.set(this,db);
  }
  private async read(tx:Transaction,value:WindowsNativeOriginalKey,write:boolean):Promise<WindowsNativeEvidenceView>{
    try{
      const key=freeze(validateWindowsNativeOriginalKey(value));must(tx.account.account_id===key.binding.accountId&&data(this.db,'role')==='trio_web_worker');
      const bundle=await row(tx.client,'SELECT manga_web.windows_native_evidence_lookup($1::jsonb) AS bundle',[JSON.stringify(key)],'bundle',bundleMaximum);if(bundle===null)return waiting;
      const facts=validateWindowsNativeEvidenceBundle(bundle,key,'trio_web_worker'),body=values(facts);
      const operation=wrap(facts,'WINDOWS_NATIVE_OPERATION',body.operation),termination=wrap(facts,'WINDOWS_NATIVE_TERMINATION',body.termination);
      nativeJsonBytes(operation,this.bounds.maxRecordBytes);nativeJsonBytes(termination,this.bounds.maxRecordBytes);
      const fn=write?'windows_native_evidence_record':'windows_native_evidence_lookup_bridge';
      const result=await row(tx.client,`SELECT manga_web.${fn}($1::jsonb,$2::jsonb,$3::jsonb) AS view`,[JSON.stringify(key),JSON.stringify(operation),JSON.stringify(termination)],'view',this.bounds.maxRecordBytes);
      return result===null?waiting:view(result,operation,termination);
    }catch(error){if(error instanceof DomainError)return waiting;throw error;}
  }
  async recordIn(tx:Transaction,key:WindowsNativeOriginalKey):Promise<WindowsNativeEvidenceView>{return this.read(tx,key,true);}
  async lookupIn(tx:Transaction,key:WindowsNativeOriginalKey):Promise<WindowsNativeEvidenceView>{return this.read(tx,key,false);}

  // B2 uses independent bounds: the original B1 record cap never truncates a
  // whole census or a Windows original. These are DB-only, same-transaction ports.
  async stageOriginalFactsIn(tx:Transaction,bundleValue:unknown,keyValue:WindowsNativeOriginalKey,source:{operation:WindowsNativeCostRef|null;termination:WindowsNativeCostRef|null}):Promise<WindowsNativeEvidenceFacts|null>{
    try{
      const key=validateWindowsNativeOriginalKey(stageCapture(keyValue,32768));must(key.binding.accountId===tx.account.account_id);closed(source,['operation','termination']);
      const bundle=stageCapture(bundleValue,bundleMaximum);const original=data(bundle,'original'),service=data(original,'ownerService');must(service==='trio_web_worker'||service==='trio_web_api');
      const facts=validateWindowsNativeEvidenceBundle(bundle,key,service);
      if(source.operation===null||source.termination===null){must(source.operation===null&&source.termination===null);return facts;}
      const opRef=costRef(source.operation),termRef=costRef(source.termination);must(opRef.evidenceId!==termRef.evidenceId);const body=values(facts);
      const op=wrap(facts,'WINDOWS_NATIVE_OPERATION',body.operation),term=wrap(facts,'WINDOWS_NATIVE_TERMINATION',body.termination);
      const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown;execution_id:string}>(`SELECT evidence_id,evidence_digest,execution_id,protected_evidence_ref,CASE WHEN octet_length(protected_observation::text)<=32768 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND((kind='WINDOWS_NATIVE_OPERATION' AND protected_observation->'value'->'binding'->>'jobId'=$3) OR(kind='WINDOWS_NATIVE_TERMINATION' AND protected_observation->'value'->>'jobId'=$3)) LIMIT 3`,[tx.account.account_id,facts.source.input.executionId,key.binding.jobId])).rows;
      must(rows.length===2);for(const [expected,r] of [[op,opRef],[term,termRef]] as const){const actual=rows.find(row=>row.evidence_id===r.evidenceId);must(actual&&actual.execution_id===facts.source.input.executionId&&actual.protected_evidence_ref===r.evidenceId&&actual.evidence_digest===r.evidenceDigest&&r.evidenceDigest===digest(expected)&&digest(actual.protected_observation)===r.evidenceDigest);}
      return facts;
    }catch(error){if(error instanceof DomainError)return null;throw error;}
  }
  async stageLookupIn(tx:Transaction,query:WindowsStageLookupQuery,limit:number):Promise<unknown|null>{
    return this.stageValue(tx,()=>{
      const q=stageCapture(query,65536) as WindowsStageLookupQuery;
      const mode=(q as {mode?:unknown}).mode;
      must(Number.isSafeInteger(limit)&&limit>0&&limit<=16384);
      if(mode==='CENSUS'||mode==='SEALED'){
        closed(q,['version','mode','owner']);stageSelector(q.owner);
      }else if(mode==='ORIGINAL'){
        closed(q,['version','mode','owner','key']);validateWindowsNativeCostOwner(q.owner);must(q.mode==='ORIGINAL');validateWindowsNativeOriginalKey(q.key);
      }else if(mode==='SOURCE'){
        closed(q,['version','mode','owner','ref']);validateWindowsNativeCostOwner(q.owner);must(q.mode==='SOURCE');costRef(q.ref);
      }else must(false);
      must(q.version===1);
      const maximum=mode==='CENSUS'?8388608:mode==='ORIGINAL'?1576960:mode==='SOURCE'?135168:2101248;
      return {sql:'SELECT manga_web.windows_stage_cost_lookup($1::jsonb,$2) AS value',parameters:[JSON.stringify(q),limit],maximum};
    });
  }
  async stageProjectIn(tx:Transaction,ownerValue:WindowsNativeCostOwner,key:unknown,operation:unknown,termination:unknown):Promise<unknown|null>{
    return this.stageValue(tx,()=>{
      const owner=validateWindowsNativeCostOwner(ownerValue),captured=stageCapture(key,32768);
      const op=stageCapture(operation,32768),term=stageCapture(termination,32768);
      return {sql:'SELECT manga_web.windows_stage_cost_project($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) AS value',parameters:[JSON.stringify(owner),JSON.stringify(captured),op===null?null:JSON.stringify(op),term===null?null:JSON.stringify(term)],maximum:98304};
    });
  }
  async stageSealIn(tx:Transaction,ownerValue:WindowsNativeCostOwner,candidate:unknown):Promise<unknown|null>{
    return this.stageValue(tx,()=>{
      const owner=validateWindowsNativeCostOwner(ownerValue),captured=stageCapture(candidate,3145728);
      return {sql:'SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) AS value',parameters:[JSON.stringify(owner),JSON.stringify(captured)],maximum:2101248};
    });
  }
  private async stageValue(tx:Transaction,prepare:()=>{sql:string;parameters:unknown[];maximum:number}):Promise<unknown|null>{
    try{
      must(windowsCostJournals.get(this)===this.db&&data(this.db,'role')==='trio_web_worker'&&uuid.test(tx.account.account_id));
      const request=prepare();
      const raw=await row(tx.client,request.sql,request.parameters,'value',request.maximum);
      return raw===null?null:stageCapture(raw,request.maximum);
    }catch(error){if(error instanceof DomainError)return null;throw error;}
  }

  isForDatabase(db:Database):boolean{return db===this.db;}
  private async costValue<T>(tx:Transaction,prepare:()=>{sql:string;parameters:unknown[];validate:(value:unknown)=>T}):Promise<T|null>{
    try{
      must(data(this.db,'role')==='trio_web_worker'&&typeof tx.account.account_id==='string'&&uuid.test(tx.account.account_id),'WINDOWS_NATIVE_COST_OWNER_UNCONFIRMED');
      const call=prepare();const value=await row(tx.client,call.sql,call.parameters,'value',this.bounds.maxRecordBytes);
      return value===null?null:freeze(call.validate(value));
    }catch(error){if(error instanceof DomainError)return null;throw error;}
  }
  async enrollInputIn(tx:Transaction,value:WindowsNativeCostRef):Promise<WindowsNativeCostRef|null>{
    return this.costValue(tx,()=>{const ref=costRef(costCapture(value));return {sql:'SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) AS value',parameters:[JSON.stringify(ref)],validate:costRef};});
  }
  async activateRootIn(tx:Transaction,value:WindowsNativeCostOwner,components:WindowsNativeCostComponent[]):Promise<WindowsNativeCostRef|null>{
    return this.costValue(tx,()=>{const owner=costOwner(costCapture(value)),mapping=costComponents(costCapture(components));return {sql:'SELECT manga_web.windows_native_cost_activate($1::jsonb,$2::jsonb) AS value',parameters:[JSON.stringify(owner),JSON.stringify(mapping)],validate:costRef};});
  }
  async beginScopeIn(tx:Transaction,value:WindowsNativeCostOwner,targetValue:NativeTarget,phase:NativeExecutionPhase,validationTargetDigest:string|null,scopeId:string):Promise<WindowsNativeCostScope|null>{
    return this.costValue(tx,()=>{
      const owner=costOwner(costCapture(value)),target=costTarget(costCapture(targetValue));must(target.accountId===tx.account.account_id);costId(scopeId);must(['INPUT','CHECKPOINT','VALIDATION','LOOKUP','DISPATCH'].includes(phase));
      if(target.targetKind==='EXECUTION')must(target.targetId===owner.executionId&&target.sourceInput?.executionId===owner.executionId&&target.sourceInput.inputEvidenceId===owner.inputEvidenceId&&owner.validationAttemptRef===null&&validationTargetDigest===null);
      else{must(target.targetKind==='REQUEST_CHECKPOINT'&&owner.validationAttemptRef!==null&&phase==='CHECKPOINT');costHash(validationTargetDigest);}
      const body={version:1 as const,scopeId,owner,target,phase,validationTargetDigest},scope:WindowsNativeCostScope={...body,scopeDigest:digest(body)};costCapture(scope,16384);
      return {sql:'SELECT manga_web.windows_native_cost_begin($1::jsonb,$2::jsonb) AS value',parameters:[JSON.stringify(owner),JSON.stringify(scope)],validate:value=>{const actual=validateWindowsNativeCostScope(value);must(digest(actual)===digest(scope));return actual;}};
    });
  }
  async registerCallIn(tx:Transaction,scopeValue:WindowsNativeCostScope,value:WindowsNativeCostCall):Promise<WindowsNativeCostCall|null>{
    return this.costValue(tx,()=>{const scope=validateWindowsNativeCostScope(scopeValue),call=validateWindowsNativeCostCall(value);must(scope.target.accountId===tx.account.account_id&&call.scopeId===scope.scopeId&&call.scopeDigest===scope.scopeDigest);return {sql:'SELECT manga_web.windows_native_cost_register_call($1,$2::jsonb) AS value',parameters:[scope.scopeId,JSON.stringify(call)],validate:value=>{const actual=validateWindowsNativeCostCall(value);must(digest(actual)===digest(call));return actual;}};});
  }
  async admitIn(tx:Transaction,scopeValue:WindowsNativeCostScope,callValue:WindowsNativeCostCall,intentValue:NativeJobIntent,capacityValue:NativeCapacityAdmission,componentId:string):Promise<WindowsNativeCostAdmission>{
    const answer=await this.costValue(tx,()=>{const scope=validateWindowsNativeCostScope(scopeValue),call=validateWindowsNativeCostCall(callValue),intent=validateNativeJobIntent(costCapture(intentValue)),capacity=validateNativeCapacityAdmission(costCapture(capacityValue));
      must(scope.target.accountId===tx.account.account_id&&call.scopeId===scope.scopeId&&call.scopeDigest===scope.scopeDigest&&call.componentId===componentId&&call.task===intent.task&&call.taskVersion===intent.taskVersion&&call.profileDigest===intent.profileDigest&&call.operationInputDigest===intent.operationInputDigest&&intent.targetKind===scope.target.targetKind&&intent.targetId===scope.target.targetId&&intent.semanticCaptureDigest===scope.target.semanticCaptureDigest&&digest(intent.claim)===digest(scope.target.claim)&&digest(intent.protectedOwnerCapture)===digest(scope.target.protectedOwnerCapture)&&digest(capacity.sourceInput)===digest(scope.target.sourceInput));
      return {sql:'SELECT manga_web.windows_native_cost_admit($1,$2::jsonb,$3::jsonb,$4) AS value',parameters:[call.callId,JSON.stringify(intent),JSON.stringify(capacity),componentId],validate:value=>{const item=costCapture(value) as Record<string,unknown>;must(typeof item.allowed==='boolean'&&typeof item.reason==='string'&&item.reason.length<=128&&Reflect.ownKeys(item).every(k=>['allowed','reason','intentDigest','capacityReservationId'].includes(String(k))));if(item.allowed)costId(item.capacityReservationId);return item as WindowsNativeCostAdmission;}};
    });return answer??Object.freeze({allowed:false,reason:'WINDOWS_NATIVE_COST_OWNER_UNCONFIRMED'});
  }
  async joinScopeIn(tx:Transaction,scopeValue:WindowsNativeCostScope,value:WindowsNativeCostScopeEnd):Promise<'JOINED'|'WAIT'>{
    return await this.costValue(tx,()=>{const scope=validateWindowsNativeCostScope(scopeValue),end=costCapture(value);closed(end,['version','scopeId','scopeDigest','eventId','outcome','terminalEvidence']);must(scope.target.accountId===tx.account.account_id&&end.version===1&&end.scopeId===scope.scopeId&&end.scopeDigest===scope.scopeDigest&&['RETURNED','THREW'].includes(end.outcome));costId(end.eventId);must(Array.isArray(end.terminalEvidence)&&end.terminalEvidence.length<=128);end.terminalEvidence.forEach(costRef);must(new Set(end.terminalEvidence.map(x=>x.evidenceId)).size===end.terminalEvidence.length);return {sql:'SELECT manga_web.windows_native_cost_join($1,$2::jsonb) AS value',parameters:[scope.scopeId,JSON.stringify(end)],validate:value=>{must(value==='JOINED'||value==='WAIT');return value;}};})??'WAIT';
  }
  async lookupScopeIn(tx:Transaction,scopeId:string):Promise<WindowsNativeCostScope|null>{
    return this.costValue(tx,()=>{costId(scopeId);return {sql:'SELECT manga_web.windows_native_cost_lookup($1::jsonb,$2) AS value',parameters:[JSON.stringify({scopeId}),64],validate:value=>{const scope=validateWindowsNativeCostScope(value);must(scope.scopeId===scopeId&&scope.target.accountId===tx.account.account_id);return scope;}};});
  }
  async beginIoIn(tx:Transaction,value:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>{return this.ioIn(tx,value,'begin');}
  async lookupIoIn(tx:Transaction,value:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>{return this.ioIn(tx,value,'lookup');}
  private async ioIn(tx:Transaction,value:WindowsCostedIoRequest,kind:'begin'|'lookup'):Promise<WindowsCostedIoEvent|null>{
    return this.costValue(tx,()=>{const request=validateWindowsCostedIoRequest(value);return {sql:`SELECT manga_web.windows_native_cost_io_${kind}($1::jsonb) AS value`,parameters:[JSON.stringify(request)],validate:value=>validateWindowsCostedIoEvent(value,request)};});
  }
  async endIoIn(tx:Transaction,value:WindowsCostedIoCompletion):Promise<WindowsCostedIoEvent|null>{
    return this.costValue(tx,()=>{const completion=costCapture(value);closed(completion,['version','operationId','eventId','call','kind','key','started','ended','state','observed','code']);must(completion.ended===null&&(completion.state==='RETURNED'||completion.state==='THREW'));validateWindowsCostedIoEvent({...completion,state:'UNCONFIRMED',ended:null});
      return {sql:'SELECT manga_web.windows_native_cost_io_end($1::jsonb) AS value',parameters:[JSON.stringify(completion)],validate:value=>{const actual=validateWindowsCostedIoEvent(value);must(actual.ended!==null&&digest({...actual,ended:null})===digest(completion));return actual;}};});
  }
  async recordCacheUseIn(tx:Transaction,callValue:WindowsNativeCostCall,source:unknown):Promise<WindowsNativeCostRef|null>{
    return this.costValue(tx,()=>{const call=validateWindowsNativeCostCall(callValue),captured=costCapture(source,32768);return {sql:'SELECT manga_web.windows_native_cost_cache_use($1,$2::jsonb) AS value',parameters:[call.callId,JSON.stringify(captured)],validate:costRef};});
  }
  async authorizeResultQueryIn(tx:Transaction,callValue:WindowsNativeCostCall,request:unknown):Promise<WindowsNativeCostRef|null>{return this.resultQueryIn(tx,callValue,request);}
  async finishResultQueryIn(tx:Transaction,callValue:WindowsNativeCostCall,request:unknown,responseRef:unknown):Promise<WindowsNativeCostRef|null>{return this.resultQueryIn(tx,callValue,request,responseRef);}
  private async resultQueryIn(tx:Transaction,callValue:WindowsNativeCostCall,request:unknown,responseRef?:unknown):Promise<WindowsNativeCostRef|null>{
    return this.costValue(tx,()=>{const call=validateWindowsNativeCostCall(callValue),captured=costCapture(request,32768),finish=responseRef!==undefined;return {sql:finish?'SELECT manga_web.windows_native_cost_finish_result_query($1,$2::jsonb,$3::jsonb) AS value':'SELECT manga_web.windows_native_cost_authorize_result_query($1,$2::jsonb) AS value',parameters:[call.callId,JSON.stringify(captured),...(finish?[JSON.stringify(costCapture(responseRef))]:[])],validate:costRef};});
  }
}

// Isolated operator access is authenticated by the unchanged base role checks.
// The original link's signature covers that link, never newly derived metadata.
export class WindowsNativeCapacityOperator extends NativeCapacityOperator{
  async confirmWindows(value:WindowsNativeOriginalKey):Promise<NativeCapacityDecision>{
    const key=freeze(validateWindowsNativeOriginalKey(value));await this.validate();
    const bundle=await row(this.client,'SELECT manga_web.native_capacity_windows_operator_evidence($1::jsonb) AS bundle',[JSON.stringify(key)],'bundle',bundleMaximum);must(bundle!==null);
    const ownerService=data(data(bundle,'original'),'ownerService');must(ownerService==='trio_web_api'||ownerService==='trio_web_worker');
    const facts=validateWindowsNativeEvidenceBundle(bundle,key,ownerService),metadata=proofMetadata(facts);
    const result=await row(this.client,'SELECT manga_web.native_capacity_confirm_windows_proof($1::jsonb,$2::jsonb,$3,$4) AS decision',[JSON.stringify(key),JSON.stringify(metadata),facts.link.canonical,facts.link.signature],'decision',valueMaximum);
    return decision(result,key.binding.capacityReservationId);
  }
  async releaseWindows(accountId:string,reservationId:string,proofId:string):Promise<NativeCapacityDecision>{
    must(typeof accountId==='string'&&typeof reservationId==='string'&&typeof proofId==='string'&&uuid.test(accountId)&&uuid.test(reservationId)&&uuid.test(proofId));await this.validate();
    const result=await row(this.client,'SELECT manga_web.native_capacity_release_windows($1,$2,$3) AS decision',[accountId,reservationId,proofId],'decision',valueMaximum);return decision(result,reservationId,proofId);
  }
}


export type WindowsNativeCostOwner={executionId:string;inputEvidenceId:string;inputFingerprint:string;basisRef:WindowsNativeCostRef;claim:NativeJobClaim;validationAttemptRef:WindowsNativeCostRef|null};
export type WindowsNativeCostComponent={task:NativeTask;componentId:string};
export type WindowsNativeCostScope={version:1;scopeId:string;scopeDigest:string;owner:WindowsNativeCostOwner;target:NativeTarget;phase:NativeExecutionPhase;validationTargetDigest:string|null};
export type WindowsNativeCostCall={version:1;callId:string;callDigest:string;scopeId:string;scopeDigest:string;task:NativeTask;taskVersion:string;profileDigest:string;kernelDigest:string;operationInputDigest:string;componentId:string};
export type WindowsNativeCostScopeEnd={version:1;scopeId:string;scopeDigest:string;eventId:string;outcome:'RETURNED'|'THREW';terminalEvidence:WindowsNativeCostRef[]};
export type WindowsNativeCostAdmission={allowed:boolean;reason:string;intentDigest?:string;capacityReservationId?:string};
export type WindowsCostedIoCall={callId:string;callDigest:string};
export type WindowsCostedIoRequest={version:1;operationId:string;eventId:string;call:WindowsCostedIoCall;kind:'OBJECT_READ'|'OBJECT_RECEIPT'|'OBJECT_PUT';key:string;expected:{sha256:string;bytesLength:string}|null};
export type WindowsCostedIoEvent={version:1;operationId:string;eventId:string;call:WindowsCostedIoCall;kind:WindowsCostedIoRequest['kind'];key:string;started:WindowsNativeCostRef;ended:WindowsNativeCostRef|null;state:'RETURNED'|'THREW'|'UNCONFIRMED';observed:{sha256:string;bytesLength:string}|null;code:string|null};
export type WindowsCostedIoCompletion=Omit<WindowsCostedIoEvent,'ended'|'state'>&{ended:null;state:'RETURNED'|'THREW'};
export type WindowsCostedIoReply<T>={state:'RETURNED';event:WindowsCostedIoEvent;value:T}|{state:'THREW'|'UNCONFIRMED';event:WindowsCostedIoEvent};
export interface WindowsCostedObjectIo{readonly bucket:string;read(request:WindowsCostedIoRequest):Promise<WindowsCostedIoReply<Buffer>>;receipt(request:WindowsCostedIoRequest):Promise<WindowsCostedIoReply<ObjectReceipt|null>>;put(request:WindowsCostedIoRequest,bytes:Buffer):Promise<WindowsCostedIoReply<ObjectReceipt>>;lookup(request:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>;}

function costId(value:unknown):asserts value is string{must(typeof value==='string'&&uuid.test(value));}
function costHash(value:unknown):asserts value is string{must(typeof value==='string'&&hash.test(value));}
// A bounded descriptor walk precedes canonicalization; aliases count each visit.
function costCapture<T>(value:T,maximum=32768):T{
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(item:unknown,depth:number):void=>{
    must(++nodes<=4096&&depth<=24);if(item===null||typeof item==='boolean'){bytes+=5;return;}
    if(typeof item==='string'){bytes+=Buffer.byteLength(item,'utf8')+2;must(bytes<=maximum);return;}
    if(typeof item==='number'){must(Number.isFinite(item));bytes+=32;must(bytes<=maximum);return;}
    must(typeof item==='object'&&!types.isProxy(item)&&!active.has(item));active.add(item);
    const array=Array.isArray(item);must(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype));const keys=Reflect.ownKeys(item);must(keys.length<=1025);
    for(const key of keys){if(array&&key==='length')continue;must(typeof key==='string');const field=Object.getOwnPropertyDescriptor(item,key);must(field?.enumerable&&'value'in field);bytes+=Buffer.byteLength(key,'utf8')+4;must(bytes<=maximum);visit(field.value,depth+1);}
    if(array)must(keys.length===item.length+1);active.delete(item);
  };
  visit(value,0);nativeJsonBytes(value,maximum);return structuredClone(value);
}
function costRef(value:unknown):WindowsNativeCostRef{const item=closed(costCapture(value),['evidenceId','evidenceDigest']);costId(item.evidenceId);costHash(item.evidenceDigest);return {evidenceId:item.evidenceId,evidenceDigest:item.evidenceDigest};}
function costOwner(value:unknown):WindowsNativeCostOwner{
  const item=closed(value,['executionId','inputEvidenceId','inputFingerprint','basisRef','claim','validationAttemptRef']);costId(item.executionId);costId(item.inputEvidenceId);costHash(item.inputFingerprint);const claim=validateNativeJobClaim(item.claim);must(claim.workItemId!==null);return {executionId:item.executionId,inputEvidenceId:item.inputEvidenceId,inputFingerprint:item.inputFingerprint,basisRef:costRef(item.basisRef),claim,validationAttemptRef:item.validationAttemptRef===null?null:costRef(item.validationAttemptRef)};
}
export function validateWindowsNativeCostOwner(value:unknown):WindowsNativeCostOwner{return freeze(costOwner(costCapture(value)));}
function costTarget(value:unknown):NativeTarget{
  const item=closed(value,['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim','sourceInput']);costId(item.accountId);costId(item.targetId);costHash(item.semanticCaptureDigest);must(item.targetKind==='EXECUTION'||item.targetKind==='REQUEST_CHECKPOINT');return {accountId:item.accountId,targetKind:item.targetKind,targetId:item.targetId,semanticCaptureDigest:item.semanticCaptureDigest,protectedOwnerCapture:validateNativeOwnerCapture(item.protectedOwnerCapture),claim:validateNativeJobClaim(item.claim),sourceInput:validateNativeSourceInput(item.sourceInput)};
}
function costComponents(value:unknown):WindowsNativeCostComponent[]{
  must(Array.isArray(value)&&value.length>0&&value.length<=64);const mapping=value.map(v=>{const item=closed(v,['task','componentId']);must(nativeTasks.includes(item.task as NativeTask)&&typeof item.componentId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(item.componentId));return {task:item.task as NativeTask,componentId:item.componentId};});must(new Set(mapping.map(x=>x.task)).size===mapping.length);return mapping;
}
export function validateWindowsNativeCostScope(value:unknown):WindowsNativeCostScope{
  const item=closed(costCapture(value,16384),['version','scopeId','scopeDigest','owner','target','phase','validationTargetDigest']);must(item.version===1);costId(item.scopeId);costHash(item.scopeDigest);const owner=costOwner(item.owner),target=costTarget(item.target);must(['INPUT','CHECKPOINT','VALIDATION','LOOKUP','DISPATCH'].includes(item.phase as string));if(item.validationTargetDigest!==null)costHash(item.validationTargetDigest);
  const body={version:1 as const,scopeId:item.scopeId,owner,target,phase:item.phase as NativeExecutionPhase,validationTargetDigest:item.validationTargetDigest as string|null};must(item.scopeDigest===digest(body));return freeze({...body,scopeDigest:item.scopeDigest});
}
export function validateWindowsNativeCostCall(value:unknown):WindowsNativeCostCall{
  const item=closed(costCapture(value,16384),['version','callId','callDigest','scopeId','scopeDigest','task','taskVersion','profileDigest','kernelDigest','operationInputDigest','componentId']);must(item.version===1&&nativeTasks.includes(item.task as NativeTask)&&item.taskVersion===nativeTaskVersion);costId(item.callId);costId(item.scopeId);for(const key of ['callDigest','scopeDigest','profileDigest','kernelDigest','operationInputDigest'])costHash(item[key]);must(typeof item.componentId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(item.componentId));
  const {callDigest,...body}=item;must(callDigest===digest(body));return freeze(item as WindowsNativeCostCall);
}
function costObserved(value:unknown):{sha256:string;bytesLength:string}{const item=closed(value,['sha256','bytesLength']);costHash(item.sha256);must(typeof item.bytesLength==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(item.bytesLength));return {sha256:item.sha256,bytesLength:item.bytesLength};}
export function validateWindowsCostedIoRequest(value:unknown):WindowsCostedIoRequest{
  const item=closed(costCapture(value),['version','operationId','eventId','call','kind','key','expected']);must(item.version===1&&['OBJECT_READ','OBJECT_RECEIPT','OBJECT_PUT'].includes(item.kind as string));costId(item.operationId);costId(item.eventId);const call=closed(item.call,['callId','callDigest']);costId(call.callId);costHash(call.callDigest);must(typeof item.key==='string'&&/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(item.key));if(item.expected!==null)costObserved(item.expected);return freeze(item as WindowsCostedIoRequest);
}
export function validateWindowsCostedIoEvent(value:unknown,request?:WindowsCostedIoRequest):WindowsCostedIoEvent{
  const item=closed(costCapture(value),['version','operationId','eventId','call','kind','key','started','ended','state','observed','code']);const base={version:item.version,operationId:item.operationId,eventId:item.eventId,call:item.call,kind:item.kind,key:item.key,expected:request?.expected??null};validateWindowsCostedIoRequest(base);
  costRef(item.started);if(item.ended!==null)costRef(item.ended);must(['RETURNED','THREW','UNCONFIRMED'].includes(item.state as string)&&(item.state==='UNCONFIRMED')===(item.ended===null));if(item.observed!==null)costObserved(item.observed);must(item.code===null||(typeof item.code==='string'&&/^[A-Z0-9_]{1,128}$/.test(item.code)));if(item.state==='RETURNED')must(item.code===null);if(item.ended!==null)must((item.started as WindowsNativeCostRef).evidenceId!==(item.ended as WindowsNativeCostRef).evidenceId);
  if(request){must(digest(base)===digest(request));if(request.expected!==null&&item.state==='RETURNED'&&item.observed!==null)must(digest(request.expected)===digest(item.observed));}return freeze(item as WindowsCostedIoEvent);
}

export type WindowsStageOwnerSelector={executionId:string;inputEvidenceId:string;inputFingerprint:string;basisRef:WindowsNativeCostRef};
export type WindowsStageLookupQuery={version:1;mode:'CENSUS'|'SEALED';owner:WindowsStageOwnerSelector}|{version:1;mode:'ORIGINAL';owner:WindowsNativeCostOwner;key:WindowsNativeOriginalKey}|{version:1;mode:'SOURCE';owner:WindowsNativeCostOwner;ref:WindowsNativeCostRef};
export function isWindowsNativeCostJournal(value:unknown,db:Database):value is WindowsNativeCostJournal{return typeof value==='object'&&value!==null&&windowsCostJournals.get(value)===db;}
function stageSelector(value:unknown):WindowsStageOwnerSelector{
  const item=closed(value,['executionId','inputEvidenceId','inputFingerprint','basisRef']);costId(item.executionId);costId(item.inputEvidenceId);costHash(item.inputFingerprint);costRef(item.basisRef);return item as WindowsStageOwnerSelector;
}
function stageCapture<T>(value:T,maximum:number):T{
  let nodes=0,bytes=0;const active=new Set<object>();
  const walk=(item:unknown,depth:number):void=>{
    must(++nodes<=maximum&&depth<=64&&!types.isProxy(item));
    if(typeof item==='string'){bytes+=Buffer.byteLength(item,'utf8')+2;must(bytes<=maximum);return;}
    if(item===null||typeof item==='boolean'||typeof item==='number'){must(typeof item!=='number'||Number.isFinite(item));bytes+=typeof item==='number'?String(item).length:5;must(bytes<=maximum);return;}
    must(typeof item==='object'&&!active.has(item));active.add(item);const array=Array.isArray(item),keys=Reflect.ownKeys(item);
    must(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype)&&keys.length<=maximum);
    if(array)must(keys.length===(item as unknown[]).length+1&&keys.every(k=>typeof k==='string'&&(k==='length'||/^(0|[1-9][0-9]*)$/.test(k))));
    for(const key of keys){if(array&&key==='length')continue;must(typeof key==='string');const field=Object.getOwnPropertyDescriptor(item,key);must(field?.enumerable&&'value'in field);bytes+=Buffer.byteLength(key,'utf8')+4;must(bytes<=maximum);walk(field.value,depth+1);}active.delete(item);
  };
  walk(value,0);return JSON.parse(nativeJsonBytes(value,maximum).toString('utf8')) as T;
}
