import Decimal from 'decimal.js';
import {describe,expect,it,vi} from 'vitest';
import {digest} from '../../packages/contracts/src/intent.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostFacts,type FullStageCostSnapshot,type FullStageExecutionCapture} from '../../packages/domain/src/full-stage-cost.js';

// Owned facts below exercise a private reader contract. These labels, amounts,
// references and units are fixtures, never actual measurement or price proof.
const limits=():FullStageCostBounds=>({maxInputBytes:64*1024,maxOutputBytes:128*1024,maxComponents:16,maxEvidenceRefs:128,maxStringBytes:256});
const original=():FullStageExecutionCapture=>({accountId:'10000000-0000-4000-8000-000000000001',executionId:'20000000-0000-4000-8000-000000000001',inputDigest:'a'.repeat(64),inputFingerprint:'b'.repeat(64),stage:'CLEANUP',profileDigest:'c'.repeat(64),mode:'PAID'});
const basis=():FullStageCostSnapshot=>({version:1,state:'MEASURED',stage:'CLEANUP',profileDigest:'c'.repeat(64),basisVersion:'owned-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned:measurement'],components:[
  {componentId:'mask',kind:'IMAGE',unit:'owned-mask-mpixel',rateVersion:'owned-mask-rate-v1',usdPerUnit:'0.1',evidenceRefs:['owned:mask-rate']},
  {componentId:'render',kind:'RENDER',unit:'owned-render-mpixel',rateVersion:'owned-render-rate-v1',usdPerUnit:'0.03',evidenceRefs:['owned:render-rate']},
  {componentId:'store',kind:'STORAGE',unit:'owned-byte-day',rateVersion:'owned-store-rate-v1',usdPerUnit:'0.0002',evidenceRefs:['owned:store-rate']},
]});
function specimen(snapshot:FullStageCostSnapshot|null=basis(),capture=original(),bounds=limits()){
  const calculator=new FullStageCostCalculator(snapshot,bounds),captureDigest=calculator.capture(capture).captureDigest;
  const facts:FullStageCostFacts={provider:{scope:'ACTUAL_AI_USD',captureDigest,state:'CONFIRMED',actualUsd:'0.2',evidenceRefs:['owned:provider']},quantities:(snapshot?.components??basis().components).map((component,index)=>({componentId:component.componentId,captureDigest,state:'CONFIRMED',quantity:['0.2','2','10'][index]??'1',unit:component.unit,evidenceRefs:[`owned:quantity:${component.componentId}`]})),allocation:{captureDigest,mode:capture.mode,funding:capture.mode==='FREE'?'FREE_OPERATIONS':'PAID_PROCESSING',basisVersion:snapshot?.basisVersion??'owned-basis-v1',state:'CONFIRMED',actualUsd:'0.04',evidenceRefs:['owned:allocation']}};
  return {calculator,capture,captureDigest,snapshot,facts,bounds,calculate:()=>calculator.calculate(capture,facts)};
}
function oneTerm(rounding:FullStageCostSnapshot['rounding']='HALF_UP'){
  const snapshot=basis();snapshot.components=snapshot.components.slice(0,1);snapshot.rounding=rounding;
  const s=specimen(snapshot);s.facts.provider!.actualUsd='0';s.facts.allocation!.actualUsd='0';return s;
}
const cast=<T>(value:unknown):T=>value as T;
function reject(action:()=>unknown,code?:string){expect(action).toThrow(code??/^FULL_STAGE_COST_/);}
const codes=(result:ReturnType<FullStageCostCalculator['calculate']>)=>result.reasons.map(reason=>reason.code);

describe('pure full stage cost',()=>{
  it('links exact USD parts, immutable original capture, and all raw fact digests',()=>{
    const s=specimen(),result=s.calculate();
    expect(result).toMatchObject({version:1,scope:'FULL_STAGE_PROCESS',state:'CONFIRMED',reasons:[],basisVersion:'owned-basis-v1',usdScale:12,rounding:'HALF_UP',exactTotalUsd:'0.322',actualUsd:'0.322000000000',captureDigest:s.captureDigest});
    expect(result.breakdown.components.map(part=>part.exactUsd)).toEqual(['0.02','0.06','0.002']);
    expect(result.capture).toEqual({...s.capture,captureDigest:s.captureDigest});
    expect(s.captureDigest).toBe(digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture:s.capture}));
    expect(result.snapshotDigest).toBe(digest(s.snapshot));expect(result.factsDigest).toBe(digest(s.facts));
    expect(result.breakdown.provider.factDigest).toBe(digest(s.facts.provider));expect(result.breakdown.allocation.factDigest).toBe(digest(s.facts.allocation));
    expect(result.breakdown.components[0]).toMatchObject({rateDigest:digest(s.snapshot!.components[0]),quantityDigest:digest(s.facts.quantities![0]),rateEvidenceRefs:['owned:mask-rate'],quantityEvidenceRefs:['owned:quantity:mask'],unit:'owned-mask-mpixel'});
  });

  it('quantizes the final sum once, retaining exact sub-scale products',()=>{
    const snapshot=basis();snapshot.components=Array.from({length:5},(_,index)=>({componentId:`sub-${index}`,kind:'IMAGE',unit:'owned-unit',rateVersion:'owned-rate',usdPerUnit:'0.000000000001',evidenceRefs:[`owned:rate:${index}`]}));
    const s=specimen(snapshot);s.facts.provider!.actualUsd='0';s.facts.allocation!.actualUsd='0';for(const row of s.facts.quantities!)row.quantity='0.1';
    const result=s.calculate();expect(result.breakdown.components.map(part=>part.exactUsd)).toEqual(Array(5).fill('0.0000000000001'));
    expect(result.exactTotalUsd).toBe('0.0000000000005');expect(result.actualUsd).toBe('0.000000000001');
  });

  it.each([['UP','0.000000000001'],['HALF_UP','0.000000000000']] as const)('honors explicit %s rounding below the half boundary',(rounding,actual)=>{
    const s=oneTerm(rounding);s.snapshot!.components[0].usdPerUnit='0.000000000001';
    // Rates are captured by the constructor, so intentionally build a new calculator.
    const calculator=new FullStageCostCalculator(s.snapshot!,s.bounds);s.facts.quantities![0].quantity='0.1';
    const result=calculator.calculate(s.capture,s.facts);expect(result.exactTotalUsd).toBe('0.0000000000001');expect(result.actualUsd).toBe(actual);
  });

  it('preserves the largest NUMERIC(28,12) value without binary float loss',()=>{
    const s=oneTerm();s.facts.provider!.actualUsd='9999999999999999.999999999999';s.facts.quantities![0].quantity='0';
    expect(s.calculate().actualUsd).toBe('9999999999999999.999999999999');
  });

  it('keeps 24 fractional product digits alongside the largest integer total',()=>{
    const snapshot=basis();snapshot.components=snapshot.components.slice(0,1);snapshot.components[0].usdPerUnit='0.000000000001';
    const s=specimen(snapshot);s.facts.quantities![0].quantity='0.000000000001';s.facts.provider!.actualUsd='9999999999999999';s.facts.allocation!.actualUsd='0';
    const result=s.calculate();expect(result.exactTotalUsd).toBe('9999999999999999.000000000000000000000001');expect(result.actualUsd).toBe('9999999999999999.000000000000');
  });

  it('preserves exact products and sum carry at the explicitly bounded component count',()=>{
    const bounds={...limits(),maxComponents:16},snapshot=basis();snapshot.components=Array.from({length:16},(_,index)=>({componentId:`term-${index}`,kind:'IMAGE',unit:'owned-unit',rateVersion:'owned-rate',usdPerUnit:'0.999999999999',evidenceRefs:[`owned:rate:${index}`]}));
    const s=specimen(snapshot,original(),bounds);s.facts.provider!.actualUsd='0';s.facts.allocation!.actualUsd='0';for(const row of s.facts.quantities!)row.quantity='999999999999.999999999999';
    const result=s.calculate();expect(result.breakdown.components[0].exactUsd).toBe('999999999998.999999999999000000000001');
    expect(result.exactTotalUsd).toBe('15999999999983.999999999984000000000016');expect(result.actualUsd).toBe('15999999999983.999999999984');
  });

  it.each(['sum','product','quantization','known-subtotal'] as const)('rejects %s overflow',(caseName)=>{
    const snapshot=basis();snapshot.components=snapshot.components.slice(0,1);snapshot.rounding='UP';snapshot.components[0].usdPerUnit=caseName==='product'?'9999999999999999':'0.000000000001';
    const s=specimen(snapshot);s.facts.allocation!.actualUsd='0';
    if(caseName==='product'){s.facts.quantities![0].quantity='2';s.facts.provider!.actualUsd='0';}
    else if(caseName==='quantization'){s.facts.provider!.actualUsd='9999999999999999.999999999999';s.facts.quantities![0].quantity='0.1';}
    else{s.facts.provider!.actualUsd='9999999999999999.999999999999';s.facts.quantities![0].quantity='1';if(caseName==='known-subtotal')s.facts.allocation=null;}
    reject(s.calculate,'FULL_STAGE_COST_OVERFLOW');
  });

  it('allows a representable HALF_UP result from an exact sub-scale residue near the upper boundary',()=>{
    const snapshot=basis();snapshot.components=snapshot.components.slice(0,1);snapshot.components[0].usdPerUnit='0.000000000001';
    const s=specimen(snapshot);s.facts.provider!.actualUsd='9999999999999999.999999999999';s.facts.allocation!.actualUsd='0';s.facts.quantities![0].quantity='0.1';
    expect(s.calculate().actualUsd).toBe('9999999999999999.999999999999');
  });

  it('isolates Decimal arithmetic from later global precision and rounding changes',()=>{
    const s=specimen(),precision=Decimal.precision,rounding=Decimal.rounding;
    try{Decimal.set({precision:2,rounding:Decimal.ROUND_DOWN});expect(s.calculate().actualUsd).toBe('0.322000000000');}
    finally{Decimal.set({precision,rounding});}
  });

  it('owns Decimal exponent bounds even if global settings changed before construction',()=>{
    const previous={precision:Decimal.precision,rounding:Decimal.rounding,minE:Decimal.minE,maxE:Decimal.maxE};
    try{Decimal.set({precision:2,rounding:Decimal.ROUND_DOWN,minE:0,maxE:2});expect(specimen().calculate().actualUsd).toBe('0.322000000000');}
    finally{Decimal.set(previous);}
  });

  it.each(['-1','-0','01','1e-3','NaN','Infinity','0.0000000000001','.1','1.','10000000000000000',0.1] as const)('rejects malformed or out-of-domain numeric %s',(value)=>{
    const s=specimen();s.facts.provider!.actualUsd=cast<string>(value);reject(s.calculate);
  });

  it.each(['rate','quantity','allocation'] as const)('applies the same numeric domain to %s',(target)=>{
    const s=specimen();if(target==='rate'){s.snapshot!.components[0].usdPerUnit='1e-3';reject(()=>new FullStageCostCalculator(s.snapshot!,s.bounds));}
    else{if(target==='quantity')s.facts.quantities![0].quantity='-1';else s.facts.allocation!.actualUsd='1.0000000000001';reject(s.calculate);}
  });

  it('requires an explicit rounding mode and scale without defaults',()=>{
    const snapshot=basis();snapshot.rounding=cast<FullStageCostSnapshot['rounding']>(null);reject(()=>new FullStageCostCalculator(snapshot,limits()));
    const other=basis();other.usdScale=cast<12>(2);reject(()=>new FullStageCostCalculator(other,limits()));
  });
});

describe('NULL, confirmation and full coverage',()=>{
  it('retains known facts and quantities when the entire snapshot is absent',()=>{
    const s=specimen(null),result=s.calculate();expect(result).toMatchObject({state:'UNCONFIRMED',snapshot:null,snapshotDigest:null,basisVersion:null,usdScale:null,rounding:null,actualUsd:null,exactTotalUsd:null});
    expect(codes(result)).toContain('SNAPSHOT_MISSING');expect(result.facts).toEqual(s.facts);expect(result.factsDigest).toBe(digest(s.facts));
    expect(result.breakdown.provider).toMatchObject({reportedUsd:'0.2',exactUsd:'0.2',confirmed:true,evidenceRefs:['owned:provider']});
    expect(result.breakdown.components[0]).toMatchObject({kind:null,quantity:'0.2',unit:'owned-mask-mpixel',rateDigest:null,exactUsd:null});
  });

  it.each([
    ['snapshot-unmeasured','SNAPSHOT_UNMEASURED'],['snapshot-evidence','SNAPSHOT_EVIDENCE_MISSING'],['rate-null','RATE_MISSING'],['rate-version-null','RATE_VERSION_MISSING'],['rate-evidence','RATE_EVIDENCE_MISSING'],
  ] as const)('does not turn %s into zero',(target,reason)=>{
    const snapshot=basis();if(target==='snapshot-unmeasured')snapshot.state='UNMEASURED';else if(target==='snapshot-evidence')snapshot.evidenceRefs=[];else if(target==='rate-null')snapshot.components[0].usdPerUnit=null;else if(target==='rate-version-null')snapshot.components[0].rateVersion=null;else snapshot.components[0].evidenceRefs=[];
    const s=specimen(snapshot),result=s.calculate();expect(result.state).toBe('UNCONFIRMED');expect(result.actualUsd).toBeNull();expect(result.exactTotalUsd).toBeNull();expect(codes(result)).toContain(reason);expect(result.snapshotDigest).toBe(digest(snapshot));expect(result.factsDigest).toBe(digest(s.facts));
  });

  it.each([
    ['provider-missing','PROVIDER_MISSING'],['provider-unconfirmed','PROVIDER_UNCONFIRMED'],['provider-null','PROVIDER_USD_MISSING'],['provider-evidence','PROVIDER_EVIDENCE_MISSING'],
    ['quantities-missing','QUANTITIES_MISSING'],['quantity-missing','QUANTITY_MISSING'],['quantity-null','QUANTITY_MISSING'],['quantity-unconfirmed','QUANTITY_UNCONFIRMED'],['quantity-evidence','QUANTITY_EVIDENCE_MISSING'],
    ['allocation-missing','ALLOCATION_MISSING'],['allocation-unconfirmed','ALLOCATION_UNCONFIRMED'],['allocation-null','ALLOCATION_USD_MISSING'],['allocation-evidence','ALLOCATION_EVIDENCE_MISSING'],['allocation-basis','ALLOCATION_BASIS_MISSING'],['allocation-funding','ALLOCATION_FUNDING_MISSING'],
  ] as const)('retains unknown %s rather than inferring zero',(target,reason)=>{
    const s=specimen();switch(target){
      case 'provider-missing':s.facts.provider=null;break;case 'provider-unconfirmed':s.facts.provider!.state='UNCONFIRMED';break;case 'provider-null':s.facts.provider!.actualUsd=null;break;case 'provider-evidence':s.facts.provider!.evidenceRefs=[];break;
      case 'quantities-missing':s.facts.quantities=null;break;case 'quantity-missing':s.facts.quantities!.shift();break;case 'quantity-null':s.facts.quantities![0].quantity=null;break;case 'quantity-unconfirmed':s.facts.quantities![0].state='UNCONFIRMED';break;case 'quantity-evidence':s.facts.quantities![0].evidenceRefs=[];break;
      case 'allocation-missing':s.facts.allocation=null;break;case 'allocation-unconfirmed':s.facts.allocation!.state='UNCONFIRMED';break;case 'allocation-null':s.facts.allocation!.actualUsd=null;break;case 'allocation-evidence':s.facts.allocation!.evidenceRefs=[];break;case 'allocation-basis':s.facts.allocation!.basisVersion=null;break;case 'allocation-funding':s.facts.allocation!.funding=null;break;
    }
    const result=s.calculate();expect(result.state).toBe('UNCONFIRMED');expect(result.actualUsd).toBeNull();expect(result.exactTotalUsd).toBeNull();expect(codes(result)).toContain(reason);expect(result.facts).toEqual(s.facts);expect(result.factsDigest).toBe(digest(s.facts));
  });

  it('rejects an empty MEASURED coverage instead of confirming provider-only total cost',()=>{
    const snapshot=basis();snapshot.components=[];reject(()=>new FullStageCostCalculator(snapshot,limits()),'FULL_STAGE_COST_COVERAGE_MISSING');
  });

  it('retains an empty UNMEASURED declaration without inventing component coverage',()=>{
    const snapshot=basis();snapshot.state='UNMEASURED';snapshot.components=[];
    const s=specimen(snapshot),result=s.calculate();expect(result.state).toBe('UNCONFIRMED');expect(result.actualUsd).toBeNull();expect(result.breakdown.components).toEqual([]);expect(codes(result)).toContain('SNAPSHOT_UNMEASURED');
  });

  it('accepts zero only when every declared zero has an explicit evidence reference',()=>{
    const snapshot=basis();for(const component of snapshot.components)component.usdPerUnit='0.000';
    const s=specimen(snapshot);s.facts.provider!.actualUsd='0';s.facts.allocation!.actualUsd='0.000000000000';for(const row of s.facts.quantities!)row.quantity='0';
    const result=s.calculate();expect(result.state).toBe('CONFIRMED');expect(result.exactTotalUsd).toBe('0');expect(result.actualUsd).toBe('0.000000000000');
    expect(result.breakdown.components.every(part=>part.confirmed&&part.exactUsd==='0')).toBe(true);
  });

  it.each(['provider','allocation','quantity','rate'] as const)('rejects an explicit zero without evidence in %s',(target)=>{
    const s=specimen();if(target==='rate'){s.snapshot!.components[0].usdPerUnit='0';s.snapshot!.components[0].evidenceRefs=[];reject(()=>new FullStageCostCalculator(s.snapshot!,s.bounds),'FULL_STAGE_COST_ZERO_WITHOUT_EVIDENCE');}
    else{if(target==='quantity'){s.facts.quantities![0].quantity='0.0';s.facts.quantities![0].evidenceRefs=[];s.facts.quantities![0].state='UNCONFIRMED';}else{s.facts[target]!.actualUsd='0';s.facts[target]!.evidenceRefs=[];}reject(s.calculate,'FULL_STAGE_COST_ZERO_WITHOUT_EVIDENCE');}
  });

  it('does not fill a missing required quantity or fold components that use different units',()=>{
    const snapshot=basis();snapshot.components.push({componentId:'cleanup-verification',kind:'IMAGE',unit:'owned-rgba-pixel',rateVersion:'owned-rate-v1',usdPerUnit:'0.1',evidenceRefs:['owned:verification-rate']});
    const s=specimen(snapshot);s.facts.quantities!.pop();const result=s.calculate();expect(result.actualUsd).toBeNull();expect(result.reasons).toContainEqual({code:'QUANTITY_MISSING',componentId:'cleanup-verification'});
    expect(result.breakdown.components.map(part=>part.unit)).toEqual(['owned-mask-mpixel','owned-render-mpixel','owned-byte-day','owned-rgba-pixel']);
  });

  it.each(['rate-duplicate','quantity-duplicate','unknown-quantity','unit'] as const)('rejects %s rather than silently ignoring a row',(target)=>{
    const s=specimen();if(target==='rate-duplicate'){s.snapshot!.components.push(structuredClone(s.snapshot!.components[0]));reject(()=>new FullStageCostCalculator(s.snapshot!,s.bounds),'FULL_STAGE_COST_DUPLICATE_COMPONENT');}
    else{if(target==='quantity-duplicate')s.facts.quantities!.push(structuredClone(s.facts.quantities![0]));else if(target==='unknown-quantity')s.facts.quantities![0].componentId='outside-required-coverage';else s.facts.quantities![0].unit='owned-byte-day';
      reject(s.calculate,target==='quantity-duplicate'?'FULL_STAGE_COST_DUPLICATE_COMPONENT':target==='unit'?'FULL_STAGE_COST_UNIT_CONFLICT':'FULL_STAGE_COST_COVERAGE_CONFLICT');}
  });

  it.each(['provider','quantity','allocation','rate','snapshot'] as const)('rejects duplicate refs within %s',(target)=>{
    const s=specimen();if(target==='snapshot')s.snapshot!.evidenceRefs=['same','same'];else if(target==='rate')s.snapshot!.components[0].evidenceRefs=['same','same'];else if(target==='quantity')s.facts.quantities![0].evidenceRefs=['same','same'];else s.facts[target]!.evidenceRefs=['same','same'];
    reject(target==='snapshot'||target==='rate'?()=>new FullStageCostCalculator(s.snapshot!,s.bounds):s.calculate,'FULL_STAGE_COST_DUPLICATE_EVIDENCE');
  });
});

describe('original execution, funding and past snapshot binding',()=>{
  it.each(['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode'] as const)('binds original %s rather than borrowing another execution',(field)=>{
    const s=specimen(),capture={...s.capture};if(field==='accountId'||field==='executionId')capture[field]='30000000-0000-4000-8000-000000000001';else if(field==='stage')capture.stage='TYPESET';else if(field==='mode')capture.mode='FREE';else capture[field]='d'.repeat(64);
    expect(s.calculator.capture(capture).captureDigest).not.toBe(s.captureDigest);reject(()=>s.calculator.calculate(capture,s.facts),'FULL_STAGE_COST_BINDING_CONFLICT');
  });

  it.each(['provider','quantity','allocation'] as const)('rejects a cross-execution %s fact even if unconfirmed',(target)=>{
    const s=specimen();const fact=target==='quantity'?s.facts.quantities![0]:s.facts[target]!;fact.captureDigest='d'.repeat(64);fact.state='UNCONFIRMED';reject(s.calculate,'FULL_STAGE_COST_BINDING_CONFLICT');
  });

  it.each(['stage','profileDigest'] as const)('rejects a snapshot for a different %s',(field)=>{
    const snapshot=basis();if(field==='stage')snapshot.stage='OCR';else snapshot.profileDigest='d'.repeat(64);const s=specimen(snapshot);reject(s.calculate,'FULL_STAGE_COST_BINDING_CONFLICT');
  });

  it('rejects a mismatched allocation basis version or mode',()=>{
    const s=specimen();s.facts.allocation!.basisVersion='other-basis';reject(s.calculate,'FULL_STAGE_COST_BINDING_CONFLICT');
    s.facts.allocation!.basisVersion='owned-basis-v1';s.facts.allocation!.mode='FREE';reject(s.calculate,'FULL_STAGE_COST_BINDING_CONFLICT');
  });

  it.each(['CONFIRMED','UNCONFIRMED'] as const)('refuses FREE_OPERATIONS funding on PAID even when %s',(state)=>{
    const s=specimen();s.facts.allocation!.funding='FREE_OPERATIONS';s.facts.allocation!.state=state;reject(s.calculate,'FULL_STAGE_COST_FREE_ALLOCATION_FOR_PAID');
  });

  it.each(['CONFIRMED','UNCONFIRMED'] as const)('refuses PAID_PROCESSING funding on FREE even when %s',(state)=>{
    const capture=original();capture.mode='FREE';const s=specimen(basis(),capture);s.facts.allocation!.funding='PAID_PROCESSING';s.facts.allocation!.state=state;reject(s.calculate,'FULL_STAGE_COST_PAID_ALLOCATION_FOR_FREE');
  });

  it('preserves FREE actual USD under its original pool without producing a bill or credit',()=>{
    const capture=original();capture.mode='FREE';const s=specimen(basis(),capture),result=s.calculate();expect(result.actualUsd).toBe('0.322000000000');expect(result.breakdown.allocation).toMatchObject({mode:'FREE',funding:'FREE_OPERATIONS',reportedUsd:'0.04'});
    expect(result).not.toHaveProperty('credits');expect(result).not.toHaveProperty('settlement');expect(result.capture.mode).toBe('FREE');
  });

  it('owns original rates, units, versions and bounds before caller mutation',()=>{
    const s=specimen(),before=s.calculate();s.snapshot!.basisVersion='new-basis';s.snapshot!.components[0].usdPerUnit='9';s.snapshot!.components[0].unit='caller-unit';s.snapshot!.components[0].evidenceRefs[0]='caller-ref';s.snapshot!.components.push(structuredClone(s.snapshot!.components[1]));s.bounds.maxInputBytes=1;s.bounds.maxEvidenceRefs=1;
    expect(s.calculate()).toEqual(before);expect(before.snapshot!.components[0].usdPerUnit).toBe('0.1');
  });

  it('uses a new explicit snapshot only in a new calculator, preserving the old result',()=>{
    const s=specimen(),before=s.calculate(),next=structuredClone(s.snapshot!);next.basisVersion='owned-basis-v2';next.components[0].rateVersion='owned-mask-rate-v2';next.components[0].usdPerUnit='0.2';
    const calculator=new FullStageCostCalculator(next,limits()),facts=structuredClone(s.facts);facts.allocation!.basisVersion=next.basisVersion;const result=calculator.calculate(s.capture,facts);
    expect(result.actualUsd).toBe('0.342000000000');expect(result.snapshotDigest).not.toBe(before.snapshotDigest);expect(result.captureDigest).toBe(before.captureDigest);expect(s.calculate()).toEqual(before);
  });

  it('owns and deeply freezes returned capture, snapshot, facts, refs and breakdown',()=>{
    const s=specimen(),result=s.calculate(),saved=JSON.stringify(result);s.capture.inputDigest='d'.repeat(64);s.facts.provider!.actualUsd='9';s.facts.quantities![0].quantity='9';s.facts.allocation!.evidenceRefs[0]='changed';
    expect(JSON.stringify(result)).toBe(saved);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.facts.quantities)).toBe(true);expect(Object.isFrozen(result.breakdown.components[0].quantityEvidenceRefs)).toBe(true);
    reject(()=>{cast<string[]>(result.facts.provider!.evidenceRefs).push('caller');},'extensible');
  });
});

describe('closed plain data and explicit byte, row and reference bounds',()=>{
  it.each(['capture','bounds'] as const)('rejects a %s Proxy before any get trap runs',(target)=>{
    const s=specimen(),read=vi.fn((value:object,key:PropertyKey,receiver:unknown)=>Reflect.get(value,key,receiver));
    if(target==='capture')s.capture=new Proxy<FullStageExecutionCapture>(s.capture,{get:read});else s.bounds=new Proxy<FullStageCostBounds>(s.bounds,{get:read});
    reject(target==='capture'?()=>s.calculator.capture(s.capture):()=>new FullStageCostCalculator(s.snapshot!,s.bounds));expect(read).not.toHaveBeenCalled();
  });

  it.each(['capture','facts','provider','quantity','allocation','snapshot','rate','bounds'] as const)('rejects %s getters without calling them',(target)=>{
    const s=specimen(),read=vi.fn(()=>target==='bounds'?1:'caller-value');
    const object=target==='capture'?s.capture:target==='facts'?s.facts:target==='provider'?s.facts.provider!:target==='quantity'?s.facts.quantities![0]:target==='allocation'?s.facts.allocation!:target==='snapshot'?s.snapshot!:target==='rate'?s.snapshot!.components[0]:s.bounds;
    const key=Object.keys(object)[0];Object.defineProperty(object,key,{enumerable:true,get:read});
    reject(target==='snapshot'||target==='rate'||target==='bounds'?()=>new FullStageCostCalculator(s.snapshot!,s.bounds):s.calculate);expect(read).not.toHaveBeenCalled();
  });

  it('rejects an indexed array getter without invoking it',()=>{
    const s=specimen(),read=vi.fn(()=>s.facts.quantities![1]);Object.defineProperty(s.facts.quantities!,'0',{enumerable:true,get:read});reject(s.calculate);expect(read).not.toHaveBeenCalled();
  });

  it.each(['capture','facts','provider','quantity','allocation','snapshot','rate','bounds'] as const)('rejects extra fields on %s',(target)=>{
    const s=specimen();const object=target==='capture'?s.capture:target==='facts'?s.facts:target==='provider'?s.facts.provider!:target==='quantity'?s.facts.quantities![0]:target==='allocation'?s.facts.allocation!:target==='snapshot'?s.snapshot!:target==='rate'?s.snapshot!.components[0]:s.bounds;
    Object.assign(object,{extra:'caller'});reject(target==='snapshot'||target==='rate'||target==='bounds'?()=>new FullStageCostCalculator(s.snapshot!,s.bounds):s.calculate);
  });

  it.each([Buffer.from('owned bytes'),new Date(0),new Map(),Object.create(null),()=>null] as unknown[])('rejects non-plain capability input %s',(input)=>{
    const s=specimen();reject(()=>s.calculator.calculate(cast<FullStageExecutionCapture>(input),s.facts));
  });

  it.each(['symbol','nonenumerable','sparse','array-property','undefined','cycle','surrogate','deep'] as const)('rejects malformed %s without normalization',(kind)=>{
    const s=specimen();switch(kind){
      case 'symbol':Object.defineProperty(s.capture,Symbol('caller'),{value:'x',enumerable:true});break;
      case 'nonenumerable':Object.defineProperty(s.capture,'accountId',{value:s.capture.accountId,enumerable:false});break;
      case 'sparse':delete s.facts.quantities![0];break;
      case 'array-property':Object.assign(s.facts.quantities!,{caller:'x'});break;
      case 'undefined':s.facts.provider!.actualUsd=cast<string>(undefined);break;
      case 'cycle':Object.assign(s.facts.provider!,{cycle:s.facts});break;
      case 'surrogate':s.facts.provider!.evidenceRefs=['\ud800'];break;
      case 'deep':Object.assign(s.facts,{extra:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:'x'}}}}}}}}}}});break;
    }
    reject(s.calculate);
  });

  it.each(['accountId','executionId','inputDigest','inputFingerprint','profileDigest','stage','mode'] as const)('rejects malformed capture %s',(field)=>{
    const s=specimen();s.capture[field]=cast<never>(field==='inputDigest'?'A'.repeat(64):'invalid');reject(()=>s.calculator.capture(s.capture));
  });

  it.each(['maxInputBytes','maxOutputBytes','maxComponents','maxEvidenceRefs','maxStringBytes'] as const)('requires a positive explicit %s',(field)=>{
    for(const value of [0,-1,0.5,Infinity,2147483648]){const bounds=limits();bounds[field]=value;reject(()=>new FullStageCostCalculator(basis(),bounds),'FULL_STAGE_COST_BOUNDS');}
    const missing=limits();delete cast<Partial<FullStageCostBounds>>(missing)[field];reject(()=>new FullStageCostCalculator(basis(),missing));
  });

  it('bounds aggregate snapshot, capture and facts bytes before arithmetic',()=>{
    const s=specimen(),size=Buffer.byteLength(JSON.stringify({capture:s.capture,snapshot:s.snapshot,facts:s.facts}));const calculator=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxInputBytes:size});expect(calculator.calculate(s.capture,s.facts).actualUsd).toBe('0.322000000000');
    const tighter=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxInputBytes:size-1});reject(()=>tighter.calculate(s.capture,s.facts),'FULL_STAGE_COST_BOUNDS');
  });

  it('bounds UTF-8 width rather than JavaScript character count',()=>{
    const s=specimen();s.facts.provider!.evidenceRefs=['가'.repeat(86)];reject(s.calculate,'FULL_STAGE_COST_BOUNDS');
  });

  it('bounds declared component rows and fact rows',()=>{
    const s=specimen();reject(()=>new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxComponents:2}),'FULL_STAGE_COST_BOUNDS');
    const calculator=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxComponents:3});s.facts.quantities!.push({...s.facts.quantities![0],componentId:'fourth'});reject(()=>calculator.calculate(s.capture,s.facts),'FULL_STAGE_COST_BOUNDS');
  });

  it('bounds references across the snapshot and all facts, including unknown facts',()=>{
    const s=specimen(),calculator=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxEvidenceRefs:8});s.facts.provider!.state='UNCONFIRMED';reject(()=>calculator.calculate(s.capture,s.facts),'FULL_STAGE_COST_BOUNDS');
    const exact=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxEvidenceRefs:9});expect(exact.calculate(s.capture,s.facts).actualUsd).toBeNull();
  });

  it('bounds the complete result encoding without truncating evidence',()=>{
    const s=specimen(),result=s.calculate(),size=Buffer.byteLength(JSON.stringify(result)),exact=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxOutputBytes:size});expect(exact.calculate(s.capture,s.facts)).toEqual(result);
    const tighter=new FullStageCostCalculator(s.snapshot!,{...s.bounds,maxOutputBytes:size-1});reject(()=>tighter.calculate(s.capture,s.facts),'FULL_STAGE_COST_BOUNDS');
  });
});
