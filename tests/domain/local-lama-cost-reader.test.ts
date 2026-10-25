import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {FullStageCostCalculator,type FullStageExecutionCapture,type FullStageCostFacts,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostBasis,FullStageCostCalculationRecord,FullStageCostJournalBounds,FullStageCostJournalView} from '../../packages/domain/src/full-stage-cost-journal.js';
import {LocalLaMaJournalCostReader,type LocalLaMaWholeStageClosure,type LocalLaMaWholeStageClosureReader,type LocalLaMaJournalCostOptions} from '../../packages/domain/src/local-lama-cost-reader.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import type {LocalLaMaCapture,LocalLaMaRuntimeFacts} from '../../packages/providers/src/local-lama.js';
import type {LocalLaMaFullCostReader,LocalLaMaInvocationBinding,LocalLaMaOriginalInvocation} from '../../packages/providers/src/local-lama-executor.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';

// Only owned fake INPUT, rates and capability ports. MEASURED/CLOSED labels
// prove no actual inference, lifetime join, profile, cost or operational grant.
type Query=Parameters<LocalLaMaFullCostReader['lookup']>[0];
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(complete=>{resolve=complete;});return {promise,resolve};}
function proxy<T extends object>(value:T){let calls=0;const trap=()=>{calls++;throw Error('OWNED_PROXY_TRAP');};return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}
function getter<T extends object>(value:T,key:string){let calls=0;Object.defineProperty(value,key,{enumerable:true,configurable:true,get(){calls++;throw Error('OWNED_GETTER');}});return {value,calls:()=>calls};}
function fixture(mode:'FREE'|'PAID'='FREE'){
  const bounds:FullStageCostJournalBounds={maxRecordBytes:32768,maxRecords:16,calculator:{maxInputBytes:32768,maxOutputBytes:65536,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}};
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),originalAssetId=randomUUID(),inputDigest=sha256('owned-cost-input');
  const settings={settingsVersion:'1',contractVersion:'owned-local-cost-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'CLEANUP',inputDigest,settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest,assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:'owned-local-cost-profile'}};
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest,profileId:'owned-local-cost-profile',profileDigest:sha256('owned-media-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('owned-weights'),configSha256:sha256('owned-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:sha256('owned-image'),imageByteLength:48,maskSha256:sha256('owned-mask'),maskByteLength:24};
  const capture:LocalLaMaCapture={...body,captureDigest:digest(body)},raw:FullStageExecutionCapture={accountId,executionId,inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'CLEANUP',profileDigest:sha256('owned-cost-profile-distinct-from-media'),mode};
  const snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'CLEANUP',profileDigest:raw.profileDigest,basisVersion:'owned-full-stage-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-rates'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-image-rate-v1',usdPerUnit:'0.001',evidenceRefs:['owned-image-rate']}]};
  const calculator=new FullStageCostCalculator(snapshot,bounds.calculator),initial=calculator.calculate(raw,{provider:null,quantities:null,allocation:null});
  const basis:FullStageCostBasis={version:1,capture:initial.capture,captureDigest:initial.captureDigest,snapshot:structuredClone(initial.snapshot) as FullStageCostSnapshot,snapshotDigest:initial.snapshotDigest};
  const binding:LocalLaMaInvocationBinding={version:1,accountId,requestId,executionId,inputDigest,inputFingerprint:raw.inputFingerprint,fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,mode};
  const original:LocalLaMaOriginalInvocation={version:1,bindingDigest:digest(binding),localCaptureDigest:capture.captureDigest,invocationId:randomUUID()},runtime:LocalLaMaRuntimeFacts={version:1,kind:'LOCAL_LAMA',invocationId:original.invocationId,executionId,inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)},query:Query={binding,original,capture,runtime};
  const facts:FullStageCostFacts={provider:{scope:'ACTUAL_AI_USD',captureDigest:basis.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:['owned-model-cost']},quantities:[{componentId:'image',captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:'2',unit:'pixel',evidenceRefs:['owned-image-pixels']}],allocation:{captureDigest:basis.captureDigest,mode,funding:mode==='FREE'?'FREE_OPERATIONS':'PAID_PROCESSING',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.001',evidenceRefs:['owned-allocation']}};
  const record=(supplied:FullStageCostFacts=facts):FullStageCostCalculationRecord=>{const result=calculator.calculate(raw,supplied),wrapped={version:1,accountId,executionId,inputDigest,inputFingerprint:raw.inputFingerprint,kind:'OPERATIONAL_COST_CALCULATION',value:result};return {evidenceId:randomUUID(),evidenceDigest:digest(wrapped),result:structuredClone(result)};};
  const calculation=record(),proof:LocalLaMaWholeStageClosure={version:1,state:'CLOSED',bindingDigest:digest(binding),fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,invocationId:original.invocationId,runtimeDigest:digest(runtime),workSetDigest:sha256('owned-complete-work-set'),calculationEvidenceId:calculation.evidenceId,calculationEvidenceDigest:calculation.evidenceDigest,factsDigest:calculation.result.factsDigest,evidenceRef:'owned-immutable-closure'};
  const state:{view:FullStageCostJournalView;proof:LocalLaMaWholeStageClosure|null}={view:{basis,state:'CONFIRMED',costUsd:calculation.result.actualUsd,conflicts:[],calculations:[calculation]},proof};
  const lookup=vi.fn<LocalLaMaJournalCostOptions['journal']['lookup']>(async()=>state.view),closedWork=vi.fn<LocalLaMaWholeStageClosureReader['lookup']>(async()=>state.proof),journal={lookup},closure={lookup:closedWork};
  const options:LocalLaMaJournalCostOptions={input,binding,capture,journal,closure,bounds};return {bounds,input,capture,binding,original,runtime,query,raw,snapshot,facts,basis,record,calculation,proof,state,lookup,closedWork,journal,closure,options,reader:()=>new LocalLaMaJournalCostReader(options)};
}

describe('original local LaMa complete cost reader',()=>{
  it.each(['FREE','PAID'] as const)('joins sealed final %s calculation without choosing rates or starting work',async mode=>{
    const f=fixture(mode),reader=f.reader();expect(f.lookup).not.toHaveBeenCalled();expect(f.closedWork).not.toHaveBeenCalled();const reply=await reader.lookup(f.query);
    expect(reply).toEqual({version:1,bindingDigest:digest(f.binding),fullStageCaptureDigest:f.basis.captureDigest,closureEvidenceRef:f.proof.evidenceRef,fullCost:{version:1,scope:'FULL_STAGE_PROCESS',captureDigest:f.capture.captureDigest,runtimeDigest:digest(f.runtime),actualUsd:'0.013000000000',evidenceRef:`execution-evidence:${f.calculation.evidenceId}:${f.calculation.evidenceDigest}`,basisVersion:f.snapshot.basisVersion}});
    expect(reply!.fullCost.captureDigest).not.toBe(reply!.fullStageCaptureDigest);expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.input);expect(f.closedWork).toHaveBeenCalledExactlyOnceWith(f.query);
  });
  it('returns NULL before the complete work set closes even with a confirmed early calculation',async()=>{
    const f=fixture();f.state.proof=null;expect(await f.reader().lookup(f.query)).toBeNull();expect(f.lookup).not.toHaveBeenCalled();
  });
  it('does not mix an earlier same-capture amount with final closure or erase its later conflict',async()=>{
    const f=fixture(),early=structuredClone(f.facts);early.quantities![0].quantity='1';const first=f.record(early);f.state.view={basis:f.basis,state:'CONFIRMED',costUsd:first.result.actualUsd,conflicts:[],calculations:[first]};const reader=f.reader();
    expect(await reader.lookup(f.query)).toBeNull();expect(f.state.view.calculations[0].result.actualUsd).toBe('0.012000000000');f.state.view.calculations.push(f.calculation);f.state.view.state='CONFLICT';f.state.view.costUsd=null;f.state.view.conflicts=['QUANTITY_CONFLICT:image','TOTAL_COST_CONFLICT'];await expect(reader.lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});expect(f.state.view.calculations).toHaveLength(2);
  });
  it('joins a sealed final calculation that arrives after the immutable closure without creating another fact',async()=>{
    const f=fixture(),reader=f.reader();f.state.view={basis:f.basis,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]};expect(await reader.lookup(f.query)).toBeNull();f.state.view.calculations.push(f.calculation);f.state.view.state='CONFIRMED';f.state.view.costUsd=f.calculation.result.actualUsd;expect((await reader.lookup(f.query))!.fullCost.actualUsd).toBe('0.013000000000');expect(f.state.view.calculations).toHaveLength(1);
  });
  it('waits for missing original basis and later joins the original sealed row',async()=>{
    const f=fixture(),complete=structuredClone(f.state.view),reader=f.reader();f.state.view={basis:null,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]};expect(await reader.lookup(f.query)).toBeNull();f.state.view=complete;expect((await reader.lookup(f.query))!.fullCost.actualUsd).toBe(f.calculation.result.actualUsd);
  });
  it('does not use a confirmed previous row when the sealed final facts remain unconfirmed',async()=>{
    const f=fixture(),incomplete=structuredClone(f.facts);incomplete.quantities=null;const pending=f.record(incomplete);f.state.view.calculations.push(pending);f.state.proof={...f.proof,calculationEvidenceId:pending.evidenceId,calculationEvidenceDigest:pending.evidenceDigest,factsDigest:pending.result.factsDigest};expect(await f.reader().lookup(f.query)).toBeNull();
  });
  it('preserves stable original evidenceRef when an equal amount with different evidence arrives first in history',async()=>{
    const f=fixture(),reader=f.reader(),before=await reader.lookup(f.query),same=structuredClone(f.facts);same.provider!.evidenceRefs=['owned-model-cost-second-observation'];const other=f.record(same);f.state.view.calculations.unshift(other);
    expect((await reader.lookup(f.query))!.fullCost).toEqual(before!.fullCost);expect(f.state.view.calculations).toHaveLength(2);
  });
  it('rejects a changed immutable closure instead of silently replacing an earlier amount',async()=>{
    const f=fixture(),reader=f.reader();await reader.lookup(f.query);const same=structuredClone(f.facts);same.provider!.evidenceRefs=['another-fact'];const next=f.record(same);f.state.view.calculations.push(next);f.state.proof={...f.proof,calculationEvidenceId:next.evidenceId,calculationEvidenceDigest:next.evidenceDigest,factsDigest:next.result.factsDigest};
    await expect(reader.lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});expect(f.lookup).toHaveBeenCalledOnce();
  });
  it('holds a vanished prior closure and preserves the first seal',async()=>{
    const f=fixture(),reader=f.reader(),first=await reader.lookup(f.query);f.state.proof=null;await expect(reader.lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});f.state.proof=f.proof;expect(await reader.lookup(f.query)).toEqual(first);
  });
  it.each(['provider','allocation','quantity','offsetting'] as const)('rejects a hidden %s contradiction outside the sealed row',async key=>{
    const f=fixture(),different=structuredClone(f.facts);if(key==='provider')different.provider!.actualUsd='0.02';if(key==='allocation')different.allocation!.actualUsd='0.002';if(key==='quantity')different.quantities![0].quantity='3';if(key==='offsetting'){different.provider!.actualUsd='0.011';different.quantities![0].quantity='1';}const crossed=f.record(different);f.state.view.calculations.push(crossed);
    await expect(f.reader().lookup(f.query)).rejects.toThrow();expect(f.state.view.calculations).toHaveLength(2);
  });
  it('preserves a correctly reported full journal conflict rather than returning its sealed row',async()=>{
    const f=fixture(),different=structuredClone(f.facts);different.provider!.actualUsd='0.02';f.state.view.calculations.push(f.record(different));f.state.view.state='CONFLICT';f.state.view.costUsd=null;f.state.view.conflicts=['PROVIDER_COST_CONFLICT','TOTAL_COST_CONFLICT'];await expect(f.reader().lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});
  });
  it('compares confirmed allocation facts even before the whole calculation is ready',async()=>{
    const f=fixture(),partial=structuredClone(f.facts);partial.allocation!.actualUsd='0.002';partial.allocation!.basisVersion=null;partial.allocation!.funding=null;f.state.view.calculations.push(f.record(partial));await expect(f.reader().lookup(f.query)).rejects.toThrow();
  });
  it.each(['evidenceDigest','factsDigest'] as const)('rejects a closure that references the selected row with wrong %s',async key=>{
    const f=fixture();f.state.proof=key==='evidenceDigest'?{...f.proof,calculationEvidenceDigest:sha256('wrong-row')}:{...f.proof,factsDigest:sha256('wrong-facts')};await expect(f.reader().lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});
  });
  it.each(['basis','amount','digest','duplicate-row','duplicate-facts','state','conflicts'] as const)('rejects a malformed complete journal %s',async key=>{
    const f=fixture();if(key==='basis')f.state.view.basis!.captureDigest=sha256('wrong-basis');if(key==='amount')f.state.view.costUsd='0';if(key==='digest')f.state.view.calculations[0].evidenceDigest=sha256('wrong-evidence');if(key==='duplicate-row')f.state.view.calculations.push(structuredClone(f.calculation));if(key==='duplicate-facts')f.state.view.calculations.push({...structuredClone(f.calculation),evidenceId:randomUUID()});if(key==='state')f.state.view.state='UNCONFIRMED';if(key==='conflicts')f.state.view.conflicts=['invented'];await expect(f.reader().lookup(f.query)).rejects.toThrow();
  });
  it('rejects a forged result outside the sealed row without ignoring unknown records',async()=>{
    const f=fixture(),fake=structuredClone(f.facts);fake.provider!.evidenceRefs=['owned-second'];const extra=f.record(fake);(extra.result as unknown as {actualUsd:string}).actualUsd='0.012';f.state.view.calculations.push(extra);await expect(f.reader().lookup(f.query)).rejects.toThrow();
  });
  it.each(['accountId','requestId','executionId','inputDigest','inputFingerprint','mode','localCaptureDigest','fullStageCaptureDigest'] as const)('rejects a constructor binding with wrong %s',key=>{
    const f=fixture(),changed={...f.binding};if(key==='mode')changed.mode='PAID';else if(key==='accountId'||key==='requestId'||key==='executionId')changed[key]=randomUUID();else changed[key]=sha256('crossed');f.options.binding=changed;
    if(key==='mode'||key==='fullStageCaptureDigest'){const reader=f.reader();expect(reader).toBeInstanceOf(LocalLaMaJournalCostReader);}
    else expect(()=>f.reader()).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.closedWork).not.toHaveBeenCalled();
  });
  it.each(['mode','fullStageCaptureDigest'] as const)('rejects %s mismatch in the original journal instead of minting a new basis',async key=>{
    const f=fixture(),changed={...f.binding};if(key==='mode')changed.mode='PAID';else changed.fullStageCaptureDigest=sha256('wrong-full-stage');f.options.binding=changed;const reader=f.reader(),query={...f.query,binding:changed,original:{...f.original,bindingDigest:digest(changed)}};f.state.proof={...f.proof,bindingDigest:digest(changed),fullStageCaptureDigest:changed.fullStageCaptureDigest};await expect(reader.lookup(query)).rejects.toThrow();
  });
  it.each(['stage','envelope','identity','image','capture-body'] as const)('rejects incorrect CLEANUP source %s before port I/O',key=>{
    const f=fixture();if(key==='stage')f.input.stage='OCR';if(key==='envelope')f.input.envelope!.logicalStepId='OCR';if(key==='identity')(f.capture.identity as unknown as {weightsSha256:string}).weightsSha256='bad';if(key==='image')(f.capture as unknown as {imageSha256:string}).imageSha256='bad';if(key==='capture-body')(f.capture as unknown as {imageByteLength:number}).imageByteLength++;
    expect(()=>f.reader()).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.closedWork).not.toHaveBeenCalled();
  });
  it.each(['binding','original','capture','runtime','identity'] as const)('rejects crossed query %s before either port',async key=>{
    const f=fixture(),reader=f.reader(),query=structuredClone(f.query);if(key==='binding')(query.binding as unknown as {inputDigest:string}).inputDigest=sha256('wrong');if(key==='original')(query.original as unknown as {localCaptureDigest:string}).localCaptureDigest=sha256('wrong');if(key==='capture')(query.capture as unknown as {maskSha256:string}).maskSha256=sha256('wrong');if(key==='runtime')(query.runtime as unknown as {invocationId:string}).invocationId=randomUUID();if(key==='identity')(query.runtime as unknown as {identityDigest:string}).identityDigest=sha256('wrong');await expect(reader.lookup(query)).rejects.toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.closedWork).not.toHaveBeenCalled();
  });
  it('never accepts a new invocation on the same original reader after a first missing closure',async()=>{
    const f=fixture(),reader=f.reader();f.state.proof=null;await reader.lookup(f.query);const query=structuredClone(f.query),newId=randomUUID();(query.original as unknown as {invocationId:string}).invocationId=newId;(query.runtime as unknown as {invocationId:string}).invocationId=newId;await expect(reader.lookup(query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_CONFLICT'});expect(f.closedWork).toHaveBeenCalledOnce();
  });
  it('looks up original cost after claim generation changed without asking for a current lease',async()=>{
    const f=fixture();f.input.claimGeneration='999';const reply=await f.reader().lookup(f.query);expect(reply!.fullCost.actualUsd).toBe(f.calculation.result.actualUsd);expect(f.lookup.mock.calls[0][0].claimGeneration).toBe('999');
  });
  it('owns all constructor records and both port methods before any later mutation',async()=>{
    const f=fixture(),reader=f.reader(),query=structuredClone(f.query),input=structuredClone(f.input),other=vi.fn();f.journal.lookup=other;f.closure.lookup=other;f.input.width=99;(f.binding as unknown as {mode:string}).mode='PAID';(f.capture as unknown as {profileId:string}).profileId='changed';f.bounds.maxRecordBytes=1;f.bounds.calculator.maxInputBytes=1;
    expect((await reader.lookup(query))!.fullCost.actualUsd).toBe('0.013000000000');expect(f.lookup.mock.calls[0][0]).toEqual(input);expect(other).not.toHaveBeenCalled();
  });
  it('owns query before closure wait and isolates the argument handed to that port',async()=>{
    const f=fixture(),reader=f.reader(),query=structuredClone(f.query),gate=deferred<LocalLaMaWholeStageClosure|null>(),original=structuredClone(query);f.closedWork.mockImplementationOnce(value=>{(value.binding as unknown as {mode:string}).mode='PAID';return gate.promise;});const pending=reader.lookup(query);(query.binding as unknown as {inputFingerprint:string}).inputFingerprint=sha256('changed');(query.original as unknown as {invocationId:string}).invocationId=randomUUID();gate.resolve(f.proof);
    expect((await pending)!.bindingDigest).toBe(digest(original.binding));expect(f.query.binding.mode).toBe('FREE');
  });
  it('owns closure proof before journal wait and leaves caller records detached',async()=>{
    const f=fixture(),reader=f.reader(),gate=deferred<FullStageCostJournalView>();f.lookup.mockReturnValueOnce(gate.promise);const pending=reader.lookup(f.query);await Promise.resolve();(f.proof as unknown as {evidenceRef:string}).evidenceRef='caller-changed';gate.resolve(f.state.view);expect((await pending)!.closureEvidenceRef).toBe('owned-immutable-closure');
  });
  it('owns returned full cost and keeps its evidence stable on the next read',async()=>{
    const f=fixture(),reader=f.reader(),first=await reader.lookup(f.query),original=structuredClone(first);(first!.fullCost as unknown as {actualUsd:string;evidenceRef:string}).actualUsd='999';(first!.fullCost as unknown as {evidenceRef:string}).evidenceRef='changed';expect(await reader.lookup(f.query)).toEqual(original);
  });
  it.each(['closure','journal'] as const)('propagates %s lookup failure without replacing it with zero or creating work',async key=>{
    const f=fixture(),error=Error('OWNED_LOOKUP_UNCONFIRMED');if(key==='closure')f.closedWork.mockRejectedValueOnce(error);else f.lookup.mockRejectedValueOnce(error);await expect(f.reader().lookup(f.query)).rejects.toBe(error);
  });
  it.each(['constructor','query','closure','journal','calculation'] as const)('rejects %s Proxy without any reflection trap',async where=>{
    const f=fixture();if(where==='constructor'){const p=proxy(f.input);f.options.input=p.value;expect(()=>f.reader()).toThrow();expect(p.calls()).toBe(0);return;}
    const reader=f.reader();if(where==='query'){const p=proxy(f.query);await expect(reader.lookup(p.value)).rejects.toThrow();expect(p.calls()).toBe(0);return;}
    // A root Proxy is assimilated by Promise.then before the reader receives
    // it. Keep the guard target inside the owned result's evidence field.
    if(where==='closure'){const p=proxy({invalid:'owned-proxy'});f.state.proof={...f.proof,evidenceRef:p.value as unknown as string};await expect(reader.lookup(f.query)).rejects.toMatchObject({code:'LOCAL_LAMA_COST_READER_UNCONFIRMED'});expect(p.calls()).toBe(0);return;}
    if(where==='journal'){const p=proxy(f.state.view.basis!);f.state.view.basis=p.value;await expect(reader.lookup(f.query)).rejects.toThrow();expect(p.calls()).toBe(0);return;}
    const p=proxy(f.calculation.result.facts);(f.state.view.calculations[0].result as unknown as {facts:typeof f.calculation.result.facts}).facts=p.value;await expect(reader.lookup(f.query)).rejects.toThrow();expect(p.calls()).toBe(0);
  });
  it('propagates root Proxy Promise assimilation from a port without producing a cost or reading the journal',async()=>{
    const f=fixture(),reader=f.reader(),keys:string[]=[],error=Error('OWNED_PROMISE_THEN_UNCONFIRMED'),value=new Proxy(f.proof,{get(_target,key){keys.push(String(key));throw error;}});f.closedWork.mockResolvedValueOnce(value);
    await expect(reader.lookup(f.query)).rejects.toBe(error);expect(keys).toEqual(['then']);expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(['options','binding','method','closure','array'] as const)('rejects %s getters without calling them',async where=>{
    const f=fixture();if(where==='options'){const g=getter(f.options,'input');expect(()=>new LocalLaMaJournalCostReader(g.value)).toThrow();expect(g.calls()).toBe(0);return;}
    if(where==='binding'){const g=getter(f.binding,'mode');expect(()=>f.reader()).toThrow();expect(g.calls()).toBe(0);return;}
    if(where==='method'){const g=getter(f.journal,'lookup');expect(()=>f.reader()).toThrow();expect(g.calls()).toBe(0);return;}
    const reader=f.reader();if(where==='closure'){const g=getter(f.proof,'evidenceRef');await expect(reader.lookup(f.query)).rejects.toThrow();expect(g.calls()).toBe(0);return;}
    const g=getter(f.state.view.calculations,'0');await expect(reader.lookup(f.query)).rejects.toThrow();expect(g.calls()).toBe(0);
  });
  it.each(['zero','overflow','records'] as const)('rejects invalid encoded %s bounds before any port calls',key=>{
    const f=fixture();if(key==='zero')f.bounds.maxRecordBytes=0;if(key==='overflow')f.bounds.maxRecords=2147483647;if(key==='records')f.bounds.maxRecords=0;expect(()=>f.reader()).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(f.closedWork).not.toHaveBeenCalled();
  });
  it('rejects oversized returned metadata with explicit encoded bounds',async()=>{
    const f=fixture(),reader=f.reader();f.state.proof={...f.proof,evidenceRef:'x'.repeat(f.bounds.maxRecordBytes)};await expect(reader.lookup(f.query)).rejects.toThrow();expect(f.lookup).not.toHaveBeenCalled();
  });
});
