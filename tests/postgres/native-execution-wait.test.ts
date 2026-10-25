import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {Projections} from '../../packages/domain/src/projections.js';
import {SyntheticProvider,canonicalInput,storedInput,type ProviderAdapter,type StageInput} from '../../packages/domain/src/provider.js';
import {contextRow,type RequestRow} from '../../packages/domain/src/model.js';
import {closeContext} from '../../packages/domain/src/liveness.js';
import {nativeExecutionHold,nativeExecutionWaiting} from '../../packages/domain/src/native-execution-wait.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent,type NativeJobObservation} from '../../packages/domain/src/native-jobs.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,NativeJobError} from '../../packages/native/src/dto.js';
import type {NativeGateway,NativeTarget} from '../../packages/native/src/gateway.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// These cases exercise owning rows through real API/worker LOGIN roles. Provider,
// facade and physical observations are synthetic; they establish no isolation,
// production native termination, capacity release or external-cost authority.
const connections:Database[]=[],caseAccounts:string[]=[];
let admin:Database,api:Database,worker:Database,now=new Date();
const clock=async()=>now;
beforeAll(async()=>{
  console.info(JSON.stringify({nativeExecutionWaitTrace:'shared_fixture',phase:'database_start'}));
  admin=await testDatabase(clock);connections.push(admin);
  api=await provisionLocalService(admin,'trio_web_api',clock);worker=await provisionLocalService(admin,'trio_web_worker',clock);connections.push(api,worker);
  for(const db of [api,worker])await db.validateServiceRole();
  for(const [db,role] of [[api,'trio_web_api'],[worker,'trio_web_worker']] as const){const identity=(await db.pool.query('SELECT session_user,current_user')).rows[0];expect(identity.current_user).toBe(role);expect(identity.session_user).not.toBe(role);}
  console.info(JSON.stringify({nativeExecutionWaitTrace:'shared_fixture',phase:'migrations_and_login_roles_verified'}));
});
afterEach(async()=>{
  // Preserve the case's WAIT and append-only evidence. Only fixture scheduling is
  // parked after assertions, so another case's real claim() cannot take its work.
  for(const accountId of caseAccounts.splice(0))await admin.pool.query("UPDATE manga_web.work_items SET due_at='2100-01-01T00:00:00Z' WHERE account_id=$1 AND state<>'DONE'",[accountId]);
});
afterAll(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
function fault(){return new NativeJobError('NATIVE_JOB_TIMEOUT',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-native-input'),profileDigest:sha256('owned-native-profile'),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'});}
function gateway(){const targets:NativeTarget[]=[],ports=new WeakMap<NativeFacade,NativeTarget>();const native:NativeGateway={forTarget:vi.fn(target=>{const port={} as NativeFacade;targets.push(structuredClone(target));ports.set(port,structuredClone(target));return port;}),stopClaims:vi.fn(),idle:async()=>{}};return {native,targets,ports};}
async function fixture(stageOrder=['OCR']){
  const sampled=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;if(sampled>now)now=sampled;
  const seed=await seedWorkspace(admin,await seedIdentity(admin,now),2,now);caseAccounts.push(seed.accountId);
  const policy:RequestPolicy={stageOrder,synthetic:true,paidEnabled:false,realProviderEnabled:false},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider() as SyntheticProvider&ProviderAdapter,g=gateway();
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=async(operation:WorkspaceCommand['operation']):Promise<WorkspaceCommand>=>api.accountTransaction(seed.accountId,async tx=>{const context=await contextRow(tx,seed.contextId);return {commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:context.generation,tabId:seed.tabId,expectedOwnerRevision:context.owner_revision,expectedWorkspaceRevision:context.workspace_revision},operation};});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,await command({kind:'PATCH_SETTINGS',payload:{settings}}));
  const request=async(pageId=seed.pageIds[0])=>(await workspace.handle(actor,await command({kind:'REQUEST_TRANSLATION',payload:{pageId,scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}))).reply.operationRef.id!;
  const service=(p:ProviderAdapter=provider)=>new ExecutionService(worker,p,policy,{},g.native);
  return {seed,policy,provider,g,actor,workspace,command,request,service,advance:(milliseconds:number)=>{now=new Date(now.valueOf()+milliseconds);}};
}
async function requestRow(accountId:string,requestId:string):Promise<RequestRow>{return (await admin.pool.query<RequestRow>('SELECT * FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[accountId,requestId])).rows[0];}
async function evidence(accountId:string,executionId:string,kind:string){return (await admin.pool.query('SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id',[accountId,executionId,kind])).rows;}
async function executionRow(accountId:string,executionId?:string){return (await admin.pool.query('SELECT * FROM manga_web.executions WHERE account_id=$1 AND ($2::uuid IS NULL OR execution_id=$2) ORDER BY execution_id',[accountId,executionId??null])).rows;}
async function costs(accountId:string){return (await admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 ORDER BY cost_item_id',[accountId])).rows;}
async function free(accountId:string){return (await admin.pool.query('SELECT free_started_count,(SELECT count(*)::integer FROM manga_web.free_starts s WHERE s.account_id=a.account_id) AS starts,(SELECT count(*)::integer FROM manga_web.active_page_requests r WHERE r.account_id=a.account_id) AS active FROM manga_web.accounts a WHERE account_id=$1',[accountId])).rows[0];}
async function drain(service:ExecutionService,limit=20){for(let i=0;i<limit;i++)if(!await service.runOnce())return;throw new Error('OWNED_UNBOUNDED_WORK_LOOP');}
async function prepared(service:ExecutionService):Promise<{claim:Claim;input:StageInput}>{const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');const input=await service.authorize(claim!);expect(input).not.toBeNull();return {claim:claim!,input:input!};}
async function waiting(accountId:string,requestId:string){return api.accountTransaction(accountId,async tx=>nativeExecutionWaiting(tx,(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[accountId,requestId])).rows[0]),true);}
async function syntheticNativeIntent(service:ExecutionService,claim:Claim,input:StageInput,targetKind:'EXECUTION'|'REQUEST_CHECKPOINT'='EXECUTION'){
  const context=await worker.accountTransaction(claim.accountId,tx=>contextRow(tx,input.contextId!));
  const job=createNativeJob('DECODE_IMAGE',sha256('owned-native-profile'),{sourceBlobId:'owned-source'},new Map([['owned-source',Buffer.from('owned-fixture-input')]]),{maxMetadataBytes:4096,maxBinaryBytes:4096,maxItems:4});
  const value={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind,targetId:targetKind==='EXECUTION'?input.executionId:input.requestId,semanticCaptureDigest:sha256(`owned-capture:${input.executionId}:${targetKind}`),
    protectedOwnerCapture:{contextId:input.contextId!,contextGeneration:context.generation,ownerSessionId:context.owner_session_id,ownerTabId:context.owner_tab_id,ownerRevision:context.owner_revision,workspaceRevision:context.workspace_revision},claim:{generation:claim.generation,ownerId:service.workerId,workItemId:claim.workId}};
  const intent:NativeJobIntent={...value,logicalOperationKey:nativeLogicalOperationKey(value)},store=new NativeJobStore(worker,claim.accountId);await store.beforeIntent(intent);await store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture);return {intent,store};
}
function nativeObservation(intent:NativeJobIntent,event:'RESULT'|'TERMINATION',joined=true):NativeJobObservation{return {version:1,parentInstanceId:intent.parentInstanceId,event,code:event==='RESULT'?'NATIVE_RESULT_VALIDATED':'NATIVE_OPERATION_JOINED',resultDigest:event==='RESULT'?sha256('owned-calculation-result'):null,termination:{jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:joined,kind:joined?'DIRECT_CHILD_ONLY':'UNCONFIRMED',isolation:'OWNED_FIXTURE'}};}

describe('native execution waits through owning LOGIN roles',()=>{
  it('keeps INPUT native WAIT across restart and API safe stop without provider or free START',async()=>{
    const f=await fixture(),requestId=await f.request(),error=fault(),validate=vi.fn(async()=>{throw error;});f.provider.validateInput=validate;
    const service=f.service();expect(await service.runOnce()).toBe(true);const original=(await executionRow(f.seed.accountId))[0],inputs=await evidence(f.seed.accountId,original.execution_id,'INPUT'),waits=await evidence(f.seed.accountId,original.execution_id,'NATIVE_VALIDATION_WAIT');
    expect(original).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null});expect(waits).toHaveLength(1);expect(waits[0].protected_observation).toMatchObject({phase:'INPUT',currentRequestId:requestId,originExecutionId:original.execution_id,inputFingerprint:digest(inputs[0].protected_observation),termination:error.termination});
    expect(await requestRow(f.seed.accountId,requestId)).toMatchObject({state:'WAITING',hold_reasons:[nativeExecutionHold],first_start_at:null});expect(await free(f.seed.accountId)).toEqual({free_started_count:0,starts:0,active:1});expect(await costs(f.seed.accountId)).toEqual([]);expect(f.provider.calls).toHaveLength(0);
    f.advance(5001);await drain(f.service());expect(validate).toHaveBeenCalledOnce();expect((await executionRow(f.seed.accountId))[0]).toEqual(original);expect(await evidence(f.seed.accountId,original.execution_id,'INPUT')).toEqual(inputs);expect(f.provider.calls).toHaveLength(0);
    await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:requestId}}));expect(await requestRow(f.seed.accountId,requestId)).toMatchObject({state:'STOP_REQUESTED',hold_reasons:[nativeExecutionHold],terminal_at:null});expect(await free(f.seed.accountId)).toEqual({free_started_count:0,starts:0,active:1});
    expect((await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{state:'HELD'}]);expect((await admin.pool.query('SELECT state FROM manga_web.work_items WHERE account_id=$1',[f.seed.accountId])).rows.every(row=>row.state!=='DONE')).toBe(true);
    const publicView=await api.accountTransaction(f.seed.accountId,async tx=>new Projections(api).request(tx,await requestRow(f.seed.accountId,requestId)));expect(publicView).toMatchObject({state:'STOP_REQUESTED',holdReasons:['EXECUTION_UNKNOWN'],resultState:'NONE'});
    await expect(api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE account_id=$1',[f.seed.accountId]))).rejects.toMatchObject({code:'42501'});expect(f.g.targets).toHaveLength(1);expect(f.g.targets[0]).toMatchObject({targetKind:'EXECUTION',targetId:original.execution_id,claim:{ownerId:service.workerId}});
  });
  it('keeps checkpoint native WAIT scoped to the current retry with original execution and cost unchanged',async()=>{
    const f=await fixture(['OCR','TRANSLATE']),success=f.provider.success.bind(f.provider);const provider=new SyntheticProvider(input=>input.stage==='TRANSLATE'?{evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:'0.02',usageConfirmed:true,finishReason:'OWNED_CONFIRMED_FAILURE',providerRef:input.executionId,data:null}:success(input)) as SyntheticProvider&ProviderAdapter;
    const first=await f.request();await drain(f.service(provider));expect((await requestRow(f.seed.accountId,first)).state).toBe('FAILED');
    const originalExecutions=await executionRow(f.seed.accountId),originalCosts=await costs(f.seed.accountId),checkpoint=(await admin.pool.query('SELECT * FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows[0],originalInputs=await evidence(f.seed.accountId,checkpoint.execution_id,'INPUT'),originalFree=await free(f.seed.accountId);
    const retry=(await f.workspace.handle(f.actor,await f.command({kind:'RETRY_REQUEST',payload:{requestId:first}}))).reply.operationRef.id!,error=fault(),validate=vi.fn(async()=>{throw error;});
    provider.validateObservation=async(_input,_observation,context)=>{const target=f.g.ports.get(context!.native)!;if(target.targetKind==='REQUEST_CHECKPOINT'&&target.targetId===retry)await validate();else expect(target.targetKind).toBe('EXECUTION');};
    const service=f.service(provider);expect(await service.runOnce()).toBe(true);expect(await requestRow(f.seed.accountId,retry)).toMatchObject({state:'WAITING',hold_reasons:[nativeExecutionHold],first_start_at:null});expect(await executionRow(f.seed.accountId)).toEqual(originalExecutions);expect(await costs(f.seed.accountId)).toEqual(originalCosts);expect((await admin.pool.query('SELECT * FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([checkpoint]);expect(await evidence(f.seed.accountId,checkpoint.execution_id,'INPUT')).toEqual(originalInputs);
    const wait=(await evidence(f.seed.accountId,checkpoint.execution_id,'NATIVE_VALIDATION_WAIT'))[0].protected_observation;expect(wait).toMatchObject({phase:'CHECKPOINT',currentRequestId:retry,originExecutionId:checkpoint.execution_id,knownObservationDigest:digest(checkpoint.output_envelope),termination:error.termination});expect(wait.currentRequestId).not.toBe(originalInputs[0].protected_observation.requestId);expect(provider.calls).toHaveLength(2);expect(await free(f.seed.accountId)).toMatchObject({free_started_count:originalFree.free_started_count,starts:originalFree.starts,active:1});
    expect(f.g.targets.at(-1)).toMatchObject({targetKind:'REQUEST_CHECKPOINT',targetId:retry,claim:{ownerId:service.workerId}});f.advance(5001);await drain(f.service(provider));expect(validate).toHaveBeenCalledOnce();expect(provider.calls).toHaveLength(2);expect(provider.lookups.length).toBeGreaterThan(0);expect(await costs(f.seed.accountId)).toEqual(originalCosts);expect(await executionRow(f.seed.accountId)).toEqual(originalExecutions);expect(await requestRow(f.seed.accountId,first)).toMatchObject({state:'FAILED',hold_reasons:[]});expect(await evidence(f.seed.accountId,checkpoint.execution_id,'NATIVE_VALIDATION_WAIT')).toHaveLength(1);
  });
  it('keeps known SUCCESS cost and START while native validation and late publication remain UNKNOWN',async()=>{
    const f=await fixture(),success=f.provider.success.bind(f.provider),provider=new SyntheticProvider(input=>({...success(input),costUsd:'0.027'})) as SyntheticProvider&ProviderAdapter,error=fault(),validate=vi.fn(async()=>{throw error;});provider.validateObservation=validate;
    const requestId=await f.request(),service=f.service(provider);await service.runOnce();const input=provider.calls[0],known=structuredClone(provider.observations.get(input.executionId)!);
    expect((await executionRow(f.seed.accountId,input.executionId))[0]).toMatchObject({state:'UNKNOWN',output_envelope:{outcome:'UNKNOWN',providerOutcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,data:null,outputAssetIds:[],nativeFailure:{termination:error.termination}}});expect(await requestRow(f.seed.accountId,requestId)).toMatchObject({state:'WAITING',hold_reasons:[nativeExecutionHold]});expect(await free(f.seed.accountId)).toEqual({free_started_count:1,starts:1,active:1});expect((await costs(f.seed.accountId))[0]).toMatchObject({state:'CONFIRMED',actual_usd:'0.027000000000',evidence_conflict:false});
    const source=(await evidence(f.seed.accountId,input.executionId,'NATIVE_VALIDATION_SOURCE'))[0];expect(source.protected_observation).toEqual(known);expect(source.evidence_digest).toBe(digest(known));expect((await evidence(f.seed.accountId,input.executionId,'NATIVE_VALIDATION_WAIT'))[0].protected_observation).toMatchObject({phase:'VALIDATION',knownObservationDigest:digest(known),knownObservationRef:source.evidence_id});
    await admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[f.seed.accountId]);const late={...known,evidenceId:randomUUID()};await service.observe(f.seed.accountId,input.executionId,late);
    const saved=(await executionRow(f.seed.accountId,input.executionId))[0];expect(saved.output_envelope).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',costUsd:'0.027',started:true,data:null});expect(saved.output_envelope).not.toHaveProperty('nativeFailure');expect(await evidence(f.seed.accountId,input.executionId,'NATIVE_VALIDATION_SOURCE')).toHaveLength(2);expect(provider.observations.get(input.executionId)).toEqual(known);expect((await costs(f.seed.accountId))[0]).toMatchObject({actual_usd:'0.027000000000',state:'CONFIRMED',evidence_conflict:false});
    expect((await admin.pool.query('SELECT count(*)::integer AS count FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows[0].count).toBe(0);expect((await admin.pool.query('SELECT count(*)::integer AS count FROM manga_web.result_applications WHERE account_id=$1',[f.seed.accountId])).rows[0].count).toBe(0);f.advance(5001);await drain(f.service(provider));expect(provider.calls).toHaveLength(1);expect(provider.lookups).toHaveLength(0);expect(validate).toHaveBeenCalledOnce();expect(await free(f.seed.accountId)).toEqual({free_started_count:1,starts:1,active:1});
  });
  it.each(['PRE_PROVIDER','POST_PROVIDER'] as const)('keeps DISPATCH native WAIT independent of actual provider START at %s',async phase=>{
    const f=await fixture(),error=fault(),success=f.provider.success.bind(f.provider);const provider=new SyntheticProvider(input=>({...success(input),outcome:'UNKNOWN',providerOutcome:'SUCCESS',costUsd:'0.031',data:null,finishReason:nativeExecutionHold,nativeFailure:{code:error.code,termination:error.termination}})) as SyntheticProvider&ProviderAdapter;
    if(phase==='PRE_PROVIDER')provider.dispatch=vi.fn(async()=>{throw error;});const requestId=await f.request();await f.service(provider).runOnce();const execution=(await executionRow(f.seed.accountId))[0];
    expect(await requestRow(f.seed.accountId,requestId)).toMatchObject({state:'WAITING',hold_reasons:[nativeExecutionHold]});expect((await evidence(f.seed.accountId,execution.execution_id,'NATIVE_VALIDATION_WAIT'))[0].protected_observation).toMatchObject({phase:'DISPATCH',termination:error.termination});
    if(phase==='PRE_PROVIDER'){expect(execution).toMatchObject({state:'DISPATCHING',start_confirmed_at:null,output_envelope:null});expect(await costs(f.seed.accountId)).toEqual([]);expect(await evidence(f.seed.accountId,execution.execution_id,'OUTCOME')).toEqual([]);expect(await free(f.seed.accountId)).toEqual({free_started_count:0,starts:0,active:1});expect(provider.calls).toHaveLength(0);expect(provider.dispatch).toHaveBeenCalledOnce();}
    else{expect(execution).toMatchObject({state:'UNKNOWN',output_envelope:{outcome:'UNKNOWN',providerOutcome:'SUCCESS',started:true,costUsd:'0.031',usageConfirmed:true,data:null}});expect((await costs(f.seed.accountId))[0]).toMatchObject({state:'CONFIRMED',actual_usd:'0.031000000000'});expect(await free(f.seed.accountId)).toEqual({free_started_count:1,starts:1,active:1});expect((await evidence(f.seed.accountId,execution.execution_id,'NATIVE_VALIDATION_SOURCE'))[0].protected_observation).toEqual(provider.observations.get(execution.execution_id));}
    f.advance(5001);await drain(f.service(provider));expect(provider.calls).toHaveLength(phase==='PRE_PROVIDER'?0:1);expect(provider.lookups).toHaveLength(0);
  });
  it('keeps LOOKUP native WAIT in a closed source context without changing prior outcome or cost',async()=>{
    const f=await fixture(),provider=new SyntheticProvider(()=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'OWNED_RESPONSE_LOSS',providerRef:'owned-provider-ref',data:null})) as SyntheticProvider&ProviderAdapter,requestId=await f.request();await drain(f.service(provider));const input=provider.calls[0],original=(await executionRow(f.seed.accountId))[0],originalCosts=await costs(f.seed.accountId),inputs=await evidence(f.seed.accountId,input.executionId,'INPUT');
    await worker.accountTransaction(f.seed.accountId,async tx=>closeContext(tx,await contextRow(tx,f.seed.contextId),'NORMAL_EXIT'));const error=fault(),lookup=vi.fn(async()=>{throw error;});provider.lookup=lookup;f.advance(5001);const service=f.service(provider);await drain(service);
    expect((await executionRow(f.seed.accountId))[0]).toEqual(original);expect(await costs(f.seed.accountId)).toEqual(originalCosts);expect(await evidence(f.seed.accountId,input.executionId,'INPUT')).toEqual(inputs);expect(await requestRow(f.seed.accountId,requestId)).toMatchObject({state:'STOP_REQUESTED',hold_reasons:expect.arrayContaining([nativeExecutionHold])});expect((await evidence(f.seed.accountId,input.executionId,'NATIVE_VALIDATION_WAIT'))[0].protected_observation).toMatchObject({phase:'LOOKUP',currentRequestId:requestId,termination:error.termination});expect(lookup).toHaveBeenCalledOnce();expect(provider.calls).toHaveLength(1);expect(f.g.targets.at(-1)).toMatchObject({targetKind:'EXECUTION',targetId:input.executionId,protectedOwnerCapture:{contextId:f.seed.contextId,contextGeneration:'1',ownerSessionId:null,ownerTabId:null},claim:{ownerId:service.workerId}});
    f.advance(5001);await drain(f.service(provider));expect(lookup).toHaveBeenCalledOnce();expect(provider.calls).toHaveLength(1);expect(await costs(f.seed.accountId)).toEqual(originalCosts);expect(await free(f.seed.accountId)).toEqual({free_started_count:1,starts:1,active:1});
  });
  it('keeps successful native calculation separate from unresolved release and unrelated request or account faults',async()=>{
    const f=await fixture();await f.request();await f.request(f.seed.pageIds[1]);const service=f.service(),first=await prepared(service),second=await prepared(service),completed=await syntheticNativeIntent(service,first.claim,first.input),pending=await syntheticNativeIntent(service,second.claim,second.input,'REQUEST_CHECKPOINT');
    expect(await waiting(f.seed.accountId,first.input.requestId)).toBe(true);await completed.store.observe(randomUUID(),nativeObservation(completed.intent,'RESULT'));expect(await waiting(f.seed.accountId,first.input.requestId)).toBe(true);await completed.store.observe(randomUUID(),nativeObservation(completed.intent,'TERMINATION'));expect(await waiting(f.seed.accountId,first.input.requestId)).toBe(false);expect(await waiting(f.seed.accountId,second.input.requestId)).toBe(true);
    await pending.store.observe(randomUUID(),nativeObservation(pending.intent,'RESULT'));await pending.store.observe(randomUUID(),nativeObservation(pending.intent,'TERMINATION',false));expect(await waiting(f.seed.accountId,second.input.requestId)).toBe(true);expect(await waiting(f.seed.accountId,first.input.requestId)).toBe(false);
    const other=await fixture(),otherService=other.service();await other.request();const unrelated=await prepared(otherService);await syntheticNativeIntent(otherService,unrelated.claim,unrelated.input);expect(await waiting(other.seed.accountId,unrelated.input.requestId)).toBe(true);expect(await waiting(f.seed.accountId,first.input.requestId)).toBe(false);
    expect(await service.preflight(first.claim,first.input)).toBe(true);const observed=await f.provider.dispatch(first.input,id=>service.started(f.seed.accountId,first.input.executionId,id,first.claim));await service.observe(f.seed.accountId,first.input.executionId,await service.validated(first.input,observed,first.claim),false,first.claim);await service.finish(first.claim,false);await drain(service);
    expect(await requestRow(f.seed.accountId,first.input.requestId)).toMatchObject({state:'COMPLETED',hold_reasons:[]});expect((await executionRow(f.seed.accountId,first.input.executionId))[0].state).toBe('SUCCEEDED');expect(f.provider.calls).toHaveLength(1);expect((await completed.store.unresolved(completed.intent.logicalOperationKey))[0]).toMatchObject({unresolved:true,cost:'UNCONFIRMED',application:'UNCONFIRMED'});
    expect(await service.preflight(second.claim,second.input)).toBe(false);expect((await executionRow(f.seed.accountId,second.input.executionId))[0]).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});expect(await requestRow(f.seed.accountId,second.input.requestId)).toMatchObject({state:'WAITING',hold_reasons:[nativeExecutionHold]});expect(await waiting(other.seed.accountId,unrelated.input.requestId)).toBe(true);
    const original=await worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,first.input.executionId));expect(digest(original)).toBe(digest(canonicalInput(first.input)));await expect(completed.store.beforeGo(completed.intent.jobId,completed.intent.parentInstanceId,completed.intent.claim,completed.intent.protectedOwnerCapture)).rejects.toMatchObject({code:'NATIVE_GO_ALREADY_CONSUMED'});
  });
});


it('W4-C v2 원 종료 관측이 완전하면 물리 슬롯과 별개로 계산 대기를 해제한다',async()=>{
  const {guardWindowsNativeIo,windowsNativeFixture,createWindowsNativeCostOriginalFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined;
  try{
    f=await windowsNativeFixture();const native=await createWindowsNativeCostOriginalFixture(f,{mode:'CREATED',accounting:{userTime100ns:'10000000',kernelTime100ns:'0'}});
    const rows=(await f.admin.pool.query("SELECT event,protected_observation,observation_digest FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 ORDER BY event",[f.seed.accountId,native.binding.jobId])).rows;
    expect(rows).toHaveLength(2);expect(rows.map(row=>row.event)).toEqual(['RESULT','TERMINATION']);
    for(const row of rows)expect(row.protected_observation).toMatchObject({version:2,code:'OK',termination:{jobId:native.binding.jobId,kind:'WINDOWS_JOB_EMPTY',isolation:'WINDOWS_JOB_OBJECT',operationJoined:true,directChildClosed:true,subtreeTerminationConfirmed:true}});
    const waiting=await f.worker.accountTransaction(f.seed.accountId,async tx=>{
      const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[f!.seed.accountId,native.execution.input.requestId])).rows[0];
      expect(request.hold_reasons).not.toContain(nativeExecutionHold);return nativeExecutionWaiting(tx,request);
    },true);
    console.info(JSON.stringify({w4cV2Gate:{observations:rows.map(row=>({event:row.event,version:row.protected_observation.version,kind:row.protected_observation.termination.kind})),waiting,guardDenied:guard.denied}}));
    expect(waiting).toBe(false);
    expect((await f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,native.binding.jobId])).rows).toEqual([{state:'HELD'}]);
    // 복수 job 조립도 원 operator proof만 등록하며 두 예약의 HELD를 유지한다.
    const {WindowsNativeCapacityOperator}=await import('../../packages/domain/src/windows-native-cost.js');
    const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name),proof=await operator.confirmWindows(native.key);expect(proof.allowed).toBe(true);
    expect((await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,native.binding.jobId])).rows).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);
    const pending=await f.originalIntent(native.execution,'EXECUTION',native.execution.input.requestId,'POLYGON_MASK');
    const pendingReservation=await pending.reserve(native.capacity);expect(pendingReservation).toMatchObject({allowed:true,reason:'CREATED'});
    const waitingWithPending=await f.worker.accountTransaction(f.seed.accountId,async tx=>nativeExecutionWaiting(tx,(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[f!.seed.accountId,native.execution.input.requestId])).rows[0]),true);
    expect(waitingWithPending).toBe(true);
    expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) intents,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go',[f.seed.accountId])).rows).toEqual([{intents:2,go:1}]);
    console.info(JSON.stringify({w4cV2Pending:{completeWaiting:waiting,pendingWaiting:waitingWithPending,intents:2,go:1}}));
    const {WindowsNativeJournal}=await import('../../packages/domain/src/windows-native-journal.js');
    const {storeWindowsNativeRaw,windowsNativeScript,windowsNativeLimits,windowsFrameLimits}=await import('../fixtures/windows-native.js');
    const {createNativeResult}=await import('../../packages/native/src/dto.js'),{deflateSync}=await import('node:zlib');
    const journal=new WindowsNativeJournal(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity:native.capacity,limits:windowsNativeLimits,signer:f.signer},f.memory!);f.journals.push(journal);
    const ports=journal.portsFor(f.peer),input=await journal.offerOriginal(f.peer,pending.binding(pendingReservation.capacityReservationId!),pending.frame),captured=await ports.original.captureFresh(input),script=windowsNativeScript(input,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'0'});
    for(const entry of script.entries)await ports.journal.appendOriginal(captured.capture,entry.event,entry.source);
    await journal.readyOriginal(captured.capture,script.prepared);const go=await ports.original.grantOriginal(captured.capture),prefix=script.entries.length;expect(go.created).toBe(true);script.complete(go.goGrantRef);
    for(const entry of script.entries.slice(prefix))await ports.journal.appendOriginal(captured.capture,entry.event,entry.source);
    // 네이티브 실행 없이 합성 mask 결과를 만든다. 원 frame/journal 검증은 유지한다.
    const chunk=(kind:string,data:Buffer)=>{
      const payload=Buffer.concat([Buffer.from(kind,'ascii'),data]);let crc=0xffffffff;
      for(const byte of payload){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;}
      const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,payload,sum]);
    };
    const header=Buffer.alloc(13);header.writeUInt32BE(4,0);header.writeUInt32BE(4,4);header[8]=8;
    const scanlines=Buffer.alloc(20,255);for(let row=0;row<4;row++)scanlines[row*5]=0;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]),pixels=Buffer.alloc(16,255),blobs=new Map([['mask-png',png],['mask-pixels',pixels]]);
    const envelope=createNativeResult(input.frame.envelope,{metadata:{width:4,height:4,pngBlobId:'mask-png',pngByteLength:png.length,pixelsBlobId:'mask-pixels',pixelsByteLength:pixels.length},blobs},windowsFrameLimits),raw=await storeWindowsNativeRaw(f,captured.capture,{envelope,blobs});
    await journal.parentJoinedOriginal(captured.capture,script.joinAck);const sealed=await ports.journal.sealOriginal(captured.capture,script.seal()),finalized=script.finalized(sealed);
    await journal.finishOriginal(captured.capture,{outcome:script.outcome(sealed,raw),finalized,brokerJoin:{end:'EXPECTED',finalized}});
    const bothComplete=await f.worker.accountTransaction(f.seed.accountId,async tx=>nativeExecutionWaiting(tx,(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[f!.seed.accountId,native.execution.input.requestId])).rows[0]),true);
    expect(bothComplete).toBe(false);expect((await f.admin.pool.query('SELECT event,count(*)::integer n FROM manga_web.native_job_observations WHERE account_id=$1 GROUP BY event ORDER BY event',[f.seed.accountId])).rows).toEqual([{event:'RESULT',n:2},{event:'TERMINATION',n:2}]);
    console.info(JSON.stringify({w4cV2Multiple:{bothCompleteWaiting:bothComplete,jobs:2,observations:4,automaticPhysicalRelease:false,fixtureOperatorRelease:0}}));
  }finally{try{await f?.close();}finally{const denied=[...guard.denied];guard.restore();expect(denied).toEqual([]);}}
},120000);


it('W4-C v2 단일 관측 결손과 충돌은 정상 대조를 보존하며 계산 대기를 유지한다',async()=>{
  const {guardWindowsNativeIo,windowsNativeFixture,createWindowsNativeCostOriginalFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined;
  try{
    f=await windowsNativeFixture();const owned=f,native=await createWindowsNativeCostOriginalFixture(f,{mode:'CREATED',accounting:{userTime100ns:'10000000',kernelTime100ns:'0'}});
    const original=(await f.admin.pool.query('SELECT observation_id,event,parent_instance_id,protected_observation,observation_digest,received_at FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 ORDER BY event',[f.seed.accountId,native.binding.jobId])).rows;
    const read=()=>owned.worker.accountTransaction(owned.seed.accountId,async tx=>nativeExecutionWaiting(tx,(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[owned.seed.accountId,native.execution.input.requestId])).rows[0]),true);
    expect(await read()).toBe(false);
    type Body=Record<string,unknown>;
    const term=(body:Body)=>body.termination as Body,record=(body:Body)=>body.windowsRecordRef as Body;
    const defects:{name:string;change(body:Body,event:string):void}[]=[
      {name:'숫자 버전 대신 문자열',change:body=>{body.version='2';}},
      {name:'v2를 v1으로 표기',change:body=>{body.version=1;}},
      {name:'정상 code 불일치',change:body=>{body.code='UNCONFIRMED';}},
      {name:'원 event 불일치',change:(body,event)=>{if(event==='RESULT')body.event='TERMINATION';}},
      {name:'원 parent 불일치',change:body=>{body.parentInstanceId='11111111-1111-4111-8111-111111111111';}},
      {name:'원 job 불일치',change:body=>{term(body).jobId='11111111-1111-4111-8111-111111111111';}},
      {name:'원 input 불일치',change:body=>{term(body).inputDigest=sha256('다른 입력');}},
      {name:'원 profile 불일치',change:body=>{term(body).profileDigest=sha256('다른 프로필');}},
      {name:'종료 종류 미확정',change:body=>{term(body).kind='UNCONFIRMED';}},
      {name:'종료 격리 불일치',change:body=>{term(body).isolation='OWNED_FIXTURE';}},
      ...['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'].flatMap(key=>[
        {name:key+' false',change:(body:Body)=>{term(body)[key]=false;}},
        {name:key+' 문자열 true',change:(body:Body)=>{term(body)[key]='true';}},
      ]),
      {name:'두 종료 본문 불일치',change:(body,event)=>{if(event==='TERMINATION')term(body).inputDigest=sha256('다른 종료 입력');}},
      {name:'RESULT digest null',change:(body,event)=>{if(event==='RESULT')body.resultDigest=null;}},
      {name:'RESULT digest 숫자',change:(body,event)=>{if(event==='RESULT')body.resultDigest=123;}},
      {name:'TERM digest 문자열',change:(body,event)=>{if(event==='TERMINATION')body.resultDigest=sha256('종료는 null이어야 한다');}},
      {name:'record ref 누락',change:body=>{delete body.windowsRecordRef;}},
      {name:'record ref null',change:body=>{body.windowsRecordRef=null;}},
      {name:'record ID 형식 불일치',change:body=>{record(body).recordId='wrong-record';}},
      {name:'record digest 형식 불일치',change:body=>{record(body).recordDigest='wrong-digest';}},
      {name:'두 record ref 불일치',change:(body,event)=>{if(event==='TERMINATION')record(body).recordDigest=sha256('다른 기록');}},
      {name:'record ref 추가 키',change:body=>{record(body).extra=true;}},
      {name:'관측 추가 키',change:body=>{body.extra=true;}},
      {name:'종료 추가 키',change:body=>{term(body).extra=true;}},
    ];
    const observed:{name:string;waiting:boolean}[]=[];
    const rollback=Object.freeze({kind:'W4C_NATIVE_GATE_ROLLBACK'});
    async function attack(name:string,mutate:(client:import('pg').PoolClient)=>Promise<void>){
      let waiting:boolean|undefined;
      try{
        await owned.admin.transaction(async client=>{
          await client.query('ALTER TABLE manga_web.native_job_observations DISABLE TRIGGER immutable_native_job_observations');
          await mutate(client);await client.query('SET LOCAL ROLE trio_web_worker');
          expect((await client.query('SELECT current_user')).rows[0].current_user).toBe('trio_web_worker');
          const tx=await owned.worker.accountContext(client,owned.seed.accountId,true),request=(await client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[owned.seed.accountId,native.execution.input.requestId])).rows[0];
          waiting=await nativeExecutionWaiting(tx,request);throw rollback;
        });
      }catch(error){expect(error,name).toBe(rollback);}
      expect(waiting,name).toBe(true);observed.push({name,waiting:waiting!});expect(await read(),name+' 이후 원 정상 대조').toBe(false);
    }
    for(const defect of defects)await attack(defect.name,async client=>{
      for(const row of original){
        const body=structuredClone(row.protected_observation) as Body;defect.change(body,row.event);
        await client.query("UPDATE manga_web.native_job_observations SET protected_observation=$3::jsonb,observation_digest=encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex') WHERE account_id=$1 AND observation_id=$2",[owned.seed.accountId,row.observation_id,JSON.stringify(body)]);
      }
    });
    for(const event of ['RESULT','TERMINATION'])await attack(event+' 한 행 누락',async client=>{
      // 원 finish가 함께 쓴 FK 참조만 먼저 제거한다. FK와 제품 권한은 유지한다.
      await client.query('ALTER TABLE manga_web.native_controller_events DISABLE TRIGGER immutable_controller_record');
      await client.query('DELETE FROM manga_web.native_controller_events WHERE account_id=$1 AND observation_id IN(SELECT observation_id FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND event=$3)',[owned.seed.accountId,native.binding.jobId,event]);
      await client.query('DELETE FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND event=$3',[owned.seed.accountId,native.binding.jobId,event]);
    });
    for(const event of ['RESULT','TERMINATION'])await attack(event+' 충돌 중복',async client=>{
      const row=original.find(value=>value.event===event)!;
      await client.query('INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[owned.seed.accountId,randomUUID(),native.binding.jobId,row.parent_instance_id,row.event,row.observation_digest,JSON.stringify(row.protected_observation),row.received_at]);
    });
    await attack('관측 digest만 불일치',async client=>{await client.query("UPDATE manga_web.native_job_observations SET observation_digest=$3 WHERE account_id=$1 AND job_id=$2 AND event='RESULT'",[owned.seed.accountId,native.binding.jobId,sha256('다른 관측 봉인')]);});
    await attack('원 ERROR 존재',async client=>{
      const row=original[0],body={...row.protected_observation,event:'ERROR',code:'UNCONFIRMED'};
      await client.query("INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES($1,$2,$3,$4,'ERROR',encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'),$5,clock_timestamp())",[owned.seed.accountId,randomUUID(),native.binding.jobId,row.parent_instance_id,JSON.stringify(body)]);
    });
    await attack('명시 native hold',async client=>{await client.query('UPDATE manga_web.processing_requests SET hold_reasons=$3 WHERE account_id=$1 AND request_id=$2',[owned.seed.accountId,native.execution.input.requestId,JSON.stringify([nativeExecutionHold])]);});
    expect((await f.admin.pool.query('SELECT observation_id,event,parent_instance_id,protected_observation,observation_digest,received_at FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 ORDER BY event',[f.seed.accountId,native.binding.jobId])).rows).toEqual(original);
    const downgrade=structuredClone(original[0].protected_observation);downgrade.version=1;delete downgrade.windowsRecordRef;downgrade.termination.kind='DIRECT_CHILD_ONLY';downgrade.termination.isolation='OWNED_FIXTURE';
    const denied=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.native_job_append_observation($1::uuid,$2::jsonb) value',[randomUUID(),JSON.stringify(downgrade)])).rows[0].value,true);
    expect(denied).toMatchObject({allowed:false,reason:'WINDOWS_NATIVE_FINAL_UNCONFIRMED'});
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('UPDATE manga_web.native_job_observations SET observation_digest=observation_digest WHERE account_id=$1 AND job_id=$2',[owned.seed.accountId,native.binding.jobId]),true)).rejects.toMatchObject({code:'42501'});
    expect(await read()).toBe(false);console.info(JSON.stringify({w4cV2SingleFaults:{cases:observed,rawRestored:true,workerDowngradeDenied:true,workerUpdateDenied:true,guardDenied:guard.denied}}));
  }finally{try{await f?.close();}finally{const denied=[...guard.denied];guard.restore();expect(denied).toEqual([]);}}
},120000);


it('W4-C v2 원 관측 SELECT의 권한 오류는 WAIT로 바꾸지 않고 원 오류로 전달한다',async()=>{
  const {guardWindowsNativeIo,windowsNativeFixture,createWindowsNativeCostOriginalFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined;
  try{
    f=await windowsNativeFixture();const owned=f,native=await createWindowsNativeCostOriginalFixture(owned,{mode:'CREATED',accounting:{userTime100ns:'10000000',kernelTime100ns:'0'}});
    const read=()=>owned.worker.accountTransaction(owned.seed.accountId,async tx=>nativeExecutionWaiting(tx,(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[owned.seed.accountId,native.execution.input.requestId])).rows[0]),true);
    expect(await read()).toBe(false);
    let serverError:unknown,outerError:unknown,queries=0;
    // 폐기 DB의 이 거래에서만 권한을 제거한다. 오류로 전체 거래가 rollback되어 ACL이 복구된다.
    try{await owned.admin.transaction(async client=>{
      await client.query('REVOKE SELECT ON manga_web.native_job_observations FROM trio_web_worker');
      await client.query('SET LOCAL ROLE trio_web_worker');
      expect((await client.query('SELECT current_user AS role')).rows[0]).toEqual({role:'trio_web_worker'});
      const tx=await owned.worker.accountContext(client,owned.seed.accountId,true),request=(await client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[owned.seed.accountId,native.execution.input.requestId])).rows[0];
      try{queries++;await nativeExecutionWaiting(tx,request);throw Error('W4C 원 권한 오류 미도달');}catch(error){serverError=error;throw error;}
    });}catch(error){outerError=error;}
    expect(queries).toBe(1);expect(serverError).toMatchObject({code:'42501'});expect(outerError).toBe(serverError);
    expect(await read()).toBe(false);
    console.info(JSON.stringify({w4cV2SqlError:{code:(serverError as {code:string}).code,identityPreserved:outerError===serverError,normalAfterRollback:true,guardDenied:guard.denied}}));
  }finally{try{await f?.close();}finally{const denied=[...guard.denied];guard.restore();expect(denied).toEqual([]);}}
},120000);
