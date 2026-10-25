import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {canonicalInput,normalizeObservation,type Observation,type ProviderAdapter,type StageInput} from '../../packages/domain/src/provider.js';
import type {ContextRow,RequestRow,PageRow,ResultRow} from '../../packages/domain/src/model.js';
import {Projections} from '../../packages/domain/src/projections.js';
import type {NativeJobClaim} from '../../packages/domain/src/native-jobs.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {FullStageCostPreparation,type FullStageCostCatalogEntry,type FullStageCostPreparationJournal} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostBasis,FullStageCostJournalView} from '../../packages/domain/src/full-stage-cost-journal.js';
import {NativeJobError} from '../../packages/native/src/dto.js';
import type {NativeGateway,NativeTarget} from '../../packages/native/src/gateway.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings} from '../../packages/contracts/src/wire.generated.js';

// Actual runOnce/authorize/persistInput/nativeCallContext/preflight control flow,
// with owned metadata-only DB/provider/native ports. No engine, assets I/O,
// production measurements, SQL authority or whole-stage work ordering proof.
type PrepareHook=(input:StageInput,claim:NativeJobClaim)=>Promise<void>;
// A typed variable with an existing Hooks field is assignable to the old
// constructor too; an absent implementation fails assertions, not typechecking.
type PrivateHooks={heartbeatMilliseconds:number;beforeValidateInput?:PrepareHook;afterPrepare?:(input:StageInput)=>Promise<void>};
type Execution={account_id:string;execution_id:string;request_id:string;logical_step_id:string;state:string;input_digest:string;claim_generation:string;dispatch_attempted_at:Date|null;start_confirmed_at:Date|null;output_envelope:Observation|null};
type InputRecord={evidence_id:string;protected_observation:StageInput;evidence_digest:string};
const costBounds=()=>({maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512});
const costView=(basis:FullStageCostBasis|null):FullStageCostJournalView=>({basis,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(complete=>{resolve=complete;});return {promise,resolve};}
function nativeFault(){return new NativeJobError('NATIVE_JOB_TIMEOUT',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-preparation-native-input'),profileDigest:sha256('owned-preparation-native-profile'),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'});}
afterEach(()=>vi.restoreAllMocks());

function fixture(installed=true,hook?:PrepareHook){
  const now=new Date('2026-10-04T00:00:00Z'),accountId=randomUUID(),requestId=randomUUID(),contextId=randomUUID(),workId=randomUUID(),sessionId=randomUUID(),pageId=randomUUID(),events:string[]=[],inputs:InputRecord[]=[],nativeTargets:NativeTarget[]=[];
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const context:ContextRow={account_id:accountId,context_id:contextId,project_lineage_id:randomUUID(),generation:'1',lifecycle:'OPEN',owner_session_id:sessionId,owner_tab_id:randomUUID(),owner_revision:'0',workspace_revision:'0',connection_generation:'1',heartbeat_seq:'0',last_valid_heartbeat_at:now,owner_capability_digest:sha256('owned-preparation-owner'),project_status:'IN_PROGRESS',current_settings_revision:'1',title:'owned'};
  const request:RequestRow={account_id:accountId,request_id:requestId,retry_of_request_id:null,context_id:contextId,context_generation:'1',project_lineage_id:context.project_lineage_id,page_lineage_id:pageId,batch_id:null,settings_revision:'1',captured_scope:{kind:'PAGE'},scope_digest:digest({kind:'PAGE'}),state:'ACCEPTED',mode:'FREE',first_start_at:null,expected_result_revision:'0',captured_stage_order:['OCR'],hold_reasons:[],captured_input:{originalAssetId:randomUUID(),data:{blocks:[],geometryContract:'geometry-v1',renderContract:'render-v1',cleanupQa:'NOT_RUN'},width:100,height:100,assetDependencies:[],parameterProfileVersion:'owned-preparation-profile'}};
  const work={account_id:accountId,work_item_id:workId,kind:'DISPATCH',state:'CLAIMED',claim_generation:'1',claim_owner:'',lease_until:new Date(now.valueOf()+30000),due_at:now,target_ref:{requestId}};
  const account={account_id:accountId,access_state:'ACTIVE',auth_generation:'0',balance_credit:'100',free_started_count:0,revision:'0',binding_revision:'0',last_all_logout_order:'0'};
  const session={absolute_expires_at:new Date(now.valueOf()+86400000),revoked_at:null,auth_generation:'0',binding_state:'ACTIVE'};
  const state:{execution:Execution|null;pointer:string|null;waitDeadline:Date|null;inputCommits:number;inputWrites:number}={execution:null,pointer:null,waitDeadline:null,inputCommits:0,inputWrites:0};
  const query=vi.fn(async(text:string,values:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>=>{
    let rows:unknown[]=[];let affected=0;
    if(text.startsWith('SELECT * FROM work_items'))rows=[structuredClone(work)];
    else if(text.startsWith('SELECT * FROM processing_requests'))rows=[structuredClone(request)];
    else if(text.startsWith('SELECT state FROM processing_requests'))rows=[{state:request.state}];
    else if(text.startsWith('SELECT * FROM workspace_contexts'))rows=[structuredClone(context)];
    else if(text.startsWith('SELECT s.absolute_expires_at'))rows=[structuredClone(session)];
    else if(text.startsWith('SELECT captured_settings'))rows=[{captured_settings:structuredClone(settings)}];
    else if(text.startsWith('SELECT p.result_revision'))rows=[{result_revision:'0',excluded:false,request_id:requestId}];
    else if(text.startsWith('SELECT s.logical_step_id,s.current_execution_id'))rows=[{logical_step_id:'OCR',current_execution_id:state.pointer,reuse_checkpoint_id:null,execution_state:state.execution?.state??null,output_envelope:null}];
    else if(text.startsWith('SELECT * FROM executions'))rows=state.execution?[structuredClone(state.execution)]:[];
    else if(text.startsWith('SELECT request_id,logical_step_id,input_digest'))rows=state.execution?[{request_id:state.execution.request_id,logical_step_id:state.execution.logical_step_id,input_digest:state.execution.input_digest}]:[];
    else if(text.startsWith('SELECT execution_id FROM executions'))rows=state.execution?[{execution_id:state.execution.execution_id}]:[];
    else if(text.startsWith('SELECT current_execution_id'))rows=[{current_execution_id:state.pointer}];
    else if(text.startsWith('SELECT protected_observation,evidence_digest'))rows=inputs.filter(row=>row.protected_observation.executionId===values[1]).map(row=>structuredClone(row));
    else if(text.startsWith('SELECT evidence_id FROM execution_evidence'))rows=inputs.filter(row=>row.protected_observation.executionId===values[1]).map(row=>({evidence_id:row.evidence_id}));
    else if(text.startsWith('SELECT 1 FROM execution_evidence')&&text.includes("kind='INPUT'"))rows=inputs.filter(row=>row.protected_observation.executionId===values[1]).map(()=>({present:1}));
    else if(text.startsWith('SELECT deadline FROM provider_wait_rounds'))rows=state.waitDeadline?[{deadline:state.waitDeadline}]:[];
    else if(text.startsWith('INSERT INTO executions')){state.execution={account_id:accountId,execution_id:values[1] as string,request_id:values[2] as string,logical_step_id:values[3] as string,state:'PREPARED',input_digest:values[5] as string,claim_generation:values[7] as string,dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null};affected=1;}
    else if(text.startsWith('UPDATE request_steps SET current_execution_id')){state.pointer=values[3] as string;affected=1;}
    else if(text.startsWith('INSERT INTO execution_evidence')&&text.includes("'INPUT'")){inputs.push({evidence_id:values[1] as string,protected_observation:JSON.parse(values[5] as string) as StageInput,evidence_digest:values[3] as string});state.inputWrites++;events.push('INPUT_INSERT');affected=1;}
    else if(text.startsWith('UPDATE executions SET claim_generation')&&state.execution){state.execution.claim_generation=values[2] as string;affected=1;}
    else if(text.startsWith("UPDATE executions SET state='DISPATCHING'")&&state.execution){events.push('PREFLIGHT');state.execution.state='DISPATCHING';state.execution.dispatch_attempted_at=values[2] as Date;affected=1;}
    else if(text.startsWith("UPDATE executions SET state='REJECTED'")&&state.execution){state.execution.state='REJECTED';affected=1;}
    else if(text.startsWith('UPDATE work_items SET state=')&&work.state==='CLAIMED'&&work.claim_generation===values[2]&&work.claim_owner===values[5]&&work.lease_until&&work.lease_until>(values[6] as Date)){work.state=values[3] as string;Object.assign(work,{claim_owner:null,lease_until:null});affected=1;}
    else if(text.startsWith('UPDATE processing_requests SET state=$3')){request.state=values[2] as RequestRow['state'];request.hold_reasons=[];affected=1;}
    return {rows,rowCount:affected||rows.length};
  });
  const tx={client:{query},account,now} as unknown as Transaction;
  const transactions=vi.fn(async(_id:string,run:(tx:Transaction)=>Promise<unknown>,_restricted?:boolean)=>{const before=state.inputWrites;const value=await run(tx);if(state.inputWrites>before){state.inputCommits++;events.push('INPUT_COMMIT_ACK');}return value;});
  const db={accountTransaction:transactions} as unknown as Database;
  const gateway:NativeGateway={forTarget:vi.fn(target=>{nativeTargets.push(structuredClone(target));const original=inputs[0]?.protected_observation;events.push(original&&target.semanticCaptureDigest===nativeExecutionCaptureDigest('INPUT',requestId,original)?'NATIVE_INPUT':original&&target.semanticCaptureDigest===nativeExecutionCaptureDigest('LOOKUP',requestId,original)?'NATIVE_LOOKUP':'NATIVE_DISPATCH');return {} as NativeFacade;}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};
  const validateInput=vi.fn<NonNullable<ProviderAdapter['validateInput']>>(async()=>{events.push('VALIDATE_INPUT');});
  const dispatch=vi.fn<ProviderAdapter['dispatch']>(async()=>{events.push('DISPATCH');return {evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'OWNED_METADATA_ONLY',providerRef:null,data:null};});
  const lookup=vi.fn<ProviderAdapter['lookup']>(async()=>null);
  const provider:ProviderAdapter={synthetic:true,validateInput,dispatch,lookup};
  const beforeValidateInput=vi.fn<PrepareHook>(async(input,claim)=>{events.push('PREPARE_HOOK');if(hook)await hook(input,claim);});
  const afterPrepare=vi.fn(async()=>{events.push('AFTER_PREPARE');});
  const hooks:PrivateHooks={heartbeatMilliseconds:1000000,afterPrepare,...(installed?{beforeValidateInput}:{})};
  const service=new ExecutionService(db,provider,{stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false},hooks,gateway);work.claim_owner=service.workerId;
  const claim:Claim={accountId,workId,generation:'1',kind:'DISPATCH',ref:{requestId}};
  vi.spyOn(service,'claim').mockImplementation(async()=>claim);
  const observe=vi.spyOn(service,'observe').mockResolvedValue(),started=vi.spyOn(service,'started').mockResolvedValue(),finish=vi.spyOn(service,'finish'),nativeWait=vi.spyOn(service,'nativeWait').mockResolvedValue();
  return {now,accountId,requestId,context,request,work,account,session,state,inputs,events,query,transactions,tx,db,gateway,nativeTargets,provider,validateInput,dispatch,lookup,hooks,beforeValidateInput,afterPrepare,service,claim,observe,started,finish,nativeWait};
}
function noWork(f:ReturnType<typeof fixture>){
  expect(f.validateInput).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expect(f.started).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();expect(f.afterPrepare).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([text])=>text.includes('reserve_execution')||text.includes('INSERT INTO free_starts')||text.includes('INSERT INTO cost_items')||text.includes('INSERT INTO settlements')||text.includes("SET state='DISPATCHING'")||text.includes("SET state='REJECTED'")||text.includes('terminal_at='))).toBe(false);
}
function basisFixture(f:ReturnType<typeof fixture>){
  const profileDigest=sha256('owned-run-preparation-profile'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'owned-preparation-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-explicit-catalog'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-image-rate-v1',usdPerUnit:'0.001',evidenceRefs:['owned-fake-rate']}]};
  const state:{basis:FullStageCostBasis|null;ackError:Error|null}={basis:null,ackError:null};
  const lookup=vi.fn<FullStageCostPreparationJournal['lookup']>(async()=>costView(state.basis));
  const prepare=vi.fn<FullStageCostPreparationJournal['prepare']>(async(input,rates,profile,claim)=>{
    expect(f.state.inputCommits).toBeGreaterThan(0);expect(claim).toEqual({generation:f.claim.generation,ownerId:f.service.workerId,workItemId:f.claim.workId});expect(f.state.execution).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});
    if(state.basis)return {created:false,basis:state.basis};const calculation=new FullStageCostCalculator(rates,costBounds()).calculate({accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'OCR',profileDigest:profile,mode:'FREE'},{provider:null,quantities:null,allocation:null});
    state.basis={version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:structuredClone(calculation.snapshot) as FullStageCostSnapshot|null,snapshotDigest:calculation.snapshotDigest};f.events.push('BASIS_COMMIT_ACK');if(state.ackError){const error=state.ackError;state.ackError=null;throw error;}return {created:true,basis:state.basis};
  });
  const journal:FullStageCostPreparationJournal={lookup,prepare},catalog:FullStageCostCatalogEntry[]=[{stage:'OCR',profileDigest,snapshot}];
  return {state,lookup,prepare,journal,catalog,snapshot,adapter:(entries=catalog)=>new FullStageCostPreparation(journal,entries,costBounds())};
}

describe('private execution preparation before INPUT native/validation work',()=>{
  it('preserves the uninstalled runOnce default and original afterPrepare/preflight order',async()=>{
    const f=fixture(false);expect(await f.service.runOnce()).toBe(true);expect(f.events).toEqual(['INPUT_INSERT','INPUT_COMMIT_ACK','NATIVE_INPUT','VALIDATE_INPUT','AFTER_PREPARE','PREFLIGHT','NATIVE_DISPATCH','DISPATCH']);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.inputs).toHaveLength(1);expect(f.nativeTargets[0].sourceInput).toMatchObject({executionId:f.inputs[0].protected_observation.executionId,inputEvidenceId:f.inputs[0].evidence_id});expect(f.started).not.toHaveBeenCalled();
  });
  it('commits immutable INPUT then calls preparation before native INPUT, validation, afterPrepare and dispatch',async()=>{
    const f=fixture(),basis=basisFixture(f),preparation=basis.adapter();f.hooks.beforeValidateInput=async(input,claim)=>{f.events.push('PREPARE_HOOK');await preparation.prepare(input,claim);};
    expect(await f.service.runOnce()).toBe(true);expect(f.events).toEqual(['INPUT_INSERT','INPUT_COMMIT_ACK','PREPARE_HOOK','BASIS_COMMIT_ACK','NATIVE_INPUT','VALIDATE_INPUT','AFTER_PREPARE','PREFLIGHT','NATIVE_DISPATCH','DISPATCH']);expect(basis.state.basis!.capture.inputFingerprint).toBe(digest(f.inputs[0].protected_observation));expect(basis.prepare).toHaveBeenCalledOnce();expect(f.dispatch).toHaveBeenCalledOnce();expect(f.started).not.toHaveBeenCalled();
  });
  it('calls installed preparation even when the provider has no validateInput method',async()=>{
    const f=fixture();delete f.provider.validateInput;expect(await f.service.runOnce()).toBe(true);expect(f.beforeValidateInput).toHaveBeenCalledOnce();expect(f.events).toEqual(['INPUT_INSERT','INPUT_COMMIT_ACK','PREPARE_HOOK','AFTER_PREPARE','PREFLIGHT','NATIVE_DISPATCH','DISPATCH']);expect(f.validateInput).not.toHaveBeenCalled();
  });
  it.each(['PLAIN','NATIVE'] as const)('propagates %s preparation error outside input validation failure/native wait handling',async kind=>{
    const error=kind==='NATIVE'?nativeFault():Error('OWNED_PREPARATION_IO_UNKNOWN'),f=fixture(true,async()=>{throw error;});await expect(f.service.runOnce()).rejects.toBe(error);noWork(f);expect(f.inputs).toHaveLength(1);expect(f.state.inputCommits).toBe(1);expect(f.state.execution).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null});expect(f.request.state).toBe('ACCEPTED');expect(f.finish).not.toHaveBeenCalled();expect(f.work).toMatchObject({state:'CLAIMED',claim_owner:f.service.workerId});
  });
  it('preserves committed basis on ACK error and reuses the same execution/snapshot on retry with a different catalog',async()=>{
    const f=fixture(),basis=basisFixture(f),error=Error('OWNED_BASIS_COMMIT_ACK_UNKNOWN');basis.state.ackError=error;let preparation=basis.adapter();f.hooks.beforeValidateInput=async(input,claim)=>{await preparation.prepare(input,claim);};
    await expect(f.service.runOnce()).rejects.toBe(error);noWork(f);const savedInput=structuredClone(f.inputs),savedBasis=structuredClone(basis.state.basis);expect(savedBasis).not.toBeNull();expect(f.state.inputCommits).toBe(1);
    const newer=structuredClone(basis.catalog);newer[0].snapshot!.basisVersion='owned-new-catalog';newer[0].snapshot!.components[0].usdPerUnit='9';preparation=basis.adapter(newer);f.claim.generation='2';f.work.claim_generation='2';
    expect(await f.service.runOnce()).toBe(true);expect(f.inputs).toEqual(savedInput);expect(basis.state.basis).toEqual(savedBasis);expect(basis.prepare).toHaveBeenCalledOnce();expect(basis.lookup).toHaveBeenCalledTimes(2);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.dispatch.mock.calls[0][0].executionId).toBe(savedInput[0].protected_observation.executionId);expect(f.dispatch.mock.calls[0][0].claimGeneration).toBe('2');
  });
  it.each(['lease','generation','owner','work-state','context-generation','context-closed','stop','pointer','wait','restricted','session'] as const)('fences %s changes during preparation before any native/validation/preflight side effect',async kind=>{
    const entered=deferred<boolean>(),gate=deferred<void>(),f=fixture(true,async()=>{entered.resolve(true);await gate.promise;}),pending=f.service.runOnce();const observed=await Promise.race([entered.promise,pending.then(()=>false)]);expect(observed).toBe(true);
    const executionId=f.inputs[0].protected_observation.executionId;
    try{
      if(kind==='lease')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='generation')f.work.claim_generation='2';if(kind==='owner')f.work.claim_owner=randomUUID();if(kind==='work-state')f.work.state='READY';if(kind==='context-generation')f.context.generation='2';if(kind==='context-closed')f.context.lifecycle='CLOSED';if(kind==='stop')f.request.state='STOP_REQUESTED';if(kind==='pointer')f.state.pointer=randomUUID();if(kind==='wait')f.state.waitDeadline=new Date(f.now.valueOf()-1);if(kind==='restricted')f.account.access_state='RESTRICTED';if(kind==='session')f.session.absolute_expires_at=new Date(f.now.valueOf()-1);
    }finally{gate.resolve();}
    expect(await pending).toBe(true);noWork(f);expect(f.state.execution).toMatchObject({execution_id:executionId,state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});expect(f.inputs).toHaveLength(1);expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
    if(['lease','generation','owner','work-state'].includes(kind)){expect(f.work.state).toBe(kind==='work-state'?'READY':'CLAIMED');if(kind==='owner')expect(f.work.claim_owner).not.toBe(f.service.workerId);if(kind==='generation')expect(f.work.claim_generation).toBe('2');}
  });
  it.each(['STATE','DISPATCH','START','GENERATION','DIGEST','REQUEST'] as const)('rejects changed prepared execution %s without replacing its facts',async kind=>{
    const entered=deferred<boolean>(),gate=deferred<void>(),f=fixture(true,async()=>{entered.resolve(true);await gate.promise;}),pending=f.service.runOnce();expect(await Promise.race([entered.promise,pending.then(()=>false)])).toBe(true);
    try{const execution=f.state.execution!;if(kind==='STATE')execution.state='UNKNOWN';if(kind==='DISPATCH')execution.dispatch_attempted_at=f.now;if(kind==='START')execution.start_confirmed_at=f.now;if(kind==='GENERATION')execution.claim_generation='2';if(kind==='DIGEST')execution.input_digest=sha256('changed-execution-input');if(kind==='REQUEST')execution.request_id=randomUUID();}finally{gate.resolve();}
    const original=structuredClone(f.state.execution);expect(await pending).toBe(true);noWork(f);expect(f.state.execution).toEqual(original);expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
  });
  it('propagates original INPUT integrity failure after preparation without terminalizing it',async()=>{
    const entered=deferred<boolean>(),gate=deferred<void>(),f=fixture(true,async()=>{entered.resolve(true);await gate.promise;}),pending=f.service.runOnce();expect(await Promise.race([entered.promise,pending.then(()=>false)])).toBe(true);f.inputs[0].protected_observation.width=101;gate.resolve();await expect(pending).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});noWork(f);expect(f.state.execution).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});expect(f.request.state).toBe('ACCEPTED');expect(f.finish).not.toHaveBeenCalled();
  });
  it('owns separate hook INPUT/claim copies and ignores its returned replacement data',async()=>{
    const f=fixture(),originalClaim={generation:f.claim.generation,ownerId:f.service.workerId,workItemId:f.claim.workId};let seenInput:StageInput|undefined,seenClaim:NativeJobClaim|undefined;
    f.hooks.beforeValidateInput=async(input,claim)=>{seenInput=input;seenClaim=claim;input.width=999;input.settings.baseFontSizePx=99;input.envelope!.assetIds.push(randomUUID());input.executionId=randomUUID();claim.generation='999';claim.ownerId=randomUUID();claim.workItemId=randomUUID();return {input,claim} as unknown as void;};
    expect(await f.service.runOnce()).toBe(true);expect(seenInput).toMatchObject({width:999,settings:{baseFontSizePx:99}});expect(seenClaim).toMatchObject({generation:'999'});expect(seenInput).not.toBe(f.validateInput.mock.calls[0][0]);expect(seenClaim).not.toBe(f.claim);expect(f.validateInput.mock.calls[0][0]).toMatchObject({width:100,executionId:f.inputs[0].protected_observation.executionId,settings:{baseFontSizePx:20}});expect(canonicalInput(f.dispatch.mock.calls[0][0])).toEqual(f.inputs[0].protected_observation);expect(f.nativeTargets.every(target=>digest(target.claim)===digest(originalClaim))).toBe(true);expect(f.claim.generation).toBe('1');
  });
  it('preserves existing canDispatch continuation when an already-started page receives STOP_REQUESTED during preparation',async()=>{
    const entered=deferred<boolean>(),gate=deferred<void>(),f=fixture(true,async()=>{entered.resolve(true);await gate.promise;}),firstStart=new Date(f.now);
    f.request.first_start_at=firstStart;f.account.free_started_count=1;
    const pending=f.service.runOnce(),settled=pending.then(()=>false,()=>false);expect(await Promise.race([entered.promise,settled])).toBe(true);
    try{f.request.state='STOP_REQUESTED';}finally{gate.resolve();}
    expect(await pending).toBe(true);expect(f.events).toEqual(['INPUT_INSERT','INPUT_COMMIT_ACK','PREPARE_HOOK','NATIVE_INPUT','VALIDATE_INPUT','AFTER_PREPARE','PREFLIGHT','NATIVE_DISPATCH','DISPATCH']);
    expect(f.validateInput).toHaveBeenCalledOnce();expect(f.dispatch).toHaveBeenCalledOnce();expect(f.afterPrepare).toHaveBeenCalledOnce();expect(f.inputs).toHaveLength(1);expect(f.request).toMatchObject({state:'STOP_REQUESTED',first_start_at:firstStart});expect(f.account.free_started_count).toBe(1);expect(f.started).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([text])=>text.includes('INSERT INTO free_starts')||text.includes('INSERT INTO cost_items')||text.includes('INSERT INTO settlements'))).toBe(false);
  });
  it('keeps RECONCILE lookup-only with the installed preparation hook unused',async()=>{
    const f=fixture();const prepared=await f.service.authorize(f.claim);expect(prepared).not.toBeNull();f.beforeValidateInput.mockClear();f.events.length=0;Object.assign(f.claim,{kind:'RECONCILE',ref:{executionId:prepared!.executionId}});vi.spyOn(f.service,'reconciled').mockResolvedValue(false);
    expect(await f.service.runOnce()).toBe(true);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.validateInput).not.toHaveBeenCalled();expect(f.afterPrepare).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).toHaveBeenCalledExactlyOnceWith(prepared!.executionId,canonicalInput(prepared!),expect.objectContaining({native:expect.any(Object)}));expect(f.events).toEqual(['NATIVE_LOOKUP']);expect(f.inputs).toHaveLength(1);
  });
});


// Conditional admission fixtures reuse the original runOnce/INPUT/claim tests.
// These ports prove control flow only, not a measured host or operational GO.
function conditionalFixture(){
  const f=fixture();
  const reference={kind:'OWNED_FIXTURE' as const,profileId:randomUUID(),profileDigest:sha256('owned-conditional-limit'),profileVersion:'owned-conditional-profile-v1'};
  Object.assign(f.db,{role:'trio_web_worker'});
  Object.assign(f.provider,{synthetic:false,validateObservation:vi.fn(async()=>{})});
  Object.assign(f.service.policy,{synthetic:false,paidEnabled:false,realProviderEnabled:true,parameterProfileVersion:reference.profileVersion,executionLimit:reference,minReadableFontSizePx:10});
  Object.assign(f.request.captured_input,{parameterProfileVersion:reference.profileVersion,executionLimit:structuredClone(reference),minReadableFontSizePx:10});
  const control={unknownCost:false,conflict:false,captureAllowed:true,reserveAllowed:true,checkpointQueries:0};
  const base=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT 1 FROM cost_items')||sql.startsWith('SELECT state,evidence_conflict FROM cost_items'))return {rows:control.unknownCost||control.conflict?[{state:'UNCONFIRMED',evidence_conflict:control.conflict}]:[],rowCount:control.unknownCost||control.conflict?1:0};
    if(sql.startsWith('SELECT manga_web.capture_execution_limits'))return {rows:[{decision:{allowed:control.captureAllowed,reason:control.captureAllowed?'CAPTURED':'LIMIT_AUTHORITY_UNCONFIRMED',stageBounds:{OCR:{boundUsd:'0.1'}}}}],rowCount:1};
    if(sql.startsWith('SELECT manga_web.reserve_execution_limits')){
      if(control.reserveAllowed){f.state.execution!.state='DISPATCHING';f.state.execution!.dispatch_attempted_at=f.now;f.events.push('RESERVE_ACK');}
      return {rows:[{decision:{allowed:control.reserveAllowed,reason:control.reserveAllowed?'RESERVED':'LIMIT_PROFILE_MISMATCH'}}],rowCount:1};
    }
    if(sql.startsWith('SELECT c.checkpoint_id'))control.checkpointQueries++;
    return base(sql,values);
  });
  return {...f,reference,control};
}
function expectNoConditionalDispatch(f:ReturnType<typeof conditionalFixture>){
  expect(f.dispatch).not.toHaveBeenCalled();expect(f.started).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();
}

describe('non-synthetic owned execution keeps original input and authority gates',()=>{
  it('dispatches exactly once after captured profile, native port, preparation and existing SQL reservation ACK',async()=>{
    const f=conditionalFixture();
    expect(await f.service.runOnce()).toBe(true);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.started).not.toHaveBeenCalled();
    expect(f.events).toEqual(['INPUT_INSERT','INPUT_COMMIT_ACK','PREPARE_HOOK','NATIVE_INPUT','VALIDATE_INPUT','AFTER_PREPARE','RESERVE_ACK','NATIVE_DISPATCH','DISPATCH']);
    expect(f.inputs).toHaveLength(1);expect(f.inputs[0].protected_observation.envelope).toMatchObject({parameterProfileVersion:f.reference.profileVersion,costBoundUsd:'0.1'});
    expect(canonicalInput(f.dispatch.mock.calls[0][0])).toEqual(f.inputs[0].protected_observation);
    expect(f.query.mock.calls.find(([sql])=>sql.startsWith('SELECT manga_web.reserve_execution_limits'))?.[1]?.[4]).toBe(JSON.stringify(f.reference));
  });
  it.each(['real-gate','worker-role','gateway','preparation','input-validation','observation-validation','profile','limit','policy-limit-version'] as const)('holds missing configured %s before DB INPUT or native semantic work',async kind=>{
    const f=conditionalFixture();
    if(kind==='real-gate')f.service.policy.realProviderEnabled=false;if(kind==='worker-role')Object.assign(f.db,{role:'trio_web_api'});
    if(kind==='gateway')Object.assign(f.service,{nativeGateway:undefined});if(kind==='preparation')delete f.hooks.beforeValidateInput;
    if(kind==='input-validation')delete f.provider.validateInput;if(kind==='observation-validation')delete f.provider.validateObservation;
    if(kind==='profile')delete f.service.policy.parameterProfileVersion;if(kind==='limit')delete f.service.policy.executionLimit;
    if(kind==='policy-limit-version')f.service.policy.parameterProfileVersion='other-profile';
    expect(await f.service.authorize(f.claim)).toBeNull();expectNoConditionalDispatch(f);expect(f.transactions).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.inputs).toEqual([]);
  });
  it.each(['capture-profile','capture-limit','capture-limit-version','capture-minimum','paid-mode','unknown-cost','cost-conflict'] as const)('holds %s before checkpoint callbacks and new INPUT',async kind=>{
    const f=conditionalFixture(),validation=f.provider.validateObservation!;
    if(kind==='capture-profile')f.request.captured_input.parameterProfileVersion='different-profile';
    if(kind==='capture-limit')delete f.request.captured_input.executionLimit;
    if(kind==='capture-limit-version')f.request.captured_input.executionLimit!.profileVersion='different-profile';
    if(kind==='capture-minimum')delete f.request.captured_input.minReadableFontSizePx;
    if(kind==='paid-mode'){f.request.mode='PAID';f.service.policy.paidEnabled=true;}
    if(kind==='unknown-cost')f.control.unknownCost=true;if(kind==='cost-conflict')f.control.conflict=true;
    expect(await f.service.validateCheckpoints(f.claim)).toBe(false);expect(await f.service.authorize(f.claim)).toBeNull();expectNoConditionalDispatch(f);
    expect(validation).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expect(f.control.checkpointQueries).toBe(kind==='unknown-cost'?2:0);expect(f.inputs).toEqual([]);expect(f.beforeValidateInput).not.toHaveBeenCalled();
  });
  it('holds an uncaptured legacy INPUT cost bound before preparation or native INPUT, without rewriting it',async()=>{
    const f=conditionalFixture(),input=await f.service.authorize(f.claim);expect(input).not.toBeNull();
    const row=f.inputs[0];row.protected_observation.envelope!.costBoundUsd=null;row.evidence_digest=digest(row.protected_observation);const original=structuredClone(f.inputs);
    expect(await f.service.runOnce()).toBe(true);expectNoConditionalDispatch(f);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expect(f.inputs).toEqual(original);expect(f.state.execution!.state).toBe('PREPARED');
  });
  it.each(['lease','generation','owner','request-stop','context-generation','session','unknown-cost','input','profile'] as const)('fences %s changes across the preparation await before native INPUT or dispatch',async kind=>{
    const f=conditionalFixture(),entered=deferred<boolean>(),gate=deferred<void>();
    f.hooks.beforeValidateInput=async()=>{entered.resolve(true);await gate.promise;};const pending=f.service.runOnce();expect(await Promise.race([entered.promise,pending.then(()=>false)])).toBe(true);
    if(kind==='lease')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='generation')f.work.claim_generation='2';if(kind==='owner')f.work.claim_owner=randomUUID();
    if(kind==='request-stop')f.request.state='STOP_REQUESTED';if(kind==='context-generation')f.context.generation='2';if(kind==='session')f.session.absolute_expires_at=new Date(f.now.valueOf()-1);
    if(kind==='unknown-cost')f.control.unknownCost=true;if(kind==='input')f.inputs[0].protected_observation.width=101;if(kind==='profile')f.service.policy.parameterProfileVersion='different-profile';
    gate.resolve();if(kind==='input')await expect(pending).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});else expect(await pending).toBe(true);
    expectNoConditionalDispatch(f);expect(f.nativeTargets).toEqual([]);expect(f.validateInput).not.toHaveBeenCalled();expect(f.state.execution).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});
  });
  it.each(['capture','reservation','profile-validation'] as const)('retains %s admission failure without provider dispatch',async kind=>{
    const f=conditionalFixture();if(kind==='capture')f.control.captureAllowed=false;if(kind==='reservation')f.control.reserveAllowed=false;
    if(kind==='profile-validation')f.validateInput.mockRejectedValue(Error('OWNED_MEASURED_PROFILE_MISMATCH'));
    expect(await f.service.runOnce()).toBe(true);expectNoConditionalDispatch(f);
    if(kind==='capture'){expect(f.inputs).toEqual([]);expect(f.nativeTargets).toEqual([]);}
    if(kind==='reservation'){expect(f.inputs).toHaveLength(1);expect(f.state.execution!.state).toBe('PREPARED');expect(f.nativeTargets).toHaveLength(1);}
    if(kind==='profile-validation')expect(f.query.mock.calls.some(([sql])=>sql.startsWith('SELECT manga_web.reserve_execution_limits'))).toBe(false);
  });
  it('retains native WAIT before checkpoint/native/provider callbacks',async()=>{
    const f=conditionalFixture();f.request.hold_reasons=['NATIVE_EXECUTION_UNCONFIRMED'];
    expect(await f.service.runOnce()).toBe(true);expectNoConditionalDispatch(f);expect(f.nativeTargets).toEqual([]);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.inputs).toEqual([]);expect(f.control.checkpointQueries).toBe(0);
  });
  it('keeps non-synthetic fixture settlement closed even after conditional admission',async()=>{
    const f=conditionalFixture();expect(await f.service.settle(f.accountId,randomUUID())).toBe(false);expect(f.transactions).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
});


function checkpointFixture(f:ReturnType<typeof conditionalFixture>,input:StageInput){
  const id=randomUUID(),row=f.inputs.find(value=>value.protected_observation.executionId===input.executionId)!;
  const observation=normalizeObservation(row.protected_observation,{evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'OWNED_CHECKPOINT',providerRef:'owned-checkpoint-result',data:structuredClone(input.initialData)});observation.stageOutput!.checkpointId=id;
  const checkpoint={checkpoint_id:id,execution_id:input.executionId,output_envelope:observation},base=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT c.checkpoint_id'))return {rows:[structuredClone(checkpoint)],rowCount:1};
    if(sql.startsWith('SELECT 1 FROM request_steps s JOIN checkpoints'))return {rows:[{present:1}],rowCount:1};
    return base(sql,values);
  });
  return {checkpoint,row};
}

describe('original checkpoint input stays bounded before semantic/native callbacks',()=>{
  it.each(['NULL_BOUND','PROFILE_MISMATCH'] as const)('holds original %s without upgrading capture or terminalizing the request',async kind=>{
    const f=conditionalFixture(),input=await f.service.authorize(f.claim);expect(input).not.toBeNull();
    const row=f.inputs[0];if(kind==='NULL_BOUND')row.protected_observation.envelope!.costBoundUsd=null;else row.protected_observation.envelope!.parameterProfileVersion='owned-old-profile-v1';row.evidence_digest=digest(row.protected_observation);
    const {checkpoint}=checkpointFixture(f,input!),originalInput=structuredClone(f.inputs),originalCheckpoint=structuredClone(checkpoint),originalRequest=structuredClone(f.request),originalClaim=structuredClone(f.claim);
    expect(await f.service.validateCheckpoints(f.claim)).toBe(false);expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expectNoConditionalDispatch(f);
    expect(f.inputs).toEqual(originalInput);expect(checkpoint).toEqual(originalCheckpoint);expect(f.request).toEqual(originalRequest);expect(f.claim).toEqual(originalClaim);
  });
  it('retains the valid original checkpoint callback and its verified digest',async()=>{
    const f=conditionalFixture(),input=await f.service.authorize(f.claim);expect(input).not.toBeNull();const {checkpoint}=checkpointFixture(f,input!),originalInput=structuredClone(f.inputs);
    expect(await f.service.validateCheckpoints(f.claim)).toBe(true);expect(f.provider.validateObservation).toHaveBeenCalledOnce();expect(f.nativeTargets).toHaveLength(1);expect(f.claim.checkpointDigests).toEqual({[checkpoint.checkpoint_id]:digest(checkpoint.output_envelope)});expect(f.inputs).toEqual(originalInput);expectNoConditionalDispatch(f);
  });
});

// Existing completed TYPESET control flow; metadata ports only, no native/job IO.
async function completedTypesetFixture(nextStage=false){
  const f=conditionalFixture();f.service.policy.stageOrder=nextStage?['TYPESET','TRANSLATE']:['TYPESET'];f.request.captured_stage_order=[...f.service.policy.stageOrder];
  f.request.captured_input.data={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',blocks:[{regionId:randomUUID(),geometry:{polygon:[{x:10,y:10},{x:80,y:10},{x:80,y:50},{x:10,y:50}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'owned confirmed source',status:'USER_CONFIRMED'},translatedText:{value:'owned confirmed translation',status:'USER_CONFIRMED'},fontAssetId:f.request.captured_input.originalAssetId,fontSizePx:12,appliedTranslation:null}]};
  const preparedBase=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT s.logical_step_id,s.current_execution_id'))return {rows:f.request.captured_stage_order.map(stage=>({logical_step_id:stage,current_execution_id:stage==='TYPESET'?f.state.pointer:null,reuse_checkpoint_id:null,execution_state:stage==='TYPESET'?f.state.execution?.state??null:null,output_envelope:null})),rowCount:f.request.captured_stage_order.length};
    if(sql.startsWith('SELECT manga_web.capture_execution_limits'))return {rows:[{decision:{allowed:true,reason:'CAPTURED',stageBounds:{TYPESET:{boundUsd:'0.1'},TRANSLATE:{boundUsd:'0.1'}}}}],rowCount:1};
    return preparedBase(sql,values);
  });
  const input=await f.service.authorize(f.claim);expect(input?.stage).toBe('TYPESET');
  const renderId=randomUUID(),checkpointId=randomUUID(),dependency={assetId:renderId,sha256:sha256('owned-completed-render'),bytesLength:'8',mediaType:'image/png'};
  const observation=normalizeObservation(input!,{evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,finishReason:'OWNED_COMPLETED_TYPESET',providerRef:input!.executionId,data:structuredClone(input!.initialData),outputAssetIds:[renderId],assetDependencies:[dependency],renderAssetId:renderId});observation.stageOutput!.checkpointId=checkpointId;
  const checkpoint={checkpoint_id:checkpointId,execution_id:input!.executionId,output_envelope:observation,verification_state:'VERIFIED',ordinal:0,logical_step_id:'TYPESET',reuse_checkpoint_id:null,execution_state:'SUCCEEDED'};
  Object.assign(f.state.execution!,{state:'SUCCEEDED',output_envelope:observation,start_confirmed_at:f.now});f.request.state='WAITING';f.request.first_start_at=f.now;f.request.hold_reasons=['COST_UNCONFIRMED'];f.control.unknownCost=true;
  const cost={cost_item_id:randomUUID(),execution_id:input!.executionId,state:'UNCONFIRMED',actual_usd:null,rate_version:null,evidence_conflict:false};
  const page:PageRow={account_id:f.accountId,context_id:f.context.context_id,project_lineage_id:f.context.project_lineage_id,page_lineage_id:f.request.page_lineage_id,display_order:0,excluded:false,skip:false,result_revision:'0',revision:'0',current_result_id:randomUUID(),image_width:100,image_height:100,paid_baseline_credit:'0',paid_baseline_state:'CONFIRMED',baseline_contribution_refs:[],baseline_unsettled_refs:[],display_name:'owned TYPESET'};
  const original:ResultRow={account_id:f.accountId,result_id:page.current_result_id!,context_id:page.context_id,page_lineage_id:page.page_lineage_id,result_revision:'0',original_asset_id:input!.originalAssetId,cleaned_asset_id:null,render_asset_id:null,edit_data:structuredClone(input!.initialData),origin:'UPLOAD'},results=[original],applications:Record<string,unknown>[]=[],queued:string[]=[];
  const base=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT 1 FROM cost_items WHERE')||sql.startsWith('SELECT state,evidence_conflict FROM cost_items WHERE'))return {rows:f.control.unknownCost||cost.evidence_conflict?[structuredClone(cost)]:[],rowCount:f.control.unknownCost||cost.evidence_conflict?1:0};
    if(sql.startsWith('SELECT c.checkpoint_id')){f.control.checkpointQueries++;return {rows:[structuredClone(checkpoint)],rowCount:1};}
    if(sql.startsWith('SELECT s.logical_step_id,s.current_execution_id'))return {rows:f.request.captured_stage_order.map((stage,ordinal)=>stage==='TYPESET'?{logical_step_id:stage,current_execution_id:input!.executionId,reuse_checkpoint_id:null,execution_state:'SUCCEEDED',output_envelope:checkpoint.output_envelope,checkpoint_id:checkpointId,origin_execution_id:input!.executionId,origin_request_id:input!.requestId,checkpoint_output:checkpoint.output_envelope,dependency_digest:input!.inputDigest,stage_contract:input!.settings.contractVersion,verification_state:checkpoint.verification_state}:{logical_step_id:stage,current_execution_id:null,reuse_checkpoint_id:null,execution_state:null,output_envelope:null,ordinal}),rowCount:f.request.captured_stage_order.length};
    if(sql.startsWith('SELECT s.logical_step_id,s.ordinal'))return {rows:f.request.captured_stage_order.map((stage,ordinal)=>({logical_step_id:stage,ordinal,reuse_checkpoint_id:null,execution_id:stage==='TYPESET'?input!.executionId:null,execution_request_id:stage==='TYPESET'?input!.requestId:null,execution_state:stage==='TYPESET'?'SUCCEEDED':null,execution_stage:stage,contract_version:input!.settings.contractVersion,input_digest:input!.inputDigest,verification_state:checkpoint.verification_state,stage_contract:input!.settings.contractVersion,dependency_digest:input!.inputDigest})),rowCount:f.request.captured_stage_order.length};
    if(sql.startsWith('SELECT 1 FROM request_steps s JOIN checkpoints'))return {rows:[{present:1}],rowCount:1};
    if(sql.startsWith('SELECT asset_id,sha256,bytes_length'))return {rows:[{asset_id:renderId,sha256:dependency.sha256,bytes_length:dependency.bytesLength,media_type:dependency.mediaType,purpose:'LIVE',deletion_state:'NOT_DUE'}],rowCount:1};
    if(sql.startsWith('SELECT p.result_revision'))return {rows:[{result_revision:page.result_revision,excluded:page.excluded,request_id:f.requestId}],rowCount:1};
    if(sql.startsWith('SELECT * FROM workspace_pages'))return {rows:[structuredClone(page)],rowCount:1};
    if(sql.startsWith('SELECT * FROM results'))return {rows:results.filter(row=>row.result_id===values[3]).map(row=>structuredClone(row)),rowCount:results.filter(row=>row.result_id===values[3]).length};
    if(sql.startsWith('SELECT COALESCE(max(result_revision)'))return {rows:[{revision:String(results.length)}],rowCount:1};
    if(sql.startsWith('SELECT 1 FROM result_applications'))return {rows:applications.map(()=>({present:1})),rowCount:applications.length};
    if(sql.startsWith('INSERT INTO results')){results.push({account_id:f.accountId,result_id:values[1] as string,context_id:values[2] as string,page_lineage_id:values[3] as string,result_revision:values[4] as string,original_asset_id:values[5] as string,edit_data:JSON.parse(values[6] as string),cleaned_asset_id:values[7] as string|null,render_asset_id:values[8] as string|null,origin:'AI_APPLIED'});return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO result_applications')){applications.push({requestId:values[2],executionId:values[3],resultId:values[4],outcome:values[7]});return {rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE workspace_pages SET current_result_id')){page.current_result_id=values[3] as string;page.result_revision=values[4] as string;return {rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE workspace_contexts SET workspace_revision')){f.context.workspace_revision=String(BigInt(f.context.workspace_revision)+1n);return {rows:[{workspace_revision:f.context.workspace_revision}],rowCount:1};}
    if(sql.startsWith('INSERT INTO work_items')){queued.push(values[2] as string);return {rows:[],rowCount:1};}
    if(sql.startsWith('SELECT s.absolute_expires_at,s.binding_id'))return {rows:[{...f.session,binding_id:randomUUID(),state:'ACTIVE'}],rowCount:1};
    if(sql.startsWith('SELECT c.cost_item_id'))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT revision,cursor_history_id FROM history_cursors'))return {rows:[{revision:'0',cursor_history_id:null}],rowCount:1};
    return base(sql,values);
  });
  const apply=vi.spyOn(f.service,'applyComplete');f.provider.validateObservation=vi.fn(async()=>{});f.nativeTargets.length=0;f.events.length=0;
  return {...f,input:input!,checkpoint,cost,page,results,applications,queued,apply,original};
}

describe('completed TYPESET result application is separate from new execution cost admission',()=>{
  it('applies and exposes a fully verified final TYPESET with unconfirmed cost and no new stage dispatch',async()=>{
    const f=await completedTypesetFixture(),inputBefore=structuredClone(f.inputs),costBefore=structuredClone(f.cost),checkpointBefore=structuredClone(f.checkpoint);
    expect(await f.service.authorize(f.claim)).toBeNull();expect(f.apply).toHaveBeenCalledOnce();expect(f.results).toHaveLength(2);expect(f.applications).toEqual([{requestId:f.requestId,executionId:f.input.executionId,resultId:f.page.current_result_id,outcome:'APPLIED'}]);expect(f.queued).toEqual(['STORE']);
    const view=await new Projections(f.db).page({accountId:f.accountId,sessionId:f.context.owner_session_id!,tabId:f.context.owner_tab_id!,ownerCapability:'owned-preparation-owner'},f.context.context_id,f.page.page_lineage_id);
    expect(view.renderAssetId).toBe(f.checkpoint.output_envelope.renderAssetId);expect(view.resultRevision).toBe('1');expect(view.blocks).toEqual(f.input.initialData.blocks);expect(f.request.state).toBe('COMPLETED');expect(f.cost).toEqual(costBefore);expect(f.cost.state).toBe('UNCONFIRMED');expect(f.inputs).toEqual(inputBefore);expect(f.checkpoint).toEqual(checkpointBefore);expectNoConditionalDispatch(f);expect(f.queued).not.toContain('SETTLE');
    const applied=structuredClone({results:f.results,applications:f.applications,queued:f.queued});expect(await f.service.authorize(f.claim)).toBeNull();expect({results:f.results,applications:f.applications,queued:f.queued}).toEqual(applied);expect(f.apply).toHaveBeenCalledOnce();
  });
  it('holds incomplete next stage with unconfirmed cost before any provider/native callback',async()=>{
    const f=await completedTypesetFixture(true);expect(await f.service.authorize(f.claim)).toBeNull();expect(f.apply).not.toHaveBeenCalled();expect(f.applications).toEqual([]);expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expectNoConditionalDispatch(f);expect(f.cost.state).toBe('UNCONFIRMED');
  });
  it.each(['LEASE','CLAIM_OWNER','CONTEXT_GENERATION','SESSION','PAGE_REVISION','INPUT_DIGEST','NULL_BOUND','PROFILE','NATIVE_WAIT','COST_CONFLICT','CHECKPOINT_TAMPER','ACCOUNT','PROFILE_CAPTURE','LIMIT_CAPTURE','UNVERIFIED','STAGE_ORDER','ZERO_BOUND'] as const)('holds completed %s without application or a new dispatch',async kind=>{
    const f=await completedTypesetFixture();
    if(kind==='LEASE')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='CLAIM_OWNER')f.work.claim_owner=randomUUID();if(kind==='CONTEXT_GENERATION')f.context.generation='2';if(kind==='SESSION')f.session.absolute_expires_at=new Date(f.now.valueOf()-1);if(kind==='PAGE_REVISION')f.page.result_revision='2';
    if(kind==='INPUT_DIGEST')f.inputs[0].protected_observation.width++;if(kind==='NULL_BOUND'){f.inputs[0].protected_observation.envelope!.costBoundUsd=null;f.inputs[0].evidence_digest=digest(f.inputs[0].protected_observation);}if(kind==='PROFILE')f.service.policy.parameterProfileVersion='different-profile';
    if(kind==='NATIVE_WAIT')f.request.hold_reasons.push('NATIVE_EXECUTION_UNCONFIRMED');if(kind==='COST_CONFLICT')f.cost.evidence_conflict=true;if(kind==='CHECKPOINT_TAMPER')f.checkpoint.output_envelope.stageOutput!.inputDigest=sha256('changed-checkpoint-input');
    if(kind==='ACCOUNT')f.account.access_state='SUSPENDED';if(kind==='PROFILE_CAPTURE')f.request.captured_input.parameterProfileVersion='old-profile';if(kind==='LIMIT_CAPTURE')delete f.request.captured_input.executionLimit;if(kind==='UNVERIFIED')f.checkpoint.verification_state='INVALID';if(kind==='STAGE_ORDER')f.request.captured_stage_order=['OCR'];if(kind==='ZERO_BOUND'){f.inputs[0].protected_observation.envelope!.costBoundUsd='0';f.inputs[0].evidence_digest=digest(f.inputs[0].protected_observation);}
    expect(await f.service.authorize(f.claim)).toBeNull();expect(f.apply).not.toHaveBeenCalled();expect(f.applications).toEqual([]);expectNoConditionalDispatch(f);expect(f.queued).not.toContain('SETTLE');expect(f.cost.state).toBe('UNCONFIRMED');
  });
  it.each(['CLAIM_OWNER','SESSION','PAGE_REVISION','COST_CONFLICT','NATIVE_WAIT','LEASE','CONTEXT_GENERATION','INPUT_DIGEST','PROFILE','LIMIT_CAPTURE','CHECKPOINT_TAMPER'] as const)('rechecks completed %s after the provider validation await',async kind=>{
    const f=await completedTypesetFixture();f.provider.validateObservation=vi.fn(async()=>{if(kind==='CLAIM_OWNER')f.work.claim_owner=randomUUID();if(kind==='SESSION')f.session.absolute_expires_at=new Date(f.now.valueOf()-1);if(kind==='PAGE_REVISION')f.page.result_revision='2';if(kind==='COST_CONFLICT')f.cost.evidence_conflict=true;if(kind==='NATIVE_WAIT')f.request.hold_reasons.push('NATIVE_EXECUTION_UNCONFIRMED');if(kind==='LEASE')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='CONTEXT_GENERATION')f.context.generation='2';if(kind==='INPUT_DIGEST')f.inputs[0].protected_observation.width++;if(kind==='PROFILE')f.service.policy.parameterProfileVersion='different-profile';if(kind==='LIMIT_CAPTURE')delete f.request.captured_input.executionLimit;if(kind==='CHECKPOINT_TAMPER')f.checkpoint.output_envelope.stageOutput!.inputDigest=sha256('changed-after-callback');});
    expect(await f.service.authorize(f.claim)).toBeNull();expect(f.provider.validateObservation).toHaveBeenCalledOnce();expect(f.applications).toEqual([]);expectNoConditionalDispatch(f);expect(f.queued).not.toContain('SETTLE');
  });
  it('keeps unconfirmed native termination during checkpoint validation on HOLD',async()=>{
    const f=await completedTypesetFixture();f.provider.validateObservation=vi.fn(async()=>{throw nativeFault();});expect(await f.service.authorize(f.claim)).toBeNull();expect(f.nativeWait).toHaveBeenCalledOnce();expect(f.nativeWait.mock.calls[0][2]).toBe('CHECKPOINT');expect(f.applications).toEqual([]);expectNoConditionalDispatch(f);
  });
});


function costWaitingFixture(){
  const f=conditionalFixture(),costs:{account_id:string;request_id:string;state:'UNCONFIRMED'|'CONFIRMED';evidence_conflict:boolean;actual_usd:string|null}[]=[],costGate={visible:true},base=f.query.getMockImplementation()!,ownerSessionId=f.context.owner_session_id;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT s.absolute_expires_at')&&(values[0]!==f.accountId||values[1]!==ownerSessionId))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT * FROM processing_requests')&&(values[0]!==f.accountId||values[1]!==f.requestId))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT * FROM work_items')&&(values[0]!==f.accountId||values[1]!==f.work.work_item_id))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT 1 FROM cost_items')||sql.startsWith('SELECT state,evidence_conflict FROM cost_items')){const pending=costs.filter(cost=>costGate.visible&&cost.account_id===values[0]&&(cost.state==='UNCONFIRMED'||cost.evidence_conflict)&&(!sql.includes('JOIN executions')||cost.request_id===values[1]));return {rows:pending.map(cost=>({state:cost.state,evidence_conflict:cost.evidence_conflict})),rowCount:pending.length};}
    if(sql.startsWith('UPDATE processing_requests SET hold_reasons=$3')){if(values[0]!==f.accountId||values[1]!==f.requestId)return {rows:[],rowCount:0};f.request.hold_reasons=JSON.parse(values[2] as string);return {rows:[],rowCount:1};}
    if(sql.startsWith("UPDATE processing_requests SET state=CASE WHEN state='STOP_REQUESTED' THEN state ELSE 'WAITING' END")){if(values[0]!==f.accountId||values[1]!==f.requestId)return {rows:[],rowCount:0};if(f.request.state!=='STOP_REQUESTED')f.request.state='WAITING';return {rows:[],rowCount:1};}
    return base(sql,values);
  });
  return {...f,costs,costGate};
}

describe('current request displays account-wide cost admission hold',()=>{
  it('shows WAITING and preserves reasons for a second request blocked by another request cost with no checkpoint',async()=>{
    const f=costWaitingFixture(),firstRequestId=randomUUID(),cost={account_id:f.accountId,request_id:firstRequestId,state:'UNCONFIRMED' as const,evidence_conflict:false,actual_usd:null};f.costs.push(cost);f.request.hold_reasons=['PROVIDER_LIMIT_WAIT'];const originalCost=structuredClone(cost);
    expect(await f.service.runOnce()).toBe(true);expect(f.request.state).toBe('WAITING');expect(f.request.hold_reasons).toEqual(['PROVIDER_LIMIT_WAIT','COST_UNCONFIRMED']);expect(f.costs).toEqual([originalCost]);expect(f.control.checkpointQueries).toBe(1);expectNoConditionalDispatch(f);expect(f.inputs).toEqual([]);expect(f.nativeTargets).toEqual([]);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
  });

  it('merges a repeated cost hold once and does not rewrite an already waiting request',async()=>{
    const f=costWaitingFixture();f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});f.request.hold_reasons=['PROVIDER_LIMIT_WAIT','COST_UNCONFIRMED','COST_UNCONFIRMED'];expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toMatchObject({state:'WAITING',hold_reasons:['PROVIDER_LIMIT_WAIT','COST_UNCONFIRMED']});f.query.mockClear();expect(await f.service.authorize(f.claim)).toBeNull();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests'))).toBe(false);expectNoConditionalDispatch(f);expect(f.inputs).toEqual([]);
  });
  it('clears only the resolved cost reason and continues original admission and START notification without changing stored cost',async()=>{
    const f=costWaitingFixture(),cost={account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED' as const,evidence_conflict:false,actual_usd:null};f.costs.push(cost);f.request.hold_reasons=['PROVIDER_LIMIT_WAIT'];const originalCost=structuredClone(f.costs);expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toMatchObject({state:'WAITING',hold_reasons:['PROVIDER_LIMIT_WAIT','COST_UNCONFIRMED'],first_start_at:null});
    // Simulate a trusted gate reporting resolution; do not rewrite the original cost fact.
    f.costGate.visible=false;const startId=randomUUID();f.dispatch.mockImplementation(async(_input,onStarted)=>{await onStarted(startId);return {evidenceId:randomUUID(),outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'OWNED_METADATA_ONLY',providerRef:null,data:null};});
    expect(await f.service.runOnce()).toBe(true);expect(f.request.hold_reasons).toEqual(['PROVIDER_LIMIT_WAIT']);expect(f.request.first_start_at).toBeNull();expect(f.costs).toEqual(originalCost);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.started).toHaveBeenCalledExactlyOnceWith(f.accountId,f.state.execution!.execution_id,startId,f.claim);expect(f.inputs).toHaveLength(1);expect(f.nativeTargets).toHaveLength(2);expect(await f.service.settle(f.accountId,randomUUID())).toBe(false);expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO settlements')||sql.includes('INSERT INTO cost_items')||sql.includes('INSERT INTO free_starts'))).toBe(false);
  });
  it('does not hold the current account for a different account unconfirmed cost',async()=>{
    const f=costWaitingFixture();f.costs.push({account_id:randomUUID(),request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});const originalCost=structuredClone(f.costs);expect(await f.service.runOnce()).toBe(true);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.request).toMatchObject({state:'ACCEPTED',hold_reasons:[]});expect(f.costs).toEqual(originalCost);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests'))).toBe(false);
  });
  it('displays a conflicting cost hold before checkpoint callbacks and preserves the actual cost evidence',async()=>{
    const f=costWaitingFixture();f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'CONFIRMED',evidence_conflict:true,actual_usd:'0.027'});const originalCost=structuredClone(f.costs);expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toMatchObject({state:'WAITING',hold_reasons:['COST_UNCONFIRMED']});expect(f.costs).toEqual(originalCost);expect(f.control.checkpointQueries).toBe(0);expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.nativeTargets).toEqual([]);expectNoConditionalDispatch(f);
  });
  it.each(['OWNER','GENERATION','LEASE','COMPLETED','STOPPED','FAILED','NO_OWNER','CONTEXT_GENERATION','SESSION','REQUEST_REF','ACCOUNT','ACCOUNT_REF','STOP_BEFORE_START'] as const)('does not update a cost hold for invalid or terminal %s',async kind=>{
    const f=costWaitingFixture();f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});
    if(kind==='OWNER')f.work.claim_owner=randomUUID();if(kind==='GENERATION')f.work.claim_generation='2';if(kind==='LEASE')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='COMPLETED'||kind==='STOPPED'||kind==='FAILED')f.request.state=kind;if(kind==='NO_OWNER')f.context.owner_session_id=null;if(kind==='CONTEXT_GENERATION')f.context.generation='2';if(kind==='SESSION')f.session.absolute_expires_at=new Date(f.now.valueOf()-1);if(kind==='REQUEST_REF')f.claim.ref.requestId=randomUUID();if(kind==='ACCOUNT')f.account.access_state='SUSPENDED';if(kind==='ACCOUNT_REF')f.claim.accountId=randomUUID();if(kind==='STOP_BEFORE_START')f.request.state='STOP_REQUESTED';
    const originalRequest=structuredClone(f.request),originalCost=structuredClone(f.costs);expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toEqual(originalRequest);expect(f.costs).toEqual(originalCost);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests'))).toBe(false);expectNoConditionalDispatch(f);expect(f.inputs).toEqual([]);expect(f.nativeTargets).toEqual([]);expect(f.beforeValidateInput).not.toHaveBeenCalled();expect(f.provider.validateObservation).not.toHaveBeenCalled();
  });
  it('preserves STOP_REQUESTED after an original START when displaying a cost hold',async()=>{
    const f=costWaitingFixture();f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});f.request.state='STOP_REQUESTED';f.request.first_start_at=f.now;f.request.hold_reasons=['PROVIDER_LIMIT_WAIT'];expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toMatchObject({state:'STOP_REQUESTED',first_start_at:f.now,hold_reasons:['PROVIDER_LIMIT_WAIT','COST_UNCONFIRMED']});expectNoConditionalDispatch(f);expect(f.inputs).toEqual([]);expect(f.nativeTargets).toEqual([]);
  });
  it.each(['OWNER','LEASE','TERMINAL','NO_OWNER'] as const)('rechecks %s after reading a pending account cost before changing request metadata',async kind=>{
    const f=costWaitingFixture(),entered=deferred<boolean>(),gate=deferred<void>();f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});const base=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values=[])=>{const result=await base(sql,values);if(sql.startsWith('SELECT state,evidence_conflict FROM cost_items')){entered.resolve(true);await gate.promise;}return result;});const pending=f.service.authorize(f.claim);expect(await Promise.race([entered.promise,pending.then(()=>false)])).toBe(true);
    if(kind==='OWNER')f.work.claim_owner=randomUUID();if(kind==='LEASE')f.work.lease_until=new Date(f.now.valueOf()-1);if(kind==='TERMINAL')f.request.state='COMPLETED';if(kind==='NO_OWNER')f.context.owner_session_id=null;const originalRequest=structuredClone(f.request);gate.resolve();expect(await pending).toBeNull();expect(f.request).toEqual(originalRequest);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests'))).toBe(false);expectNoConditionalDispatch(f);expect(f.nativeTargets).toEqual([]);expect(f.provider.validateObservation).not.toHaveBeenCalled();
  });
  it.each(['PREPARATION','PREFLIGHT'] as const)('displays the cost hold when it appears at %s while retaining no-dispatch fences',async phase=>{
    const f=costWaitingFixture(),cost={account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED' as const,evidence_conflict:false,actual_usd:null};if(phase==='PREPARATION')f.hooks.beforeValidateInput=async()=>{f.costs.push(cost);};else f.hooks.afterPrepare=async()=>{f.costs.push(cost);};
    expect(await f.service.runOnce()).toBe(true);expect(f.request).toMatchObject({state:'WAITING',hold_reasons:['COST_UNCONFIRMED']});expect(f.costs).toEqual([cost]);expectNoConditionalDispatch(f);expect(f.inputs).toHaveLength(1);expect(f.nativeTargets).toHaveLength(phase==='PREPARATION'?0:1);expect(f.state.execution).toMatchObject({state:phase==='PREPARATION'?'PREPARED':'REJECTED',dispatch_attempted_at:null,start_confirmed_at:null});
  });
  it('displays a new cost after checkpoint validation without entering another native or provider dispatch',async()=>{
    const f=costWaitingFixture(),input=await f.service.authorize(f.claim);expect(input).not.toBeNull();checkpointFixture(f,input!);const originalInput=structuredClone(f.inputs);f.provider.validateObservation=vi.fn(async()=>{f.costs.push({account_id:f.accountId,request_id:randomUUID(),state:'UNCONFIRMED',evidence_conflict:false,actual_usd:null});});expect(await f.service.authorize(f.claim)).toBeNull();expect(f.request).toMatchObject({state:'WAITING',hold_reasons:['COST_UNCONFIRMED']});expect(f.provider.validateObservation).toHaveBeenCalledOnce();expect(f.inputs).toEqual(originalInput);expect(f.nativeTargets).toHaveLength(1);expectNoConditionalDispatch(f);
  });
});


import {generateKeyPairSync} from 'node:crypto';
import {NativeRemoteDatabaseGateway} from '../../packages/domain/src/native-remote-gateway.js';
import {NativeRemoteController} from '../../packages/native/src/controller-remote.js';
import {WindowsNativeCostJournal} from '../../packages/domain/src/windows-native-cost.js';
import type {OperationalStageCost} from '../../packages/domain/src/pipeline-stage-cost.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {windowsNativeLimits} from '../fixtures/windows-native.js';

// 실제 실행기 제어 흐름과 명목 gateway를 사용하며 DB·비용 수집은 메타데이터 포트다.
// SQL 권위·전체 비용과 등록 거래의 원자성은 별도 PG 검사에서 확인한다.
function windowsExecutionFixture(){
  const f=fixture(),basis=basisFixture(f),events=f.events,signing=generateKeyPairSync('ed25519');
  Object.defineProperty(f.db,'role',{value:'trio_web_worker',enumerable:true});
  const controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,windows:{version:2},client:{exchange:vi.fn(async()=>{throw Error('B3-A 실제 native 실행 금지');}),shutdown:async()=>{}}});
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'b3a-domain-v1',maxSlots:2,nativeProfileDigest:controller.profileDigest,kernelDigest:controller.kernelImplementationDigest,controllerId:randomUUID(),keyVersion:'fixture-key',environmentDigest:sha256('B3-A 격리 환경'),publicKeySpki:signing.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:b3a/domain-only'],windows:{hostEpochId:randomUUID(),policy:{maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'},pins:{executableDigest:sha256('node'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('host'),runtimeFilesDigest:sha256('runtime'),nativeLimitsDigest:digest(windowsNativeLimits)},controllerSidDigest:sha256('controller'),childSidDigest:sha256('child'),appContainerSidDigest:sha256('container')}};
  const capacity={reference:{kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('B3-A SQL profile'),profileVersion:profile.version},profile};
  const costs=new WindowsNativeCostJournal(f.db,{maxRecordBytes:32768,maxRecords:64}),io={bucket:'fake-only',read:vi.fn(),receipt:vi.fn(),put:vi.fn(),lookup:vi.fn(async()=>null)};
  const gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs,components:[{task:'DECODE_IMAGE',componentId:'native-image'}]});
  Object.defineProperty(f.service,'nativeGateway',{value:gateway});
  const entry=basis.catalog[0];entry.profileDigest=controller.profileDigest;entry.snapshot!.profileDigest=controller.profileDigest;entry.snapshot!.components[0]={componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'b3a-domain-rate',usdPerUnit:'0.01',evidenceRefs:['b3a:unit']};
  const preparation=basis.adapter(),basisId=randomUUID(),enrollment={evidenceId:randomUUID(),evidenceDigest:sha256('B3-A enrollment')},root={evidenceId:randomUUID(),evidenceDigest:sha256('B3-A root')};
  let prepareGate:Promise<void>|undefined,finishGate:Promise<void>|undefined;
  const prepareEntered=deferred<void>(),finishEntered=deferred<void>(),query=f.query.getMockImplementation()!;
  const readBasis=()=>({version:1,accountId:f.accountId,executionId:f.state.execution!.execution_id,inputDigest:f.state.execution!.input_digest,inputFingerprint:digest(canonicalInput(f.inputs[0].protected_observation)),kind:'OPERATIONAL_COST_BASIS',value:basis.state.basis});
  f.query.mockImplementation(async(text,values=[])=>{
    if(text.startsWith('UPDATE work_items SET lease_until')){
      if(f.work.state!=='CLAIMED'||f.work.claim_owner!==values[3]||f.work.claim_generation!==values[2]||!f.work.lease_until||f.work.lease_until<=(values[5] as Date))return {rows:[],rowCount:0};
      f.work.lease_until=values[4] as Date;events.push('RENEW');return {rows:[{work_item_id:f.claim.workId}],rowCount:1};
    }
    if(text.includes('windows_native_cost_enroll_input(')){events.push('ENROLL');return {rows:[{value:enrollment}],rowCount:1};}
    if(text.includes('windows_native_cost_activate(')){events.push('ROOT_ACK');return {rows:[{value:root}],rowCount:1};}
    if(text.includes('FROM execution_evidence')&&text.includes('OPERATIONAL_COST_BASIS')&&text.trimStart().startsWith('SELECT')){
      if(!basis.state.basis)return {rows:[],rowCount:0};const wrapper=readBasis();return {rows:[{evidence_id:basisId,evidence_digest:digest(wrapper),protected_evidence_ref:basisId,kind:'OPERATIONAL_COST_BASIS',protected_observation:wrapper}],rowCount:1};
    }
    if(text.includes('FROM execution_evidence')&&text.includes("kind='INPUT'")&&text.includes('evidence_id')&&text.trimStart().startsWith('SELECT')){
      return {rows:f.inputs.map(row=>({...structuredClone(row),protected_evidence_ref:row.evidence_id,kind:'INPUT'})),rowCount:f.inputs.length};
    }
    return query(text,values);
  });
  const cost={prepare:async(input:StageInput,claim:NativeJobClaim)=>{prepareEntered.resolve();if(prepareGate)await prepareGate;await preparation.prepare(input,claim);},readIn:async()=>({...costView(basis.state.basis),sealedCalculation:null}),hasPendingOtherIn:async()=>false,
    finishAttempt:async()=>{events.push('COST_BEGIN');finishEntered.resolve();if(finishGate)await finishGate;events.push('COST_END');}};
  Object.defineProperty(f.service,'operationalCost',{value:cost as unknown as OperationalStageCost});
  // 체크포인트의 별도 원자료 계약을 우회한 제품 증거로 계산하지 않는다.
  vi.spyOn(f.service as unknown as {validateOperationalCheckpoints:()=>Promise<boolean>},'validateOperationalCheckpoints').mockResolvedValue(true);
  f.hooks.heartbeatMilliseconds=10000;
  const renew=vi.spyOn(f.service,'renew'),finish=vi.spyOn(f.service,'finish');
  finish.mockImplementation(async(...args)=>{events.push('FINISH');await ExecutionService.prototype.finish.apply(f.service,args);});
  return {...f,gateway,cost,basis,io,renew,finish,prepareEntered,finishEntered,blockPrepare:(gate:Promise<void>)=>{prepareGate=gate;},blockFinish:(gate:Promise<void>)=>{finishGate=gate;},close:async()=>{gateway.stopClaims();await gateway.idle();}};
}

describe('B3-A 실제 실행기의 원 claim 수명',()=>{
  it('B3-A preparation 중에도 같은 원 claim을 갱신한다',async()=>{
    vi.useFakeTimers();const f=windowsExecutionFixture(),gate=deferred<void>();f.blockPrepare(gate.promise);
    const completion=f.service.runOnce().then(value=>({value}),error=>({error}));
    try{
      await f.prepareEntered.promise;await vi.advanceTimersByTimeAsync(10001);
      expect(f.renew,'BASIS 준비 중 원 claim 갱신이 필요하다').toHaveBeenCalled();
      expect(f.renew.mock.calls.every(([claim])=>claim===f.claim)).toBe(true);
    }finally{gate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({value:true});
  });
  it('B3-A 비용 확인이 pending인 동안 claim을 반환하지 않는다',async()=>{
    vi.useFakeTimers();const f=windowsExecutionFixture(),gate=deferred<void>();f.blockFinish(gate.promise);
    const completion=f.service.runOnce().then(value=>({value}),error=>({error}));
    try{
      await f.finishEntered.promise;
      expect(f.work.state,'비용 확인 전에 작업 권한을 반환하면 안 된다').toBe('CLAIMED');
      expect(f.finish).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(10001);
      expect(f.renew).toHaveBeenCalled();expect(f.renew.mock.calls.every(([claim])=>claim===f.claim)).toBe(true);
    }finally{gate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({value:true});
    expect(f.events.indexOf('COST_END')).toBeLessThan(f.events.lastIndexOf('FINISH'));
  });
});


describe('B3-A 원 claim 종료와 오류 보존',()=>{
  it('B3-A 비용 종료 뒤에도 진행 중인 같은 claim 갱신을 기다린다',async()=>{
    vi.useFakeTimers();const f=windowsExecutionFixture(),costGate=deferred<void>(),renewGate=deferred<void>();f.blockFinish(costGate.promise);
    f.renew.mockImplementation(async claim=>{await renewGate.promise;return ExecutionService.prototype.renew.call(f.service,claim);});
    let completed=false;const completion=f.service.runOnce().then(value=>{completed=true;return {value};},error=>{completed=true;return {error};});
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);expect(f.renew).toHaveBeenCalledOnce();
      costGate.resolve();await Promise.resolve();await Promise.resolve();expect(completed).toBe(false);expect(f.finish).not.toHaveBeenCalled();
    }finally{costGate.resolve();renewGate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({value:true});expect(f.finish).toHaveBeenCalledOnce();expect(f.renew.mock.calls[0][0]).toBe(f.claim);
  });
  it('B3-A RECONCILE도 비용 확인 뒤에만 원 claim을 반환한다',async()=>{
    vi.useFakeTimers();const f=windowsExecutionFixture(),gate=deferred<void>();
    const input=(await f.service.authorize(f.claim))!;expect(input).not.toBeNull();await f.cost.prepare(input,{generation:'1',ownerId:f.service.workerId,workItemId:f.claim.workId});
    f.state.execution!.state='UNKNOWN';f.claim.kind='RECONCILE';f.claim.ref={executionId:input.executionId};f.work.kind='RECONCILE';f.blockFinish(gate.promise);vi.spyOn(f.service,'reconciled').mockResolvedValue(false);
    const completion=f.service.runOnce().then(value=>({value}),error=>({error}));
    try{
      await f.finishEntered.promise;expect(f.work.state).toBe('CLAIMED');expect(f.finish).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(10001);expect(f.renew).toHaveBeenCalled();expect(f.renew.mock.calls.every(([claim])=>claim===f.claim)).toBe(true);
    }finally{gate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({value:true});expect(f.finish).toHaveBeenCalledOnce();
  });
  it('B3-A 준비 오류와 비용 마감 오류를 원 순서로 보존한다',async()=>{
    const f=windowsExecutionFixture(),original=Error('B3-A 준비 원 오류'),cleanup=Error('B3-A 비용 마감 원 오류');
    f.cost.prepare=async()=>{throw original;};f.cost.finishAttempt=async()=>{throw cleanup;};
    try{
      const result=await f.service.runOnce().then(()=>null,error=>error);
      expect(result).toBeInstanceOf(AggregateError);expect((result as AggregateError).errors).toEqual([original,cleanup]);expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.dispatch).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it('B3-A 갱신의 원 SQL 오류를 숨기지 않고 새 claim을 만들지 않는다',async()=>{
    vi.useFakeTimers();const f=windowsExecutionFixture(),gate=deferred<void>(),sql=Object.assign(Error('B3-A 원 갱신 SQL 오류'),{code:'42501'});f.blockFinish(gate.promise);f.renew.mockRejectedValue(sql);
    const completion=f.service.runOnce().then(value=>({value}),error=>({error}));
    try{await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);}
    finally{gate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({error:sql});expect(f.renew.mock.calls.every(([claim])=>claim===f.claim)).toBe(true);expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
  });
});

import {DomainError} from '../../packages/contracts/src/errors.js';
import {NativeJobErrorV2} from '../../packages/native/src/controller-remote.js';

async function windowsReconcileFixture(state='UNKNOWN'){
  const f=windowsExecutionFixture(),input=(await f.service.authorize(f.claim))!;
  expect(input).not.toBeNull();await f.cost.prepare(input,{generation:f.claim.generation,ownerId:f.service.workerId,workItemId:f.claim.workId});
  f.state.execution!.state=state;f.claim.kind='RECONCILE';f.claim.ref={executionId:input.executionId};f.work.kind='RECONCILE';
  const reconciled=vi.spyOn(f.service,'reconciled').mockResolvedValue(false);return {...f,input,reconciled};
}

describe('B3-A RECONCILE 원 오류와 단일 비용 마감',()=>{
  it.each((['READINESS','ROOT','CONTEXT','LOOKUP'] as const).flatMap(boundary=>(['42501','40001','40P01','ACK','DOMAIN','NATIVE_V2'] as const).map(kind=>[boundary,kind] as const)))('B3-A RECONCILE %s 경계의 %s 원 오류를 보존한다',async(boundary,kind)=>{
    const f=await windowsReconcileFixture();
    const original=kind==='NATIVE_V2'?new NativeJobErrorV2('B3_A_WINDOWS_PHYSICAL_UNCONFIRMED',409,'WAIT',{version:2,termination:{jobId:randomUUID(),inputDigest:sha256('B3-A 원 작업'),profileDigest:sha256('B3-A 원 프로필'),goAttempted:true,startedComputation:true,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'},windowsEvidenceRef:null}):kind==='DOMAIN'?new DomainError('B3_A_ORIGINAL_DOMAIN',409,'WAIT'):kind==='ACK'?Error('B3-A 원 COMMIT ACK 유실'):Object.assign(Error('B3-A 원 SQL 오류'),{code:kind});
    if(boundary==='READINESS')vi.spyOn(f.cost,'readIn').mockRejectedValueOnce(original);
    if(boundary==='ROOT'){
      let injected=false;
      if(kind==='DOMAIN'||kind==='NATIVE_V2'){
        // DB driver가 만드는 SQL 오류와 journal 내부 검증의 null 계약을 구분한다.
        // 원 root 거래의 실제 callback이 끝난 뒤 부모 포트의 원 오류를 주입한다.
        const transaction=f.transactions.getMockImplementation()!;
        const call:typeof f.db.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{const before=f.events.filter(value=>value==='ROOT_ACK').length,value=await transaction(accountId,run,restricted) as T;if(!injected&&f.events.filter(value=>value==='ROOT_ACK').length>before){injected=true;throw original;}return value;};
        vi.spyOn(f.db,'accountTransaction').mockImplementation(call);
      }else{
        const query=f.query.getMockImplementation()!;
        f.query.mockImplementation(async(sql,values=[])=>{if(!injected&&sql.includes('windows_native_cost_activate(')){injected=true;throw original;}return query(sql,values);});
      }
    }
    if(boundary==='CONTEXT')vi.spyOn(f.service,'nativeCallContext').mockRejectedValueOnce(original);
    if(boundary==='LOOKUP')vi.spyOn(f.provider,'lookup').mockRejectedValueOnce(original);
    const cost=vi.spyOn(f.cost,'finishAttempt');
    try{
      const completion=await f.service.runOnce().then(value=>({value}),error=>({error}));
      expect(completion).toEqual({error:original});expect('error'in completion&&completion.error).toBe(original);
      expect(cost).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
      expect(f.reconciled).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();
      if(boundary!=='LOOKUP')expect(f.provider.lookup).not.toHaveBeenCalled();
      if(boundary==='CONTEXT'||boundary==='LOOKUP')expect(f.events).toContain('ROOT_ACK');
    }finally{await f.close();}
  });
  it.each((['TERMINAL','CLOSED'] as const).flatMap(state=>(['COST_ACK','POST_COST_SQL'] as const).map(boundary=>[state,boundary] as const)))('B3-A %s 비용 %s 실패를 재시도하지 않고 진행 중 갱신을 기다린다',async(state,boundary)=>{
    vi.useFakeTimers();const f=await windowsReconcileFixture(state==='TERMINAL'?'FAILED':'UNKNOWN'),costGate=deferred<void>(),renewGate=deferred<void>();
    if(state==='CLOSED'){
      const query=f.query.getMockImplementation()!;
      f.query.mockImplementation(async(sql,values=[])=>sql.includes("kind='OPERATIONAL_COST_CLOSURE'")?{rows:[{present:1}],rowCount:1}:query(sql,values));
    }
    const original=boundary==='COST_ACK'?Error('B3-A 비용 COMMIT ACK 유실'):Object.assign(Error('B3-A 비용 후 정산 원 SQL 오류'),{code:'42501'});
    f.blockFinish(costGate.promise);const cost=f.cost.finishAttempt,finishAttempt=vi.spyOn(f.cost,'finishAttempt');
    if(boundary==='COST_ACK')finishAttempt.mockImplementationOnce(async()=>{await cost();throw original;});
    else{
      const reconcile=f.service.reconcileOperationalCostIn.bind(f.service);let calls=0;
      vi.spyOn(f.service,'reconcileOperationalCostIn').mockImplementation(async(...args)=>{if(++calls===2)throw original;return reconcile(...args);});
    }
    f.renew.mockImplementation(async claim=>{await renewGate.promise;return ExecutionService.prototype.renew.call(f.service,claim);});
    let completed=false;const completion=f.service.runOnce().then(value=>{completed=true;return {value};},error=>{completed=true;return {error};});
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);expect(f.renew).toHaveBeenCalledOnce();
      costGate.resolve();for(let n=0;n<20;n++)await Promise.resolve();expect(completed).toBe(false);expect(f.finish).not.toHaveBeenCalled();
    }finally{costGate.resolve();renewGate.resolve();await completion;await f.close();vi.useRealTimers();}
    expect(await completion).toEqual({error:original});expect(finishAttempt).toHaveBeenCalledOnce();expect(f.reconciled).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.renew.mock.calls[0][0]).toBe(f.claim);
  });
});

import {windowsExecutionCostPorts} from '../../packages/domain/src/native-remote-gateway.js';
import {ownedNativePng} from '../fixtures/native-images.js';

type WindowsFailurePhase='INPUT'|'CHECKPOINT'|'VALIDATION'|'DISPATCH';
async function windowsFailureFixture(phase:WindowsFailurePhase){
  const f=windowsExecutionFixture(),input=(await f.service.authorize(f.claim))!;
  await f.cost.prepare(input,{generation:f.claim.generation,ownerId:f.service.workerId,workItemId:f.claim.workId});
  const observation=normalizeObservation(input,{evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,finishReason:'B3_A_METADATA',providerRef:null,data:structuredClone(input.initialData)});
  f.provider.validateObservation=vi.fn(async()=>{});
  if(phase==='CHECKPOINT'){
    const id=randomUUID();observation.stageOutput!.checkpointId=id;const query=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql,values=[])=>sql.startsWith('SELECT c.checkpoint_id')?{rows:[{checkpoint_id:id,execution_id:input.executionId,output_envelope:observation,verification_state:'VERIFIED',ordinal:0,logical_step_id:input.stage,reuse_checkpoint_id:null,execution_state:'SUCCEEDED'}],rowCount:1}:query(sql,values));
  }
  const invoke=()=>phase==='CHECKPOINT'?f.service.validateCheckpoints(f.claim):phase==='VALIDATION'?f.service.validated(input,observation,f.claim):f.service.runOnce();
  return {...f,input,observation,invoke};
}
function windowsOriginalError(kind:string):Error{
  return kind==='ACK'?Error('B3-A 원 DB COMMIT ACK 유실'):kind==='NATIVE_V2'?new NativeJobErrorV2('B3_A_ORIGINAL_PHYSICAL',409,'WAIT',{version:2,termination:{jobId:randomUUID(),inputDigest:sha256('원 입력'),profileDigest:sha256('원 profile'),goAttempted:true,startedComputation:true,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'},windowsEvidenceRef:null}):Object.assign(Error('B3-A 원 DB 오류'),{code:kind});
}
function windowsFailureCallback(f:Awaited<ReturnType<typeof windowsFailureFixture>>,phase:WindowsFailurePhase,operation:()=>Promise<unknown>){
  if(phase==='INPUT')f.provider.validateInput=async()=>{await operation();};
  else if(phase==='DISPATCH')f.provider.dispatch=async()=>{await operation();return unknownObservationForWindows();};
  else f.provider.validateObservation=async()=>{await operation();};
}
function unknownObservationForWindows():Observation{return {evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'B3_A_METADATA_UNKNOWN',providerRef:null,data:null};}

describe('B3-A 의미 검증과 원 인프라 오류 분리',()=>{
  it.each((['INPUT','CHECKPOINT','VALIDATION','DISPATCH'] as const).flatMap(phase=>(['42501','40001','40P01','ACK'] as const).map(kind=>[phase,kind] as const)))('B3-A %s context 조회의 %s 원 오류를 보존한다',async(phase,kind)=>{
    const f=await windowsFailureFixture(phase),original=windowsOriginalError(kind);
    vi.spyOn(f.service,'nativeCallContext').mockImplementation(async(_claim,_input,currentPhase)=>{if(currentPhase===phase)throw original;return undefined;});
    try{await expect(f.invoke()).rejects.toBe(original);expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();}
    finally{await f.close();}
  });
  it.each(['INPUT','CHECKPOINT','VALIDATION','DISPATCH'] as const)('B3-A %s callback의 실제 v2 오류를 v1 종료나 의미 실패로 바꾸지 않는다',async phase=>{
    const f=await windowsFailureFixture(phase),original=windowsOriginalError('NATIVE_V2');vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(undefined);windowsFailureCallback(f,phase,async()=>{throw original;});
    try{await expect(f.invoke()).rejects.toBe(original);expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();}
    finally{await f.close();}
  });
  it.each(['INPUT','CHECKPOINT','VALIDATION','DISPATCH'] as const)('B3-A %s의 정상 의미 거부는 기존 실패 처리를 유지한다',async phase=>{
    const f=await windowsFailureFixture(phase);vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(undefined);windowsFailureCallback(f,phase,async()=>{throw new DomainError('NATIVE_OUTPUT_INVALID',409,'WAIT');});
    try{const result=await f.invoke();if(phase==='CHECKPOINT')expect(result).toBe(false);else if(phase==='VALIDATION')expect(result).toMatchObject({outcome:'FAILURE',finishReason:'STAGE_PROPOSAL_INVALID'});else{expect(result).toBe(true);if(phase==='DISPATCH')expect(f.observe.mock.calls[0][2].outcome).toBe('UNKNOWN');}expect(f.nativeWait).not.toHaveBeenCalled();}
    finally{await f.close();}
  });
  it.each(['INPUT','CHECKPOINT','VALIDATION','DISPATCH'] as const)('B3-A %s의 명목 context WAIT는 확정 실패를 만들지 않는다',async phase=>{
    const f=await windowsFailureFixture(phase);let waiting:unknown;try{windowsExecutionCostPorts(f.gateway,f.db)!.unconfirmed();}catch(error){waiting=error;}
    vi.spyOn(f.service,'nativeCallContext').mockImplementation(async(_claim,_input,currentPhase)=>{if(currentPhase===phase)throw waiting;return undefined;});
    try{const result=await f.invoke();if(phase==='CHECKPOINT')expect(result).toBe(false);else if(phase==='VALIDATION'){expect(result).toMatchObject({outcome:'UNKNOWN',started:f.observation.started,providerOutcome:'SUCCESS'});expect(result).not.toHaveProperty('nativeFailure');}else expect(result).toBe(true);expect(f.nativeWait).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.includes("SET state='FAILED'"))).toBe(false);}
    finally{await f.close();}
  });
  it.each((['INPUT','CHECKPOINT','VALIDATION','DISPATCH'] as const).flatMap(phase=>(['42501','40001','40P01','ACK'] as const).map(kind=>[phase,kind] as const)))('B3-A %s callback의 실제 costed DAO %s 원 오류를 보존한다',async(phase,kind)=>{
    const f=await windowsFailureFixture(phase),original=windowsOriginalError(kind),context=await f.service.nativeCallContext(f.claim,f.input,'INPUT');
    // 원 facade의 DAO 오류 전달 검사이며 checkpoint 권위·v2 검증 양성은 아니다.
    vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(context);
    const query=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql,values=[])=>{if(sql.includes('windows_native_cost_begin('))throw original;return query(sql,values);});
    windowsFailureCallback(f,phase,async()=>{await context!.native.decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile);});
    try{await expect(f.invoke()).rejects.toBe(original);expect(f.observe).not.toHaveBeenCalled();expect(f.nativeWait).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();}
    finally{await f.close();}
  });
  it.each(['42501','40001','40P01','ACK','MISMATCH'] as const)('B3-A VALIDATION 자산 거래의 %s와 정상 자산 불일치를 구분한다',async kind=>{
    const f=await windowsFailureFixture('VALIDATION'),assetId=randomUUID(),dependency={assetId,sha256:sha256('검사 자산'),bytesLength:'8',mediaType:'image/png'},original=windowsOriginalError(kind);
    f.observation.assetDependencies=[dependency];f.observation.outputAssetIds=[assetId];delete f.observation.stageOutput;
    const query=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql,values=[])=>{if(sql.startsWith('SELECT asset_id,sha256')){if(kind!=='MISMATCH')throw original;return {rows:[],rowCount:0};}return query(sql,values);});
    try{if(kind==='MISMATCH')expect(await f.invoke()).toMatchObject({outcome:'FAILURE',finishReason:'STAGE_PROPOSAL_INVALID'});else await expect(f.invoke()).rejects.toBe(original);expect(f.nativeWait).not.toHaveBeenCalled();}
    finally{await f.close();}
  });
});

import type {CheckpointValidationAttempt,CheckpointValidationPurpose,CheckpointValidationTarget} from '../../packages/domain/src/checkpoint-validation.js';

// 실제 PRE/FINAL 제어 흐름과 CHECKPOINT context를 사용한다.
// DB·비용 포트는 기존 메타데이터 fixture이며 SQL 권위·물리 실행 근거가 아니다.
async function windowsCheckpointErrorFixture(purpose:CheckpointValidationPurpose){
  const f=await windowsFailureFixture('CHECKPOINT');
  const operational=f.service as unknown as {validateOperationalCheckpoints:(claim:Claim,input:StageInput,purpose:CheckpointValidationPurpose)=>Promise<boolean>};
  vi.mocked(operational.validateOperationalCheckpoints).mockRestore();
  const basisRows=await f.query("SELECT evidence_id,evidence_digest,protected_evidence_ref FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_BASIS'",[f.accountId,f.input.executionId]);
  const basis=basisRows.rows[0] as {evidence_id:string;evidence_digest:string};
  const input=f.inputs[0],checkpointId=f.observation.stageOutput!.checkpointId!;
  const target:CheckpointValidationTarget={checkpointId,sourceRequestId:f.input.requestId,sourceExecutionId:f.input.executionId,logicalStepId:f.input.stage,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),input:{evidenceId:input.evidence_id,evidenceDigest:input.evidence_digest},basis:{evidenceId:basis.evidence_id,evidenceDigest:basis.evidence_digest},outputDigest:digest(f.observation),stageContract:f.input.envelope!.stageContract,assets:[]};
  let attempt:CheckpointValidationAttempt|undefined;
  const attempts:CheckpointValidationAttempt[]=[],callbacks:CheckpointValidationPurpose[]=[];
  const begin=vi.fn(async(_tx:Transaction,consumer:StageInput,currentPurpose:CheckpointValidationPurpose)=>{
    attempt={version:1,attemptId:randomUUID(),attemptDigest:sha256('도메인 검사 시도'),purpose:currentPurpose,consumerExecutionId:consumer.executionId,consumerRequestId:consumer.requestId,inputFingerprint:digest(canonicalInput(consumer)),inputEvidenceId:input.evidence_id,inputEvidenceDigest:input.evidence_digest,basisEvidenceId:basis.evidence_id,basisEvidenceDigest:basis.evidence_digest,validationVersion:'checkpoint-validation-v1',owner:{contextId:f.request.context_id,contextGeneration:f.request.context_generation,ownerSessionId:f.context.owner_session_id!,ownerTabId:f.context.owner_tab_id!,ownerRevision:f.context.owner_revision,workspaceRevision:f.context.workspace_revision},claimGeneration:f.claim.generation,expectedResultRevision:f.request.expected_result_revision,targets:[target]};
    attempts.push(attempt);return attempt;
  });
  const collect=vi.fn(async(_tx:Transaction,_consumer:StageInput,current:CheckpointValidationAttempt)=>({attemptId:current.attemptId,operations:[]}));
  const record=vi.fn(async()=>({state:'VERIFIED' as const,attempt,evidenceIds:[],jobIds:[]}));
  Object.assign(f.cost,{checkpoints:{beginIn:begin,lookupIn:async()=>({state:'WAIT' as const,attempt,evidenceIds:[],jobIds:[]}),recordIn:record},collectCheckpointIn:collect});
  const query=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values=[])=>{
    if(sql.startsWith('SELECT 1 FROM request_steps s JOIN checkpoints c'))return {rows:[{present:1}],rowCount:1};
    if(sql.includes('FROM execution_evidence')&&sql.includes("kind='CHECKPOINT_VALIDATION_ATTEMPT'")&&attempt){
      const id=attempt.attemptId,wrapper={version:1,accountId:f.accountId,executionId:f.input.executionId,inputFingerprint:digest(canonicalInput(f.input)),kind:'CHECKPOINT_VALIDATION_ATTEMPT',value:attempt};
      return {rows:[{evidence_id:id,evidence_digest:digest(wrapper),protected_evidence_ref:id,protected_observation:wrapper}],rowCount:1};
    }
    return query(sql,values);
  });
  const context=vi.spyOn(f.service,'nativeCallContext');
  let operation:()=>Promise<void>=async()=>{};
  f.provider.validateObservation=vi.fn(async(_input,_observation,current)=>{
    const call=context.mock.calls.at(-1);
    if(call?.[2]!=='CHECKPOINT')return;
    const currentPurpose=call[5]!.attempt.purpose;callbacks.push(currentPurpose);
    if(!current?.native)throw Error('CHECKPOINT의 실제 명목 context가 필요하다');
    if(currentPurpose===purpose)await operation();
  });
  f.dispatch.mockImplementation(async()=>{f.events.push('DISPATCH');return structuredClone(f.observation);});
  return {...f,attempts,callbacks,context,collect,record,fail:(run:()=>Promise<void>)=>{operation=run;},validate:()=>operational.validateOperationalCheckpoints(f.claim,f.input,purpose)};
}
function checkpointOriginalValue(kind:string):unknown{
  if(kind==='ERROR')return Error('체크포인트 원 오류');
  if(kind==='TYPE_ERROR')return new TypeError('체크포인트 원 타입 오류');
  if(kind==='STRING')return '체크포인트 원 문자열';
  if(kind==='NULL')return null;
  if(kind==='UNDEFINED')return undefined;
  return Object.assign(Error('체크포인트 원 SQL 오류'),{code:kind});
}

describe('B3-C F02 CHECKPOINT 오류 정책의 범위',()=>{
  it.each((['PRE_DISPATCH','FINAL_COMMIT'] as const).flatMap(purpose=>(['ERROR','TYPE_ERROR','42501','40001','40P01','STRING','NULL','UNDEFINED'] as const).map(kind=>[purpose,kind] as const)))('B3-C %s callback의 %s를 원 값으로 전달한다',async(purpose,kind)=>{
    const f=await windowsCheckpointErrorFixture(purpose),original=checkpointOriginalValue(kind);
    f.fail(async()=>{throw original;});
    try{
      await expect(f.service.runOnce()).rejects.toBe(original);
      expect(f.callbacks).toEqual(purpose==='PRE_DISPATCH'?['PRE_DISPATCH']:['PRE_DISPATCH','FINAL_COMMIT']);
      expect(f.context.mock.calls.filter(([, ,phase])=>phase==='CHECKPOINT').map(([, , , , ,validation])=>validation!.attempt.purpose)).toEqual(f.callbacks);
      expect(f.collect).toHaveBeenCalledTimes(purpose==='PRE_DISPATCH'?0:1);expect(f.record).toHaveBeenCalledTimes(purpose==='PRE_DISPATCH'?0:1);
      expect(f.dispatch).toHaveBeenCalledTimes(purpose==='PRE_DISPATCH'?0:1);expect(f.observe).toHaveBeenCalledTimes(purpose==='PRE_DISPATCH'?0:1);
      expect(f.events.filter(value=>value==='COST_BEGIN')).toHaveLength(1);expect(f.events.filter(value=>value==='COST_END')).toHaveLength(1);
      expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.nativeWait).not.toHaveBeenCalled();
      expect(f.request.state).not.toBe('FAILED');expect(f.io.put).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it.each((['PRE_DISPATCH','FINAL_COMMIT'] as const).flatMap(purpose=>(['DOMAIN','SPOOFED_WAIT','SPOOFED_DAO','CONTEXT_WAIT','NATIVE_V1','NATIVE_V2'] as const).map(kind=>[purpose,kind] as const)))('B3-C %s의 %s 분류를 보존한다',async(purpose,kind)=>{
    const f=await windowsCheckpointErrorFixture(purpose);
    const original=kind==='NATIVE_V1'?nativeFault():kind==='NATIVE_V2'?windowsOriginalError('NATIVE_V2'):Object.assign(new DomainError(kind==='SPOOFED_WAIT'?'WINDOWS_EXECUTION_CONTEXT_UNCONFIRMED':'NATIVE_OUTPUT_INVALID',409,'WAIT'),kind==='SPOOFED_DAO'?{infrastructure:true,code:'42501'}:{});
    f.fail(async()=>{if(kind==='CONTEXT_WAIT')windowsExecutionCostPorts(f.gateway,f.db)!.unconfirmed();throw original;});
    try{
      if(kind==='NATIVE_V2')await expect(f.validate()).rejects.toBe(original);
      else expect(await f.validate()).toBe(false);
      expect(f.callbacks).toEqual([purpose]);expect(f.collect).not.toHaveBeenCalled();expect(f.record).not.toHaveBeenCalled();
      if(kind==='NATIVE_V1')expect(f.nativeWait).toHaveBeenCalledExactlyOnceWith(f.claim,canonicalInput(f.input),'CHECKPOINT',original,f.observation,f.requestId);
      else expect(f.nativeWait).not.toHaveBeenCalled();
      expect(f.request.state).toBe(kind==='DOMAIN'||kind==='SPOOFED_WAIT'||kind==='SPOOFED_DAO'?'FAILED':'ACCEPTED');
      expect(f.finish).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it.each(['GENERIC','OTHER_DB','OTHER_GATEWAY'] as const)('B3-C %s의 일반 CHECKPOINT 오류는 기존 의미 거부를 유지한다',async boundary=>{
    const f=await windowsFailureFixture('CHECKPOINT'),other=boundary==='OTHER_GATEWAY'?windowsExecutionFixture():null;
    const generic:NativeGateway={forTarget:()=>({} as NativeFacade),stopClaims:()=>{},idle:async()=>{}};
    if(boundary==='OTHER_DB')Object.defineProperty(f.service,'db',{value:{accountTransaction:f.db.accountTransaction} as unknown as Database});
    else Object.defineProperty(f.service,'nativeGateway',{value:other?.gateway??generic});
    vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(undefined);
    windowsFailureCallback(f,'CHECKPOINT',async()=>{throw Error('다른 실행 경로의 일반 오류');});
    try{expect(await f.invoke()).toBe(false);expect(f.request.state).toBe('FAILED');expect(f.nativeWait).not.toHaveBeenCalled();}
    finally{await f.close();if(other)await other.close();}
  });
  it.each(['INPUT','VALIDATION','DISPATCH'] as const)('B3-C 다른 %s callback의 일반 오류 의미를 보존한다',async phase=>{
    const f=await windowsFailureFixture(phase);vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(undefined);windowsFailureCallback(f,phase,async()=>{throw new TypeError('다른 처리 단계의 원 오류');});
    try{
      const result=await f.invoke();
      if(phase==='VALIDATION')expect(result).toMatchObject({outcome:'FAILURE',finishReason:'STAGE_PROPOSAL_INVALID'});
      else{expect(result).toBe(true);if(phase==='INPUT'){expect(f.request.state).toBe('FAILED');expect(f.dispatch).not.toHaveBeenCalled();}else expect(f.observe.mock.calls[0][2]).toMatchObject({outcome:'UNKNOWN'});}
      expect(f.nativeWait).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
});

describe('B3-C F03 원 오류 뒤 비용과 원 claim 수명',()=>{
  it.each((['PRE_DISPATCH','FINAL_COMMIT'] as const).flatMap(purpose=>(['NONE','COST','RENEWAL','CLAIM'] as const).map(boundary=>[purpose,boundary] as const)))('B3-C %s 오류와 %s 마감은 비용·idle·진행 중 갱신 뒤 한 번 끝난다',async(purpose,boundary)=>{
    vi.useFakeTimers();const f=await windowsCheckpointErrorFixture(purpose),costGate=deferred<void>(),idleGate=deferred<void>(),renewGate=deferred<void>(),idleEntered=deferred<void>(),idleEnded=deferred<void>();
    const original=Error('체크포인트 원 오류'),cleanup=Error('독립 마감 원 오류'),owner=f.work.claim_owner,generation=f.claim.generation;
    f.fail(async()=>{throw original;});f.blockFinish(costGate.promise);
    const idle=f.gateway.idle.bind(f.gateway),finishCost=f.cost.finishAttempt,finishClaim=f.finish.getMockImplementation()!;
    const cost=vi.spyOn(f.cost,'finishAttempt').mockImplementation(async()=>{await finishCost();await f.gateway.idle();if(boundary==='COST')throw cleanup;});
    vi.spyOn(f.gateway,'idle').mockImplementation(async()=>{idleEntered.resolve();await idleGate.promise;await idle();f.events.push('IDLE_END');idleEnded.resolve();});
    f.renew.mockImplementation(async claim=>{await renewGate.promise;const renewed=await ExecutionService.prototype.renew.call(f.service,claim);if(boundary==='RENEWAL')throw cleanup;return renewed;});
    const returned:{claim:Claim;generation:string;owner:string;state:string}[]=[];
    f.finish.mockImplementation(async(...args)=>{returned.push({claim:args[0],generation:f.work.claim_generation,owner:f.work.claim_owner,state:f.work.state});await finishClaim(...args);if(boundary==='CLAIM')throw cleanup;});
    let completed=false;const completion=f.service.runOnce().then(value=>{completed=true;return {value};},error=>{completed=true;return {error};});
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);
      expect(f.renew).toHaveBeenCalledOnce();expect(f.renew.mock.calls[0][0]).toBe(f.claim);
      expect(f.finish).not.toHaveBeenCalled();expect(completed).toBe(false);expect(f.work).toMatchObject({state:'CLAIMED',claim_generation:generation,claim_owner:owner});
      costGate.resolve();await idleEntered.promise;
      expect(f.finish).not.toHaveBeenCalled();expect(completed).toBe(false);expect(f.events).not.toContain('IDLE_END');
      idleGate.resolve();await idleEnded.promise;for(let n=0;n<20;n++)await Promise.resolve();
      expect(f.events).toContain('COST_END');expect(f.finish).not.toHaveBeenCalled();expect(completed).toBe(false);
      renewGate.resolve();const result=await completion;expect(result).toHaveProperty('error');
      if('error'in result){
        if(boundary==='NONE')expect(result.error).toBe(original);
        else{expect(result.error).toBeInstanceOf(AggregateError);const errors=(result.error as AggregateError).errors;expect(errors).toHaveLength(2);expect(errors[0]).toBe(original);expect(errors[1]).toBe(cleanup);expect(errors.filter(error=>error===original)).toHaveLength(1);}
      }
      expect(cost).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);
      expect(returned).toHaveLength(1);expect(returned[0]).toEqual({claim:f.claim,generation,owner,state:'CLAIMED'});expect(returned[0].claim).toBe(f.claim);
      expect(f.events.indexOf('COST_END')).toBeLessThan(f.events.indexOf('IDLE_END'));expect(f.events.indexOf('IDLE_END')).toBeLessThan(f.events.indexOf('RENEW'));expect(f.events.indexOf('RENEW')).toBeLessThan(f.events.indexOf('FINISH'));
      expect(f.service.claim).toHaveBeenCalledOnce();expect(f.claim.generation).toBe(generation);expect(f.nativeWait).not.toHaveBeenCalled();
    }finally{costGate.resolve();idleGate.resolve();renewGate.resolve();await completion;await f.close();vi.useRealTimers();}
  });
});
// 실제 runOnce의 원 claim 수명을 검사한다. private publication 경계만 분리하여
// 호출 순서와 오류 전달을 확인하며 DB publication 권위는 실제 PG 검사에 남긴다.
type WindowsPublicationBoundary={finishWindowsPublication:(claim:Claim,input:StageInput)=>Promise<boolean>;finishCostAttempt:(input:StageInput)=>Promise<void>};
async function windowsPublicationFixture(){
  const f=await windowsFailureFixture('DISPATCH'),entered=deferred<void>();
  f.dispatch.mockImplementation(async()=>{f.events.push('DISPATCH');return structuredClone(f.observation);});
  const publication=vi.fn(async(_claim:Claim,_input:StageInput)=>{f.events.push('PUBLICATION_BEGIN');entered.resolve();return true;});
  // 현재 제품에 helper가 없어도 조립 오류 대신 실제 누락 호출을 RED로 확인한다.
  Object.defineProperty(f.service,'finishWindowsPublication',{value:publication,configurable:true});
  const boundary=f.service as unknown as WindowsPublicationBoundary,finishCost=boundary.finishCostAttempt.bind(f.service);
  vi.spyOn(boundary,'finishCostAttempt').mockImplementation(async input=>{await finishCost(input);f.events.push('COST_ACK');});
  return {...f,publication,publicationEntered:entered};
}

describe('W4-C 원 비용 ACK와 publication 호출 순서',()=>{
  it('W4-C 비용 ACK와 진행 중 renewal 합류 뒤 publication ACK를 기다려 원 claim을 끝낸다',async()=>{
    vi.useFakeTimers();const f=await windowsPublicationFixture(),costGate=deferred<void>(),renewGate=deferred<void>(),publicationGate=deferred<void>();
    f.blockFinish(costGate.promise);
    f.renew.mockImplementation(async claim=>{await renewGate.promise;const value=await ExecutionService.prototype.renew.call(f.service,claim);f.events.push('RENEW_JOIN');return value;});
    f.publication.mockImplementation(async()=>{f.events.push('PUBLICATION_BEGIN');f.publicationEntered.resolve();await publicationGate.promise;f.events.push('PUBLICATION_ACK');return true;});
    let completed=false;const completion=f.service.runOnce().then(value=>{completed=true;return {value};},error=>{completed=true;return {error};});
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);
      expect(f.publication).not.toHaveBeenCalled();expect(f.finish).not.toHaveBeenCalled();expect(completed).toBe(false);
      expect(f.renew).toHaveBeenCalledOnce();costGate.resolve();await vi.advanceTimersByTimeAsync(1);
      expect(f.events).toContain('COST_ACK');expect(f.publication).not.toHaveBeenCalled();expect(f.finish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30000);expect(f.renew).toHaveBeenCalledOnce();
      renewGate.resolve();
      expect(await Promise.race([f.publicationEntered.promise.then(()=>true),completion.then(()=>false)]),'비용과 갱신이 끝나면 publication에 진입해야 한다').toBe(true);
      expect(f.finish).not.toHaveBeenCalled();expect(completed).toBe(false);expect(f.work.state).toBe('CLAIMED');
      await vi.advanceTimersByTimeAsync(20000);expect(f.renew).toHaveBeenCalledOnce();
      publicationGate.resolve();expect(await completion).toEqual({value:true});
      expect(f.publication).toHaveBeenCalledExactlyOnceWith(f.claim,expect.objectContaining({executionId:f.input.executionId,requestId:f.input.requestId}));
      expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,true,0);
      for(const [first,last] of [['COST_ACK','RENEW_JOIN'],['RENEW_JOIN','PUBLICATION_BEGIN'],['PUBLICATION_BEGIN','PUBLICATION_ACK'],['PUBLICATION_ACK','FINISH']])expect(f.events.indexOf(first)).toBeLessThan(f.events.indexOf(last));
      expect(f.work.state).toBe('DONE');expect(f.io.put).not.toHaveBeenCalled();
    }finally{costGate.resolve();renewGate.resolve();publicationGate.resolve();await completion;await f.close();vi.useRealTimers();}
  });
  it('W4-C publication WAIT는 원 finish를 done으로 바꾸지 않는다',async()=>{
    const f=await windowsPublicationFixture();f.publication.mockResolvedValue(false);
    try{expect(await f.service.runOnce()).toBe(true);expect(f.publication).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,0);expect(f.work.state).toBe('READY');}
    finally{await f.close();}
  });
  it.each(['FALSE','THROW'] as const)('W4-C 늦은 renewal %s는 publication을 막고 원 claim을 한 번 반환한다',async kind=>{
    vi.useFakeTimers();const f=await windowsPublicationFixture(),costGate=deferred<void>(),renewGate=deferred<void>(),original=Error('늦은 갱신 원 오류');f.blockFinish(costGate.promise);
    const ports=windowsExecutionCostPorts(f.gateway,f.db)!;let unconfirmed:unknown;
    try{ports.unconfirmed();}catch(error){unconfirmed=error;}
    expect(unconfirmed).toBeDefined();
    f.renew.mockImplementation(async()=>{await renewGate.promise;if(kind==='THROW')throw original;return false;});
    const completion=f.service.runOnce().then(value=>({value}),error=>({error}));
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);costGate.resolve();await vi.advanceTimersByTimeAsync(1);
      expect(f.publication).not.toHaveBeenCalled();expect(f.finish).not.toHaveBeenCalled();renewGate.resolve();const result=await completion;
      expect(result).toHaveProperty('error');
      if('error'in result){if(kind==='THROW')expect(result.error).toBe(original);else expect(result.error).toMatchObject({code:(unconfirmed as DomainError).code});}
      expect(f.publication).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.renew).toHaveBeenCalledOnce();
    }finally{costGate.resolve();renewGate.resolve();await completion;await f.close();vi.useRealTimers();}
  });
  it.each(['ERROR','40001','40P01','NULL','UNDEFINED'] as const)('W4-C publication의 %s 원 오류는 성공 ACK로 바뀌지 않는다',async kind=>{
    const f=await windowsPublicationFixture(),original=checkpointOriginalValue(kind);f.publication.mockImplementation(async()=>{throw original;});
    try{await expect(f.service.runOnce()).rejects.toBe(original);expect(f.publication).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.work.state).toBe('READY');}
    finally{await f.close();}
  });
  it('W4-C publication 오류와 원 finish 오류를 한 번씩 원 순서로 보존한다',async()=>{
    const f=await windowsPublicationFixture(),original=Error('publication 원 오류'),cleanup=Error('claim 반환 원 오류');
    f.publication.mockImplementation(async()=>{throw original;});f.finish.mockRejectedValue(cleanup);
    try{const result=await f.service.runOnce().then(()=>null,error=>error);expect(result).toBeInstanceOf(AggregateError);expect((result as AggregateError).errors).toEqual([original,cleanup]);expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);}
    finally{await f.close();}
  });
  it.each(['STAGE','COST'] as const)('W4-C 원 %s 오류가 있으면 publication 호출을 건너뛴다',async kind=>{
    const f=await windowsPublicationFixture(),original=Error('원 단계 또는 비용 오류');
    if(kind==='STAGE')f.hooks.afterPrepare=async()=>{throw original;};else f.cost.finishAttempt=async()=>{throw original;};
    try{await expect(f.service.runOnce()).rejects.toBe(original);expect(f.publication).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);}
    finally{await f.close();}
  });
  it('W4-C stopClaims는 진행 중 원 DISPATCH publication을 막지 않는다',async()=>{
    const f=await windowsPublicationFixture();f.hooks.afterPrepare=async()=>{f.service.stopClaims();};
    try{expect(await f.service.runOnce()).toBe(true);expect(f.publication).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,true,0);}
    finally{await f.close();}
  });
  it('W4-C RECONCILE은 publication으로 승격하지 않는다',async()=>{
    const f=await windowsPublicationFixture();f.state.execution!.state='UNKNOWN';f.claim.kind='RECONCILE';f.claim.ref={executionId:f.input.executionId};f.work.kind='RECONCILE';vi.spyOn(f.service,'reconciled').mockResolvedValue(false);
    try{expect(await f.service.runOnce()).toBe(true);expect(f.publication).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);}
    finally{await f.close();}
  });
});

import type {WindowsExecutionCostPorts} from '../../packages/domain/src/native-remote-gateway.js';

describe('W4-C 갱신 실패의 명시 상태',()=>{
  it('W4-C renew false 뒤 unconfirmed가 반환해도 publication을 막고 재확인 지연을 보존한다',async()=>{
    vi.useFakeTimers();const f=await windowsPublicationFixture(),costGate=deferred<void>(),renewGate=deferred<void>();f.blockFinish(costGate.promise);
    const unconfirmed=vi.fn<WindowsExecutionCostPorts['unconfirmed']>(()=>undefined as never),ports={...windowsExecutionCostPorts(f.gateway,f.db)!,unconfirmed};
    const lifetime=f.service as unknown as {runWindowsClaim:(claim:Claim,ports:WindowsExecutionCostPorts)=>Promise<boolean>};
    f.renew.mockImplementation(async()=>{await renewGate.promise;return false;});
    const completion=lifetime.runWindowsClaim(f.claim,ports).then(value=>({value}),error=>({error}));
    try{
      await f.finishEntered.promise;await vi.advanceTimersByTimeAsync(10001);costGate.resolve();await vi.advanceTimersByTimeAsync(1);
      expect(f.publication).not.toHaveBeenCalled();expect(f.finish).not.toHaveBeenCalled();renewGate.resolve();
      expect(await completion).toEqual({value:true});expect(unconfirmed).toHaveBeenCalledOnce();
      expect(f.publication).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.claim,false,5000);expect(f.work.state).toBe('READY');
    }finally{costGate.resolve();renewGate.resolve();await completion;await f.close();vi.useRealTimers();}
  });
});

// 실제 applyComplete와 verifyAssets를 실행하고 query 포트만 교체한다.
// 25P02는 중단된 거래의 다음 SQL을 모사한 fixture이며 실제 PG 권위 증거가 아니다.
describe('W4-C applyComplete 자산 조회의 원 오류 경계',()=>{
  it.each(['40001','40P01','42501'] as const)('W4-C 자산 조회의 %s가 추가 SQL의 25P02로 바뀌지 않는다',async code=>{
    const f=await completedTypesetFixture(),original=Object.assign(Error('자산 조회 원 SQL 오류'),{code}),abortedError=Object.assign(Error('이미 실패한 거래의 추가 SQL'),{code:'25P02'});
    const query=f.query.getMockImplementation()!,afterErrorSql:string[]=[];let aborted=false,assetReads=0;
    f.query.mockImplementation(async(sql,values=[])=>{
      if(aborted){afterErrorSql.push(sql);throw abortedError;}
      if(sql.startsWith('SELECT asset_id,sha256,bytes_length')){assetReads++;aborted=true;throw original;}
      return query(sql,values);
    });
    const observation=structuredClone(f.checkpoint.output_envelope),result=await f.service.applyComplete(f.tx,f.context,f.request,observation.data!,observation).then(()=>({value:true}),error=>({error}));
    expect(assetReads).toBe(1);expect(result).toHaveProperty('error');
    if('error'in result)expect(result.error).toBe(original);
    expect(afterErrorSql).toEqual([]);expect(f.request.state).toBe('WAITING');expect(f.results).toHaveLength(1);expect(f.applications).toEqual([]);expect(f.queued).toEqual([]);
  });
  it('W4-C 자산 조회의 미분류 오류를 의미 거부로 바꾸지 않는다',async()=>{
    const f=await completedTypesetFixture(),original=Error('자산 조회 원 미분류 오류'),query=f.query.getMockImplementation()!;let assetReads=0;
    f.query.mockImplementation(async(sql,values=[])=>{if(sql.startsWith('SELECT asset_id,sha256,bytes_length')){assetReads++;throw original;}return query(sql,values);});
    const observation=structuredClone(f.checkpoint.output_envelope);
    await expect(f.service.applyComplete(f.tx,f.context,f.request,observation.data!,observation)).rejects.toBe(original);
    expect(assetReads).toBe(1);expect(f.request.state).toBe('WAITING');expect(f.results).toHaveLength(1);expect(f.applications).toEqual([]);expect(f.queued).toEqual([]);
  });
  it.each(['ASSET_MISMATCH','EDIT_INVALID','RENDER_MISSING'] as const)('W4-C 정상 의미 거부 %s는 기존 실패 판정을 유지한다',async kind=>{
    const f=await completedTypesetFixture(),observation=structuredClone(f.checkpoint.output_envelope),query=f.query.getMockImplementation()!;let assetReads=0;
    if(kind==='EDIT_INVALID')observation.data!.blocks[0].fontSizePx=0;
    if(kind==='RENDER_MISSING')delete observation.renderAssetId;
    f.query.mockImplementation(async(sql,values=[])=>{if(sql.startsWith('SELECT asset_id,sha256,bytes_length')){assetReads++;if(kind==='ASSET_MISMATCH')return {rows:[],rowCount:0};}return query(sql,values);});
    await expect(f.service.applyComplete(f.tx,f.context,f.request,observation.data!,observation)).resolves.toBeUndefined();
    expect(assetReads).toBe(kind==='ASSET_MISMATCH'?1:0);expect(f.request.state).toBe('FAILED');expect(f.results).toHaveLength(1);expect(f.applications).toEqual([]);expect(f.queued).toEqual([]);
    expect(f.query.mock.calls.some(([sql,values])=>sql.startsWith('UPDATE processing_requests SET state=$3')&&values?.[4]==='STAGE_PROPOSAL_INVALID')).toBe(true);
  });
});
