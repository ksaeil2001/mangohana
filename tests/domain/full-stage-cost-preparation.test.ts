import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostFacts,type FullStageCostSnapshot,type FullStageExecutionCapture} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostBasis,FullStageCostJournalView} from '../../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostPreparation,type FullStageCostCatalogEntry,type FullStageCostPreparationJournal} from '../../packages/domain/src/full-stage-cost-preparation.js';
import type {NativeJobClaim} from '../../packages/domain/src/native-jobs.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';

// Owned INPUT, claim, fake journal and explicitly invented catalog only. The
// fixture's MEASURED label proves no measurement, rate, lease or activation.
type Stage=FullStageExecutionCapture['stage'];
const limits=():FullStageCostBounds=>({maxInputBytes:32768,maxOutputBytes:65536,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512});
const view=(basis:FullStageCostBasis|null):FullStageCostJournalView=>({basis,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]});
function basis(input:StageInput,snapshot:FullStageCostSnapshot|null,profileDigest:string,mode:'FREE'|'PAID'='FREE'):FullStageCostBasis{
  const calculation=new FullStageCostCalculator(snapshot,limits()).calculate({accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage as Stage,profileDigest,mode},{provider:null,quantities:null,allocation:null});
  return {version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:structuredClone(calculation.snapshot) as FullStageCostSnapshot|null,snapshotDigest:calculation.snapshotDigest};
}
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(complete=>{resolve=complete;});return {promise,resolve};}
function fixture(stage:Stage='CLEANUP'){
  const settings={settingsVersion:'1',contractVersion:'owned-cost-preparation-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),originalAssetId=randomUUID(),profileDigest=sha256('owned-preparation-profile');
  const input:StageInput={accountId,contextId,executionId,requestId,stage,inputDigest:sha256('owned-preparation-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:stage,stageContract:settings.contractVersion,inputDigest:sha256('owned-preparation-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:'owned-cost-profile'}};
  const claim:NativeJobClaim={generation:'1',ownerId:randomUUID(),workItemId:randomUUID()},snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage,profileDigest,basisVersion:'owned-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-catalog'],components:[{componentId:'mask',kind:'IMAGE',unit:'pixel',rateVersion:'owned-rate-v1',usdPerUnit:'0.001',evidenceRefs:['owned-rate']}]};
  const bounds=limits(),catalog:FullStageCostCatalogEntry[]=[{stage,profileDigest,snapshot}],state:{basis:FullStageCostBasis|null}={basis:null};
  const lookup=vi.fn<FullStageCostPreparationJournal['lookup']>(async()=>view(state.basis));
  const prepare=vi.fn<FullStageCostPreparationJournal['prepare']>(async(original,rates,profile)=>{
    if(state.basis)return {created:false,basis:state.basis};state.basis=basis(original,rates,profile);return {created:true,basis:state.basis};
  });
  const journal:FullStageCostPreparationJournal={lookup,prepare};
  return {input,claim,snapshot,profileDigest,catalog,bounds,state,lookup,prepare,journal,adapter:()=>new FullStageCostPreparation(journal,catalog,bounds)};
}
function proxy<T extends object>(value:T){let calls=0;const trap=()=>{calls++;throw Error('OWNED_PROXY_TRAP');};return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}
function getter<T extends object>(value:T,key:string){let calls=0;Object.defineProperty(value,key,{enumerable:true,configurable:true,get(){calls++;throw Error('OWNED_GETTER');}});return {value,calls:()=>calls};}

describe('private original full-stage cost preparation',()=>{
  it.each(['OCR','TRANSLATE','CLEANUP','TYPESET'] as const)('selects the explicit %s catalog only after original lookup',async stage=>{
    const f=fixture(stage),result=await f.adapter().prepare(f.input,f.claim);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.input);expect(f.prepare).toHaveBeenCalledExactlyOnceWith(f.input,f.snapshot,f.profileDigest,f.claim);expect(f.lookup.mock.invocationCallOrder[0]).toBeLessThan(f.prepare.mock.invocationCallOrder[0]);
    expect(result).toEqual({created:true,basis:basis(f.input,f.snapshot,f.profileDigest)});expect(result.basis.capture.inputFingerprint).toBe(digest(canonicalInput(f.input)));
  });
  it('owns catalog, bounds, INPUT and first claim before a journal wait',async()=>{
    const f=fixture(),original=structuredClone(f.input),rates=structuredClone(f.snapshot),claim=structuredClone(f.claim),gate=deferred<FullStageCostJournalView>();f.lookup.mockReturnValueOnce(gate.promise);
    const adapter=f.adapter(),pending=adapter.prepare(f.input,f.claim);expect(f.prepare).not.toHaveBeenCalled();
    f.input.width=900;f.input.settings.baseFontSizePx=99;f.input.envelope!.assetIds.push(randomUUID());f.input.claimGeneration='7';f.claim.ownerId=randomUUID();f.claim.workItemId=randomUUID();f.claim.generation='7';
    f.snapshot.components[0].usdPerUnit='99';f.catalog[0].profileDigest=sha256('changed-profile');f.catalog.length=0;f.bounds.maxInputBytes=1;f.bounds.maxOutputBytes=1;f.bounds.maxStringBytes=1;
    gate.resolve(view(null));const result=await pending;expect(f.lookup.mock.calls[0][0]).toEqual(original);expect(f.prepare).toHaveBeenCalledExactlyOnceWith(original,rates,f.profileDigest,claim);expect(result.basis.snapshot).toEqual(rates);
  });
  it('isolates the INPUT copies handed to lookup and prepare',async()=>{
    const f=fixture(),original=structuredClone(f.input);f.lookup.mockImplementationOnce(async value=>{value.width=99;value.envelope!.regionIds.push(randomUUID());return view(null);});
    const result=await f.adapter().prepare(f.input,f.claim);expect(f.input).toEqual(original);expect(f.prepare.mock.calls[0][0]).toEqual(original);expect(result.basis.capture.inputFingerprint).toBe(digest(canonicalInput(original)));
  });
  it('captures the journal capability once without a later caller method replacement',async()=>{
    const f=fixture(),adapter=f.adapter(),replacement=vi.fn<FullStageCostPreparationJournal['lookup']>();f.journal.lookup=replacement;
    await adapter.prepare(f.input,f.claim);expect(f.lookup).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled();
  });
  it('owns INPUT and claim while original prepare acknowledgement is pending',async()=>{
    const f=fixture(),original=structuredClone(f.input),claim=structuredClone(f.claim),gate=deferred<{created:boolean;basis:FullStageCostBasis}>();f.prepare.mockReturnValueOnce(gate.promise);
    const pending=f.adapter().prepare(f.input,f.claim);await Promise.resolve();expect(f.prepare).toHaveBeenCalledOnce();f.input.height=99;f.input.initialData.cleanupQa='NEEDS_REVIEW';f.claim.ownerId=randomUUID();
    gate.resolve({created:true,basis:basis(original,f.snapshot,f.profileDigest)});const result=await pending;expect(f.prepare.mock.calls[0][0]).toEqual(original);expect(f.prepare.mock.calls[0][3]).toEqual(claim);expect(result.basis.capture.inputFingerprint).toBe(digest(canonicalInput(original)));
  });
  it('reuses the historical profile and rate snapshot without retroactive selection',async()=>{
    const f=fixture(),oldProfile=sha256('old-profile'),historical=structuredClone(f.snapshot);historical.profileDigest=oldProfile;historical.basisVersion='old-basis';historical.components[0].usdPerUnit='0.00002';
    f.state.basis=basis(f.input,historical,oldProfile);const original=structuredClone(f.state.basis),result=await f.adapter().prepare(f.input,f.claim);
    expect(result).toEqual({created:false,basis:original});expect(result.basis.snapshotDigest).toBe(digest(historical));expect(result.basis.capture.profileDigest).toBe(oldProfile);expect(f.prepare).not.toHaveBeenCalled();
  });
  it('recovers a basis with no current catalog and a detached expired claim tuple',async()=>{
    const f=fixture();f.state.basis=basis(f.input,f.snapshot,f.profileDigest);f.catalog.length=0;const original=structuredClone(f.state.basis),reclaimed={...f.input,claimGeneration:'99'},claim={...f.claim,generation:'99',ownerId:randomUUID(),workItemId:null};
    expect(await f.adapter().prepare(reclaimed,claim)).toEqual({created:false,basis:original});expect(f.prepare).not.toHaveBeenCalled();
  });
  it('returns detached records from an original lookup and a new capture',async()=>{
    const f=fixture(),adapter=f.adapter(),created=await adapter.prepare(f.input,f.claim),saved=structuredClone(f.state.basis);
    created.basis.snapshot!.components[0].usdPerUnit='8';expect(f.state.basis).toEqual(saved);const recovered=await adapter.prepare(f.input,f.claim);recovered.basis.snapshot!.components[0].evidenceRefs.push('caller');
    expect(f.state.basis).toEqual(saved);expect((await adapter.prepare(f.input,f.claim)).basis).toEqual(saved);expect(f.prepare).toHaveBeenCalledOnce();
  });
  it('does not invent a missing stage catalog after original lookup',async()=>{
    const f=fixture();f.catalog.length=0;await expect(f.adapter().prepare(f.input,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CATALOG_MISSING'});expect(f.lookup).toHaveBeenCalledOnce();expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['state','facts'] as const)('holds original %s conflicts without a replacement capture',async condition=>{
    const f=fixture();f.lookup.mockResolvedValueOnce({...view(null),state:condition==='state'?'CONFLICT':'UNCONFIRMED',conflicts:condition==='facts'?['PROVIDER_COST_CONFLICT']:[]});
    await expect(f.adapter().prepare(f.input,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_PREPARATION_CONFLICT'});expect(f.prepare).not.toHaveBeenCalled();
  });
  it('propagates a DB unknown without capture, retry or an assumed empty view',async()=>{
    const f=fixture(),error=Error('OWNED_DB_UNKNOWN');f.lookup.mockRejectedValueOnce(error);await expect(f.adapter().prepare(f.input,f.claim)).rejects.toBe(error);expect(f.lookup).toHaveBeenCalledOnce();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('recovers a committed basis after capture ACK loss using only original lookup',async()=>{
    const f=fixture(),error=Error('OWNED_CAPTURE_ACK_LOST');f.prepare.mockImplementationOnce(async(original,rates,profile)=>{f.state.basis=basis(original,rates,profile);throw error;});
    await expect(f.adapter().prepare(f.input,f.claim)).rejects.toBe(error);expect(f.prepare).toHaveBeenCalledOnce();const original=structuredClone(f.state.basis);f.snapshot.components[0].usdPerUnit='9';
    expect(await f.adapter().prepare(f.input,f.claim)).toEqual({created:false,basis:original});expect(f.prepare).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledTimes(2);
  });
  it('concurrently recovers one original basis instead of making adapter attempts',async()=>{
    const f=fixture(),gate=deferred<FullStageCostJournalView>();f.lookup.mockReturnValue(gate.promise);const adapter=f.adapter(),one=adapter.prepare(f.input,f.claim),two=adapter.prepare(f.input,f.claim);gate.resolve(view(null));
    const results=await Promise.all([one,two]);expect(results.map(result=>result.created).sort()).toEqual([false,true]);expect(results[0].basis).toEqual(results[1].basis);expect(results[0].basis).not.toBe(results[1].basis);expect(f.prepare).toHaveBeenCalledTimes(2);
    f.lookup.mockImplementation(async()=>view(f.state.basis));expect((await adapter.prepare(f.input,f.claim)).created).toBe(false);expect(f.prepare).toHaveBeenCalledTimes(2);
  });
  it('accepts a validated original basis returned by a concurrent first capture',async()=>{
    const f=fixture(),historical=structuredClone(f.snapshot);historical.components[0].usdPerUnit='0.0001';const original=basis(f.input,historical,f.profileDigest);f.prepare.mockResolvedValueOnce({created:false,basis:original});
    expect(await f.adapter().prepare(f.input,f.claim)).toEqual({created:false,basis:original});expect(f.prepare).toHaveBeenCalledOnce();
  });
  it('reuses original basis when the journal also has confirmed calculation history',async()=>{
    const f=fixture(),original=basis(f.input,f.snapshot,f.profileDigest),facts:FullStageCostFacts={provider:{scope:'ACTUAL_AI_USD',captureDigest:original.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:['owned-ai']},quantities:[{componentId:'mask',captureDigest:original.captureDigest,state:'CONFIRMED',quantity:'1',unit:'pixel',evidenceRefs:['owned-pixels']}],allocation:{captureDigest:original.captureDigest,mode:'FREE',funding:'FREE_OPERATIONS',basisVersion:f.snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.001',evidenceRefs:['owned-allocation']}},result=new FullStageCostCalculator(f.snapshot,f.bounds).calculate({accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),stage:'CLEANUP',profileDigest:f.profileDigest,mode:'FREE'},facts);
    expect(result.state).toBe('CONFIRMED');f.lookup.mockResolvedValueOnce({...view(original),state:'CONFIRMED',costUsd:result.actualUsd,calculations:[{evidenceId:randomUUID(),evidenceDigest:digest(result),result}]});
    expect(await f.adapter().prepare(f.input,f.claim)).toEqual({created:false,basis:original});expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['null','unmeasured','missing-rate'] as const)('retains the explicit %s snapshot without fabricated completeness',async kind=>{
    const f=fixture();if(kind==='null')f.catalog[0].snapshot=null;else if(kind==='unmeasured'){f.snapshot.state='UNMEASURED';f.snapshot.components=[];f.snapshot.evidenceRefs=[];}else{f.snapshot.components[0].rateVersion=null;f.snapshot.components[0].usdPerUnit=null;}
    const original=structuredClone(f.catalog[0].snapshot),result=await f.adapter().prepare(f.input,f.claim);expect(result.basis.snapshot).toEqual(original);expect(result.basis.snapshotDigest).toBe(original===null?null:digest(original));expect(f.prepare.mock.calls[0][1]).toEqual(original);
  });
  it.each(['account','execution','input','fingerprint','stage','capture','snapshot','shape'] as const)('rejects a stored %s binding mismatch without replacement',async field=>{
    const f=fixture(),original=basis(f.input,f.snapshot,f.profileDigest),bad=structuredClone(original) as FullStageCostBasis;
    if(field==='account')bad.capture={...bad.capture,accountId:randomUUID()};else if(field==='execution')bad.capture={...bad.capture,executionId:randomUUID()};else if(field==='input')bad.capture={...bad.capture,inputDigest:sha256('other-input')};else if(field==='fingerprint')bad.capture={...bad.capture,inputFingerprint:sha256('other-fingerprint')};else if(field==='stage')bad.capture={...bad.capture,stage:'OCR'};else if(field==='capture')bad.captureDigest=sha256('other-capture');else if(field==='snapshot')bad.snapshotDigest=sha256('other-snapshot');else Object.assign(bad,{extra:true});
    f.lookup.mockResolvedValueOnce(view(bad));await expect(f.adapter().prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects a newly created basis outside the selected snapshot instead of silently accepting it',async()=>{
    const f=fixture(),other=structuredClone(f.snapshot);other.components[0].usdPerUnit='7';f.prepare.mockResolvedValueOnce({created:true,basis:basis(f.input,other,f.profileDigest)});
    await expect(f.adapter().prepare(f.input,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_PREPARATION_BINDING_CONFLICT'});expect(f.prepare).toHaveBeenCalledOnce();
  });
  it.each(['null','extra','confirmed-empty','cost-without-basis','invalid-cost','calculations-without-basis'] as const)('rejects the invalid %s original view without capture',async kind=>{
    const f=fixture(),bad:unknown=kind==='null'?null:kind==='extra'?{...view(null),extra:true}:kind==='confirmed-empty'?{...view(null),state:'CONFIRMED'}:kind==='cost-without-basis'?{...view(null),costUsd:'0'}:kind==='invalid-cost'?{...view(basis(f.input,f.snapshot,f.profileDigest)),costUsd:0}:{...view(null),calculations:[{}]};f.lookup.mockResolvedValueOnce(bad as FullStageCostJournalView);
    await expect(f.adapter().prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['duplicate','unsupported','profile','stage','extra','missing','rows'] as const)('rejects the %s catalog before original lookup',kind=>{
    const f=fixture();if(kind==='duplicate')f.catalog.push(structuredClone(f.catalog[0]));else if(kind==='unsupported')f.catalog[0].stage='EXPORT' as Stage;else if(kind==='profile')f.catalog[0].profileDigest=sha256('other-profile');else if(kind==='stage')f.snapshot.stage='OCR';else if(kind==='extra')Object.assign(f.catalog[0],{extra:true});else if(kind==='missing')delete (f.catalog[0] as Partial<FullStageCostCatalogEntry>).snapshot;else f.snapshot.components.push(structuredClone(f.snapshot.components[0]));
    expect(()=>f.adapter()).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['maxInputBytes','maxOutputBytes','maxComponents','maxEvidenceRefs','maxStringBytes'] as const)('requires an explicit positive %s bound',key=>{
    const f=fixture();for(const value of [0,-1,1.5,Infinity,2147483648]){f.bounds[key]=value;expect(()=>f.adapter()).toThrow();}delete (f.bounds as Partial<FullStageCostBounds>)[key];expect(()=>f.adapter()).toThrow();expect(f.lookup).not.toHaveBeenCalled();
  });
  it('rejects extra bounds and a catalog wider than the stage set',()=>{
    const f=fixture();expect(()=>new FullStageCostPreparation(f.journal,f.catalog,{...f.bounds,extra:true} as FullStageCostBounds)).toThrow();expect(()=>new FullStageCostPreparation(f.journal,Array.from({length:5},()=>f.catalog[0]),f.bounds)).toThrow();expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(['catalog','entry','snapshot','component','bounds','journal','method'] as const)('rejects a %s Proxy before any trap runs',part=>{
    const f=fixture(),bad=part==='catalog'?proxy(f.catalog):part==='entry'?proxy(f.catalog[0]):part==='snapshot'?proxy(f.snapshot):part==='component'?proxy(f.snapshot.components[0]):part==='bounds'?proxy(f.bounds):part==='journal'?proxy(f.journal):proxy(f.lookup);
    if(part==='entry')f.catalog[0]=bad.value as FullStageCostCatalogEntry;else if(part==='snapshot')f.catalog[0].snapshot=bad.value as FullStageCostSnapshot;else if(part==='component')f.snapshot.components[0]=bad.value as FullStageCostSnapshot['components'][number];else if(part==='method')f.journal.lookup=bad.value as FullStageCostPreparationJournal['lookup'];
    expect(()=>new FullStageCostPreparation(part==='journal'?bad.value as FullStageCostPreparationJournal:f.journal,part==='catalog'?bad.value as FullStageCostCatalogEntry[]:f.catalog,part==='bounds'?bad.value as FullStageCostBounds:f.bounds)).toThrow();expect(bad.calls()).toBe(0);expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['catalog','snapshot','bounds','method','array-index','toJSON'] as const)('rejects the %s getter without invocation',part=>{
    const f=fixture(),bad=part==='catalog'?getter(f.catalog[0],'profileDigest'):part==='snapshot'?getter(f.snapshot,'components'):part==='bounds'?getter(f.bounds,'maxInputBytes'):part==='method'?getter(f.journal,'lookup'):part==='array-index'?getter(f.catalog,'0'):getter(f.catalog,'toJSON');
    expect(()=>f.adapter()).toThrow();expect(bad.calls()).toBe(0);expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['input','settings','claim'] as const)('rejects an awaited %s Proxy before traps and journal I/O',async part=>{
    const f=fixture(),adapter=f.adapter(),bad=part==='input'?proxy(f.input):part==='settings'?proxy(f.input.settings):proxy(f.claim);if(part==='settings')f.input.settings=bad.value as StageInput['settings'];
    await expect(adapter.prepare(part==='input'?bad.value as StageInput:f.input,part==='claim'?bad.value as NativeJobClaim:f.claim)).rejects.toHaveProperty('code');expect(bad.calls()).toBe(0);expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['input','claim'] as const)('rejects an awaited %s getter without invoking it',async part=>{
    const f=fixture(),adapter=f.adapter(),bad=part==='input'?getter(f.input,'inputDigest'):getter(f.claim,'ownerId');await expect(adapter.prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(bad.calls()).toBe(0);expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(['extra','owner','generation','missing'] as const)('rejects the malformed %s claim before lookup',async kind=>{
    const f=fixture(),claim:unknown=kind==='extra'?{...f.claim,extra:true}:kind==='owner'?{...f.claim,ownerId:'bad'}:kind==='generation'?{...f.claim,generation:'01'}:undefined;
    await expect(f.adapter().prepare(f.input,claim as NativeJobClaim)).rejects.toHaveProperty('code');expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['null','digest','envelope','context','settings'] as const)('rejects a malformed %s INPUT before journal I/O',async kind=>{
    const f=fixture();if(kind==='digest')f.input.inputDigest=sha256('changed');else if(kind==='envelope')delete f.input.envelope;else if(kind==='context')f.input.contextId=randomUUID();else if(kind==='settings')f.input.settings={...f.input.settings,baseFontSizePx:21};
    await expect(f.adapter().prepare(kind==='null'?null as unknown as StageInput:f.input,f.claim)).rejects.toHaveProperty('code');expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('preserves ordinary fractional geometry as original JSON without money coercion',async()=>{
    const f=fixture();f.input.scope={kind:'PAINTED',selectionId:randomUUID()};f.input.paintStrokes=[{radiusPx:1.5,points:[{x:2.25,y:3.75}]}];const result=await f.adapter().prepare(f.input,f.claim);expect(f.prepare.mock.calls[0][0].paintStrokes).toEqual(f.input.paintStrokes);expect(result.basis.capture.inputFingerprint).toBe(digest(canonicalInput(f.input)));
  });
  it('enforces catalog string and component/evidence widths without I/O',()=>{
    const f=fixture();f.snapshot.basisVersion='가'.repeat(171);expect(()=>f.adapter()).toThrow();f.snapshot.basisVersion='owned';f.bounds.maxComponents=1;f.snapshot.components.push({...f.snapshot.components[0],componentId:'other'});expect(()=>f.adapter()).toThrow();f.snapshot.components.length=1;f.bounds.maxEvidenceRefs=1;expect(()=>f.adapter()).toThrow();expect(f.lookup).not.toHaveBeenCalled();
  });
  it('bounds complete INPUT bytes before lookup and does not copy absent facts into zeros',async()=>{
    const f=fixture();f.bounds.maxInputBytes=2048;const adapter=f.adapter();f.input.paintStrokes=Array.from({length:150},()=>({radiusPx:1,points:[{x:2,y:3}]}));await expect(adapter.prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('bounds returned journal bytes before original reuse or new capture',async()=>{
    const f=fixture();f.bounds.maxOutputBytes=32;const adapter=f.adapter();await expect(adapter.prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(f.lookup).toHaveBeenCalledOnce();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects capture response bytes beyond the owned bound without another capture',async()=>{
    const f=fixture();f.bounds.maxOutputBytes=256;await expect(f.adapter().prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(f.lookup).toHaveBeenCalledOnce();expect(f.prepare).toHaveBeenCalledOnce();expect(f.state.basis).not.toBeNull();
  });
  it('bounds the complete catalog before constructing an owned price selection',()=>{
    const f=fixture();f.bounds.maxInputBytes=128;expect(()=>f.adapter()).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects Proxy-bearing original journal replies without traps or replacement',async()=>{
    // Promise assimilation itself reads a root result's `then`; place the
    // untrusted Proxy in the ordinary journal record, before adapter copying.
    const f=fixture(),bad=proxy(basis(f.input,f.snapshot,f.profileDigest));f.lookup.mockResolvedValueOnce(view(bad.value));await expect(f.adapter().prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(bad.calls()).toBe(0);expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects getter-bearing original records without treating them as missing',async()=>{
    const f=fixture(),bad=getter(view(null),'basis');f.lookup.mockResolvedValueOnce(bad.value);await expect(f.adapter().prepare(f.input,f.claim)).rejects.toHaveProperty('code');expect(bad.calls()).toBe(0);expect(f.prepare).not.toHaveBeenCalled();
  });
});
