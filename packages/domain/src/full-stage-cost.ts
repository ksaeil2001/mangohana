import Decimal from 'decimal.js';
import {types} from 'node:util';
import {digest} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';

export type FullStageExecutionCapture={accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;stage:'OCR'|'TRANSLATE'|'CLEANUP'|'TYPESET';profileDigest:string;mode:'FREE'|'PAID'};
export type CapturedFullStageExecution=Readonly<FullStageExecutionCapture&{captureDigest:string}>;
export type FullStageRateComponent={componentId:string;kind:'IMAGE'|'RENDER'|'STORAGE';unit:string;rateVersion:string|null;usdPerUnit:string|null;evidenceRefs:string[]};
export type FullStageCostSnapshot={version:1;state:'MEASURED'|'UNMEASURED';stage:FullStageExecutionCapture['stage'];profileDigest:string;basisVersion:string;usdScale:12;rounding:'UP'|'HALF_UP';evidenceRefs:string[];components:FullStageRateComponent[]};
export type FullStageProviderUsdFact={scope:'ACTUAL_AI_USD';captureDigest:string;state:'CONFIRMED'|'UNCONFIRMED';actualUsd:string|null;evidenceRefs:string[]};
export type FullStageQuantityFact={componentId:string;captureDigest:string;state:'CONFIRMED'|'UNCONFIRMED';quantity:string|null;unit:string;evidenceRefs:string[]};
export type FullStageAllocationFact={captureDigest:string;mode:FullStageExecutionCapture['mode'];funding:'FREE_OPERATIONS'|'PAID_PROCESSING'|null;basisVersion:string|null;state:'CONFIRMED'|'UNCONFIRMED';actualUsd:string|null;evidenceRefs:string[]};
export type FullStageCostFacts={provider:FullStageProviderUsdFact|null;quantities:FullStageQuantityFact[]|null;allocation:FullStageAllocationFact|null};
export type FullStageCostBounds={maxInputBytes:number;maxOutputBytes:number;maxComponents:number;maxEvidenceRefs:number;maxStringBytes:number};
type Immutable<T>=T extends readonly (infer U)[]?readonly Immutable<U>[]:T extends object?{readonly [K in keyof T]:Immutable<T[K]>}:T;
type Reason={code:string;componentId:string|null};
type UsdBreakdown={factDigest:string|null;evidenceRefs:string[];reportedUsd:string|null;exactUsd:string|null;confirmed:boolean};
type ComponentBreakdown={componentId:string;kind:FullStageRateComponent['kind']|null;unit:string;rateVersion:string|null;usdPerUnit:string|null;rateDigest:string|null;rateEvidenceRefs:string[];quantity:string|null;quantityDigest:string|null;quantityEvidenceRefs:string[];exactUsd:string|null;confirmed:boolean};
export type FullStageCostResult=Immutable<{version:1;scope:'FULL_STAGE_PROCESS';state:'CONFIRMED'|'UNCONFIRMED';reasons:Reason[];
  capture:CapturedFullStageExecution;captureDigest:string;snapshot:FullStageCostSnapshot|null;snapshotDigest:string|null;facts:FullStageCostFacts;factsDigest:string;
  basisVersion:string|null;usdScale:12|null;rounding:FullStageCostSnapshot['rounding']|null;
  breakdown:{provider:UsdBreakdown;components:ComponentBreakdown[];allocation:UsdBreakdown&{mode:FullStageExecutionCapture['mode'];funding:FullStageAllocationFact['funding'];basisVersion:string|null}};
  exactTotalUsd:string|null;actualUsd:string|null}>;

const invalid='FULL_STAGE_COST_INVALID',boundsCode='FULL_STAGE_COST_BOUNDS',binding='FULL_STAGE_COST_BINDING_CONFLICT';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,hash=/^[0-9a-f]{64}$/;
// Same nonnegative, exponent-free NUMERIC(28,12) domain as contracts.money.
// Products can have 32 integer and 24 fractional digits; only their total is
// explicitly quantized. No credit, FX, markup, daily window or price is chosen.
const numeric=/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/,stages=['OCR','TRANSLATE','CLEANUP','TYPESET'];
function must(condition:unknown,code=invalid):asserts condition{requireCondition(condition,code,422,'WAIT');}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const actual=Reflect.ownKeys(value);must(actual.length===keys.length&&actual.every(key=>typeof key==='string'&&keys.includes(key)));
  const fields=Object.getOwnPropertyDescriptors(value);must(keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]));return value as Record<string,unknown>;
}
function unicode(value:string):boolean{
  for(let at=0;at<value.length;at++){const point=value.charCodeAt(at);if(point>=0xd800&&point<=0xdbff){const next=value.charCodeAt(++at);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(point>=0xdc00&&point<=0xdfff)return false;}return true;
}
function text(value:unknown):asserts value is string{must(typeof value==='string'&&value.trim().length>0&&unicode(value));}
function decimal(value:unknown):asserts value is string|null{must(value===null||typeof value==='string'&&numeric.test(value));}
function refs(value:unknown,counter:{refs:number},bounds:FullStageCostBounds):asserts value is string[]{
  must(Array.isArray(value));must(value.length<=bounds.maxEvidenceRefs,boundsCode);counter.refs+=value.length;must(counter.refs<=bounds.maxEvidenceRefs,boundsCode);
  must(value.every(ref=>typeof ref==='string'&&ref.trim().length>0&&unicode(ref))&&new Set(value).size===value.length,'FULL_STAGE_COST_DUPLICATE_EVIDENCE');
}
function zeroProof(value:string|null,evidenceRefs:readonly string[]):void{if(value!==null&&/^0(?:\.0+)?$/.test(value))must(evidenceRefs.length>0,'FULL_STAGE_COST_ZERO_WITHOUT_EVIDENCE');}
function freeze<T>(value:T):Immutable<T>{if(value!==null&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value as Immutable<T>;}

// Preflight descriptors, dense rows, UTF-8 widths and complete JSON byte count
// before JSON ownership copies. It never calls getters/toJSON and accepts no
// Buffer, Date, Map, Proxy, function, undefined, symbol, cycle or prototype capability.
function plainCopy<T>(value:T,bounds:FullStageCostBounds):T{
  let bytes=0;const active=new Set<object>();
  const charge=(amount:number)=>{bytes+=amount;must(Number.isSafeInteger(bytes)&&bytes<=bounds.maxInputBytes,boundsCode);};
  const string=(item:string)=>{must(unicode(item));must(Buffer.byteLength(item)<=bounds.maxStringBytes,boundsCode);charge(Buffer.byteLength(JSON.stringify(item)));};
  const visit=(item:unknown,depth:number):void=>{
    must(depth<=8,boundsCode);if(item===null){charge(4);return;}if(typeof item==='string'){string(item);return;}if(typeof item==='boolean'){charge(item?4:5);return;}
    if(typeof item==='number'){must(Number.isSafeInteger(item)&&!Object.is(item,-0));charge(String(item).length);return;}
    must(item!==null&&typeof item==='object'&&!types.isProxy(item)&&!active.has(item));active.add(item);
    if(Array.isArray(item)){
      must(Object.getPrototypeOf(item)===Array.prototype&&item.length<=Math.max(bounds.maxComponents,bounds.maxEvidenceRefs),boundsCode);const keys=Reflect.ownKeys(item);must(keys.length===item.length+1&&keys.every(key=>typeof key==='string'&&(key==='length'||/^(0|[1-9][0-9]*)$/.test(key))));charge(2+Math.max(0,item.length-1));
      for(let at=0;at<item.length;at++){const field=Object.getOwnPropertyDescriptor(item,String(at));must(field&&field.enumerable&&'value'in field);visit(field.value,depth+1);}
    }else{
      must(Object.getPrototypeOf(item)===Object.prototype);const keys=Reflect.ownKeys(item);must(keys.length<=12&&keys.every(key=>typeof key==='string'),boundsCode);charge(2+Math.max(0,keys.length-1));
      for(const key of keys){const field=Object.getOwnPropertyDescriptor(item,key);must(typeof key==='string'&&field&&field.enumerable&&'value'in field);string(key);charge(1);visit(field.value,depth+1);}
    }
    active.delete(item);
  };
  visit(value,0);return JSON.parse(JSON.stringify(value)) as T;
}

export class FullStageCostCalculator{
  private readonly bounds:Readonly<FullStageCostBounds>;
  private readonly snapshot:Immutable<FullStageCostSnapshot>|null;
  private readonly snapshotDigest:string|null;
  private readonly Exact:typeof Decimal;
  constructor(snapshot:FullStageCostSnapshot|null,bounds:FullStageCostBounds){
    const checked=object(bounds,['maxInputBytes','maxOutputBytes','maxComponents','maxEvidenceRefs','maxStringBytes']);must(Object.values(checked).every(value=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647),boundsCode);this.bounds=Object.freeze({...bounds});
    // 2*28 significant digits for each exact product, plus enough carry for
    // all declared component terms and the AI/allocation terms. Own precision
    // and exponent bounds are isolated from global changes before or after
    // construction. The smallest product has at most 24 fractional places.
    const exactDigits=56+String(this.bounds.maxComponents+2).length+2;
    this.Exact=Decimal.clone({precision:exactDigits,minE:-56,maxE:exactDigits,rounding:Decimal.ROUND_DOWN});
    const owned=plainCopy(snapshot,this.bounds);if(owned!==null)this.checkSnapshot(owned,{refs:0});this.snapshot=freeze(owned);this.snapshotDigest=owned===null?null:digest(owned);
  }
  private checkSnapshot(snapshot:Immutable<FullStageCostSnapshot>,counter:{refs:number}):void{
    object(snapshot,['version','state','stage','profileDigest','basisVersion','usdScale','rounding','evidenceRefs','components']);must(snapshot.version===1&&['MEASURED','UNMEASURED'].includes(snapshot.state)&&stages.includes(snapshot.stage)&&hash.test(snapshot.profileDigest)&&snapshot.usdScale===12&&['UP','HALF_UP'].includes(snapshot.rounding));text(snapshot.basisVersion);refs(snapshot.evidenceRefs,counter,this.bounds);
    must(Array.isArray(snapshot.components)&&snapshot.components.length<=this.bounds.maxComponents,boundsCode);must(snapshot.state!=='MEASURED'||snapshot.components.length>0,'FULL_STAGE_COST_COVERAGE_MISSING');const ids=new Set<string>();
    for(const component of snapshot.components){object(component,['componentId','kind','unit','rateVersion','usdPerUnit','evidenceRefs']);text(component.componentId);text(component.unit);must(['IMAGE','RENDER','STORAGE'].includes(component.kind));if(component.rateVersion!==null)text(component.rateVersion);decimal(component.usdPerUnit);refs(component.evidenceRefs,counter,this.bounds);zeroProof(component.usdPerUnit,component.evidenceRefs);must(!ids.has(component.componentId),'FULL_STAGE_COST_DUPLICATE_COMPONENT');ids.add(component.componentId);}
  }
  capture(value:FullStageExecutionCapture):CapturedFullStageExecution{
    const capture=plainCopy(value,this.bounds);object(capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode']);must(uuid.test(capture.accountId)&&uuid.test(capture.executionId)&&hash.test(capture.inputDigest)&&hash.test(capture.inputFingerprint)&&hash.test(capture.profileDigest)&&stages.includes(capture.stage)&&['FREE','PAID'].includes(capture.mode));return freeze({...capture,captureDigest:digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture})});
  }
  private checkFacts(capture:CapturedFullStageExecution,facts:FullStageCostFacts,counter:{refs:number}):void{
    object(facts,['provider','quantities','allocation']);
    const bound=(value:string)=>must(value===capture.captureDigest,binding);
    if(facts.provider!==null){const fact=facts.provider;object(fact,['scope','captureDigest','state','actualUsd','evidenceRefs']);must(fact.scope==='ACTUAL_AI_USD'&&['CONFIRMED','UNCONFIRMED'].includes(fact.state));bound(fact.captureDigest);decimal(fact.actualUsd);refs(fact.evidenceRefs,counter,this.bounds);zeroProof(fact.actualUsd,fact.evidenceRefs);}
    if(facts.quantities!==null){must(Array.isArray(facts.quantities)&&facts.quantities.length<=this.bounds.maxComponents,boundsCode);const ids=new Set<string>();
      for(const fact of facts.quantities){object(fact,['componentId','captureDigest','state','quantity','unit','evidenceRefs']);text(fact.componentId);text(fact.unit);must(['CONFIRMED','UNCONFIRMED'].includes(fact.state));bound(fact.captureDigest);decimal(fact.quantity);refs(fact.evidenceRefs,counter,this.bounds);zeroProof(fact.quantity,fact.evidenceRefs);must(!ids.has(fact.componentId),'FULL_STAGE_COST_DUPLICATE_COMPONENT');ids.add(fact.componentId);
        if(this.snapshot){const rate=this.snapshot.components.find(component=>component.componentId===fact.componentId);must(rate,'FULL_STAGE_COST_COVERAGE_CONFLICT');must(rate.unit===fact.unit,'FULL_STAGE_COST_UNIT_CONFLICT');}
      }
    }
    if(facts.allocation!==null){const fact=facts.allocation;object(fact,['captureDigest','mode','funding','basisVersion','state','actualUsd','evidenceRefs']);bound(fact.captureDigest);must(fact.mode===capture.mode,binding);must(fact.funding===null||['FREE_OPERATIONS','PAID_PROCESSING'].includes(fact.funding));must(!(capture.mode==='PAID'&&fact.funding==='FREE_OPERATIONS'),'FULL_STAGE_COST_FREE_ALLOCATION_FOR_PAID');must(!(capture.mode==='FREE'&&fact.funding==='PAID_PROCESSING'),'FULL_STAGE_COST_PAID_ALLOCATION_FOR_FREE');must(['CONFIRMED','UNCONFIRMED'].includes(fact.state));if(fact.basisVersion!==null){text(fact.basisVersion);if(this.snapshot)must(fact.basisVersion===this.snapshot.basisVersion,binding);}decimal(fact.actualUsd);refs(fact.evidenceRefs,counter,this.bounds);zeroProof(fact.actualUsd,fact.evidenceRefs);}
  }
  calculate(value:FullStageExecutionCapture,facts:FullStageCostFacts):FullStageCostResult{
    // CONFIRMED/MEASURED are the verified reader's private input contract.
    // This pure function authenticates no reader and proves no real provider,
    // measurement, price, allocation, free/paid admission or production gate.
    const owned=plainCopy({capture:value,snapshot:this.snapshot,facts},this.bounds),capture=this.capture(owned.capture),counter={refs:0};
    if(this.snapshot){must(this.snapshot.stage===capture.stage&&this.snapshot.profileDigest===capture.profileDigest,binding);this.checkSnapshot(owned.snapshot!,counter);}this.checkFacts(capture,owned.facts,counter);
    const reasons:Reason[]=[],reason=(code:string,componentId:string|null=null)=>reasons.push({code,componentId});
    if(!this.snapshot)reason('SNAPSHOT_MISSING');else{if(this.snapshot.state!=='MEASURED')reason('SNAPSHOT_UNMEASURED');if(!this.snapshot.evidenceRefs.length)reason('SNAPSHOT_EVIDENCE_MISSING');}
    const usdFact=(fact:FullStageProviderUsdFact|FullStageAllocationFact|null,label:string):UsdBreakdown=>{
      if(fact===null){reason(`${label}_MISSING`);return {factDigest:null,evidenceRefs:[],reportedUsd:null,exactUsd:null,confirmed:false};}
      if(fact.state!=='CONFIRMED')reason(`${label}_UNCONFIRMED`);if(fact.actualUsd===null)reason(`${label}_USD_MISSING`);if(!fact.evidenceRefs.length)reason(`${label}_EVIDENCE_MISSING`);const confirmed=fact.state==='CONFIRMED'&&fact.actualUsd!==null&&fact.evidenceRefs.length>0;
      return {factDigest:digest(fact),evidenceRefs:fact.evidenceRefs,reportedUsd:fact.actualUsd,exactUsd:confirmed?new this.Exact(fact.actualUsd!).toFixed():null,confirmed};
    };
    const provider=usdFact(owned.facts.provider,'PROVIDER'),allocationFact=owned.facts.allocation,allocationUsd=usdFact(allocationFact,'ALLOCATION');
    if(allocationFact&&allocationFact.basisVersion===null)reason('ALLOCATION_BASIS_MISSING');if(allocationFact&&allocationFact.funding===null)reason('ALLOCATION_FUNDING_MISSING');
    const allocation={...allocationUsd,mode:capture.mode,funding:allocationFact?.funding??null,basisVersion:allocationFact?.basisVersion??null,confirmed:allocationUsd.confirmed&&allocationFact?.basisVersion!==null&&allocationFact?.funding!==null};
    if(!allocation.confirmed)allocation.exactUsd=null;
    if(owned.facts.quantities===null)reason('QUANTITIES_MISSING');const quantityById=new Map((owned.facts.quantities??[]).map(fact=>[fact.componentId,fact]));
    const declared=this.snapshot?.components??(owned.facts.quantities??[]).map(fact=>({componentId:fact.componentId,kind:null,unit:fact.unit,rateVersion:null,usdPerUnit:null,evidenceRefs:[]}));
    const components:ComponentBreakdown[]=declared.map(rate=>{
      const fact=quantityById.get(rate.componentId);if(rate.usdPerUnit===null)reason('RATE_MISSING',rate.componentId);if(rate.rateVersion===null)reason('RATE_VERSION_MISSING',rate.componentId);if(!rate.evidenceRefs.length)reason('RATE_EVIDENCE_MISSING',rate.componentId);
      if(!fact)reason('QUANTITY_MISSING',rate.componentId);else{if(fact.state!=='CONFIRMED')reason('QUANTITY_UNCONFIRMED',rate.componentId);if(fact.quantity===null)reason('QUANTITY_MISSING',rate.componentId);if(!fact.evidenceRefs.length)reason('QUANTITY_EVIDENCE_MISSING',rate.componentId);}
      const confirmed=this.snapshot?.state==='MEASURED'&&this.snapshot.evidenceRefs.length>0&&rate.usdPerUnit!==null&&rate.rateVersion!==null&&rate.evidenceRefs.length>0&&!!fact&&fact.state==='CONFIRMED'&&fact.quantity!==null&&fact.evidenceRefs.length>0;
      return {componentId:rate.componentId,kind:rate.kind,unit:rate.unit,rateVersion:rate.rateVersion,usdPerUnit:rate.usdPerUnit,rateDigest:this.snapshot?digest(rate):null,rateEvidenceRefs:[...rate.evidenceRefs],quantity:fact?.quantity??null,quantityDigest:fact?digest(fact):null,quantityEvidenceRefs:fact?.evidenceRefs??[],confirmed,exactUsd:confirmed?new this.Exact(rate.usdPerUnit!).times(fact!.quantity!).toFixed():null};
    });
    let total=new this.Exact(0);for(const part of [provider,...components,allocation])if(part.confirmed&&part.exactUsd!==null)total=total.plus(part.exactUsd);
    // Nonnegative known terms cannot be cancelled by an unknown term. Reject
    // a proven overflow rather than hiding it inside an unconfirmed result.
    must(total.lt('10000000000000000'),'FULL_STAGE_COST_OVERFLOW');let actualUsd:string|null=null,exactTotalUsd:string|null=null;
    if(reasons.length===0){exactTotalUsd=total.toFixed();actualUsd=total.toFixed(12,this.snapshot!.rounding==='UP'?this.Exact.ROUND_UP:this.Exact.ROUND_HALF_UP);must(numeric.test(actualUsd),'FULL_STAGE_COST_OVERFLOW');}
    const result={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,state:reasons.length?'UNCONFIRMED' as const:'CONFIRMED' as const,reasons,capture,captureDigest:capture.captureDigest,snapshot:owned.snapshot,snapshotDigest:this.snapshotDigest,facts:owned.facts,factsDigest:digest(owned.facts),basisVersion:this.snapshot?.basisVersion??null,usdScale:this.snapshot?.usdScale??null,rounding:this.snapshot?.rounding??null,breakdown:{provider,components,allocation},exactTotalUsd,actualUsd};
    must(Buffer.byteLength(JSON.stringify(result))<=this.bounds.maxOutputBytes,boundsCode);return freeze(result);
  }
}
