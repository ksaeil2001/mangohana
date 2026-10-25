import {types} from 'node:util';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import {canonicalInput,type StageInput} from './provider.js';
import {validateNativeJobClaim,type NativeJobClaim} from './native-jobs.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostSnapshot,type FullStageExecutionCapture} from './full-stage-cost.js';
import type {FullStageCostBasis,FullStageCostJournal} from './full-stage-cost-journal.js';

export type FullStageCostCatalogEntry={stage:FullStageExecutionCapture['stage'];profileDigest:string;snapshot:FullStageCostSnapshot|null};
export type FullStageCostPreparationJournal=Pick<FullStageCostJournal,'lookup'|'prepare'>;
export type FullStageCostPrepared={created:boolean;basis:FullStageCostBasis};
const invalid='FULL_STAGE_COST_PREPARATION_UNCONFIRMED',binding='FULL_STAGE_COST_PREPARATION_BINDING_CONFLICT';
const stages=['OCR','TRANSLATE','CLEANUP','TYPESET'],hash=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function must(value:unknown,code=invalid):asserts value{requireCondition(value,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):void{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const fields=Object.getOwnPropertyDescriptors(value);must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]));
}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

// These are encoded JSON/string bounds, not a physical process memory claim.
// Reject capabilities and indexed/non-enumerable getters before serialization.
// StageInput geometry may contain finite fractional coordinates, so ownership
// follows its existing JSON contract rather than the money-only numeric shape.
function own<T>(value:T,bounds:FullStageCostBounds,maxBytes:number):T{
  const active=new Set<object>();
  const string=(item:string)=>must(Buffer.byteLength(item)<=bounds.maxStringBytes,'FULL_STAGE_COST_BOUNDS');
  const walk=(item:unknown,depth:number):void=>{
    must(!types.isProxy(item)&&depth<=64);if(item===null||typeof item==='boolean')return;if(typeof item==='string'){string(item);return;}
    if(typeof item==='number'){must(Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER);return;}
    must(typeof item==='object'&&item!==null&&!active.has(item));active.add(item);
    if(Array.isArray(item)){
      must(Object.getPrototypeOf(item)===Array.prototype&&item.length<=maxBytes,'FULL_STAGE_COST_BOUNDS');const keys=Reflect.ownKeys(item);must(keys.length===item.length+1&&keys.every(key=>typeof key==='string'&&(key==='length'||/^(0|[1-9][0-9]*)$/.test(key))));
      for(let at=0;at<item.length;at++){const field=Object.getOwnPropertyDescriptor(item,String(at));must(field?.enumerable&&'value'in field);walk(field.value,depth+1);}
    }else{
      must(Object.getPrototypeOf(item)===Object.prototype);const keys=Reflect.ownKeys(item);must(keys.length<=maxBytes&&keys.every(key=>typeof key==='string'),'FULL_STAGE_COST_BOUNDS');
      for(const key of keys){must(typeof key==='string');string(key);const field=Object.getOwnPropertyDescriptor(item,key);must(field?.enumerable&&'value'in field);walk(field.value,depth+1);}
    }
    active.delete(item);
  };
  walk(value,0);return JSON.parse(nativeJsonBytes(value,maxBytes).toString('utf8')) as T;
}
function method<K extends keyof FullStageCostPreparationJournal>(journal:FullStageCostPreparationJournal,key:K):FullStageCostPreparationJournal[K]{
  must(journal!==null&&typeof journal==='object'&&!types.isProxy(journal));const prototype=Object.getPrototypeOf(journal);must(!types.isProxy(prototype));
  const field=Object.getOwnPropertyDescriptor(journal,key)??(prototype?Object.getOwnPropertyDescriptor(prototype,key):undefined);must(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value));
  return Function.prototype.bind.call(field.value,journal) as FullStageCostPreparationJournal[K];
}

// Independent parent-only preparation. The trusted journal verifies original
// DB INPUT/mode and first owning claim. This adapter selects no default price,
// proves no measurement/authority, and grants no admission, START, GO, actual
// cost, settlement or activation. Checkpoint/native ordering stays unconnected.
export class FullStageCostPreparation{
  private readonly bounds:FullStageCostBounds;
  private readonly catalog=new Map<string,FullStageCostCatalogEntry>();
  private readonly lookup:FullStageCostPreparationJournal['lookup'];
  private readonly capture:FullStageCostPreparationJournal['prepare'];
  constructor(journal:FullStageCostPreparationJournal,catalog:readonly FullStageCostCatalogEntry[],bounds:FullStageCostBounds){
    closed(bounds,['maxInputBytes','maxOutputBytes','maxComponents','maxEvidenceRefs','maxStringBytes']);new FullStageCostCalculator(null,bounds);this.bounds=freeze({...bounds});
    this.lookup=method(journal,'lookup');this.capture=method(journal,'prepare');
    must(!types.isProxy(catalog)&&Array.isArray(catalog)&&catalog.length<=stages.length);const owned=own(catalog,this.bounds,this.bounds.maxInputBytes);
    for(const entry of owned){
      closed(entry,['stage','profileDigest','snapshot']);must(stages.includes(entry.stage)&&typeof entry.profileDigest==='string'&&hash.test(entry.profileDigest));must(!this.catalog.has(entry.stage),'FULL_STAGE_COST_CATALOG_DUPLICATE');
      new FullStageCostCalculator(entry.snapshot,this.bounds);if(entry.snapshot!==null)must(entry.snapshot.stage===entry.stage&&entry.snapshot.profileDigest===entry.profileDigest,binding);
      this.catalog.set(entry.stage,freeze(entry));
    }
  }
  private input(value:StageInput):StageInput{
    const input=own(value,this.bounds,this.bounds.maxInputBytes);
    must(input!==null&&typeof input==='object'&&!Array.isArray(input)&&input.accountId&&uuid.test(input.accountId)&&uuid.test(input.executionId)&&uuid.test(input.requestId)&&stages.includes(input.stage)&&hash.test(input.inputDigest)&&input.envelope&&input.settings!==null&&typeof input.settings==='object','INPUT_EVIDENCE_INVALID');assertWire('stageInputEnvelope',input.envelope);
    must(input.envelope.executionId===input.executionId&&input.envelope.requestId===input.requestId&&input.envelope.logicalStepId===input.stage&&input.envelope.inputDigest===input.inputDigest&&input.envelope.contextId===input.contextId&&input.envelope.stageContract===input.settings.contractVersion&&digest(input.envelope.capturedSettings)===digest(input.settings),'INPUT_EVIDENCE_INVALID');return input;
  }
  private basis(input:StageInput,value:FullStageCostBasis):FullStageCostBasis{
    const basis=own(value,this.bounds,this.bounds.maxOutputBytes);closed(basis,['version','capture','captureDigest','snapshot','snapshotDigest']);closed(basis.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const raw:FullStageExecutionCapture={accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage as FullStageExecutionCapture['stage'],profileDigest:basis.capture.profileDigest,mode:basis.capture.mode};
    const normalized=new FullStageCostCalculator(basis.snapshot,this.bounds).calculate(raw,{provider:null,quantities:null,allocation:null});
    must(basis.version===1&&digest(basis.capture)===digest(normalized.capture)&&basis.captureDigest===normalized.captureDigest&&basis.snapshotDigest===normalized.snapshotDigest,binding);return basis;
  }
  async prepare(value:StageInput,firstClaim:NativeJobClaim):Promise<FullStageCostPrepared>{
    // Both caller-owned records and all catalog data are detached before the
    // first journal await. Each journal receives its own argument copies too.
    const request=own({input:value,claim:firstClaim},this.bounds,this.bounds.maxInputBytes),input=this.input(request.input),claim=validateNativeJobClaim(request.claim);
    const view=own(await this.lookup(structuredClone(input)),this.bounds,this.bounds.maxOutputBytes);closed(view,['basis','state','costUsd','conflicts','calculations']);
    must(['UNCONFIRMED','CONFIRMED','CONFLICT'].includes(view.state)&&(view.costUsd===null||typeof view.costUsd==='string'&&/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(view.costUsd))&&Array.isArray(view.conflicts)&&Array.isArray(view.calculations));
    must(view.state!=='CONFLICT'&&view.conflicts.length===0,'FULL_STAGE_COST_PREPARATION_CONFLICT');
    if(view.basis!==null)return {created:false,basis:this.basis(input,view.basis)};
    must(view.state==='UNCONFIRMED'&&view.costUsd===null&&view.calculations.length===0);
    const entry=this.catalog.get(input.stage);must(entry,'FULL_STAGE_COST_CATALOG_MISSING');
    const result=own(await this.capture(structuredClone(input),structuredClone(entry.snapshot),entry.profileDigest,structuredClone(claim)),this.bounds,this.bounds.maxOutputBytes);closed(result,['created','basis']);must(typeof result.created==='boolean');
    const basis=this.basis(input,result.basis);if(result.created)must(basis.capture.profileDigest===entry.profileDigest&&basis.snapshotDigest===(entry.snapshot===null?null:digest(entry.snapshot)),binding);
    return {created:result.created,basis};
  }
}
