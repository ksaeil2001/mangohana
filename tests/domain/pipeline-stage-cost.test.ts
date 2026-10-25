import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import type {FullStageCostJournal,FullStageCostJournalView} from '../../packages/domain/src/full-stage-cost-journal.js';
import type {CheckpointValidationJournal,CheckpointValidationAttempt,CheckpointValidationFacts} from '../../packages/domain/src/checkpoint-validation.js';
import type {OperationalStageCostOptions,OperationalStageCostWorkSet,CostEvidenceRef} from '../../packages/domain/src/pipeline-stage-cost.js';

async function fixture(){
  const {OperationalStageCost:Cost}=await import('../../packages/domain/src/pipeline-stage-cost.js');
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),originalAssetId=randomUUID();
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'OCR',inputDigest:sha256('owned-stage-cost-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'OCR',stageContract:settings.contractVersion,inputDigest:sha256('owned-stage-cost-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:'owned-stage-cost-v1'}};
  const claim={generation:'1',ownerId:randomUUID(),workItemId:randomUUID()},view:FullStageCostJournalView={basis:null,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]};
  const tx={account:{account_id:accountId},client:{query:vi.fn(async()=>({rows:[]}))},now:new Date('2026-10-15T00:00:00Z')} as unknown as Transaction;
  const transaction=vi.fn(async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run(tx));
  const db={role:'trio_web_worker',accountTransaction:transaction} as unknown as Database;
  const prepare=vi.fn(async()=>({created:false,basis:null})),lookupIn=vi.fn(async()=>structuredClone(view)),append=vi.fn();
  const preparation={prepare} as unknown as FullStageCostPreparation,journal={db,lookupIn,append} as unknown as FullStageCostJournal;
  const sealedFinalCostIn=vi.fn(async(_tx:Transaction,_input:StageInput,_joinedEvidence:CostEvidenceRef[]):Promise<'VERIFIED'|'WAIT'>=>'WAIT');
  const checkpoints={beginIn:vi.fn(),recordIn:vi.fn(),lookupIn:vi.fn(),verifiedPredecessorsIn:vi.fn(),finalCommitIn:vi.fn(async()=>('WAIT')),sealedFinalCostIn} as unknown as CheckpointValidationJournal;
  const reader={workSetIn:vi.fn(async():Promise<OperationalStageCostWorkSet|null>=>null),checkpointFactsIn:vi.fn(async(_tx:Transaction,_input:StageInput,_attempt:CheckpointValidationAttempt):Promise<CheckpointValidationFacts|null>=>null)};
  const bounds={maxRecordBytes:262144,maxRecords:16,maxSources:16,maxExecutions:32,maxInFlight:4};
  const options:OperationalStageCostOptions={db,preparation,journal,reader,checkpoints,bounds};
  return {Cost,options,input,claim,view,tx,transaction,prepare,lookupIn,append,reader,checkpoints,sealedFinalCostIn};
}

async function sealedFixture(terminal:'TERMINAL_PREPARATION'|'EXECUTION'|null=null){
  const f=await fixture();f.input.stage='TYPESET';f.input.envelope!.logicalStepId='TYPESET';const inputFingerprint=digest(canonicalInput(f.input)),profileDigest=sha256('owned-history-profile');
  const snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'TYPESET',profileDigest,basisVersion:'owned-history-basis',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-rate'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-rate',usdPerUnit:'0.001',evidenceRefs:['owned-rate']}]};
  const calculator=new FullStageCostCalculator(snapshot,{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}),capture={accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint,stage:'TYPESET' as const,profileDigest,mode:'FREE' as const},captureDigest=calculator.calculate(capture,{provider:null,quantities:null,allocation:null}).captureDigest;
  type Row={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};const rows:Row[]=[];
  const put=(kind:string,value:unknown,wrapped=true)=>{const evidenceId=randomUUID(),raw=wrapped?{version:1,accountId:f.input.accountId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint,kind,value}:value,evidenceDigest=digest(raw);rows.push({evidence_id:evidenceId,evidence_digest:evidenceDigest,protected_evidence_ref:evidenceId,kind,protected_observation:raw});return {evidenceId,evidenceDigest};};
  const sources:OperationalStageCostWorkSet['sources']=(['PROVIDER','QUANTITY','ALLOCATION'] as const).map(target=>({sourceOperationId:randomUUID(),sourceEventId:randomUUID(),target,componentId:target==='QUANTITY'?'image':null,evidence:[put('OPERATIONAL_SOURCE',{ownedSource:randomUUID()},false)]}));
  const refs=(target:string)=>sources.find(source=>source.target===target)!.evidence.map(ref=>ref.evidenceId),facts={provider:{scope:'ACTUAL_AI_USD' as const,captureDigest,state:'CONFIRMED' as const,actualUsd:'0.01',evidenceRefs:refs('PROVIDER')},quantities:[{componentId:'image',captureDigest,state:'CONFIRMED' as const,quantity:'2',unit:'pixel',evidenceRefs:refs('QUANTITY')}],allocation:{captureDigest,mode:'FREE' as const,funding:'FREE_OPERATIONS' as const,basisVersion:snapshot.basisVersion,state:'CONFIRMED' as const,actualUsd:'0.004',evidenceRefs:refs('ALLOCATION')}};
  const result=calculator.calculate(capture,facts),basis={version:1 as const,capture:result.capture,captureDigest:result.captureDigest,snapshot,snapshotDigest:result.snapshotDigest},basisRef=put('OPERATIONAL_COST_BASIS',basis),calculationRef=put('OPERATIONAL_COST_CALCULATION',result);
  // This cost-module fixture explicitly trusts the helper port. Actual full
  // attempt/operation/GO/receipt/termination semantics belong to helper tests.
  const historyRef=put('OPERATIONAL_SOURCE',{ownedTrustedFinalHistory:true},false);
  const work:OperationalStageCostWorkSet={version:1,executionId:f.input.executionId,inputFingerprint,captureDigest,completion:terminal??'EXECUTION',joinedEvidence:[...sources.flatMap(source=>source.evidence),...(terminal?[]:[historyRef])],terminationEvidence:[put('OPERATIONAL_HOLD',{ownedNoMoreIo:randomUUID()},false)],sources,facts};
  put('OPERATIONAL_COST_CLOSURE',{version:1,basisEvidenceId:basisRef.evidenceId,basisEvidenceDigest:basisRef.evidenceDigest,workSetDigest:digest(work),workSet:work,calculationEvidenceId:calculationRef.evidenceId,calculationEvidenceDigest:calculationRef.evidenceDigest,factsDigest:result.factsDigest});
  Object.assign(f.view,{basis,state:'CONFIRMED',costUsd:result.actualUsd,calculations:[{...calculationRef,result}]});f.reader.workSetIn.mockImplementation(async()=>work);
  const execution={state:terminal?'FAILED':'SUCCEEDED',dispatch_attempted_at:terminal==='TERMINAL_PREPARATION'?null:f.tx.now,start_confirmed_at:null,request_state:'FAILED'};
  vi.mocked(f.tx.client.query).mockImplementation((async(sql:string,values:unknown[])=>({rows:sql.includes('FROM executions e JOIN processing_requests r')?[execution]:sql.includes('execution_id<>$2')?[]:sql.includes('AND evidence_id=$3')?rows.filter(row=>row.evidence_id===values[2]):rows.filter(row=>row.kind===values[2])})) as never);
  f.sealedFinalCostIn.mockResolvedValue('VERIFIED');
  return {...f,rows,work,calculationRef,result,calculator,capture,put,historyRef,execution};
}

describe('operational original stage cost capability',()=>{
  it('reads dispatched TYPESET REJECTED cost from the original not-started termination without a success FINAL',async()=>{
    const f=await sealedFixture('EXECUTION');f.execution.state='REJECTED';f.sealedFinalCostIn.mockResolvedValue('WAIT');const cost=new f.Cost(f.options),view=await cost.readIn(f.tx,f.input);
    expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.sealedCalculation).toEqual(f.calculationRef);expect(await cost.readIn(f.tx,f.input)).toEqual(view);
    expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('holds dispatched TYPESET REJECTED historical cost when START contradicts not-started termination',async()=>{
    const f=await sealedFixture('EXECUTION');f.execution.state='REJECTED';Object.assign(f.execution,{start_confirmed_at:f.tx.now});const view=await new f.Cost(f.options).readIn(f.tx,f.input);
    expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it.each(['TERMINAL_PREPARATION','EXECUTION'] as const)('reads terminal TYPESET %s actual cost without requiring a successful FINAL history',async completion=>{
    const f=await sealedFixture(completion);f.sealedFinalCostIn.mockResolvedValue('WAIT');
    const earlierFacts=structuredClone(f.work.facts);earlierFacts.provider!.evidenceRefs=[randomUUID()];const result=f.calculator.calculate(f.capture,earlierFacts),earlier=f.put('OPERATIONAL_COST_CALCULATION',result);f.view.calculations.unshift({...earlier,result});
    const cost=new f.Cost(f.options),view=await cost.readIn(f.tx,f.input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.sealedCalculation).toEqual(f.calculationRef);expect(view.sealedCalculation).not.toEqual(earlier);
    expect(await cost.readIn(f.tx,f.input)).toEqual(view);expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['TERMINAL_PREPARATION','EXECUTION'] as const)('holds terminal TYPESET %s when the execution no longer proves original termination',async completion=>{
    const f=await sealedFixture(completion);if(completion==='TERMINAL_PREPARATION'){f.execution.state='PREPARED';f.execution.request_state='ACTIVE';}else f.execution.dispatch_attempted_at=null;
    const view=await new f.Cost(f.options).readIn(f.tx,f.input);expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();
    expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it.each(['TERMINAL_PREPARATION','EXECUTION'] as const)('rejects terminal TYPESET %s historical cost without its raw termination event',async completion=>{
    const f=await sealedFixture(completion),termination=f.work.terminationEvidence[0];f.rows.splice(f.rows.findIndex(row=>row.evidence_id===termination.evidenceId),1);
    await expect(new f.Cost(f.options).readIn(f.tx,f.input)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});
    expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('exports the constructor required to keep calculations separate from closed original work',async()=>{
    await expect(import('../../packages/domain/src/pipeline-stage-cost.js')).resolves.toHaveProperty('OperationalStageCost',expect.any(Function));
  });
  it('requires worker authority, explicit finite bounds and one fixed journal DB',async()=>{
    const f=await fixture();
    for(const maxSources of [0,-1,1.5,Infinity,2147483648])expect(()=>new f.Cost({...f.options,bounds:{...f.options.bounds,maxSources}})).toThrow();
    expect(()=>new f.Cost({...f.options,db:{...f.options.db,role:'trio_web_api'} as Database})).toThrow();
    expect(()=>new f.Cost({...f.options,journal:{...f.options.journal,db:{}} as FullStageCostJournal})).toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('captures method bindings, input and claim copies before awaiting preparation',async()=>{
    const f=await fixture(),cost=new f.Cost(f.options),original=structuredClone(f.input),claim=structuredClone(f.claim);
    const begun=cost.prepare(f.input,f.claim);f.input.width=99;f.claim.generation='2';f.options.preparation.prepare=vi.fn(async()=>{throw Error('REPLACED_PREPARATION');});
    await begun;expect(f.prepare).toHaveBeenCalledWith(original,claim);expect(f.reader.workSetIn).not.toHaveBeenCalled();await cost.idle();
  });
  it('keeps the original checkpoint instance readonly and refuses accessor capabilities without invoking them',async()=>{
    const f=await fixture(),cost=new f.Cost(f.options);expect(cost.checkpoints).toBe(f.checkpoints);
    expect(()=>Object.assign(cost,{checkpoints:{}})).toThrow();
    const getter=vi.fn(()=>f.reader.workSetIn),reader=Object.defineProperty({...f.reader},'workSetIn',{get:getter});
    expect(()=>new f.Cost({...f.options,reader})).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('does not capture current prices or collect original work when a prior INPUT has no basis',async()=>{
    const f=await fixture(),cost=new f.Cost(f.options);
    await expect(cost.finishAttempt(f.input)).resolves.toBeUndefined();
    expect(f.prepare).not.toHaveBeenCalled();expect(f.reader.workSetIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
    expect(await cost.readIn(f.tx,f.input)).toEqual({...f.view,sealedCalculation:null});
  });
  it('rejects capability-bearing input before any DB callback and waits for in-flight preparation',async()=>{
    const f=await fixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
    f.prepare.mockImplementation(async()=>{await gate;return {created:false,basis:null};});const cost=new f.Cost(f.options);
    const pending=cost.prepare(f.input,f.claim);let idle=false;const waiting=cost.idle().then(()=>{idle=true;});await Promise.resolve();expect(idle).toBe(false);release();await pending;await waiting;expect(idle).toBe(true);
    const getter=vi.fn(()=>100),bad=Object.defineProperty(structuredClone(f.input),'width',{get:getter,enumerable:true});
    const calls=f.transaction.mock.calls.length;await expect(cost.finishAttempt(bad)).rejects.toThrow();expect(getter).not.toHaveBeenCalled();expect(f.transaction.mock.calls.length).toBe(calls);
  });
  it('passes checkpoint facts through the fixed DB-only reader with detached arguments and result',async()=>{
    const f=await fixture(),attempt={attemptId:randomUUID()} as CheckpointValidationAttempt,original=structuredClone(f.input),facts:CheckpointValidationFacts={attemptId:attempt.attemptId,operations:[{evidenceId:randomUUID(),evidenceDigest:sha256('owned-checkpoint-operation')}]};
    const read=f.reader.checkpointFactsIn;read.mockImplementation(async()=>facts);const cost=new f.Cost(f.options);
    f.reader.checkpointFactsIn=vi.fn(async()=>{throw Error('REPLACED_CHECKPOINT_READER');});
    const pending=cost.collectCheckpointIn(f.tx,f.input,attempt);f.input.width=100;attempt.attemptId=randomUUID();const result=await pending;
    expect(read).toHaveBeenCalledWith(f.tx,original,{attemptId:facts.attemptId});expect(result).toEqual(facts);result!.operations[0].evidenceId=randomUUID();expect(result).not.toEqual(facts);
    expect(f.transaction).not.toHaveBeenCalled();expect(f.lookupIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('bounds checkpoint operation records and keeps the constructor in-flight limit after caller mutation',async()=>{
    const f=await fixture(),attempt={attemptId:randomUUID()} as CheckpointValidationAttempt;
    f.reader.checkpointFactsIn.mockImplementation(async()=>({attemptId:attempt.attemptId,operations:Array.from({length:f.options.bounds.maxRecords+1},()=>({evidenceId:randomUUID(),evidenceDigest:sha256('owned-operation')}))}));
    const cost=new f.Cost(f.options);await expect(cost.collectCheckpointIn(f.tx,f.input,attempt)).rejects.toThrow();
    let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});f.prepare.mockImplementation(async()=>{await gate;return {created:false,basis:null};});
    f.options.bounds.maxInFlight=100;const active=Array.from({length:4},()=>cost.prepare(f.input,f.claim));
    await expect(cost.prepare(f.input,f.claim)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED'});release();await Promise.all(active);await cost.idle();
  });
  it('requires a fixed historical helper port before any DB or I/O callback',async()=>{
    const f=await fixture(),missing={...f.checkpoints} as Partial<CheckpointValidationJournal>;delete missing.sealedFinalCostIn;
    expect(()=>new f.Cost({...f.options,checkpoints:missing as CheckpointValidationJournal})).toThrow();
    const getter=vi.fn(()=>f.sealedFinalCostIn),accessor=Object.defineProperty({...f.checkpoints},'sealedFinalCostIn',{get:getter});
    expect(()=>new f.Cost({...f.options,checkpoints:accessor as unknown as CheckpointValidationJournal})).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('reads closed TYPESET cost through the fixed trusted history port while current publication waits',async()=>{
    const f=await sealedFixture(),historical=f.sealedFinalCostIn,input=structuredClone(f.input),joined=structuredClone(f.work.joinedEvidence),cost=new f.Cost(f.options);
    Object.assign(f.checkpoints,{sealedFinalCostIn:vi.fn(async()=>{throw Error('REPLACED_HISTORY_HELPER');})});
    const view=await cost.readIn(f.tx,f.input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.sealedCalculation).toEqual(f.calculationRef);
    expect(historical).toHaveBeenCalledExactlyOnceWith(f.tx,input,joined);expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();
    expect(f.reader.workSetIn).toHaveBeenCalledExactlyOnceWith(f.tx,input,f.view.basis);expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
    view.sealedCalculation!.evidenceId=randomUUID();expect((await cost.readIn(f.tx,f.input)).sealedCalculation).toEqual(f.calculationRef);
  });
  it('holds closed TYPESET cost when the historical helper waits without preparing or appending',async()=>{
    const f=await sealedFixture();f.sealedFinalCostIn.mockResolvedValue('WAIT');const cost=new f.Cost(f.options),view=await cost.readIn(f.tx,f.input);
    expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(view.calculations).toHaveLength(1);
    expect(f.sealedFinalCostIn).toHaveBeenCalledExactlyOnceWith(f.tx,f.input,f.work.joinedEvidence);expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
  });
  it('still rejects missing joined original evidence before trusting sealed history',async()=>{
    const f=await sealedFixture(),cost=new f.Cost(f.options);f.rows.splice(f.rows.findIndex(row=>row.evidence_id===f.historyRef.evidenceId),1);
    await expect(cost.readIn(f.tx,f.input)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it.each(['source','history'] as const)('rejects a termination event reused from joined %s evidence independently of source allocation duplicates',async kind=>{
    const f=await sealedFixture(),work=structuredClone(f.work);work.terminationEvidence=[kind==='source'?work.sources[0].evidence[0]:f.historyRef];f.reader.workSetIn.mockResolvedValue(work);
    await expect(new f.Cost(f.options).readIn(f.tx,f.input)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});
    expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('returns the exact sealed calculation when an earlier calculation has equal amounts and quantities but different evidence refs',async()=>{
    const f=await sealedFixture(),earlierFacts=structuredClone(f.work.facts);earlierFacts.provider!.evidenceRefs=[randomUUID()];earlierFacts.quantities![0].evidenceRefs=[randomUUID()];earlierFacts.allocation!.evidenceRefs=[randomUUID()];
    const result=f.calculator.calculate(f.capture,earlierFacts),earlier=f.put('OPERATIONAL_COST_CALCULATION',result);f.view.calculations.unshift({...earlier,result});
    expect(result.actualUsd).toBe(f.result.actualUsd);expect(result.facts.quantities![0].quantity).toBe(f.result.facts.quantities![0].quantity);expect(result.factsDigest).not.toBe(f.result.factsDigest);
    const view=await new f.Cost(f.options).readIn(f.tx,f.input);expect(view.state).toBe('CONFIRMED');expect(view.calculations[0].evidenceId).toBe(earlier.evidenceId);expect(view.sealedCalculation).toEqual(f.calculationRef);expect(view.sealedCalculation).not.toEqual(earlier);
  });
  it('exposes no sealed calculation for a conflicting journal view',async()=>{
    const f=await sealedFixture();f.view.state='CONFLICT';f.view.costUsd=null;const view=await new f.Cost(f.options).readIn(f.tx,f.input);
    expect(view.state).toBe('CONFLICT');expect(view.sealedCalculation).toBeNull();expect(f.prepare).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
});


// W4-B2: signed-original semantics are exercised by the reader/PG suites.
// These tests isolate the pipeline transaction, first-seal and drain boundary.
async function windowsPipelineFixture(outcome:'SUCCESS'|'FAILURE'|'NOT_STARTED'='SUCCESS'){
  const f=await sealedFixture(),api=await import('../../packages/domain/src/windows-stage-cost-reader.js'),{WindowsNativeCostJournal}=await import('../../packages/domain/src/windows-native-cost.js');
  const observationId=randomUUID(),observation={evidenceId:observationId,outcome,started:outcome!=='NOT_STARTED',costUsd:'0.01',usageConfirmed:true,finishReason:'OWNED_FIXTURE',providerRef:null,data:null};
  const completion=f.put('OUTCOME',observation,false);f.work.joinedEvidence.push(completion);
  const sealRef=f.put('WINDOWS_STAGE_COST_SEAL',{completion:{kind:'EXECUTION',refs:[completion]}});f.work.terminationEvidence.push(sealRef);
  const closure=f.rows.find(row=>row.kind==='OPERATIONAL_COST_CLOSURE')!,raw=closure.protected_observation as {value:{workSet:OperationalStageCostWorkSet;workSetDigest:string}};raw.value.workSet=structuredClone(f.work);raw.value.workSetDigest=digest(f.work);closure.evidence_digest=digest(raw);
  const reader=new api.WindowsStageCostReader({db:f.options.db,windows:new WindowsNativeCostJournal(f.options.db,{maxRecordBytes:32768,maxRecords:4}),nonWindows:{nonWindowsIn:vi.fn(async()=>null),checkpointFactsIn:vi.fn(async()=>null)},bounds:{...api.windowsStageCostBounds}});
  const candidate=structuredClone(f.work);candidate.terminationEvidence=candidate.terminationEvidence.filter(ref=>ref.evidenceId!==sealRef.evidenceId);
  const originalSealRow=f.rows.find(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')!;
  const workSetIn=vi.spyOn(reader,'workSetIn').mockImplementation(async()=>structuredClone(f.work)),candidateIn=vi.spyOn(reader,'candidateIn').mockImplementation(async()=>structuredClone(candidate)),prepareCandidate=vi.spyOn(reader,'prepareCandidate').mockImplementation(async()=>structuredClone(candidate)),sealIn=vi.spyOn(reader,'sealIn').mockImplementation(async()=>{if(!f.rows.includes(originalSealRow))f.rows.push(originalSealRow);return structuredClone(f.work);}),sealedCompletionIn=vi.spyOn(reader,'sealedCompletionIn').mockResolvedValue('VERIFIED');
  f.append.mockResolvedValue({view:f.view});
  const create=()=>f.Cost.windows({...f.options,reader});
  const fresh=()=>{f.rows.splice(f.rows.findIndex(row=>row.kind==='OPERATIONAL_COST_CLOSURE'),1);f.rows.splice(f.rows.indexOf(originalSealRow),1);workSetIn.mockResolvedValueOnce(null);};
  const inserted=()=>vi.mocked(f.tx.client.query).mock.calls.filter(call=>String(call[0]).includes('INSERT INTO execution_evidence'));
  return {...f,reader,candidate,completion,sealRef,workSetIn,candidateIn,prepareCandidate,sealIn,sealedCompletionIn,create,fresh,inserted};
}

describe('W4-B2 explicit Windows pipeline first seal and historical cost',()=>{
  it('seals the current candidate before append and creates CLOSURE from the sealed exact work',async()=>{
    const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValue('ELIGIBLE');
    await f.create().finishAttempt(f.input);
    expect(f.prepareCandidate).toHaveBeenCalledOnce();expect(f.sealIn).toHaveBeenCalledOnce();expect(f.append).toHaveBeenCalledExactlyOnceWith(f.input,f.work.facts);
    expect(f.sealIn.mock.invocationCallOrder[0]).toBeLessThan(f.append.mock.invocationCallOrder[0]);expect(f.inserted()).toHaveLength(1);
    const values=f.inserted()[0][1] as unknown[],closure=JSON.parse(values[6] as string);expect(closure.value.workSet).toEqual(f.work);expect(closure.value.workSetDigest).toBe(digest(f.work));
  });
  it('does not seal or append when current successful TYPESET publication still waits',async()=>{
    const f=await windowsPipelineFixture();f.fresh();await f.create().finishAttempt(f.input);
    expect(f.prepareCandidate).toHaveBeenCalledOnce();expect(f.sealIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.inserted()).toHaveLength(0);
  });
  it('uses immutable sealed completion after append when the current publication gate changes',async()=>{
    const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValueOnce('ELIGIBLE').mockResolvedValue('WAIT');
    await f.create().finishAttempt(f.input);
    expect(f.sealIn).toHaveBeenCalledOnce();expect(f.checkpoints.finalCommitIn).toHaveBeenCalledOnce();expect(f.sealedFinalCostIn).toHaveBeenCalled();expect(f.inserted()).toHaveLength(1);
  });
  it('reads successful sealed historical cost without current execution or owner authority',async()=>{
    const f=await windowsPipelineFixture();f.execution.state='PREPARED';f.execution.dispatch_attempted_at=null;
    const view=await f.create().readIn(f.tx,f.input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.sealedCalculation).toEqual(f.calculationRef);
    expect(f.prepareCandidate).not.toHaveBeenCalled();expect(f.sealIn).not.toHaveBeenCalled();expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();expect(f.sealedFinalCostIn).toHaveBeenCalledOnce();
    expect(vi.mocked(f.tx.client.query).mock.calls.some(call=>String(call[0]).includes('FROM executions e JOIN processing_requests r'))).toBe(false);
  });
  it.each(['FAILURE','NOT_STARTED'] as const)('reads sealed original %s cost without a successful FINAL and without current state',async outcome=>{
    const f=await windowsPipelineFixture(outcome);f.execution.state='SUCCEEDED';f.sealedFinalCostIn.mockResolvedValue('WAIT');
    const view=await f.create().readIn(f.tx,f.input);expect(view.state).toBe('CONFIRMED');expect(view.sealedCalculation).toEqual(f.calculationRef);expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.checkpoints.finalCommitIn).not.toHaveBeenCalled();
  });
  it('retains the previous calculation while original sealed completion is unconfirmed',async()=>{
    const f=await windowsPipelineFixture();f.sealedCompletionIn.mockResolvedValue('WAIT');const view=await f.create().readIn(f.tx,f.input);
    expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.calculations).toHaveLength(1);expect(view.sealedCalculation).toBeNull();expect(f.append).not.toHaveBeenCalled();
  });
  it('joins deferred candidate and seal work in idle before allowing the drain to resolve',async()=>{
    const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValue('ELIGIBLE');let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});f.prepareCandidate.mockImplementationOnce(async()=>{await gate;return f.candidate;});
    const cost=f.create(),pending=cost.finishAttempt(f.input);await vi.waitFor(()=>expect(f.prepareCandidate).toHaveBeenCalledOnce());let idle=false;const waiting=cost.idle().then(()=>{idle=true;});await Promise.resolve();expect(idle).toBe(false);expect(f.append).not.toHaveBeenCalled();release();await pending;await waiting;expect(idle).toBe(true);expect(f.inserted()).toHaveLength(1);
  });
  it('rejects structural and accessor Windows capabilities before touching any port',async()=>{
    const f=await windowsPipelineFixture(),get=vi.fn(()=>f.reader),options=Object.defineProperty({...f.options,reader:f.reader},'reader',{enumerable:true,get});
    expect(()=>f.Cost.windows(options)).toThrow();expect(get).not.toHaveBeenCalled();
    expect(()=>f.Cost.windows({...f.options,reader:f.options.reader as unknown as typeof f.reader})).toThrow();expect(f.workSetIn).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
  });
});

it.each(['seal','append'] as const)('W4-B2 idle waits for deferred %s without a second current gate',async boundary=>{
  const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValueOnce('ELIGIBLE').mockResolvedValue('WAIT');let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  if(boundary==='seal'){const finishSeal=f.sealIn.getMockImplementation()!;f.sealIn.mockImplementationOnce(async(tx,input,basis,work)=>{await gate;return finishSeal(tx,input,basis,work);});}else f.append.mockImplementationOnce(async()=>{await gate;return {view:f.view};});
  const cost=f.create(),pending=cost.finishAttempt(f.input);await vi.waitFor(()=>expect(boundary==='seal'?f.sealIn:f.append).toHaveBeenCalledOnce());let done=false;const idle=cost.idle().then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);expect(f.inserted()).toHaveLength(0);release();await pending;await idle;expect(done).toBe(true);expect(f.inserted()).toHaveLength(1);expect(f.checkpoints.finalCommitIn).toHaveBeenCalledOnce();
});
it('W4-B2 captures Windows candidate seal and history method identities before caller replacement',async()=>{
  const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValue('ELIGIBLE');const candidate=f.prepareCandidate,seal=f.sealIn,history=f.sealedCompletionIn,cost=f.create();
  Object.assign(f.reader,{prepareCandidate:vi.fn(async()=>{throw Error('REPLACED_CANDIDATE');}),sealIn:vi.fn(async()=>{throw Error('REPLACED_SEAL');}),sealedCompletionIn:vi.fn(async()=>{throw Error('REPLACED_COMPLETION');})});
  await cost.finishAttempt(f.input);expect(candidate).toHaveBeenCalledOnce();expect(seal).toHaveBeenCalledOnce();expect(history).toHaveBeenCalled();expect(f.inserted()).toHaveLength(1);
});
it('W4-B2 rejects a successful historical cost when the original OUTCOME ref is missing from the seal membership',async()=>{
  const f=await windowsPipelineFixture(),row=f.rows.find(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')!,record=row.protected_observation as {value:{completion:{refs:CostEvidenceRef[]}}};record.value.completion.refs=[{evidenceId:randomUUID(),evidenceDigest:sha256('foreign outcome')}];row.evidence_digest=digest(record);f.work.terminationEvidence.find(ref=>ref.evidenceId===f.sealRef.evidenceId)!.evidenceDigest=row.evidence_digest;
  const closure=f.rows.find(row=>row.kind==='OPERATIONAL_COST_CLOSURE')!,raw=closure.protected_observation as {value:{workSet:OperationalStageCostWorkSet;workSetDigest:string}};raw.value.workSet=structuredClone(f.work);raw.value.workSetDigest=digest(f.work);closure.evidence_digest=digest(raw);
  await expect(f.create().readIn(f.tx,f.input)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.sealedFinalCostIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
});

it('W4-B2 keeps original calculations and reports CONFLICT when a sealed CLOSURE loses its original work set',async()=>{
  const f=await windowsPipelineFixture();f.workSetIn.mockResolvedValue(null);const view=await f.create().readIn(f.tx,f.input);expect(view.state).toBe('CONFLICT');expect(view.conflicts).toContain('OPERATIONAL_STAGE_COST_CLOSURE_CONFLICT');expect(view.costUsd).toBeNull();expect(view.calculations).toEqual(f.view.calculations);expect(f.append).not.toHaveBeenCalled();expect(f.prepareCandidate).not.toHaveBeenCalled();expect(f.sealIn).not.toHaveBeenCalled();
});

it('W4-B2 split action runs outside account transaction and preserves private candidate identity for final seal',async()=>{
  const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValue('ELIGIBLE');
  let active=0;f.transaction.mockImplementation(async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>{active++;try{return await run(f.tx);}finally{active--;}});
  const prepared=f.candidate,prepare=vi.fn(async()=>{expect(active).toBe(0);return prepared;});Object.defineProperty(f.reader,'prepareCandidate',{value:prepare,configurable:true,writable:true});
  const cost=f.create();await cost.finishAttempt(f.input);
  expect(prepare).toHaveBeenCalledOnce();expect(f.candidateIn).not.toHaveBeenCalled();expect(f.sealIn).toHaveBeenCalledOnce();expect(f.sealIn.mock.calls[0][3]).toBe(prepared);expect(f.inserted()).toHaveLength(1);
});
it('W4-B2 split action remains pending in idle until preparation and final seal complete',async()=>{
  const f=await windowsPipelineFixture();f.fresh();vi.mocked(f.checkpoints.finalCommitIn).mockResolvedValue('ELIGIBLE');
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),prepare=vi.fn(async()=>{await gate;return f.candidate;});Object.defineProperty(f.reader,'prepareCandidate',{value:prepare,configurable:true});
  const cost=f.create(),pending=cost.finishAttempt(f.input);await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());let done=false;const idle=cost.idle().then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);expect(f.append).not.toHaveBeenCalled();release();await pending;await idle;expect(done).toBe(true);expect(f.inserted()).toHaveLength(1);
});
it('W4-B2 split action skips new preparation when original seal history conflicts',async()=>{
  const f=await windowsPipelineFixture();f.workSetIn.mockResolvedValue(null);const prepare=vi.fn(async()=>f.candidate);Object.defineProperty(f.reader,'prepareCandidate',{value:prepare,configurable:true});
  await f.create().finishAttempt(f.input);expect(prepare).not.toHaveBeenCalled();expect(f.candidateIn).not.toHaveBeenCalled();expect(f.sealIn).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.inserted()).toHaveLength(0);
});


// 과거 journal은 가짜 신뢰 포트다. 여기서는 Windows의 SQL 읽기 순서·상한과
// 마지막 원 operation/event 중복 거부를 검사하며 과거 의미 검증을 대신하지 않는다.
async function windowsClosureReadFixture(count=2,defect:'NONE'|'MISSING'|'DIGEST'|'EXTRA'|'OVERSIZED'|'LAST_DUPLICATE'='NONE'){
  const f=await windowsPipelineFixture(),query=vi.mocked(f.tx.client.query),prior=query.getMockImplementation()!;
  const originals=Array.from({length:count},(_,n)=>{
    const input=structuredClone(f.input);input.executionId=randomUUID();input.requestId=randomUUID();input.inputDigest=sha256('old-closure-'+n);Object.assign(input.envelope!,{executionId:input.executionId,requestId:input.requestId,inputDigest:input.inputDigest});
    const rawInput=canonicalInput(input),work=structuredClone(f.work);work.executionId=input.executionId;work.inputFingerprint=digest(rawInput);for(const source of work.sources){source.sourceOperationId=randomUUID();source.sourceEventId=randomUUID();}
    if(defect==='LAST_DUPLICATE'&&n===count-1)work.sources[0].sourceEventId=f.work.sources[0].sourceOperationId;
    const value={version:1,basisEvidenceId:randomUUID(),basisEvidenceDigest:sha256('old-basis'),workSetDigest:digest(work),workSet:work,calculationEvidenceId:randomUUID(),calculationEvidenceDigest:sha256('old-calculation'),factsDigest:digest(work.facts)};
    const raw={version:1,accountId:f.input.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(rawInput),kind:'OPERATIONAL_COST_CLOSURE',value},id=randomUUID(),row={evidence_id:id,evidence_digest:digest(raw),execution_id:input.executionId,kind:'OPERATIONAL_COST_CLOSURE',protected_evidence_ref:id,protected_observation:raw};
    return {input:rawInput,row,metadata:{evidence_id:id,evidence_digest:row.evidence_digest,execution_id:row.execution_id,kind:row.kind,protected_evidence_ref:id,record_bytes:defect==='OVERSIZED'?f.options.bounds.maxRecordBytes+1:Buffer.byteLength(JSON.stringify(raw))}};
  });
  const reads={metadata:0,bulk:0,bodies:[] as string[],input:0};
  query.mockImplementation((async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('execution_id<>$2')&&sql.includes("kind='OPERATIONAL_COST_CLOSURE'")){
      if(sql.includes(' AS protected_observation')){reads.bulk++;return {rows:originals.map(x=>x.row)};}
      reads.metadata++;expect(sql).not.toContain(' AS protected_observation');return {rows:originals.map(x=>x.metadata)};
    }
    const original=originals.find(x=>x.input.executionId===values[1]);
    if(original&&sql.startsWith('SELECT request_id,logical_step_id,input_digest FROM executions')){reads.input++;return {rows:[{request_id:original.input.requestId,logical_step_id:original.input.stage,input_digest:original.input.inputDigest}]};}
    if(original&&sql.includes("kind='INPUT'"))return {rows:[{protected_observation:original.input,evidence_digest:digest(original.input)}]};
    if(original&&sql.includes('evidence_id=$3')&&values[2]===original.row.evidence_id){
      reads.bodies.push(original.row.evidence_id);expect(sql).toContain('evidence_digest=$4');expect(values[3]).toBe(original.row.evidence_digest);expect(values[4]).toBe(f.options.bounds.maxRecordBytes);
      if(defect==='MISSING')return {rows:[]};if(defect==='DIGEST')return {rows:[{...original.row,evidence_digest:sha256('changed after metadata')}]};if(defect==='EXTRA')return {rows:[original.row,original.row]};return {rows:[original.row]};
    }
    return Reflect.apply(prior,f.tx.client,[sql,values]);
  }) as never);
  const cost=f.Cost.windows({...f.options,reader:f.reader,bounds:{...f.options.bounds,maxExecutions:2}}),unique=Reflect.get(cost,'uniqueIn');
  return {...f,originals,reads,unique:()=>Reflect.apply(unique,cost,[f.tx,f.input,f.work]) as Promise<void>,generic:()=>{const cost=new f.Cost(f.options);return Reflect.apply(Reflect.get(cost,'uniqueIn'),cost,[f.tx,f.input,f.work]) as Promise<void>;}};
}
it('W4-B2 bounded history rejects N+1 metadata before requesting any CLOSURE body',async()=>{
  const f=await windowsClosureReadFixture(3);await expect(f.unique()).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});expect(f.reads).toEqual({metadata:1,bulk:0,bodies:[],input:0});expect(f.lookupIn).not.toHaveBeenCalled();
});
it('W4-B2 bounded history reads allowed CLOSURE bodies one at a time with exact metadata identities',async()=>{
  const f=await windowsClosureReadFixture(2);await expect(f.unique()).resolves.toBeUndefined();expect(f.reads.metadata).toBe(1);expect(f.reads.bulk).toBe(0);expect(f.reads.bodies).toEqual(f.originals.map(x=>x.row.evidence_id));expect(f.reads.input).toBe(2);
});
it('W4-B2 bounded history still refuses an operation event repeated in the last CLOSURE',async()=>{
  const f=await windowsClosureReadFixture(2,'LAST_DUPLICATE');await expect(f.unique()).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_DUPLICATE_SOURCE',nextAction:'WAIT'});expect(f.reads.bulk).toBe(0);expect(f.reads.bodies).toHaveLength(2);
});
it('W4-B2 bounded history rejects oversized metadata before body or original journal reads',async()=>{
  const f=await windowsClosureReadFixture(1,'OVERSIZED');await expect(f.unique()).rejects.toMatchObject({nextAction:'WAIT'});expect(f.reads).toEqual({metadata:1,bulk:0,bodies:[],input:0});expect(f.lookupIn).not.toHaveBeenCalled();
});
it.each(['MISSING','DIGEST','EXTRA'] as const)('W4-B2 bounded history refuses %s single-body response after metadata',async defect=>{
  const f=await windowsClosureReadFixture(1,defect);await expect(f.unique()).rejects.toMatchObject({nextAction:'WAIT'});expect(f.reads.bulk).toBe(0);expect(f.reads.bodies).toHaveLength(1);
});
it('W4-B2 bounded history preserves the generic v1 bulk query contract',async()=>{
  const f=await windowsClosureReadFixture(2);await expect(f.generic()).resolves.toBeUndefined();expect(f.reads).toEqual({metadata:0,bulk:1,bodies:[],input:2});
});
