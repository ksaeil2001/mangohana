import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Database,type Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,canonicalInput,normalizeObservation,type Observation,type ProviderAdapter,type StageInput} from '../../packages/domain/src/provider.js';
import {contextRow} from '../../packages/domain/src/model.js';
import {FullStageCostPreparation,type FullStageCostCatalogEntry} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {FullStageCostJournal} from '../../packages/domain/src/full-stage-cost-journal.js';
import {OperationalStageCost,type OperationalStageCostReader} from '../../packages/domain/src/pipeline-stage-cost.js';
import {CheckpointValidationJournal} from '../../packages/domain/src/checkpoint-validation.js';
import type {FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {NativeJobClaim} from '../../packages/domain/src/native-jobs.js';
import type {NativeGateway,NativeTarget} from '../../packages/native/src/gateway.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError} from '../../packages/native/src/dto.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';
import {createRuntime,createWorkerRuntime,type WorkerRuntimeOptions} from '../../apps/api/src/runtime.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import type {ProjectSigner} from '../../packages/media/src/project-file.js';
import type {AuthProvider} from '../../packages/domain/src/auth-provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';

// Restricted worker/API LOGIN and original PG rows when run by the owning PG
// runner. Prices/MEASURED label/provider/facade are fake metadata only. No
// native task, child, engine, object GET/PUT, actual cost or activation evidence.
type PrepareHook=(input:StageInput,claim:NativeJobClaim)=>Promise<void>;
type PrivateHooks={heartbeatMilliseconds:number;beforeValidateInput?:PrepareHook;afterPrepare:(input:StageInput)=>Promise<void>};
type EvidenceRow={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown};
const connections:Database[]=[],caseAccounts:string[]=[];
let admin:Database,api:Database,worker:Database,now=new Date();
const clock=async()=>now;
beforeAll(async()=>{
  admin=await testDatabase(clock);connections.push(admin);
  api=await provisionLocalService(admin,'trio_web_api',clock);worker=await provisionLocalService(admin,'trio_web_worker',clock);connections.push(api,worker);
  for(const [db,role] of [[api,'trio_web_api'],[worker,'trio_web_worker']] as const){await db.validateServiceRole();const identity=(await db.pool.query('SELECT session_user,current_user')).rows[0];expect(identity.current_user).toBe(role);expect(identity.session_user).not.toBe(role);}
});
afterEach(async()=>{
  vi.restoreAllMocks();
  // Park fixture scheduling without deleting its INPUT/basis/claim facts.
  for(const accountId of caseAccounts.splice(0))await admin.pool.query("UPDATE manga_web.work_items SET due_at='2100-01-01T00:00:00Z' WHERE account_id=$1 AND state<>'DONE'",[accountId]);
});
afterAll(async()=>{const failures:unknown[]=[];for(const db of connections.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_PREPARATION_DB_CLOSE_UNCONFIRMED');});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(complete=>{resolve=complete;});return {promise,resolve};}

async function fixture(){
  const sampled=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;if(sampled>now)now=sampled;
  const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);caseAccounts.push(seed.accountId);
  const policy={stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:'owned-run-preparation-pg-v1'},workspace=new WorkspaceService(api,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=async(operation:WorkspaceCommand['operation']):Promise<WorkspaceCommand>=>api.accountTransaction(seed.accountId,async tx=>{const context=await contextRow(tx,seed.contextId);return {commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:context.generation,tabId:seed.tabId,expectedOwnerRevision:context.owner_revision,expectedWorkspaceRevision:context.workspace_revision},operation};});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,await command({kind:'PATCH_SETTINGS',payload:{settings}}));
  const requestId=(await workspace.handle(actor,await command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}))).reply.operationRef.id!;
  const events:string[]=[],targets:NativeTarget[]=[],boundary=Error('OWNED_AFTER_PREPARE_BOUNDARY');
  const gateway:NativeGateway={forTarget:vi.fn(target=>{events.push('NATIVE_CONTEXT');targets.push(structuredClone(target));return {} as NativeFacade;}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};
  const provider=new SyntheticProvider(()=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'OWNED_METADATA_PROVIDER',providerRef:null,data:null})) as SyntheticProvider&ProviderAdapter;
  const validate=vi.fn<NonNullable<ProviderAdapter['validateInput']>>(async()=>{events.push('VALIDATE_INPUT');});provider.validateInput=validate;
  const profileDigest=sha256('owned-execution-preparation-pg-profile'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'owned-run-basis-pg-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-catalog-pg'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-image-rate-pg-v1',usdPerUnit:'0.001',evidenceRefs:['owned-invented-rate-pg']}]};
  const journalBounds={maxRecordBytes:262144,maxRecords:8,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}},catalog:FullStageCostCatalogEntry[]=[{stage:'OCR',profileDigest,snapshot}];
  const journal=()=>new FullStageCostJournal(worker,journalBounds),preparation=(entries=catalog)=>new FullStageCostPreparation(journal(),entries,journalBounds.calculator);
  let installed=preparation();
  const records=async(kind:string)=>(await admin.pool.query<EvidenceRow>('SELECT evidence_id,evidence_digest,protected_evidence_ref,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind=$2 ORDER BY received_at,evidence_id',[seed.accountId,kind])).rows;
  const execution=async()=>(await admin.pool.query<{execution_id:string;request_id:string;state:string;input_digest:string;claim_generation:string;dispatch_attempted_at:Date|null;start_confirmed_at:Date|null;output_envelope:unknown}>('SELECT execution_id,request_id,state,input_digest,claim_generation,dispatch_attempted_at,start_confirmed_at,output_envelope FROM manga_web.executions WHERE account_id=$1 ORDER BY execution_id',[seed.accountId])).rows;
  const request=async()=>(await admin.pool.query<{state:string;first_start_at:Date|null;hold_reasons:string[]}>('SELECT state,first_start_at,hold_reasons FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[seed.accountId,requestId])).rows[0];
  const work=async()=>(await admin.pool.query<{work_item_id:string;state:string;claim_generation:string;claim_owner:string|null;lease_until:Date|null}>("SELECT work_item_id,state,claim_generation,claim_owner,lease_until FROM manga_web.work_items WHERE account_id=$1 AND kind='DISPATCH' ORDER BY work_item_id",[seed.accountId])).rows[0];
  const hook=vi.fn<PrepareHook>(async(input,claim)=>{
    events.push('PREPARE_HOOK');const saved=await records('INPUT');expect(saved).toHaveLength(1);expect(saved[0].protected_observation).toEqual(canonicalInput(input));expect(saved[0].evidence_digest).toBe(digest(canonicalInput(input)));
    expect(await execution()).toEqual([expect.objectContaining({execution_id:input.executionId,state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null})]);expect(await work()).toMatchObject({work_item_id:claim.workItemId,claim_generation:claim.generation,claim_owner:claim.ownerId,state:'CLAIMED'});expect(targets).toEqual([]);expect(validate).not.toHaveBeenCalled();expect(provider.calls).toEqual([]);
    await installed.prepare(input,claim);events.push('BASIS_PREPARED');
  });
  const afterPrepare=vi.fn<PrivateHooks['afterPrepare']>(async()=>{events.push('AFTER_PREPARE');throw boundary;});
  const service=(withHook=true)=>{const hooks:PrivateHooks={heartbeatMilliseconds:1000000,afterPrepare,...(withHook?{beforeValidateInput:hook}:{})};return new ExecutionService(worker,provider,policy,hooks,gateway);};
  const resource=vi.fn(async()=>{throw Error('OWNED_FACTORY_RESOURCE_CALL');});
  const factory=(mode:'worker'|'composed',cost?:OperationalStageCost)=>{
    const objects:ObjectStore={bucket:'owned-preparation-memory',put:resource,read:resource,receipt:resource,remove:resource},fonts={catalog:{version:'owned-preparation-font',fonts:[]},bytes:new Map()} as unknown as FontCatalog;
    const options:WorkerRuntimeOptions={worker,objects,fonts,profile:syntheticProfile,policy,provider,workerNative:gateway,workerOperationalCost:cost,workerExecutionHooks:{heartbeatMilliseconds:1000000,afterPrepare,beforeValidateInput:hook}};
    return mode==='worker'?createWorkerRuntime(options):createRuntime({...options,api,signer:{envelope:resource,check:resource} as unknown as ProjectSigner,authProvider:{begin:resource,verify:resource} as unknown as AuthProvider,allowedAccounts:new Set([seed.accountId]),limiterSecret:Buffer.alloc(32,7)});
  };
  const unstarted=async(reservation:'HELD'|'RELEASED_CONFIRMED'='HELD')=>{
    for(const kind of ['START','STALE_START','OUTCOME','OPERATIONAL_COST_CALCULATION'])expect(await records(kind)).toEqual([]);
    for(const table of ['free_starts','cost_items','settlements','ledger_entries','native_job_intents','native_job_go_consumptions','native_job_observations'])expect((await admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[seed.accountId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('SELECT free_started_count FROM manga_web.accounts WHERE account_id=$1',[seed.accountId])).rows).toEqual([{free_started_count:0}]);expect((await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[seed.accountId])).rows).toEqual([{state:reservation}]);expect(provider.calls).toEqual([]);expect(await execution()).toEqual([expect.objectContaining({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null})]);
  };
  return {seed,actor,workspace,command,requestId,events,targets,boundary,gateway,provider,validate,profileDigest,snapshot,catalog,journalBounds,journal,preparation,hook,afterPrepare,service,factory,resource,records,execution,request,work,unstarted,replacePreparation:(entries:FullStageCostCatalogEntry[])=>{installed=preparation(entries);},advance:(milliseconds:number)=>{now=new Date(now.valueOf()+milliseconds);}};
}

describe('restricted execution INPUT cost preparation seam',()=>{
  it.each(['worker','composed'] as const)('prepares committed INPUT before native validation through %s factory and joins its in-flight hook on stop',async mode=>{
    const f=await fixture(),entered=deferred<boolean>(),gate=deferred<void>(),original=f.hook.getMockImplementation()!;
    f.hook.mockImplementationOnce(async(input,claim)=>{await original(input,claim);entered.resolve(true);await gate.promise;});
    const runtime=f.factory(mode),pending=runtime.tick(),settled=pending.then(()=>false,()=>false),idleComplete=vi.fn();let joining:Promise<unknown>|undefined;
    try{
      expect(await Promise.race([entered.promise,settled])).toBe(true);expect(f.events).toEqual(['PREPARE_HOOK','BASIS_PREPARED']);expect(await f.records('INPUT')).toHaveLength(1);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);expect(f.targets).toEqual([]);
      runtime.stopClaims();joining=runtime.idle().then(()=>{idleComplete();return null;},error=>{idleComplete();return error;});await Promise.resolve();expect(idleComplete).not.toHaveBeenCalled();
    }finally{gate.resolve();}
    await expect(pending).rejects.toBe(f.boundary);expect(await joining).toBe(f.boundary);expect(f.events).toEqual(['PREPARE_HOOK','BASIS_PREPARED','NATIVE_CONTEXT','VALIDATE_INPUT','AFTER_PREPARE']);expect(f.hook).toHaveBeenCalledOnce();
    const [input,claim]=f.hook.mock.calls[0];expect(claim.ownerId).toBe(runtime.execution.workerId);expect(await f.work()).toMatchObject({work_item_id:claim.workItemId,claim_generation:claim.generation,claim_owner:claim.ownerId,state:'CLAIMED'});expect(f.targets[0]).toMatchObject({targetKind:'EXECUTION',targetId:input.executionId,sourceInput:{inputEvidenceId:(await f.records('INPUT'))[0].evidence_id},claim});
    const view=await f.journal().lookup(input);expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.basis!.capture.inputFingerprint).toBe(digest(canonicalInput(input)));expect(view.basis!.snapshot).toEqual(f.snapshot);
    await runtime.tick();await runtime.idle();expect(f.hook).toHaveBeenCalledOnce();expect(f.gateway.stopClaims).toHaveBeenCalledOnce();expect(f.gateway.idle).toHaveBeenCalledOnce();expect(f.resource).not.toHaveBeenCalled();await f.unstarted();
  },20000);
  it.each(['worker','composed'] as const)('propagates preparation failure through %s factory without validation or a new claim after stop',async mode=>{
    const f=await fixture(),error=Error('OWNED_FACTORY_PREPARATION_IO_UNKNOWN');f.hook.mockImplementationOnce(async()=>{throw error;});const runtime=f.factory(mode);
    await expect(runtime.tick()).rejects.toBe(error);expect(await f.records('INPUT')).toHaveLength(1);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);expect(await f.request()).toMatchObject({state:'ACCEPTED',first_start_at:null,hold_reasons:[]});expect(await f.work()).toMatchObject({state:'CLAIMED',claim_owner:runtime.execution.workerId});expect(f.validate).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(f.afterPrepare).not.toHaveBeenCalled();
    runtime.stopClaims();await runtime.tick();await runtime.idle();expect(f.hook).toHaveBeenCalledOnce();expect(f.gateway.stopClaims).toHaveBeenCalledOnce();expect(f.gateway.idle).toHaveBeenCalledOnce();expect(f.resource).not.toHaveBeenCalled();await f.unstarted();
  },20000);
  it('preserves no-hook INPUT/validation/afterPrepare behavior without adding a basis',async()=>{
    const f=await fixture();await expect(f.service(false).runOnce()).rejects.toBe(f.boundary);expect(f.hook).not.toHaveBeenCalled();expect(f.events).toEqual(['NATIVE_CONTEXT','VALIDATE_INPUT','AFTER_PREPARE']);expect(await f.records('INPUT')).toHaveLength(1);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);await f.unstarted();
  },20000);
  it('prepares through the owning worker after committed INPUT and before native INPUT/validation',async()=>{
    const f=await fixture(),service=f.service();await expect(service.runOnce()).rejects.toBe(f.boundary);expect(f.events).toEqual(['PREPARE_HOOK','BASIS_PREPARED','NATIVE_CONTEXT','VALIDATE_INPUT','AFTER_PREPARE']);expect(f.hook).toHaveBeenCalledOnce();const [input,claim]=f.hook.mock.calls[0];expect(claim.ownerId).toBe(service.workerId);expect(claim.workItemId).toBe((await f.work()).work_item_id);expect(claim.generation).toBe((await f.work()).claim_generation);expect(f.targets[0]).toMatchObject({targetKind:'EXECUTION',targetId:input.executionId,sourceInput:{inputEvidenceId:(await f.records('INPUT'))[0].evidence_id},claim});
    const view=await f.journal().lookup(input);expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.basis!.capture.inputFingerprint).toBe(digest(canonicalInput(input)));expect(view.basis!.snapshot).toEqual(f.snapshot);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);
    await expect(api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE account_id=$1',[f.seed.accountId]),true)).rejects.toMatchObject({code:'42501'});await f.unstarted();
  },20000);
  it('prepares without a provider validateInput method while retaining the afterPrepare boundary',async()=>{
    const f=await fixture();delete f.provider.validateInput;await expect(f.service().runOnce()).rejects.toBe(f.boundary);expect(f.events).toEqual(['PREPARE_HOOK','BASIS_PREPARED','AFTER_PREPARE']);expect(f.hook).toHaveBeenCalledOnce();expect(f.validate).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);await f.unstarted();
  },20000);
  it('keeps committed INPUT and the owning claim when preparation throws before any validation/START',async()=>{
    const f=await fixture(),error=Error('OWNED_PREPARATION_LOOKUP_IO_UNKNOWN');f.hook.mockImplementationOnce(async()=>{throw error;});const service=f.service();await expect(service.runOnce()).rejects.toBe(error);expect(await f.records('INPUT')).toHaveLength(1);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);expect(await f.request()).toMatchObject({state:'ACCEPTED',first_start_at:null,hold_reasons:[]});expect(await f.work()).toMatchObject({state:'CLAIMED',claim_owner:service.workerId});expect(f.validate).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(f.afterPrepare).not.toHaveBeenCalled();await f.unstarted();
  },20000);
  it('preserves real basis COMMIT on wrapper ACK error and reuses it after a new worker/catalog',async()=>{
    const f=await fixture(),error=Error('OWNED_BASIS_COMMIT_ACK_UNKNOWN'),transaction=worker.accountTransaction.bind(worker);let lost=false;
    const loseBasis:typeof worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{const value=await transaction(accountId,run,restricted);if(accountId===f.seed.accountId&&!lost&&value!==null&&typeof value==='object'&&'created'in value&&value.created===true&&'basis'in value){lost=true;throw error;}return value;};
    const first=f.service(),spy=vi.spyOn(worker,'accountTransaction').mockImplementation(loseBasis);try{await expect(first.runOnce()).rejects.toBe(error);}finally{spy.mockRestore();}
    expect(lost).toBe(true);const savedInputs=await f.records('INPUT'),savedBasis=await f.records('OPERATIONAL_COST_BASIS'),savedExecutions=await f.execution();expect(savedInputs).toHaveLength(1);expect(savedBasis).toHaveLength(1);expect(f.targets).toEqual([]);expect(f.validate).not.toHaveBeenCalled();expect(f.afterPrepare).not.toHaveBeenCalled();await f.unstarted();
    const next=structuredClone(f.catalog);next[0].snapshot!.basisVersion='owned-new-catalog-pg';next[0].snapshot!.components[0].usdPerUnit='9';f.replacePreparation(next);await admin.pool.query('UPDATE manga_web.work_items SET lease_until=$2 WHERE account_id=$1 AND kind=\'DISPATCH\'',[f.seed.accountId,new Date(now.valueOf()-1)]);f.advance(5001);f.events.length=0;const reopened=f.service();
    await expect(reopened.runOnce()).rejects.toBe(f.boundary);expect(f.hook).toHaveBeenCalledTimes(2);expect(f.hook.mock.calls[1][1].ownerId).toBe(reopened.workerId);expect(BigInt(f.hook.mock.calls[1][1].generation)).toBeGreaterThan(BigInt(f.hook.mock.calls[0][1].generation));expect(await f.records('INPUT')).toEqual(savedInputs);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(savedBasis);expect((await f.execution()).map(row=>row.execution_id)).toEqual(savedExecutions.map(row=>row.execution_id));expect(f.events).toEqual(['PREPARE_HOOK','BASIS_PREPARED','NATIVE_CONTEXT','VALIDATE_INPUT','AFTER_PREPARE']);await f.unstarted();
  },20000);
  it.each(['lease','new-worker','context-closed','stop','pointer','wait'] as const)('fences %s during the post-basis await without releasing a foreign claim or changing execution facts',async kind=>{
    const f=await fixture(),entered=deferred<boolean>(),gate=deferred<void>(),original=f.hook.getMockImplementation()!;f.hook.mockImplementationOnce(async(input,claim)=>{await original(input,claim);entered.resolve(true);await gate.promise;});const service=f.service(),pending=service.runOnce(),settled=pending.then(()=>false,()=>false);
    expect(await Promise.race([entered.promise,settled])).toBe(true);const savedInput=await f.records('INPUT'),savedBasis=await f.records('OPERATIONAL_COST_BASIS'),savedExecution=await f.execution(),savedWork=await f.work();let foreignOwner:string|null=null;
    try{
      if(kind==='lease')await admin.pool.query('UPDATE manga_web.work_items SET lease_until=$3 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,savedWork.work_item_id,new Date(now.valueOf()-1)]);
      if(kind==='new-worker'){foreignOwner=randomUUID();await admin.pool.query("UPDATE manga_web.work_items SET claim_generation=claim_generation+1,claim_owner=$3,lease_until=$4 WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,savedWork.work_item_id,foreignOwner,new Date(now.valueOf()+30000)]);}
      if(kind==='context-closed')await admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId,now]);
      if(kind==='stop')await admin.pool.query("UPDATE manga_web.processing_requests SET state='STOP_REQUESTED' WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.requestId]);
      if(kind==='pointer')await admin.pool.query('UPDATE manga_web.request_steps SET current_execution_id=NULL WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId]);
      if(kind==='wait')await admin.pool.query('INSERT INTO manga_web.provider_wait_rounds(account_id,wait_round_id,request_id,logical_step_id,linked_execution_id,started_at,deadline) VALUES($1,$2,$3,\'OCR\',$4,$5,$6)',[f.seed.accountId,randomUUID(),f.requestId,savedExecution[0].execution_id,new Date(now.valueOf()-600001),new Date(now.valueOf()-1)]);
    }finally{gate.resolve();}
    expect(await pending).toBe(true);expect(f.validate).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(f.afterPrepare).not.toHaveBeenCalled();expect(await f.records('INPUT')).toEqual(savedInput);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(savedBasis);expect(await f.execution()).toEqual(savedExecution);
    const current=await f.work();if(kind==='new-worker')expect(current).toMatchObject({state:'CLAIMED',claim_owner:foreignOwner,claim_generation:(BigInt(savedWork.claim_generation)+1n).toString()});else if(kind==='lease')expect(current).toMatchObject({state:'CLAIMED',claim_owner:service.workerId});else expect(current).toMatchObject({state:'READY',claim_owner:null,lease_until:null});await f.unstarted();
  },20000);
  it('propagates post-preparation INPUT tamper without FAILED, START or replacement basis',async()=>{
    const f=await fixture(),entered=deferred<boolean>(),gate=deferred<void>(),original=f.hook.getMockImplementation()!;f.hook.mockImplementationOnce(async(input,claim)=>{await original(input,claim);entered.resolve(true);await gate.promise;});const pending=f.service().runOnce(),settled=pending.then(()=>false,()=>false);expect(await Promise.race([entered.promise,settled])).toBe(true);
    const savedBasis=await f.records('OPERATIONAL_COST_BASIS'),savedExecution=await f.execution(),input=(await f.records('INPUT'))[0],tampered=structuredClone(input.protected_observation) as StageInput;tampered.width++;
    try{await admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,input.evidence_id,JSON.stringify(tampered)]);}finally{gate.resolve();}
    await expect(pending).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(savedBasis);expect(await f.execution()).toEqual(savedExecution);expect(await f.request()).toMatchObject({state:'ACCEPTED',first_start_at:null,hold_reasons:[]});expect((await f.work()).state).toBe('CLAIMED');expect(f.validate).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(f.afterPrepare).not.toHaveBeenCalled();await f.unstarted();
  },20000);
});
// C3 uses the real C2 preparation, cost and checkpoint journals. The whole-cost
// reader deliberately returns no facts. Only an empty OCR PRE attempt receives
// invented empty checkpoint facts; native facade/provider stay inert. This does
// not prove CLEANUP capture, nonempty checkpoint/native chains or C5 completion.
async function operationalFixture(options:{c4Started?:boolean}={}){
  const f=await fixture(),journal=f.journal(),preparation=new FullStageCostPreparation(journal,f.catalog,f.journalBounds.calculator);
  if(options.c4Started)f.afterPrepare.mockImplementation(async()=>{f.events.push('AFTER_PREPARE');});
  const reconciles=async()=>(await admin.pool.query<{work_item_id:string;operation_digest:string;target_ref:{executionId:string}}>("SELECT work_item_id,operation_digest,target_ref FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE' ORDER BY work_item_id",[f.seed.accountId])).rows;
  const committedInput=async(input:StageInput,claim:NativeJobClaim)=>{
    const saved=await f.records('INPUT');expect(saved).toHaveLength(1);expect(saved[0].protected_observation).toEqual(canonicalInput(input));expect(saved[0].evidence_digest).toBe(digest(canonicalInput(input)));
    expect(await f.execution()).toEqual([expect.objectContaining({execution_id:input.executionId,request_id:f.requestId,state:'PREPARED',input_digest:input.inputDigest,claim_generation:claim.generation,dispatch_attempted_at:null,start_confirmed_at:null,output_envelope:null})]);
    expect(await f.work()).toMatchObject({work_item_id:claim.workItemId,claim_generation:claim.generation,claim_owner:claim.ownerId,state:'CLAIMED'});
    expect(await reconciles()).toEqual([expect.objectContaining({operation_digest:digest({kind:'RECONCILE',executionId:input.executionId}),target_ref:{executionId:input.executionId}})]);
  };
  const originalPrepare=preparation.prepare.bind(preparation);
  const prepareBasis=vi.spyOn(preparation,'prepare').mockImplementation(async(input,claim)=>{
    await committedInput(input,claim);f.events.push('INPUT_RECONCILE_COMMITTED');
    const result=await originalPrepare(input,claim);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);f.events.push('BASIS_COMMITTED');return result;
  });
  const checkpoints=new CheckpointValidationJournal(worker,{maxRecordBytes:262144,maxRecords:64,maxTargets:4,maxJobs:32});
  const originalBegin=checkpoints.beginIn.bind(checkpoints),originalRecord=checkpoints.recordIn.bind(checkpoints);
  const begin=vi.spyOn(checkpoints,'beginIn').mockImplementation(async(tx,input,purpose)=>{
    if(options.c4Started&&purpose==='FINAL_COMMIT'){const attempt=await originalBegin(tx,input,purpose);expect(attempt.targets).toHaveLength(1);f.events.push('C4_FINAL_COMMIT_BEGIN');return attempt;}
    expect(purpose).toBe('PRE_DISPATCH');expect(f.hook).toHaveBeenCalledOnce();expect(f.targets).toEqual([]);
    const attempt=await originalBegin(tx,input,purpose);expect(attempt.targets).toEqual([]);f.events.push('PRE_DISPATCH_BEGIN');return attempt;
  });
  const record=vi.spyOn(checkpoints,'recordIn').mockImplementation(async(tx,input,attempt,facts)=>{
    const result=await originalRecord(tx,input,attempt,facts);expect(result.state).toBe('VERIFIED');f.events.push('PRE_DISPATCH_VERIFIED');return result;
  });
  const reader:OperationalStageCostReader={
    workSetIn:vi.fn(async()=>null),
    checkpointFactsIn:vi.fn(async(_tx,input,attempt)=>{
      // C4의 양성 owner 대조는 가짜 authority 통과까지이며 실제 FINAL 작업 증거는 제공하지 않는다.
      if(options.c4Started&&attempt.purpose==='FINAL_COMMIT'){expect(attempt.consumerExecutionId).toBe(input.executionId);f.events.push('C4_FINAL_FACTS_UNCONFIRMED');return null;}
      expect(attempt.consumerExecutionId).toBe(input.executionId);expect(attempt.inputFingerprint).toBe(digest(canonicalInput(input)));expect(attempt.targets).toEqual([]);expect(f.targets).toEqual([]);
      f.events.push('EMPTY_PRE_DISPATCH_FACTS');return {attemptId:attempt.attemptId,operations:[]};
    }),
  };
  const cost=new OperationalStageCost({db:worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:262144,maxRecords:64,maxSources:16,maxExecutions:32,maxInFlight:4}});
  const prepare=vi.spyOn(cost,'prepare');
  f.hook.mockImplementation(async(input,claim)=>{
    f.events.push('PREPARE_HOOK');
    expect(prepareBasis,'C3 workerOperationalCost must reach ExecutionService before the hook').toHaveBeenCalledOnce();
    await committedInput(input,claim);
    const view=await journal.lookup(input);expect(view.basis).not.toBeNull();expect(view.basis!.capture).toMatchObject({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input))});expect(view.basis!.snapshot).toEqual(f.snapshot);
    expect(prepare.mock.calls).toEqual([[input,claim]]);expect(prepareBasis.mock.calls).toEqual([[input,claim]]);expect(f.targets).toEqual([]);expect(f.validate).not.toHaveBeenCalled();expect(f.provider.calls).toEqual([]);
  });
  const noNewIo=async(reservation:'HELD'|'RELEASED_CONFIRMED'='HELD')=>{
    expect(f.validate).not.toHaveBeenCalled();expect(f.gateway.forTarget).not.toHaveBeenCalled();expect(f.targets).toEqual([]);expect(f.afterPrepare).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();expect(f.provider.lookups).toEqual([]);await f.unstarted(reservation);
  };
  return {...f,cost,checkpoints,reader,prepare,prepareBasis,begin,record,reconciles,noNewIo};
}

describe('C3 runtime cost preparation port',()=>{
  it.each(['worker','composed'] as const)('C3 forwards actual C2 cost through %s before hook, empty PRE and native INPUT',async mode=>{
    const f=await operationalFixture(),runtime=f.factory(mode,f.cost),failure=await runtime.tick().then(()=>null,error=>error);
    expect(f.prepareBasis,'C3 workerOperationalCost was not forwarded to ExecutionService').toHaveBeenCalledOnce();
    expect(failure).toBe(f.boundary);expect(runtime.execution.operationalCost===f.cost).toBe(true);
    expect(f.events).toEqual(['INPUT_RECONCILE_COMMITTED','BASIS_COMMITTED','PREPARE_HOOK','PRE_DISPATCH_BEGIN','EMPTY_PRE_DISPATCH_FACTS','PRE_DISPATCH_VERIFIED','NATIVE_CONTEXT','VALIDATE_INPUT','AFTER_PREPARE']);
    const [input,claim]=f.hook.mock.calls[0],savedInput=(await f.records('INPUT'))[0],savedBasis=(await f.records('OPERATIONAL_COST_BASIS'))[0];
    expect(claim.ownerId).toBe(runtime.execution.workerId);expect(f.targets).toEqual([expect.objectContaining({targetKind:'EXECUTION',targetId:input.executionId,sourceInput:{executionId:input.executionId,inputEvidenceId:savedInput.evidence_id,stageInputDigest:input.inputDigest},claim})]);
    const verified=await worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'PRE_DISPATCH'),true);
    expect(verified.state).toBe('VERIFIED');expect(verified.attempt).toMatchObject({purpose:'PRE_DISPATCH',consumerExecutionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),inputEvidenceId:savedInput.evidence_id,basisEvidenceId:savedBasis.evidence_id,claimGeneration:claim.generation,targets:[]});
    expect(await f.records('CHECKPOINT_VALIDATION_ATTEMPT')).toHaveLength(1);expect(await f.records('CHECKPOINT_VALIDATION_VERIFIED')).toHaveLength(1);expect(await f.records('CHECKPOINT_VALIDATION_OPERATION')).toEqual([]);
    expect(f.prepare).toHaveBeenCalledOnce();expect(f.begin).toHaveBeenCalledOnce();expect(f.record).toHaveBeenCalledOnce();expect(f.resource).not.toHaveBeenCalled();expect(f.provider.lookups).toEqual([]);await f.unstarted();
    runtime.stopClaims();await runtime.idle();
  },20000);
  it.each(['worker','composed'] as const)('C3 preserves original INPUT, BASIS and RECONCILE after actual cost preparation rejects through %s',async mode=>{
    const f=await operationalFixture(),error=Error('OWNED_C3_PREPARATION_AFTER_BASIS_UNKNOWN'),original=f.prepareBasis.getMockImplementation()!;
    f.prepareBasis.mockImplementationOnce(async(input,claim)=>{await original(input,claim);throw error;});
    const runtime=f.factory(mode,f.cost);await expect(runtime.tick()).rejects.toBe(error);
    const saved=await originalCostFacts(f);expect(saved.inputs).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.reconciles).toHaveLength(1);expect(saved.executions).toHaveLength(1);
    expect(f.events).toEqual(['INPUT_RECONCILE_COMMITTED','BASIS_COMMITTED']);expect(f.hook).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();expect(await f.records('CHECKPOINT_VALIDATION_ATTEMPT')).toEqual([]);
    expect(await f.request()).toMatchObject({state:'ACCEPTED',first_start_at:null,hold_reasons:[]});expect(await f.work()).toMatchObject({state:'CLAIMED',claim_owner:runtime.execution.workerId});
    await originalLookup(f,runtime,saved);expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();runtime.stopClaims();await runtime.idle();
  },20000);
  it.each(['worker','composed'] as const)('C3 preserves a real BASIS COMMIT ACK loss and reconciles the original execution through %s',async mode=>{
    const f=await operationalFixture(),error=Error('OWNED_C3_BASIS_COMMIT_ACK_UNKNOWN'),transaction=worker.accountTransaction.bind(worker);let lost=false;
    const acknowledgement:typeof worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{
      const value=await transaction(accountId,run,restricted);
      // The real restricted transaction has completed COMMIT before this
      // wrapper loses its acknowledgement. No fake SQL success is returned.
      if(accountId===f.seed.accountId&&!lost&&value!==null&&typeof value==='object'&&'created'in value&&value.created===true&&'basis'in value){lost=true;throw error;}return value;
    };
    const runtime=f.factory(mode,f.cost),spy=vi.spyOn(worker,'accountTransaction').mockImplementation(acknowledgement);
    try{await expect(runtime.tick()).rejects.toBe(error);}finally{spy.mockRestore();}
    expect(lost).toBe(true);const saved=await originalCostFacts(f);expect(saved.inputs).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.reconciles).toHaveLength(1);expect(saved.executions).toHaveLength(1);
    expect(f.events).toEqual(['INPUT_RECONCILE_COMMITTED']);expect(f.hook).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();expect(await f.request()).toMatchObject({state:'ACCEPTED',first_start_at:null,hold_reasons:[]});await f.noNewIo();
    runtime.stopClaims();await runtime.idle();f.advance(5001);
    const reopened=f.factory(mode,f.cost),lookup=vi.spyOn(reopened.execution,'reconciled');await reopened.tick();
    expect(lookup.mock.calls).toEqual([[f.seed.accountId,saved.executions[0].execution_id]]);
    await originalLookup(f,reopened,saved);expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();expect(f.hook).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();
    const readerInputs=vi.mocked(f.reader.workSetIn).mock.calls.map(([,input,basis])=>({executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),basisExecutionId:basis.capture.executionId}));
    expect(readerInputs.length).toBeGreaterThan(1);expect(readerInputs.every(input=>input.executionId===saved.executions[0].execution_id&&input.basisExecutionId===input.executionId&&input.inputFingerprint===saved.inputs[0].evidence_digest)).toBe(true);
    reopened.stopClaims();await reopened.idle();
  },20000);
  it.each((['worker','composed'] as const).flatMap(mode=>(['cancel','foreign-claim'] as const).map(kind=>[mode,kind] as const)))('C3 fences %s %s after BASIS before checkpoint/native I/O while keeping original cost facts',async(mode,kind)=>{
    const f=await operationalFixture(),entered=deferred<boolean>(),gate=deferred<void>(),original=f.hook.getMockImplementation()!;
    f.hook.mockImplementationOnce(async(input,claim)=>{await original(input,claim);entered.resolve(true);await gate.promise;});
    const runtime=f.factory(mode,f.cost),pending=runtime.tick(),settled=pending.then(()=>false,()=>false);
    expect(await Promise.race([entered.promise,settled])).toBe(true);
    const saved=await originalCostFacts(f),work=await f.work(),foreignOwner=randomUUID();
    try{
      if(kind==='cancel'){
        await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:f.requestId}}));
        expect(await f.request()).toMatchObject({state:'STOPPED',first_start_at:null,hold_reasons:[]});
      }else await admin.pool.query("UPDATE manga_web.work_items SET claim_generation=claim_generation+1,claim_owner=$3,lease_until=$4 WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,work.work_item_id,foreignOwner,new Date(now.valueOf()+30000)]);
    }finally{gate.resolve();}
    await pending;expect(f.events).toEqual(['INPUT_RECONCILE_COMMITTED','BASIS_COMMITTED','PREPARE_HOOK']);expect(f.begin).not.toHaveBeenCalled();expect(await f.records('CHECKPOINT_VALIDATION_ATTEMPT')).toEqual([]);
    const reservation=kind==='cancel'?'RELEASED_CONFIRMED':'HELD';await originalLookup(f,runtime,saved,reservation);
    if(kind==='foreign-claim')expect(await f.work()).toMatchObject({state:'CLAIMED',claim_owner:foreignOwner,claim_generation:(BigInt(work.claim_generation)+1n).toString()});
    else expect(await f.work()).toMatchObject({state:'READY',claim_owner:null,lease_until:null});
    expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();expect(f.hook).toHaveBeenCalledOnce();runtime.stopClaims();await runtime.idle();
  },20000);
  it.each(['worker','composed'] as const)('C3 keeps null checkpoint source facts at PRE WAIT through %s without native INPUT',async mode=>{
    const f=await operationalFixture();vi.mocked(f.reader.checkpointFactsIn).mockResolvedValueOnce(null);const runtime=f.factory(mode,f.cost);
    await runtime.tick();const saved=await originalCostFacts(f);expect(saved.inputs).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.reconciles).toHaveLength(1);
    expect(f.events).toEqual(['INPUT_RECONCILE_COMMITTED','BASIS_COMMITTED','PREPARE_HOOK','PRE_DISPATCH_BEGIN']);expect(f.record).not.toHaveBeenCalled();expect(await f.records('CHECKPOINT_VALIDATION_ATTEMPT')).toHaveLength(1);expect(await f.records('CHECKPOINT_VALIDATION_VERIFIED')).toEqual([]);expect(await f.records('CHECKPOINT_VALIDATION_OPERATION')).toEqual([]);
    const input=f.prepare.mock.calls[0][0],view=await worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'PRE_DISPATCH'),true);expect(view.state).toBe('WAIT');
    await originalLookup(f,runtime,saved);expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();expect(f.hook).toHaveBeenCalledOnce();runtime.stopClaims();await runtime.idle();
  },20000);
});

async function originalCostFacts(f:Awaited<ReturnType<typeof operationalFixture>>){
  return {inputs:await f.records('INPUT'),bases:await f.records('OPERATIONAL_COST_BASIS'),reconciles:await f.reconciles(),executions:await f.execution()};
}
async function originalLookup(f:Awaited<ReturnType<typeof operationalFixture>>,runtime:ReturnType<typeof f.factory>,saved:Awaited<ReturnType<typeof originalCostFacts>>,reservation:'HELD'|'RELEASED_CONFIRMED'='HELD'){
  expect(await runtime.execution.reconciled(f.seed.accountId,saved.executions[0].execution_id)).toBe(false);
  const input=f.prepare.mock.calls[0][0],view=await worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,input),true);
  expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(view.basis!.capture).toMatchObject({executionId:saved.executions[0].execution_id,inputFingerprint:saved.inputs[0].evidence_digest});
  expect(await originalCostFacts(f)).toEqual(saved);expect(await f.records('OPERATIONAL_COST_CALCULATION')).toEqual([]);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);await f.noNewIo(reservation);
}

// C4는 원 비용 확인 합류만 검증한다. 전체 reader의 null은 비용 확정이나 물리 실행 증거가 아니다.
describe('C4 original cost drain',()=>{
  it.each(['worker','composed'] as const)('C4 joins actual original cost pending before %s idle resolves',async mode=>{
    const f=await operationalFixture(),runtime=f.factory(mode,f.cost);
    await expect(runtime.tick()).rejects.toBe(f.boundary);
    const saved=await originalCostFacts(f),input=f.prepare.mock.calls[0][0],entered=deferred<boolean>(),gate=deferred<null>();
    expect(runtime.execution.operationalCost).toBe(f.cost);expect(saved.inputs).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.reconciles).toHaveLength(1);
    // constructor가 고정한 바로 그 mock 함수에 다음 호출만 지연을 설치한다.
    vi.mocked(f.reader.workSetIn).mockImplementationOnce(async(_tx,original,basis)=>{
      expect(canonicalInput(original)).toEqual(saved.inputs[0].protected_observation);expect(basis.capture.executionId).toBe(input.executionId);entered.resolve(true);return gate.promise;
    });
    const finishing=f.cost.finishAttempt(input),finished=vi.fn(),observed=finishing.then(()=>{finished();return false;},error=>{finished();throw error;}),idleComplete=vi.fn();let joining:Promise<void>|undefined;
    try{
      expect(await Promise.race([entered.promise,observed])).toBe(true);expect(finished).not.toHaveBeenCalled();
      runtime.stopClaims();joining=runtime.idle().then(()=>{idleComplete();});
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(finished).not.toHaveBeenCalled();expect(idleComplete,'C4 원 cost.finishAttempt가 pending인 동안 runtime.idle 성공은 0이어야 한다').not.toHaveBeenCalled();
    }finally{gate.resolve(null);await observed;await joining;}
    expect(finished).toHaveBeenCalledOnce();expect(idleComplete).toHaveBeenCalledOnce();expect(await originalCostFacts(f)).toEqual(saved);
    const view=await worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,input),true);
    expect(view).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});expect(view.basis!.capture.inputFingerprint).toBe(saved.inputs[0].evidence_digest);
    for(const kind of ['OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE'])expect(await f.records(kind)).toEqual([]);
    await runtime.tick();expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();expect(f.resource).not.toHaveBeenCalled();expect(f.provider.lookups).toEqual([]);await f.unstarted();
  },20000);
});
type C4OwnerTuple=Readonly<{ownerSessionId:string|null;ownerTabId:string|null;ownerRevision:string}>;
async function c4StartedFixture(mode:'worker'|'composed'){
  const f=await operationalFixture({c4Started:true}),entered=deferred<StageInput>(),reply=deferred<Observation>();
  // FINAL 대조에 필요한 합성 자산 메타데이터만 완성한다. 실제 객체 읽기나 native 작업은 없다.
  await admin.pool.query("UPDATE manga_web.assets SET object_key=account_id::text||'/'||asset_id::text,object_created_at=$2,verified_at=$2 WHERE account_id=$1",[f.seed.accountId,now]);
  const authorityReader=vi.fn(async():Promise<C4OwnerTuple>=>worker.accountTransaction(f.seed.accountId,async tx=>{
    const context=await contextRow(tx,f.seed.contextId);return Object.freeze({ownerSessionId:context.owner_session_id,ownerTabId:context.owner_tab_id,ownerRevision:context.owner_revision});
  },true));
  const sealed=new Map<string,{inputFingerprint:string;owner:C4OwnerTuple}>(),decisions:{accepted:boolean;reason:'OWNER_TUPLE_MATCH'|'OWNER_TUPLE_MISMATCH';original:C4OwnerTuple;current:C4OwnerTuple}[]=[],originalValidate=f.validate.getMockImplementation()!;
  f.validate.mockImplementation(async(input,context)=>{
    await originalValidate(input,context);const owner=await authorityReader(),target=f.targets.at(-1)!;
    expect(target.protectedOwnerCapture).toMatchObject(owner);expect(await f.records('INPUT')).toHaveLength(1);
    sealed.set(input.executionId,Object.freeze({inputFingerprint:digest(canonicalInput(input)),owner}));
  });
  // 명시한 가짜 authority reader다. 제품 validated()가 이 포트를 호출할 때만 owner를 판정한다.
  const authority=vi.fn<NonNullable<ProviderAdapter['validateObservation']>>(async(input,_observation,context)=>{
    expect(context).toBeDefined();const original=sealed.get(input.executionId)!;expect(original.inputFingerprint).toBe(digest(canonicalInput(input)));
    const current=await authorityReader(),accepted=digest(original.owner)===digest(current);decisions.push({accepted,reason:accepted?'OWNER_TUPLE_MATCH':'OWNER_TUPLE_MISMATCH',original:original.owner,current});
    if(!accepted)throw new NativeJobError('NATIVE_PARENT_FENCE_REJECTED',409,'WAIT',{jobId:randomUUID(),inputDigest:input.inputDigest,profileDigest:f.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'NO_CHILD_CREATED'});
  });
  f.provider.validateObservation=authority;
  const dispatch=vi.spyOn(f.provider,'dispatch').mockImplementation(async(input,started)=>{
    f.provider.calls.push(structuredClone(input));await started(randomUUID());entered.resolve(structuredClone(input));
    const observation=await reply.promise;f.provider.observations.set(input.executionId,structuredClone(observation));return observation;
  });
  const runtime=f.factory(mode,f.cost),pending=runtime.tick(),completion=pending.then(()=>null,error=>error);
  const reached=await Promise.race([entered.promise,completion]);expect(reached).toMatchObject({executionId:expect.any(String)});const input=await entered.promise;
  const fallback:Observation={evidenceId:randomUUID(),outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'C4_FAKE_REPLY_UNKNOWN',providerRef:input.executionId,data:null};
  return {...f,runtime,input,reply,completion,fallback,dispatch,authority,authorityReader,sealed,decisions};
}
async function c4CurrentView(f:Awaited<ReturnType<typeof operationalFixture>>){
  return (await admin.pool.query('SELECT c.owner_session_id,c.owner_tab_id,c.owner_revision,c.workspace_revision,c.generation,c.lifecycle,p.current_result_id,p.result_revision,p.revision FROM manga_web.workspace_contexts c JOIN manga_web.workspace_pages p USING(account_id,context_id) WHERE c.account_id=$1 AND c.context_id=$2 AND p.page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]])).rows[0];
}
async function c4OriginalStartedFacts(f:Awaited<ReturnType<typeof c4StartedFixture>>,saved:Awaited<ReturnType<typeof originalCostFacts>>){
  expect(await f.records('INPUT')).toEqual(saved.inputs);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(saved.bases);expect(await f.reconciles()).toEqual(saved.reconciles);
  expect(await f.execution()).toEqual([expect.objectContaining({execution_id:f.input.executionId,request_id:f.requestId,input_digest:f.input.inputDigest,dispatch_attempted_at:expect.any(Date),start_confirmed_at:expect.any(Date)})]);
  expect(await f.records('START')).toHaveLength(1);expect(await f.records('STALE_START')).toEqual([]);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.provider.calls).toEqual([f.input]);
  expect((await admin.pool.query('SELECT execution_id,unit_count FROM manga_web.free_starts WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{execution_id:f.input.executionId,unit_count:1}]);
  expect((await admin.pool.query('SELECT free_started_count FROM manga_web.accounts WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{free_started_count:1}]);expect((await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{state:'CONVERTED'}]);
  expect((await admin.pool.query('SELECT execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{execution_id:f.input.executionId,component:'STAGE_TOTAL',ordinal:0,state:'UNCONFIRMED',actual_usd:null,usage_ref:null,rate_version:null,confirmed_at:null,evidence_conflict:false}]);
  const view=await worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.input),true);expect(view).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});expect(view.basis!.capture.inputFingerprint).toBe(saved.inputs[0].evidence_digest);
  for(const kind of ['OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE'])expect(await f.records(kind)).toEqual([]);
  for(const table of ['settlements','ledger_entries','result_applications','native_job_intents','native_job_go_consumptions','native_job_observations'])expect((await admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(0);
  expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepareBasis).toHaveBeenCalledOnce();expect(f.hook).toHaveBeenCalledOnce();expect(f.afterPrepare).toHaveBeenCalledOnce();expect(f.resource).not.toHaveBeenCalled();
}

describe('C4 started original cancellation and owner facts',()=>{
  it.each(['worker','composed'] as const)('C4 preserves started REQUEST_STOP, UNKNOWN and late original cost through %s restart RECONCILE without redispatch',async mode=>{
    const f=await c4StartedFixture(mode),saved=await originalCostFacts(f),current=await c4CurrentView(f);let reopened:ReturnType<typeof f.factory>|undefined;
    try{
      expect(await f.request()).toMatchObject({first_start_at:expect.any(Date)});await c4OriginalStartedFacts(f,saved);
      await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:f.requestId}}));
      expect(await f.request()).toMatchObject({state:'STOP_REQUESTED',first_start_at:expect.any(Date)});expect(f.authority).not.toHaveBeenCalled();
      f.reply.resolve(f.fallback);expect(await f.completion).toBeNull();expect((await f.execution())[0]).toMatchObject({state:'UNKNOWN',output_envelope:normalizeObservation(f.input,f.fallback)});
      await c4OriginalStartedFacts(f,saved);f.runtime.stopClaims();await f.runtime.idle();
      // 원 provider의 늦은 보고만 바꾼다. 새 runtime은 원 RECONCILE에서 normalize→observe를 실행한다.
      const late:Observation={...f.fallback,evidenceId:randomUUID(),costUsd:'0.024000000000',usageConfirmed:true,finishReason:'C4_LATE_FAKE_PROVIDER_USAGE'};
      f.provider.observations.set(f.input.executionId,structuredClone(late));f.advance(5001);reopened=f.factory(mode,f.cost);
      const lookup=vi.spyOn(f.provider,'lookup'),observe=vi.spyOn(reopened.execution,'observe'),validated=vi.spyOn(reopened.execution,'validated'),reconcile=vi.spyOn(reopened.execution,'reconciled');
      for(let attempt=0;attempt<3&&!lookup.mock.calls.length;attempt++)await reopened.tick();
      expect(lookup.mock.calls.map(([executionId])=>executionId)).toEqual([f.input.executionId]);expect(validated).toHaveBeenCalledWith(expect.objectContaining({executionId:f.input.executionId,inputDigest:f.input.inputDigest}),late,expect.objectContaining({kind:'RECONCILE',ref:{executionId:f.input.executionId}}));
      expect(observe).toHaveBeenCalledWith(f.seed.accountId,f.input.executionId,normalizeObservation(f.input,late),false,expect.objectContaining({kind:'RECONCILE',ref:{executionId:f.input.executionId}}));expect(reconcile).toHaveBeenCalledWith(f.seed.accountId,f.input.executionId);
      const outcomes=[...await f.records('OUTCOME'),...await f.records('STALE_OUTCOME')];expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({protected_observation:normalizeObservation(f.input,late)})]));
      expect((await f.execution())[0]).toMatchObject({state:'UNKNOWN',output_envelope:normalizeObservation(f.input,late)});expect(await f.request()).toMatchObject({state:'STOP_REQUESTED',first_start_at:expect.any(Date)});
      expect(f.authority).not.toHaveBeenCalled();expect(await c4CurrentView(f)).toEqual(current);await c4OriginalStartedFacts(f,saved);expect(await f.records('NATIVE_VALIDATION_WAIT')).toEqual([]);
    }finally{f.reply.resolve(f.fallback);await f.completion;f.runtime.stopClaims();await f.runtime.idle();reopened?.stopClaims();await reopened?.idle();}
  },20000);
  it.each((['worker','composed'] as const).flatMap(mode=>(['unchanged','handoff'] as const).map(owner=>[mode,owner] as const)))('C4 validates original owner through %s %s authority and preserves raw known cost',async(mode,owner)=>{
    const f=await c4StartedFixture(mode),saved=await originalCostFacts(f),original=f.sealed.get(f.input.executionId)!,validated=vi.spyOn(f.runtime.execution,'validated');
    const raw:Observation={...f.provider.success(f.input),costUsd:'0.031000000000',finishReason:'C4_FAKE_KNOWN_PROVIDER_SUCCESS'};
    try{
      expect(f.authority).not.toHaveBeenCalled();expect(f.authorityReader).toHaveBeenCalledOnce();
      if(owner==='handoff'){
        const tabId=randomUUID(),actor={...f.actor,tabId,ownerCapability:null},command=await f.command({kind:'HANDOFF',payload:{newTabId:tabId}});command.target.tabId=tabId;
        const transfer=await f.workspace.handle(actor,command);expect(transfer.ownerCapability).toEqual(expect.any(String));
        expect(await f.authorityReader()).toEqual({ownerSessionId:original.owner.ownerSessionId,ownerTabId:tabId,ownerRevision:(BigInt(original.owner.ownerRevision)+1n).toString()});
      }
      const current=await c4CurrentView(f);f.reply.resolve(raw);expect(await f.completion).toBeNull();
      expect(validated).toHaveBeenCalledWith(f.input,raw,expect.objectContaining({kind:'DISPATCH',ref:{requestId:f.requestId}}));expect(f.authority.mock.calls[0]).toEqual([f.input,raw,expect.any(Object)]);expect(f.authorityReader.mock.calls.length).toBeGreaterThan(1);
      const normalized=await validated.mock.results[0].value;expect(normalized).toMatchObject({outcome:owner==='handoff'?'UNKNOWN':'SUCCESS',started:true,costUsd:raw.costUsd,usageConfirmed:true});
      if(owner==='handoff'){
        await expect(f.authority.mock.results[0].value).rejects.toMatchObject({code:'NATIVE_PARENT_FENCE_REJECTED',nextAction:'WAIT'});
        expect(f.decisions).toEqual([{accepted:false,reason:'OWNER_TUPLE_MISMATCH',original:original.owner,current:{ownerSessionId:current.owner_session_id,ownerTabId:current.owner_tab_id,ownerRevision:current.owner_revision}}]);
        const sources=await f.records('NATIVE_VALIDATION_SOURCE');expect(sources).toHaveLength(1);expect(sources[0]).toMatchObject({evidence_digest:digest(raw),protected_observation:raw});
        expect(await f.records('NATIVE_VALIDATION_WAIT')).toEqual([expect.objectContaining({protected_observation:expect.objectContaining({phase:'VALIDATION',originExecutionId:f.input.executionId,inputFingerprint:digest(canonicalInput(f.input)),errorCode:'NATIVE_PARENT_FENCE_REJECTED',knownObservationDigest:digest(raw),knownObservationRef:sources[0].evidence_id})})]);
        expect(await f.request()).toMatchObject({state:'WAITING',hold_reasons:expect.arrayContaining(['NATIVE_EXECUTION_UNCONFIRMED'])});expect((await f.execution())[0]).toMatchObject({state:'UNKNOWN',output_envelope:expect.objectContaining({providerOutcome:'SUCCESS',costUsd:raw.costUsd,usageConfirmed:true,data:null})});
        expect((await admin.pool.query('SELECT checkpoint_id FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([]);
      }else{
        expect(f.decisions.length).toBeGreaterThan(0);expect(f.decisions.every(decision=>decision.accepted&&decision.reason==='OWNER_TUPLE_MATCH')).toBe(true);for(const result of f.authority.mock.results)await expect(result.value).resolves.toBeUndefined();
        expect((await f.execution())[0]).toMatchObject({state:'SUCCEEDED',output_envelope:expect.objectContaining({outcome:'SUCCESS',costUsd:raw.costUsd,usageConfirmed:true})});expect(await f.records('NATIVE_VALIDATION_WAIT')).toEqual([]);expect(await f.records('NATIVE_VALIDATION_SOURCE')).toEqual([]);
        expect((await admin.pool.query('SELECT execution_id FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{execution_id:f.input.executionId}]);expect(f.events).toContain('C4_FINAL_FACTS_UNCONFIRMED');
      }
      const outcomes=[...await f.records('OUTCOME'),...await f.records('STALE_OUTCOME')];expect(outcomes).toEqual([expect.objectContaining({protected_observation:expect.objectContaining({costUsd:raw.costUsd,usageConfirmed:true,started:true})})]);
      expect(await c4CurrentView(f)).toEqual(current);await c4OriginalStartedFacts(f,saved);
    }finally{f.reply.resolve(f.fallback);await f.completion;f.runtime.stopClaims();await f.runtime.idle();}
  },20000);
});

import {createB3WindowsExecutionFixture,guardWindowsNativeIo} from '../fixtures/windows-native.js';

describe('B3-A 실제 Windows 실행 등록',()=>{
  it('B3-A 최초 authorize가 원 INPUT과 enrollment를 같은 거래에 저장한다',async()=>{
    const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof createB3WindowsExecutionFixture>>|undefined;
    try{
      f=await createB3WindowsExecutionFixture();const claim=await f.service.claim();expect(claim?.kind).toBe('DISPATCH');
      const input=await f.service.authorize(claim!);expect(input).not.toBeNull();
      const inputs=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,xmin::text AS input_xmin FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[f.seed.accountId,input!.executionId])).rows;
      const enrollments=(await f.admin.pool.query('SELECT input_evidence_id,input_fingerprint,input_xact::text FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,input!.executionId])).rows;
      expect(inputs).toHaveLength(1);console.info(JSON.stringify({b3aAuthorize:{inputCount:inputs.length,enrollmentCount:enrollments.length,inputEvidenceId:inputs[0].evidence_id}}));
      expect(enrollments).toHaveLength(1);expect(enrollments[0]).toEqual({input_evidence_id:inputs[0].evidence_id,input_fingerprint:inputs[0].evidence_digest,input_xact:inputs[0].input_xmin});const replay=await f.service.authorize(claim!);expect(canonicalInput(replay!)).toEqual(canonicalInput(input!));expect((await f.admin.pool.query('SELECT evidence_id,evidence_digest FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1',[f.seed.accountId])).rows).toHaveLength(1);
      expect(f.objectIo).toEqual({get:0,put:0});expect(f.provider.calls).toEqual([]);expect(f.remote.host).toBeUndefined();
    }finally{try{await f?.close();}finally{console.info(JSON.stringify({b3aGuard:{denied:guard.denied,realNativeChildCalls:guard.denied.filter(kind=>kind==='PROCESS'||kind==='WIN32_NATIVE_ADDON').length,externalApiModelCalls:guard.denied.filter(kind=>['NETWORK','HTTP','TLS','FETCH'].includes(kind)).length}}));guard.restore();expect(guard.denied).toEqual([]);}}
  },30000);
});

type B3Fixture=Awaited<ReturnType<typeof createB3WindowsExecutionFixture>>;
type B3Stage='INPUT'|'BASIS'|'ROOT';
async function b3Case(run:(f:B3Fixture)=>Promise<void>){
  const guard=guardWindowsNativeIo();let f:B3Fixture|undefined;
  try{f=await createB3WindowsExecutionFixture();await run(f);}
  finally{try{await f?.close();}finally{const denied=[...guard.denied];guard.restore();console.info(JSON.stringify({b3aGuard:{denied,realNativeChildCalls:denied.filter(kind=>kind==='PROCESS'||kind==='WIN32_NATIVE_ADDON').length,externalApiModelCalls:denied.filter(kind=>['NETWORK','HTTP','TLS','FETCH'].includes(kind)).length}}));expect(denied).toEqual([]);}}
}
async function b3Facts(f:B3Fixture){
  const account=f.seed.accountId;
  const inputs=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation,xmin::text AS input_xmin FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' ORDER BY evidence_id",[account])).rows;
  const bases=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_BASIS' ORDER BY evidence_id",[account])).rows;
  const enrollments=(await f.admin.pool.query('SELECT input_evidence_id,input_fingerprint,input_xact::text,evidence_id,evidence_digest,created_at FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 ORDER BY evidence_id',[account])).rows;
  const roots=(await f.admin.pool.query('SELECT execution_id,owner_identity,components,evidence_id,evidence_digest,created_at FROM manga_web.windows_native_cost_roots WHERE account_id=$1 ORDER BY evidence_id',[account])).rows;
  return {inputs,bases,enrollments,roots};
}
async function b3NoNative(f:B3Fixture){
  expect(f.objectIo).toEqual({get:0,put:0});expect(f.provider.calls).toEqual([]);expect(f.provider.lookups).toEqual([]);expect(f.remote.host).toBeUndefined();
  for(const table of ['native_job_intents','native_job_go_consumptions','native_job_observations','windows_native_cost_scopes','windows_native_cost_calls','windows_native_cost_io_starts','windows_native_cost_io_ends']){
    expect((await f.admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(0);
  }
  expect((await f.admin.pool.query("SELECT kind FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN ('START','STALE_START','OUTCOME','STALE_OUTCOME','OPERATIONAL_COST_CLOSURE','OPERATIONAL_COST_CALCULATION')",[f.seed.accountId])).rows).toEqual([]);
}
function b3Service(f:B3Fixture,hooks:ConstructorParameters<typeof ExecutionService>[3]={}){return new ExecutionService(f.worker,f.provider,f.requestPolicy,hooks,f.gateway,f.operationalCost);}
function b3TransactionFault(f:B3Fixture,stage:B3Stage,actions:{before?:(tx:Transaction)=>Promise<void>;after?:()=>Promise<void>;repeat?:boolean}){
  const transaction=f.worker.accountTransaction.bind(f.worker);let hits=0;
  const call:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{
    let hit=false;const result=await transaction(accountId,async tx=>{
      let rootReturned=false;
      const query=tx.client.query,observer=stage==='ROOT'?vi.spyOn(tx.client,'query').mockImplementation((...args)=>{
        const result:unknown=Reflect.apply(query,tx.client,args);
        if(typeof args[0]==='string'&&args[0].includes('manga_web.windows_native_cost_activate('))return (result as Promise<{rows:{value:unknown}[]}>).then(value=>{if(value.rows[0]?.value!==null&&value.rows[0]?.value!==undefined)rootReturned=true;return value;});
        return result;
      }):undefined;
      let value:T;try{value=await run(tx);}finally{observer?.mockRestore();}
      if(accountId===f.seed.accountId&&(actions.repeat||hits===0)){
        if(stage==='ROOT'){if(rootReturned){hits++;hit=true;await actions.before?.(tx);}}
        else{
          const sql="SELECT 1 FROM manga_web.execution_evidence WHERE account_id=$1 AND kind=$2 AND xmin::text=pg_current_xact_id()::text";
          const rows=await tx.client.query(sql,[accountId,stage==='INPUT'?'INPUT':'OPERATIONAL_COST_BASIS']);
          if(rows.rowCount){hits++;hit=true;await actions.before?.(tx);}
        }
      }
      return value;
    },restricted);
    if(hit)await actions.after?.();return result;
  };
  const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(call);return {spy,get hits(){return hits;}};
}
async function b3ClaimView(f:B3Fixture,claim:{workId:string}){
  return (await f.admin.pool.query<{work_item_id:string;state:string;claim_owner:string|null;claim_generation:string;lease_until:Date|null}>('SELECT work_item_id,state,claim_owner,claim_generation,lease_until FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim.workId])).rows[0];
}

describe('B3-A 실제 준비와 ACK 경계',()=>{
  it('B3-A BASIS와 root ACK 뒤 실제 INPUT native facade를 연결한다',async()=>b3Case(async f=>{
    const boundary=Error('B3_A_입력_준비_후_경계'),order:string[]=[],provider:ProviderAdapter=f.provider;
    const prepare=f.operationalCost.prepare.bind(f.operationalCost);
    vi.spyOn(f.operationalCost,'prepare').mockImplementation(async(input,claim)=>{
      const before=await b3Facts(f);expect(before.inputs).toHaveLength(1);expect(before.enrollments).toHaveLength(1);expect(before.bases).toEqual([]);expect(before.roots).toEqual([]);order.push('INPUT_ENROLLED');
      await prepare(input,claim);const after=await b3Facts(f);expect(after.bases).toHaveLength(1);expect(after.roots).toEqual([]);order.push('BASIS_ACK');
    });
    const service=b3Service(f,{beforeValidateInput:async(input,claim)=>{
      const saved=await b3Facts(f);expect(saved.roots).toHaveLength(1);expect(saved.roots[0].owner_identity).toMatchObject({executionId:input.executionId,inputEvidenceId:saved.inputs[0].evidence_id,inputFingerprint:saved.inputs[0].evidence_digest,basisRef:{evidenceId:saved.bases[0].evidence_id,evidenceDigest:saved.bases[0].evidence_digest}});
      const owner={...saved.roots[0].owner_identity,claim,validationAttemptRef:null};const replay=await f.worker.accountTransaction(f.seed.accountId,tx=>f.costs.activateRootIn(tx,owner,f.components));expect(replay).toEqual({evidenceId:saved.roots[0].evidence_id,evidenceDigest:saved.roots[0].evidence_digest});expect(await b3Facts(f)).toEqual(saved);expect(claim.ownerId).toBe(service.workerId);expect(saved.roots[0].components).toEqual([{task:'DECODE_IMAGE',componentId:'native-image'}]);await b3NoNative(f);order.push('ROOT_ACK');
    },afterPrepare:async()=>{order.push('AFTER_PREPARE');throw boundary;}});
    provider.validateInput=async(_input,context)=>{expect(context?.native).toBeDefined();order.push('NATIVE_INPUT');const {ownedNativePng}=await import('../fixtures/native-images.js');const image=await context!.native.decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile);expect(image).toMatchObject({width:1,height:1});};
    await expect(service.runOnce()).rejects.toBe(boundary);expect(order).toEqual(['INPUT_ENROLLED','BASIS_ACK','ROOT_ACK','NATIVE_INPUT','AFTER_PREPARE']);
    const saved=await b3Facts(f);expect(saved.inputs).toHaveLength(1);expect(saved.enrollments).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.roots).toHaveLength(1);
    expect((await f.admin.pool.query("SELECT protected_scope->>'phase' AS phase,protected_scope FROM manga_web.windows_native_cost_scopes WHERE account_id=$1",[f.seed.accountId])).rows).toEqual([expect.objectContaining({phase:'INPUT',protected_scope:expect.objectContaining({owner:expect.objectContaining({claim:expect.objectContaining({ownerId:service.workerId})})})})]);
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(1);expect(f.objectIo.get).toBeGreaterThan(0);expect(f.objectIo.put).toBeGreaterThan(0);expect(f.provider.calls).toEqual([]);
    const input=saved.inputs[0].protected_observation as StageInput,view=await f.worker.accountTransaction(f.seed.accountId,tx=>f.operationalCost.readIn(tx,input),true);expect(view).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});expect(view.basis!.snapshot).toEqual(f.snapshot);
  }),30000);
  it('B3-A enrollment 뒤 같은 거래의 실패는 INPUT과 등록을 함께 되돌린다',async()=>b3Case(async f=>{
    const error=Error('B3_A_등록_거래_롤백'),fault=b3TransactionFault(f,'INPUT',{before:async()=>{throw error;}});
    try{await expect(f.service.runOnce()).rejects.toBe(error);}finally{fault.spy.mockRestore();}
    expect(fault.hits).toBe(1);expect(await b3Facts(f)).toEqual({inputs:[],bases:[],enrollments:[],roots:[]});await b3NoNative(f);
  }),20000);
  it.each(['INPUT','BASIS','ROOT'] as const)('B3-A %s COMMIT 뒤 ACK 유실은 원 자료와 시각을 보존하고 후속 I/O를 막는다',async stage=>b3Case(async f=>{
    const error=Error('B3_A_'+stage+'_ACK_미확정'),hook=vi.fn(async()=>{}),service=b3Service(f,{beforeValidateInput:hook}),fault=b3TransactionFault(f,stage,{after:async()=>{throw error;}});
    try{await expect(service.runOnce()).rejects.toBe(error);}finally{fault.spy.mockRestore();}
    expect(fault.hits).toBe(1);expect(hook).not.toHaveBeenCalled();const saved=await b3Facts(f);expect(saved.inputs).toHaveLength(1);expect(saved.enrollments).toHaveLength(1);expect(saved.bases).toHaveLength(stage==='INPUT'?0:1);expect(saved.roots).toHaveLength(stage==='ROOT'?1:0);await b3NoNative(f);
    const input=saved.inputs[0].protected_observation as StageInput;
    const enrolled=await f.worker.accountTransaction(f.seed.accountId,tx=>f.costs.enrollInputIn(tx,{evidenceId:saved.inputs[0].evidence_id,evidenceDigest:saved.inputs[0].evidence_digest}));expect(enrolled).toEqual({evidenceId:saved.enrollments[0].evidence_id,evidenceDigest:saved.enrollments[0].evidence_digest});
    if(stage!=='INPUT')expect((await f.journal.lookup(input)).basis?.snapshot).toEqual(f.snapshot);
    expect(await b3Facts(f)).toEqual(saved);await b3NoNative(f);
  }),20000);
  it.each((['INPUT','BASIS','ROOT'] as const).flatMap(stage=>(['42501','40001','40P01'] as const).map(code=>[stage,code] as const)))('B3-A %s 거래의 실제 SQL %s를 WAIT나 입력 실패로 바꾸지 않고 롤백한다',async(stage,code)=>b3Case(async f=>{
    const fault=b3TransactionFault(f,stage,{repeat:true,before:async tx=>{await tx.client.query("DO $b3$ BEGIN RAISE EXCEPTION USING ERRCODE='"+code+"',MESSAGE='B3_A_SQL_오류'; END $b3$");}});
    try{await expect(f.service.runOnce()).rejects.toMatchObject({code});}finally{fault.spy.mockRestore();}
    expect(fault.hits).toBe(code==='42501'?1:3);const saved=await b3Facts(f);expect(saved.inputs).toHaveLength(stage==='INPUT'?0:1);expect(saved.enrollments).toHaveLength(stage==='INPUT'?0:1);expect(saved.bases).toHaveLength(stage==='ROOT'?1:0);expect(saved.roots).toEqual([]);await b3NoNative(f);
  }),20000);
  it('B3-A 과거 미등록 INPUT은 다시 저장하거나 후등록하지 않는다',async()=>b3Case(async f=>{
    const legacy=new ExecutionService(f.worker,f.provider,f.requestPolicy),claim=await legacy.claim();expect(claim?.kind).toBe('DISPATCH');const input=await legacy.authorize(claim!);expect(input).not.toBeNull();
    const saved=await b3Facts(f);expect(saved.inputs).toHaveLength(1);expect(saved.enrollments).toEqual([]);
    const late=await f.worker.accountTransaction(f.seed.accountId,tx=>f.costs.enrollInputIn(tx,{evidenceId:saved.inputs[0].evidence_id,evidenceDigest:saved.inputs[0].evidence_digest}));expect(late).toBeNull();
    const nativeClaim={generation:claim!.generation,ownerId:legacy.workerId,workItemId:claim!.workId};await f.operationalCost.prepare(input!,nativeClaim);
    await legacy.finish(claim!,false);const service=b3Service(f),current=await service.claim();expect(current?.kind).toBe('DISPATCH');expect(BigInt(current!.generation)).toBeGreaterThan(BigInt(claim!.generation));
    await expect(service.authorize(current!)).rejects.toMatchObject({nextAction:'WAIT'});const after=await b3Facts(f);expect(after.inputs).toEqual(saved.inputs);expect(after.enrollments).toEqual([]);expect(after.roots).toEqual([]);expect(after.bases).toHaveLength(1);await b3NoNative(f);
  }),20000);
});

describe('B3-A 현재 권한과 원 claim 수명',()=>{
  it.each(['owner','generation','lease','context','revision'] as const)('B3-A 준비 대기의 %s 권한 결손은 root와 새 native I/O 전에 거부한다',async kind=>b3Case(async f=>{
    const entered=deferred<StageInput>(),gate=deferred<void>(),prepare=f.operationalCost.prepare.bind(f.operationalCost),hook=vi.fn(async()=>{}),service=b3Service(f,{beforeValidateInput:hook});
    vi.spyOn(f.operationalCost,'prepare').mockImplementation(async(input,claim)=>{await prepare(input,claim);entered.resolve(input);await gate.promise;});
    const pending=service.runOnce(),completion=pending.then(()=>null,error=>error);let saved:Awaited<ReturnType<typeof b3Facts>>|undefined;
    try{
      const input=await Promise.race([entered.promise,completion.then(error=>{throw error??Error('B3_A_준비_조기_종료');})]);saved=await b3Facts(f);expect(saved.enrollments).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.roots).toEqual([]);
      if(kind==='owner')await f.admin.pool.query('UPDATE manga_web.work_items SET claim_owner=$2 WHERE account_id=$1 AND kind=\'DISPATCH\'',[f.seed.accountId,randomUUID()]);
      if(kind==='generation')await f.admin.pool.query('UPDATE manga_web.work_items SET claim_generation=claim_generation+1 WHERE account_id=$1 AND kind=\'DISPATCH\'',[f.seed.accountId]);
      if(kind==='lease')await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND kind='DISPATCH'",[f.seed.accountId]);
      if(kind==='context')await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
      if(kind==='revision')await f.admin.pool.query('UPDATE manga_web.workspace_pages SET result_revision=result_revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]]);
      expect(input.executionId).toBe(saved.inputs[0].protected_observation.executionId);
    }finally{gate.resolve();}
    const error=await completion;expect(error).toMatchObject({nextAction:'WAIT'});expect(hook).not.toHaveBeenCalled();expect(await b3Facts(f)).toEqual(saved);await b3NoNative(f);
  }),20000);
  it('B3-A 준비 pending 동안 실제 두 client에서 같은 claim을 갱신하고 stop idle이 합류한다',async()=>b3Case(async f=>{
    const entered=deferred<{input:StageInput;claim:NativeJobClaim}>(),gate=deferred<void>(),renewed=deferred<{claim:import('../../packages/domain/src/execution.js').Claim;lease:Date}>(),boundary=Error('B3_A_준비_후_중단');
    const prepare=f.operationalCost.prepare.bind(f.operationalCost);vi.spyOn(f.operationalCost,'prepare').mockImplementation(async(input,claim)=>{entered.resolve({input,claim});await gate.promise;await prepare(input,claim);});
    const options:WorkerRuntimeOptions={worker:f.worker,objects:f.files,fonts:{catalog:{version:'b3a-fixed-font',fonts:[]},bytes:new Map()} as unknown as FontCatalog,profile:syntheticProfile,policy:f.requestPolicy,provider:f.provider,workerNative:f.gateway,workerOperationalCost:f.operationalCost,workerExecutionHooks:{heartbeatMilliseconds:25,afterPrepare:async()=>{throw boundary;}}};
    const runtime=createWorkerRuntime(options),renew=runtime.execution.renew.bind(runtime.execution),seen:import('../../packages/domain/src/execution.js').Claim[]=[];
    vi.spyOn(runtime.execution,'renew').mockImplementation(async claim=>{const result=await renew(claim);seen.push(claim);const current=await b3ClaimView(f,claim);expect(result).toBe(true);expect(current).toMatchObject({work_item_id:claim.workId,state:'CLAIMED',claim_owner:runtime.execution.workerId,claim_generation:claim.generation});renewed.resolve({claim,lease:current.lease_until!});return result;});
    const pending=runtime.tick(),completion=pending.then(()=>null,error=>error);let joining:Promise<unknown>|undefined;let idleDone=false;
    try{
      const input=await Promise.race([entered.promise,completion.then(error=>{throw error??Error('B3_A_준비_조기_종료');})]);const original=(await f.admin.pool.query('SELECT work_item_id,lease_until FROM manga_web.work_items WHERE account_id=$1 AND kind=\'DISPATCH\'',[f.seed.accountId])).rows[0];
      const updated=await Promise.race([renewed.promise,completion.then(error=>{throw error??Error('B3_A_갱신_이전_종료');})]);expect(updated.claim).toMatchObject({workId:input.claim.workItemId,generation:input.claim.generation,accountId:f.seed.accountId});expect(updated.lease.valueOf()).toBeGreaterThanOrEqual(original.lease_until.valueOf());
      expect(updated.claim.ref).toEqual({requestId:f.requestId});runtime.stopClaims();joining=runtime.idle().then(()=>{idleDone=true;return null;},error=>{idleDone=true;return error;});await new Promise<void>(resolve=>setImmediate(resolve));expect(idleDone).toBe(false);expect((await b3ClaimView(f,updated.claim)).state).toBe('CLAIMED');await b3NoNative(f);
    }finally{gate.resolve();}
    expect(await completion).toBe(boundary);expect(await joining).toBe(boundary);expect(idleDone).toBe(true);expect(seen.length).toBeGreaterThan(0);expect(seen.every(claim=>claim===seen[0])).toBe(true);const stable=seen.length;await runtime.tick();await runtime.idle();expect(seen).toHaveLength(stable);expect(await runtime.execution.claim()).toBeNull();await b3NoNative(f);
  }),30000);
  it.each(['DISPATCH','RECONCILE'] as const)('B3-A %s 조기 종료는 비용 pending과 진행 중 renewal을 합류한 뒤 원 claim을 반환한다',async phase=>b3Case(async f=>{
    const boundary=Error('B3_A_비용_선행_준비_경계'),hook=async()=>{throw boundary;};
    // RECONCILE은 실제 제품 authorize와 C2 준비를 먼저 실행한 PREPARED 자료를 사용한다.
    if(phase==='RECONCILE'){
      const initial=b3Service(f,{afterPrepare:hook});await expect(initial.runOnce()).rejects.toBe(boundary);
      await f.admin.pool.query("UPDATE manga_web.work_items SET due_at=clock_timestamp()-interval '1 second',lease_until=NULL,state='READY',claim_owner=NULL WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId]);
      await f.admin.pool.query("UPDATE manga_web.work_items SET due_at='2100-01-01T00:00:00Z' WHERE account_id=$1 AND kind='DISPATCH'",[f.seed.accountId]);
    }
    const entered=deferred<StageInput>(),gate=deferred<null>(),drained=deferred<void>(),renewEntered=deferred<import('../../packages/domain/src/execution.js').Claim>(),renewGate=deferred<void>(),finishViews:{state:string;claim_owner:string|null;claim_generation:string}[]=[],events:string[]=[];
    const provider:ProviderAdapter=f.provider;provider.validateInput=async()=>{};
    // 실제 C2 비용 메서드 진입을 지연한다. DB 잠금을 보유한 reader 대기와 구분한다.
    const finishCost=f.operationalCost.finishAttempt.bind(f.operationalCost);vi.spyOn(f.operationalCost,'finishAttempt').mockImplementation(async input=>{events.push('COST_ENTERED');entered.resolve(input);await gate.promise;await finishCost(input);});
    if(phase==='DISPATCH')vi.mocked(f.reader.checkpointFactsIn).mockResolvedValueOnce(null);
    const runtime=createWorkerRuntime({worker:f.worker,objects:f.files,fonts:{catalog:{version:'b3a-fixed-font',fonts:[]},bytes:new Map()} as unknown as FontCatalog,profile:syntheticProfile,policy:f.requestPolicy,provider:f.provider,workerNative:f.gateway,workerOperationalCost:f.operationalCost,workerExecutionHooks:{heartbeatMilliseconds:25}});
    const owner=runtime.execution as unknown as {finishCostAttempt(input:StageInput):Promise<void>},costDrain=owner.finishCostAttempt.bind(owner),reconciled=runtime.execution.reconciled.bind(runtime.execution);
    // 원 메서드의 실제 DB 비용 마감과 조기 종료 판단까지 통과한 지점을 관측한다.
    vi.spyOn(owner,'finishCostAttempt').mockImplementation(async input=>{await costDrain(input);if(phase==='DISPATCH')drained.resolve();});
    vi.spyOn(runtime.execution,'reconciled').mockImplementation(async(...args)=>{const result=await reconciled(...args);if(phase==='RECONCILE')drained.resolve();return result;});
    const renew=runtime.execution.renew.bind(runtime.execution),finish=runtime.execution.finish.bind(runtime.execution);let finishAttempts=0;let originalClaim:import('../../packages/domain/src/execution.js').Claim|undefined;
    vi.spyOn(runtime.execution,'renew').mockImplementation(async claim=>{originalClaim??=claim;expect(claim).toBe(originalClaim);const result=await renew(claim);expect(result).toBe(true);events.push('RENEW_COMMITTED');renewEntered.resolve(claim);await renewGate.promise;events.push('RENEW_JOINED');return result;});
    vi.spyOn(runtime.execution,'finish').mockImplementation(async(claim,done,delay)=>{finishAttempts++;expect(claim).toBe(originalClaim);finishViews.push(await b3ClaimView(f,claim));events.push('FINISH');await finish(claim,done,delay);});
    const pending=runtime.tick(),completion=pending.then(()=>null,error=>error);let joining:Promise<unknown>|undefined;let idleDone=false;
    try{
      const input=await Promise.race([entered.promise,completion.then(error=>{throw error??Error('B3_A_비용_조기_종료');})]);const claim=await Promise.race([renewEntered.promise,completion.then(error=>{throw error??Error('B3_A_비용_갱신_공백');})]);expect(claim.kind).toBe(phase);expect(input.executionId).toBe((await b3Facts(f)).inputs[0].protected_observation.executionId);
      expect(finishViews).toEqual([]);expect(await b3ClaimView(f,claim)).toMatchObject({state:'CLAIMED',claim_owner:runtime.execution.workerId,claim_generation:claim.generation});runtime.stopClaims();joining=runtime.idle().then(()=>{idleDone=true;return null;},error=>{idleDone=true;return error;});await new Promise<void>(resolve=>setImmediate(resolve));expect(idleDone).toBe(false);
      gate.resolve(null);await Promise.race([drained.promise,completion.then(error=>{throw error??Error('B3_A_갱신_합류_이전_종료');})]);await new Promise<void>(resolve=>setImmediate(resolve));expect(finishAttempts).toBe(0);expect(finishViews).toEqual([]);expect(idleDone).toBe(false);renewGate.resolve();
    }finally{gate.resolve(null);renewGate.resolve();}
    expect(await completion).toBeNull();expect(await joining).toBeNull();expect(finishViews).toHaveLength(1);expect(finishViews[0]).toMatchObject({state:'CLAIMED',claim_owner:runtime.execution.workerId,claim_generation:originalClaim!.generation});expect(events.indexOf('FINISH')).toBeGreaterThan(events.lastIndexOf('RENEW_JOINED'));expect(await b3ClaimView(f,originalClaim!)).toMatchObject({state:'READY',claim_owner:null,lease_until:null});
    const count=events.filter(event=>event==='RENEW_COMMITTED').length;await runtime.tick();await runtime.idle();expect(events.filter(event=>event==='RENEW_COMMITTED')).toHaveLength(count);expect(await runtime.execution.claim()).toBeNull();
    const saved=await b3Facts(f);expect(saved.enrollments).toHaveLength(1);expect(saved.bases).toHaveLength(1);expect(saved.roots).toHaveLength(1);await b3NoNative(f);
  }),30000);
});

// B3-C는 실제 runOnce의 등록과 비어 있지 않은 PRE를 연결한다.
import {createB3CWindowsExecutionFixture,createW4CWindowsExecutionFixture} from '../fixtures/windows-native.js';

it('W4-C E3 최초 요청의 두 단계가 실제 FINAL과 전체 비용 뒤 원 claim으로 한 번 적용된다',async()=>{
  const guard=guardWindowsNativeIo(),failures:unknown[]=[];let f:Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>|undefined;
  try{
    f=await createW4CWindowsExecutionFixture();
    expect(await f.service.runOnce()).toBe(true);
    const first=await f.inspect();
    console.info(JSON.stringify({w4cE3진단:await f.diagnose('최초 runOnce 반환 뒤')}));
    expect(first.executions).toHaveLength(1);expect(first.executions[0]).toMatchObject({logical_step_id:'OCR',state:'SUCCEEDED'});
    expect(first.financial).toHaveLength(1);expect(first.financial[0]).toMatchObject({stage_usd:'0.011000000000',expense_usd:'0.011000000000'});
    expect(first.applications).toEqual([]);expect(first.results).toEqual([]);expect(first.store).toEqual([]);
    expect(await f.runTypeset()).toBe(true);
    const state=await f.inspect(),ocr=f.inputs.find(value=>value.stage==='OCR'),typeset=f.inputs.find(value=>value.stage==='TYPESET');
    expect(f.inputs).toHaveLength(2);expect(ocr).toBeDefined();expect(typeset).toBeDefined();expect(ocr!.requestId).toBe(f.requestId);expect(typeset!.requestId).toBe(f.requestId);
    expect(f.synthetic.calls.map(value=>value.stage)).toEqual(['OCR','TYPESET']);expect(f.synthetic.lookups).toEqual([]);
    expect(f.events.filter(value=>value.startsWith('VALIDATION_RETURNED:'))).toEqual(['VALIDATION_RETURNED:OCR','VALIDATION_RETURNED:TYPESET']);
    expect(state.request.captured_stage_order).toEqual(['OCR','TYPESET']);expect(state.request.captured_input.originalAssetId).toBe(f.originalAssetId);expect(state.request.captured_input.currentRenderAssetId).toBe(f.renderAssetId);
    expect(state.request.captured_input.assetDependencies.map((value:{assetId:string})=>value.assetId).sort()).toEqual([f.originalAssetId,f.renderAssetId].sort());
    expect(sha256(f.originalBytes)).not.toBe(sha256(f.renderBytes));
    for(const input of f.inputs){
      expect(input.assetDependencies?.map(value=>value.assetId).sort()).toEqual([f.originalAssetId,f.renderAssetId].sort());
      for(const kind of ['INPUT','OPERATIONAL_COST_BASIS','START','OUTCOME','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE','WINDOWS_STAGE_COST_SEAL'])expect(state.evidence.filter(row=>row.execution_id===input.executionId&&row.kind===kind),kind).toHaveLength(1);
      const enrollment=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,input.executionId])).rows,roots=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_roots WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,input.executionId])).rows;
      expect(enrollment).toHaveLength(1);expect(roots).toHaveLength(1);
      const basis=state.evidence.find(row=>row.execution_id===input.executionId&&row.kind==='OPERATIONAL_COST_BASIS')!,original=state.evidence.find(row=>row.execution_id===input.executionId&&row.kind==='INPUT')!;
      expect(digest(original.protected_observation)).toBe(original.evidence_digest);expect(digest(basis.protected_observation)).toBe(basis.evidence_digest);expect(basis.received_at.valueOf()).toBeGreaterThanOrEqual(original.received_at.valueOf());
    }
    expect(state.executions.map(row=>[row.logical_step_id,row.state])).toEqual([['OCR','SUCCEEDED'],['TYPESET','SUCCEEDED']]);expect(state.checkpoints).toHaveLength(2);
    for(const checkpoint of state.checkpoints){const outcome=state.evidence.find(row=>row.execution_id===checkpoint.execution_id&&row.kind==='OUTCOME')!;expect(checkpoint.verification_state).toBe('VERIFIED');expect(outcome.protected_observation.outcome).toBe('SUCCESS');expect(outcome.protected_observation.stageOutput.checkpointId).toBe(checkpoint.checkpoint_id);expect(digest(checkpoint.output_envelope)).toBe(outcome.evidence_digest);}
    const ocrPre=state.views.filter(item=>item.input.executionId===ocr!.executionId&&item.view.attempt?.purpose==='PRE_DISPATCH').at(-1)!.view,pre=state.views.filter(item=>item.input.executionId===typeset!.executionId&&item.view.attempt?.purpose==='PRE_DISPATCH').at(-1)!.view,final=state.views.filter(item=>item.input.executionId===typeset!.executionId&&item.view.attempt?.purpose==='FINAL_COMMIT').at(-1)!.view;
    expect(ocrPre.state).toBe('VERIFIED');expect(ocrPre.attempt?.targets).toEqual([]);expect(ocrPre.jobIds).toEqual([]);
    expect(pre.state).toBe('VERIFIED');expect(pre.attempt?.targets).toHaveLength(1);expect(pre.jobIds).toHaveLength(1);expect(pre.attempt?.targets[0].sourceExecutionId).toBe(ocr!.executionId);expect(pre.attempt?.consumerExecutionId).toBe(typeset!.executionId);
    expect(final.state).toBe('VERIFIED');expect(final.attempt?.targets.map(value=>value.sourceExecutionId)).toEqual([ocr!.executionId,typeset!.executionId]);
    const preOps=state.operations.filter(item=>item.operation.attemptId===pre.attempt!.attemptId),finalOps=state.operations.filter(item=>item.operation.attemptId===final.attempt!.attemptId);
    expect(preOps).toHaveLength(1);expect(preOps[0].operation.native).toHaveLength(1);expect(preOps[0].operation.native[0].origin).toBe('FRESH');expect(finalOps).toHaveLength(2);
    expect(finalOps[0].operation.native).toHaveLength(1);expect(finalOps[0].operation.native[0].origin).toBe('CACHE');expect(finalOps[1].operation.native).toEqual([]);
    expect(state.cache).toHaveLength(1);expect(state.native).toHaveLength(2);expect(new Set(state.native.map(row=>row.protected_intent.operationInputDigest)).size).toBe(2);
    expect(f.confirmedProofs).toHaveLength(2);expect(f.confirmedProofs.map(value=>value.input.stage)).toEqual(['OCR','TYPESET']);
    const held=(await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 ORDER BY reservation_id',[f.seed.accountId])).rows;expect(held).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null},{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);
    const proofRows=(await f.admin.pool.query('SELECT proof_id,reservation_id FROM manga_web.windows_native_termination_proofs WHERE account_id=$1 ORDER BY reservation_id',[f.seed.accountId])).rows;expect(proofRows).toHaveLength(2);for(const proof of f.confirmedProofs)expect(proofRows).toContainEqual({proof_id:proof.proofId,reservation_id:proof.key.binding.capacityReservationId});
    expect((await f.admin.pool.query('SELECT * FROM manga_web.native_capacity_termination_proofs WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([]);
    const promoted=(await f.admin.pool.query('SELECT execution_id,mode FROM manga_web.native_capacity_adoptions WHERE account_id=$1 ORDER BY execution_id',[f.seed.accountId])).rows;expect(promoted).toHaveLength(2);for(const input of f.inputs)expect(promoted).toContainEqual({execution_id:input.executionId,mode:'PROMOTE'});
    expect((await f.admin.pool.query('SELECT max_slots FROM manga_web.native_capacity_profiles WHERE profile_id=$1',[f.remote.capacity.reference.profileId])).rows).toEqual([{max_slots:2}]);expect((await f.admin.pool.query('SELECT max_slots FROM manga_web.execution_limit_profiles WHERE profile_id=$1',[f.requestPolicy.executionLimit!.profileId])).rows).toEqual([{max_slots:2}]);
    for(const input of f.inputs){const proof=f.events.indexOf('OPERATOR_PROOF_ACK:'+input.stage),preflight=f.events.indexOf('PREFLIGHT_BEGIN:'+input.stage),promote=f.events.indexOf('PERMIT_PROMOTE:'+input.stage),dispatch=f.events.indexOf('DISPATCH:'+input.stage);expect(proof).toBeGreaterThan(f.events.indexOf('AFTER_PREPARE:'+input.stage));expect(preflight).toBeGreaterThan(proof);expect(promote).toBeGreaterThan(preflight);expect(dispatch).toBeGreaterThan(promote);}
    const nativeRows=(await f.admin.pool.query("SELECT i.job_id,i.protected_intent,o.event,o.protected_observation FROM manga_web.native_job_intents i JOIN manga_web.native_job_observations o USING(account_id,job_id) WHERE i.account_id=$1 ORDER BY i.job_id,o.event",[f.seed.accountId])).rows;
    for(const job of state.native){const rows=nativeRows.filter(row=>row.job_id===job.job_id);expect(rows.filter(row=>row.event==='RESULT')).toHaveLength(1);expect(rows.filter(row=>row.event==='TERMINATION')).toHaveLength(1);for(const row of rows)expect(row.protected_observation).toMatchObject({version:2,code:'OK',termination:{kind:'WINDOWS_JOB_EMPTY'}});}
    expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[f.seed.accountId])).rows).toHaveLength(2);expect(f.remote.hosts).toHaveLength(2);
    expect(state.financial.map(row=>[row.stage_usd,row.expense_usd])).toEqual([['0.011000000000','0.011000000000'],['0.014000000000','0.014000000000']]);
    for(const row of state.financial){expect(row.state).toBe('CONFIRMED');expect(row.usage_ref).toBe('execution-evidence:'+row.evidence_id+':'+row.evidence_digest);const calculation=state.evidence.find(value=>value.evidence_id===row.evidence_id)!;expect(calculation.kind).toBe('OPERATIONAL_COST_CALCULATION');expect(calculation.evidence_digest).toBe(row.evidence_digest);}
    expect((await f.admin.pool.query("SELECT sum(c.actual_usd)::text total FROM manga_web.cost_items c JOIN manga_web.executions e USING(account_id,execution_id) WHERE c.account_id=$1 AND e.request_id=$2 AND c.component='STAGE_TOTAL'",[f.seed.accountId,f.requestId])).rows[0].total).toBe('0.025000000000');
    expect(f.preSnapshots).toHaveLength(2);expect(f.preSnapshots[1]).toEqual(f.preSnapshots[0]);
    const preAfter=state.evidence.filter(row=>row.execution_id===typeset!.executionId&&['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_VERIFIED'].includes(row.kind)&&row.protected_observation.value.attemptId===pre.attempt!.attemptId).map(({evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at})=>({evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at}));expect(preAfter).toEqual(f.preSnapshots[0]);
    // 위 원 FINAL과 전체 비용이 확인된 뒤에만 publication 기능 RED로 판정한다.
    console.info(JSON.stringify({w4cE3:{요청:f.requestId,실행:state.executions.length,checkpoint:state.checkpoints.length,원비용:state.financial.map(row=>row.stage_usd),FINAL:final.state,적용:state.applications.length,events:f.events}}));
    expect(state.applications).toHaveLength(1);expect(state.applications[0]).toMatchObject({outcome:'APPLIED',execution_id:typeset!.executionId,request_id:f.requestId});expect(state.results).toHaveLength(1);expect(state.results[0].result_id).toBe(state.applications[0].result_id);expect(state.store).toHaveLength(1);expect(state.request.state).toBe('COMPLETED');
    const before=await f.inspect(),fileBefore={...f.objectIo};for(const input of f.inputs)await f.cost.finishAttempt(input);await f.cost.idle();expect(await f.inspect()).toEqual(before);expect(f.objectIo).toEqual(fileBefore);
  }catch(error){failures.push(error);if(f){try{console.info(JSON.stringify({w4cE3진단:await f.diagnose('검사 오류 뒤 정리 전')}));}catch(diagnosticError){failures.push(diagnosticError);}}}
  finally{
    try{await f?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();}catch(error){failures.push(error);}try{expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 검사와 정리 오류');
},120000);

it('B3-C E2 실제 등록과 원 FINAL 검증에서 원 finally의 전체 비용 정산까지 연결한다',async()=>{
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof createB3CWindowsExecutionFixture>>|undefined;
  try{
    f=await createB3CWindowsExecutionFixture({mode:'E2_FINAL'});
    await f.runBoundary();const state=await f.inspect();
    expect(state.inputs).toHaveLength(1);expect(state.enrollments).toHaveLength(1);expect(state.bases).toHaveLength(1);expect(state.roots).toHaveLength(1);
    expect(f.finalResult).toBe(true);expect(f.finalEligible).toBe('ELIGIBLE');expect(state.pre.state).toBe('VERIFIED');expect(state.pre.jobIds).toEqual([]);
    expect(state.final.state).toBe('VERIFIED');expect(state.final.attempt?.targets).toHaveLength(2);expect(state.final.jobIds).toHaveLength(1);
    expect(state.final.attempt?.targets.map(target=>target.sourceExecutionId)).toEqual([f.source.executionId,f.consumer!.executionId]);
    expect(state.cost.state).toBe('CONFIRMED');expect(state.cost.costUsd).toBe('0.013900719925');
    expect(state.counts).toMatchObject({go:1,calculation:1,closure:1,seal:1,expense:1});expect(state.counts.starts).toBe(state.counts.ends);
    expect(state.totals).toHaveLength(1);expect(state.totals[0]).toMatchObject({stage_usd:'0.013900719925',expense_usd:'0.013900719925'});
    expect(state.totals[0].usage_ref).toBe('execution-evidence:'+state.totals[0].evidence_id+':'+state.totals[0].evidence_digest);
    b3cPgExactFinancial(state,'0.013900719925');
    expect(f.events).not.toContain('DISPATCH');expect(f.events).not.toContain('VALIDATE_INPUT');
    const before=await f.inspect();await f.cost.finishAttempt(f.consumer!);await f.cost.idle();expect(await f.inspect()).toEqual(before);
  }finally{try{await f?.close();}finally{const denied=[...guard.denied];guard.restore();expect(denied).toEqual([]);}}
},120000);

it('W4-C E3 같은 요청의 PRE 원자료는 실제 FINAL과 원 finally 뒤에도 변하지 않는다',async()=>{
  const guard=guardWindowsNativeIo(),restores:B3CPgRestore[]=[],failures:unknown[]=[];let f:Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>|undefined;
  try{
    f=await createW4CWindowsExecutionFixture();const fixture=f;
    const originalOwner={admin:f.admin,seed:f.seed,get consumer(){return fixture.inputs.find(input=>input.stage==='TYPESET')??null;}};
    const internal=f.service as unknown as B3CPgCheckpointService,validate=internal.validateOperationalCheckpoints.bind(internal);
    let preBefore:Awaited<ReturnType<typeof b3cPgPreSnapshot>>|undefined,preAfter:Awaited<ReturnType<typeof b3cPgPreSnapshot>>|undefined,finalCalls=0;
    const spy=vi.spyOn(internal,'validateOperationalCheckpoints').mockImplementation(async(...args)=>{
      if(args[1].stage!=='TYPESET'||args[2]!=='FINAL_COMMIT')return validate(...args);
      finalCalls++;preBefore=await b3cPgPreSnapshot(originalOwner);
      const result=await validate(...args);expect(result).toBe(true);preAfter=await b3cPgPreSnapshot(originalOwner);expect(preAfter).toEqual(preBefore);return result;
    });restores.push(()=>spy.mockRestore());
    expect(await f.service.runOnce()).toBe(true);expect(await f.runTypeset()).toBe(true);const state=await f.inspect();
    expect(finalCalls).toBe(1);expect(preBefore).toBeDefined();expect(preAfter).toBeDefined();expect(await b3cPgPreSnapshot(originalOwner)).toEqual(preBefore);
    expect(f.preSnapshots).toHaveLength(2);expect(f.preSnapshots[1]).toEqual(f.preSnapshots[0]);
    const rows=await b3cPgEvidence(originalOwner);expect(rows.filter(row=>row.kind==='OUTCOME')).toHaveLength(1);expect(rows.filter(row=>row.kind==='STALE_OUTCOME')).toEqual([]);
    const pre=state.views.find(row=>row.input.stage==='TYPESET'&&row.view.attempt?.purpose==='PRE_DISPATCH')?.view;
    const final=state.views.find(row=>row.input.stage==='TYPESET'&&row.view.attempt?.purpose==='FINAL_COMMIT')?.view;
    expect(pre?.state).toBe('VERIFIED');expect(pre?.jobIds).toHaveLength(1);expect(final?.state).toBe('VERIFIED');expect(final?.attempt?.targets).toHaveLength(2);
    expect(f.events.filter(event=>event.startsWith('FINAL_COMMIT:'))).toEqual(['FINAL_COMMIT:OCR','FINAL_COMMIT:TYPESET']);
    expect(state.financial.map(row=>row.stage_usd)).toEqual(['0.011000000000','0.014000000000']);expect(state.applications).toHaveLength(1);expect(state.request.state).toBe('COMPLETED');
  }catch(error){failures.push(error);}
  finally{
    for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
    try{await f?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();}catch(error){failures.push(error);}try{expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 PRE 원자료 검사와 정리 오류');
},120000);



// 기존 본문 뒤에 추가하는 B3-C 전용 회귀다. PG 실행은 부모가 소유한다.
import {isWindowsExecutionContextWait} from '../../packages/domain/src/native-remote-gateway.js';

type B3CPgFixture=Awaited<ReturnType<typeof createB3CWindowsExecutionFixture>>;
type B3CPgOptions=Parameters<typeof createB3CWindowsExecutionFixture>[0];
type B3CPgContext=Parameters<NonNullable<B3CPgOptions['beforeValidation']>>[0];
type B3CPgOperation=Parameters<NonNullable<B3CPgOptions['alterOperation']>>[0];
type B3CPgRestore=()=>void;
type B3CPgEvidence={evidence_id:string;execution_id:string;kind:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:unknown;received_at:Date;row_xmin:string};
type B3CPgNativeCounts={intents:number;admissions:number;go:number;observations:number;bindings:number;scopes:number;calls:number;cacheUses:number;starts:number;ends:number};
const b3cPgEvidenceSelect='SELECT evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at,xmin::text AS row_xmin FROM manga_web.execution_evidence';

async function b3cPgCase(options:(current:()=>B3CPgFixture)=>B3CPgOptions,run:(f:B3CPgFixture,restores:B3CPgRestore[])=>Promise<void>){
  const guard=guardWindowsNativeIo(),restores:B3CPgRestore[]=[],failures:unknown[]=[];let f:B3CPgFixture|undefined;
  const current=()=>{if(!f)throw Error('B3C_PG_FIXTURE_NOT_READY');return f;};
  try{f=await createB3CWindowsExecutionFixture(options(current));await run(f,restores);}catch(error){failures.push(error);}
  finally{
    for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
    try{await f?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();}catch(error){failures.push(error);}
    try{expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'B3C_PG_CASE_AND_CLEANUP_UNCONFIRMED');
}

function b3cPgFileSpies(f:B3CPgFixture,restores:B3CPgRestore[]){
  const read=vi.spyOn(f.files,'read');restores.push(()=>read.mockRestore());
  const put=vi.spyOn(f.files,'put');restores.push(()=>put.mockRestore());
  return {read,put};
}

async function b3cPgNativeCounts(f:Pick<B3CPgFixture,'admin'|'seed'>):Promise<B3CPgNativeCounts>{
  return (await f.admin.pool.query<B3CPgNativeCounts>(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,
    (SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE account_id=$1) AS admissions,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE account_id=$1) AS observations,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_bindings WHERE account_id=$1) AS bindings,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_scopes WHERE account_id=$1) AS scopes,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_calls WHERE account_id=$1) AS calls,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_cache_uses WHERE account_id=$1) AS "cacheUses",
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) AS starts,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) AS ends`,[f.seed.accountId])).rows[0];
}

async function b3cPgEvidence(f:Pick<B3CPgFixture,'admin'|'seed'|'consumer'>):Promise<B3CPgEvidence[]>{
  expect(f.consumer).not.toBeNull();
  return (await f.admin.pool.query<B3CPgEvidence>(b3cPgEvidenceSelect+' WHERE account_id=$1 AND execution_id=$2 ORDER BY received_at,evidence_id',[f.seed.accountId,f.consumer!.executionId])).rows;
}

async function b3cPgOriginals(f:Pick<B3CPgFixture,'admin'|'seed'|'consumer'>){
  expect(f.consumer).not.toBeNull();const params=[f.seed.accountId,f.consumer!.executionId];
  const evidence=(await f.admin.pool.query<B3CPgEvidence>(b3cPgEvidenceSelect+" WHERE account_id=$1 AND execution_id=$2 AND kind IN ('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind,evidence_id",params)).rows;
  const enrollments=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2 ORDER BY evidence_id',params)).rows;
  const roots=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_roots WHERE account_id=$1 AND execution_id=$2 ORDER BY evidence_id',params)).rows;
  return {evidence,enrollments,roots};
}

type B3CPgCheckpointService={validateOperationalCheckpoints(claim:NonNullable<B3CPgFixture['claim']>,input:NonNullable<B3CPgFixture['consumer']>,purpose:'PRE_DISPATCH'|'FINAL_COMMIT'):Promise<boolean>};

async function b3cPgPreSnapshot(f:Pick<B3CPgFixture,'admin'|'seed'|'consumer'>){
  const rows=await b3cPgEvidence(f);
  const attempts=rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&b3cPgValue<{purpose:string}>(row).purpose==='PRE_DISPATCH');expect(attempts).toHaveLength(1);
  const attemptId=b3cPgValue<{attemptId:string}>(attempts[0]).attemptId;
  const evidence=rows.filter(row=>['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_VERIFIED'].includes(row.kind)&&b3cPgValue<{attemptId:string}>(row).attemptId===attemptId);
  for(const kind of ['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_VERIFIED'])expect(evidence.filter(row=>row.kind===kind)).toHaveLength(1);
  return {originals:await b3cPgOriginals(f),evidence};
}

async function b3cPgProducerReceipts(f:B3CPgFixture,jobId:string){
  const params=[f.seed.accountId,jobId];
  const candidates=(await f.admin.pool.query('SELECT * FROM manga_web.native_result_candidates WHERE account_id=$1 AND job_id=$2 ORDER BY candidate_id',params)).rows;
  const receipts=(await f.admin.pool.query('SELECT r.* FROM manga_web.native_result_receipts r JOIN manga_web.native_result_candidates c USING(account_id,candidate_id) WHERE c.account_id=$1 AND c.job_id=$2 ORDER BY c.candidate_id',params)).rows;
  expect(candidates).toHaveLength(1);expect(receipts).toHaveLength(1);return {candidates,receipts};
}

function b3cPgValue<T>(row:B3CPgEvidence):T{return (row.protected_observation as {value:T}).value;}

async function b3cPgUnconfirmed(f:B3CPgFixture){
  const state=await f.inspect(),rows=await b3cPgEvidence(f);
  expect.soft(state.inputs).toHaveLength(1);expect.soft(state.bases).toHaveLength(1);expect.soft(state.enrollments).toHaveLength(1);expect.soft(state.roots).toHaveLength(1);
  expect.soft(state.cost.state).toBe('UNCONFIRMED');expect.soft(state.cost.basis).not.toBeNull();expect.soft(state.cost.costUsd).toBeNull();expect.soft(state.cost.sealedCalculation).toBeNull();
  expect.soft(state.counts).toMatchObject({calculation:0,closure:0,seal:0,expense:0});
  expect.soft(rows.filter(row=>['OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE','WINDOWS_STAGE_COST_SEAL'].includes(row.kind))).toEqual([]);
  const costs=(await f.admin.pool.query<{state:string;actual_usd:string|null;usage_ref:string|null;rate_version:string|null;confirmed_at:Date|null;evidence_conflict:boolean}>("SELECT state,actual_usd::text,usage_ref,rate_version,confirmed_at,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 AND component='STAGE_TOTAL' ORDER BY ordinal",[f.seed.accountId,f.consumer!.executionId])).rows;
  for(const cost of costs)expect.soft(cost).toEqual({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,rate_version:null,confirmed_at:null,evidence_conflict:false});
  const expenses=(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2',[f.seed.accountId,f.consumer!.executionId])).rows;
  expect.soft(expenses).toEqual([]);expect.soft(f.events).not.toContain('DISPATCH');if(f.mode==='PRE_BOUNDARY')expect.soft(f.events.filter(event=>event==='VALIDATE_INPUT')).toHaveLength(1);else expect.soft(f.events).not.toContain('VALIDATE_INPUT');
  return {state,rows,costs};
}

function b3cPgCommittedAck(f:B3CPgFixture,stage:'BEGIN'|'VERIFIED',sentinel:Error,afterCommit:(row:B3CPgEvidence)=>Promise<void>,restores:B3CPgRestore[]){
  const transaction=f.worker.accountTransaction.bind(f.worker);let hits=0,observed:{row:B3CPgEvidence;writerXid:string;result:unknown}|undefined;
  const call:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{
    let pending:{row:B3CPgEvidence;writerXid:string}|undefined;
    const result=await transaction(accountId,async tx=>{
      const value=await run(tx);
      if(accountId===f.seed.accountId&&hits===0&&f.consumer){
        const matches=(await tx.client.query<B3CPgEvidence&{writer_xid:string}>(`SELECT e.evidence_id,e.execution_id,e.kind,e.evidence_digest,e.protected_evidence_ref,e.protected_observation,e.received_at,e.xmin::text AS row_xmin,pg_current_xact_id()::text AS writer_xid
          FROM manga_web.execution_evidence e JOIN manga_web.execution_evidence a ON a.account_id=e.account_id AND a.execution_id=e.execution_id
            AND a.kind='CHECKPOINT_VALIDATION_ATTEMPT' AND a.protected_observation->'value'->>'purpose'='FINAL_COMMIT'
            AND a.protected_observation->'value'->>'attemptId'=e.protected_observation->'value'->>'attemptId'
          WHERE e.account_id=$1 AND e.execution_id=$2 AND e.kind=$3 AND e.xmin::text=pg_current_xact_id()::text`,[accountId,f.consumer.executionId,stage==='BEGIN'?'CHECKPOINT_VALIDATION_ATTEMPT':'CHECKPOINT_VALIDATION_VERIFIED'])).rows;
        if(matches.length===1){const {writer_xid,...row}=matches[0];pending={row,writerXid:writer_xid};}
        else if(matches.length>1)throw Error('B3C_PG_ACK_BOUNDARY_AMBIGUOUS');
      }
      return value;
    },restricted);
    if(pending){hits++;observed={...pending,result};await afterCommit(pending.row);throw sentinel;}
    return result;
  };
  const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(call);restores.push(()=>spy.mockRestore());
  return {get hits(){return hits;},get observed(){return observed;}};
}

it.each(['BEGIN','OP','VERIFIED'] as const)('B3-C C3-07 %s FINAL COMMIT 뒤 ACK 유실은 원 row와 오류를 보존하고 추가 작업을 막는다',async stage=>{
  const sentinel=Error('B3C_'+stage+'_ACK_미확정');let opHits=0;
  let boundary:{row:B3CPgEvidence|undefined;rows:B3CPgEvidence[];originals:Awaited<ReturnType<typeof b3cPgOriginals>>;native:B3CPgNativeCounts;reads:number;puts:number}|undefined;
  let io:ReturnType<typeof b3cPgFileSpies>|undefined;
  const capture=async(f:B3CPgFixture,evidenceId:string)=>{
    const rows=await b3cPgEvidence(f);boundary={row:rows.find(row=>row.evidence_id===evidenceId),rows,originals:await b3cPgOriginals(f),native:await b3cPgNativeCounts(f),reads:io!.read.mock.calls.length,puts:io!.put.mock.calls.length};
  };
  await b3cPgCase(current=>({mode:'E2_FINAL',afterOperation:async(ref,ctx)=>{
    if(stage!=='OP'||opHits!==0||ctx.attempt.purpose!=='FINAL_COMMIT'||ctx.input.executionId!==current().source.executionId)return;
    await capture(current(),ref.evidenceId);opHits++;throw sentinel;
  }}),async(f,restores)=>{
    io=b3cPgFileSpies(f,restores);
    const fault=stage==='OP'?undefined:b3cPgCommittedAck(f,stage,sentinel,row=>capture(f,row.evidence_id),restores);
    let returned:boolean|undefined,rejected:unknown;try{await f.runBoundary();returned=true;}catch(error){rejected=error;}
    const checked=await b3cPgUnconfirmed(f),after=await b3cPgNativeCounts(f);
    expect.soft(stage==='OP'?opHits:fault!.hits).toBe(1);expect.soft(boundary).toBeDefined();expect.soft(boundary?.row).toBeDefined();
    if(fault?.observed){
      expect.soft(fault.observed.row.row_xmin).toBe(fault.observed.writerXid);expect.soft(boundary?.row).toEqual(fault.observed.row);
      if(stage==='BEGIN')expect.soft(fault.observed.result).toMatchObject({purpose:'FINAL_COMMIT',consumerExecutionId:f.consumer!.executionId});
      else expect.soft(fault.observed.result).toBe(true);
    }
    if(boundary){
      expect.soft(checked.rows).toEqual(boundary.rows);expect.soft(await b3cPgOriginals(f)).toEqual(boundary.originals);expect.soft(after).toEqual(boundary.native);
      expect.soft(io.read.mock.calls).toHaveLength(boundary.reads);expect.soft(io.put.mock.calls).toHaveLength(boundary.puts);
      if(boundary.row){expect.soft(boundary.row.protected_evidence_ref).toBe(boundary.row.evidence_id);expect.soft(digest(boundary.row.protected_observation)).toBe(boundary.row.evidence_digest);expect.soft(boundary.row.received_at).toBeInstanceOf(Date);}
    }
    const attempts=checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&b3cPgValue<B3CPgContext['attempt']>(row).purpose==='FINAL_COMMIT');
    expect.soft(attempts).toHaveLength(1);
    if(attempts.length===1){
      const attempt=b3cPgValue<B3CPgContext['attempt']>(attempts[0]),operations=checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION'&&b3cPgValue<B3CPgOperation>(row).attemptId===attempt.attemptId);
      const verified=checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&b3cPgValue<{attemptId:string}>(row).attemptId===attempt.attemptId);
      expect.soft(attempt.targets.map(target=>target.sourceExecutionId)).toEqual([f.source.executionId,f.consumer!.executionId]);
      expect.soft(operations).toHaveLength(stage==='BEGIN'?0:stage==='OP'?1:2);expect.soft(verified).toHaveLength(stage==='VERIFIED'?1:0);
      if(stage==='OP'&&operations.length===1)expect.soft(b3cPgValue<B3CPgOperation>(operations[0]).targetDigest).toBe(digest(attempt.targets[0]));
    }
    expect.soft(checked.state.pre.state).toBe('VERIFIED');expect.soft(checked.state.final.state).toBe(stage==='VERIFIED'?'VERIFIED':'WAIT');
    expect.soft(after.go).toBe(stage==='VERIFIED'?1:0);expect.soft(f.finalResult).toBeNull();expect.soft(f.finalEligible).toBe('WAIT');
    expect.soft(f.events.filter(event=>event==='E2_SUCCESS_FIXTURE')).toHaveLength(1);
    expect.soft(checked.rows.filter(row=>row.kind==='OUTCOME')).toHaveLength(1);
    // OP의 원 Error가 삼켜지는 현행 결함도 아래 기대를 바꾸지 않고 그대로 실패시킨다.
    expect.soft(returned).toBeUndefined();expect.soft(isWindowsExecutionContextWait(rejected,f.service.nativeGateway)).toBe(false);
    if(rejected instanceof AggregateError){expect.soft(rejected.errors).toContain(sentinel);expect.soft(rejected.errors.filter(error=>error===sentinel)).toHaveLength(1);expect.soft(rejected.errors.filter(error=>error!==sentinel),'ACK 오류와 별개의 독립 오류').toEqual([]);}
    else expect.soft(rejected).toBe(sentinel);
  });
},120000);

it.each(['consumer','purpose','target'] as const)('B3-C C3-04 단일 %s context 변조는 원 brand WAIT를 보존하고 추가 I/O와 비용 확정을 막는다',async fault=>{
  let captured:B3CPgContext|undefined,raised:unknown,calls=0;
  let boundary:{native:B3CPgNativeCounts;originals:Awaited<ReturnType<typeof b3cPgOriginals>>}|undefined;
  await b3cPgCase(current=>({mode:'PRE_FAULT',beforeValidation:async ctx=>{
    const f=current();captured=ctx;calls++;boundary={native:await b3cPgNativeCounts(f),originals:await b3cPgOriginals(f)};
    const validation={consumer:fault==='consumer'?ctx.input:ctx.consumer,attempt:fault==='purpose'?{...ctx.attempt,purpose:'FINAL_COMMIT' as const}:ctx.attempt,target:fault==='target'?{...ctx.target,sourceExecutionId:ctx.consumer.executionId}:ctx.target};
    try{await f.service.nativeCallContext(ctx.claim,ctx.input,'CHECKPOINT',ctx.consumer.requestId,ctx.observation,validation);}catch(error){raised=error;throw error;}
  }}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores);expect(await f.service.runOnce()).toBe(true);
    const checked=await b3cPgUnconfirmed(f);
    expect.soft(calls).toBe(1);expect.soft(captured).toBeDefined();expect.soft(captured?.native.decodeImage).toBeTypeOf('function');
    expect.soft(captured?.attempt.purpose).toBe('PRE_DISPATCH');expect.soft(captured?.consumer.executionId).toBe(f.consumer!.executionId);
    expect.soft(captured?.input.executionId).toBe(f.source.executionId);expect.soft(f.consumer!.executionId).not.toBe(f.source.executionId);
    expect.soft(captured?.target.sourceExecutionId).toBe(f.source.executionId);expect.soft(isWindowsExecutionContextWait(raised,f.service.nativeGateway)).toBe(true);
    expect.soft(raised).toMatchObject({code:'WINDOWS_EXECUTION_CONTEXT_UNCONFIRMED',nextAction:'WAIT'});
    const sourceRows=(await f.admin.pool.query<B3CPgEvidence>(b3cPgEvidenceSelect+" WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[f.seed.accountId,f.source.executionId])).rows;
    expect.soft(sourceRows).toHaveLength(1);
    if(sourceRows.length===1){expect.soft(sourceRows[0].protected_observation).toEqual(canonicalInput(f.source));expect.soft(sourceRows[0].evidence_digest).toBe(digest(canonicalInput(f.source)));}
    expect.soft(checked.state.pre.state).toBe('WAIT');expect.soft(checked.state.pre.evidenceIds).toEqual([]);expect.soft(checked.state.pre.jobIds).toEqual([]);
    expect.soft(checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')).toHaveLength(1);
    expect.soft(checked.rows.filter(row=>['CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_VERIFIED','OUTCOME','START','STALE_OUTCOME'].includes(row.kind))).toEqual([]);
    expect.soft(boundary).toBeDefined();
    if(boundary){expect.soft(await b3cPgNativeCounts(f)).toEqual(boundary.native);expect.soft(await b3cPgOriginals(f)).toEqual(boundary.originals);}
    expect.soft(io.read).not.toHaveBeenCalled();expect.soft(io.put).not.toHaveBeenCalled();
    expect.soft(checked.state.request.state).not.toBe('FAILED');
  });
},120000);

it.each(['operations','storage','native'] as const)('B3-C C3-06 실제 callback 원자료가 있어도 %s facts 누락은 PRE와 비용을 확정하지 않는다',async missing=>{
  let original:B3CPgOperation|undefined,captured:B3CPgContext|undefined,alterCalls=0,factsCalls=0;
  let originalFacts:import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts|undefined;
  await b3cPgCase(()=>({mode:'PRE_FAULT',alterOperation:(operation,ctx)=>{
    original=structuredClone(operation);captured=ctx;alterCalls++;
    return missing==='storage'?{...operation,storage:[]}:missing==='native'?{...operation,native:[]}:operation;
  },checkpointFacts:(facts,attempt)=>{
    if(attempt.purpose!=='PRE_DISPATCH')return facts;
    originalFacts=structuredClone(facts);factsCalls++;return missing==='operations'?{...facts,operations:[]}:facts;
  }}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores);expect(await f.service.runOnce()).toBe(true);
    const checked=await b3cPgUnconfirmed(f),nativeCounts=await b3cPgNativeCounts(f);
    expect.soft(alterCalls).toBe(1);expect.soft(factsCalls).toBe(1);expect.soft(captured?.attempt.purpose).toBe('PRE_DISPATCH');
    expect.soft(captured?.input.executionId).toBe(f.source.executionId);expect.soft(original).toBeDefined();expect.soft(originalFacts?.operations).toHaveLength(1);
    expect.soft(original?.storage.length).toBeGreaterThan(0);expect.soft(original?.native).toHaveLength(1);expect.soft(original?.semantic.outcome).toBe('RETURNED');
    expect.soft(io.read.mock.calls.length).toBeGreaterThan(0);expect.soft(nativeCounts.go).toBe(1);expect.soft(nativeCounts.bindings).toBe(1);
    expect.soft(nativeCounts.starts).toBeGreaterThan(0);expect.soft(nativeCounts.ends).toBe(nativeCounts.starts);
    const operations=checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION');expect.soft(operations).toHaveLength(1);
    if(operations.length===1&&original){
      expect.soft(operations[0].protected_evidence_ref).toBe(operations[0].evidence_id);expect.soft(digest(operations[0].protected_observation)).toBe(operations[0].evidence_digest);
      expect.soft(b3cPgValue<B3CPgOperation>(operations[0])).toEqual(missing==='storage'?{...original,storage:[]}:missing==='native'?{...original,native:[]}:original);
      expect.soft(originalFacts?.operations).toEqual([{evidenceId:operations[0].evidence_id,evidenceDigest:operations[0].evidence_digest}]);
    }
    const rawNative=(await f.admin.pool.query<{candidate:unknown;receipt:unknown;intent:unknown;termination:unknown}>(`SELECT c.protected_candidate AS candidate,r.protected_receipt AS receipt,i.protected_intent AS intent,o.protected_observation AS termination
      FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id)
      JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.native_job_observations o ON o.account_id=c.account_id AND o.job_id=c.job_id AND o.event='TERMINATION'
      WHERE c.account_id=$1`,[f.seed.accountId])).rows;
    expect.soft(rawNative).toHaveLength(1);
    if(rawNative.length===1&&original?.native.length===1){expect.soft(original.native[0]).toMatchObject({candidate:rawNative[0].candidate,receipt:rawNative[0].receipt,intent:rawNative[0].intent});expect.soft(rawNative[0].termination).toMatchObject({termination:{operationJoined:true,directChildClosed:true,goAttempted:true}});}
    const rawReads=(await f.admin.pool.query<{event:{eventId:string;kind:string;state:string;observed:{sha256:string;bytesLength:string}|null}}>(`SELECT ending.protected_event AS event
      FROM manga_web.windows_native_cost_io_starts start JOIN manga_web.windows_native_cost_io_ends ending USING(account_id,operation_id)
      WHERE start.account_id=$1 AND start.execution_id=$2 AND start.protected_request->>'kind'='OBJECT_READ'
      ORDER BY start.created_at,start.operation_id`,[f.seed.accountId,f.consumer!.executionId])).rows;
    expect.soft(rawReads.length).toBeGreaterThan(0);
    for(const event of original?.storage??[])expect.soft(rawReads).toContainEqual({event:expect.objectContaining({eventId:event.eventId,kind:'OBJECT_READ',state:'RETURNED',observed:{sha256:event.sha256,bytesLength:event.bytesLength}})});
    expect.soft(checked.state.pre.state).toBe('WAIT');expect.soft(checked.state.pre.evidenceIds).toEqual([]);expect.soft(checked.state.pre.jobIds).toEqual([]);
    expect.soft(checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')).toHaveLength(1);
    expect.soft(checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED')).toEqual([]);
    expect.soft(checked.rows.filter(row=>['OUTCOME','STALE_OUTCOME','START'].includes(row.kind))).toEqual([]);
  });
},120000);

// 기존 B3-C 9건 뒤에 가상으로 결합해 검토하는 초안이다. 실제 append와 PG 실행은 부모가 소유한다.
type B3CPhClaim=import('../../packages/domain/src/execution.js').Claim;
type B3CPhClient=Parameters<Parameters<Database['transaction']>[0]>[0];
type B3CPhCleanup=()=>void|Promise<unknown>;
type B3CPhIdentity={pid:number;role:string;session_role:string};
type B3CPhWork=B3CPhIdentity&{work_item_id:string;claim_generation:string;claim_owner:string|null;state:string;lease_until:Date|null;lease_live:boolean;revision:string;execution_generation:string};
type B3CPhRenew={claim:B3CPhClaim;before:B3CPhWork;after:B3CPhWork;ok:boolean};
type B3CPhRef={evidenceId:string;evidenceDigest:string};
type B3CPhClosure={calculationEvidenceId:string;calculationEvidenceDigest:string;workSet:{joinedEvidence:B3CPhRef[]}};

async function b3cPhFinally(run:()=>Promise<void>,cleanup:B3CPhCleanup[]){
  const failures:unknown[]=[];try{await run();}catch(error){failures.push(error);}
  finally{for(const close of cleanup){try{await close();}catch(error){failures.push(error);}}}
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'B3C_PENDING_HISTORY_AND_CLEANUP_UNCONFIRMED');
}

async function b3cPhAwait<T>(pending:Promise<T>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([pending,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('B3C_PENDING_BARRIER_TIMEOUT')),30000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

function b3cPhDuringTick<T>(entered:Promise<T>,completion:Promise<unknown>,code:string){return b3cPhAwait(Promise.race([entered,completion.then(error=>{throw error??Error(code);})]));}

async function b3cPhObserve(client:B3CPhClient,f:Pick<B3CPgFixture,'seed'|'consumer'>,claim:B3CPhClaim):Promise<B3CPhWork>{
  return (await client.query<B3CPhWork>(`WITH sampled AS MATERIALIZED(SELECT clock_timestamp() value)
    SELECT pg_backend_pid() pid,current_user::text role,session_user::text session_role,
      w.work_item_id,w.claim_generation::text,w.claim_owner,w.state,w.lease_until,w.lease_until>sampled.value lease_live,w.revision::text,e.claim_generation::text execution_generation
    FROM sampled,manga_web.work_items w JOIN manga_web.executions e ON e.account_id=w.account_id AND e.execution_id=$3
    WHERE w.account_id=$1 AND w.work_item_id=$2`,[f.seed.accountId,claim.workId,f.consumer!.executionId])).rows[0];
}

function b3cPhClaimMatches(row:B3CPhWork,f:Pick<B3CPgFixture,'service'>,claim:B3CPhClaim){
  expect(row).toMatchObject({work_item_id:claim.workId,claim_generation:claim.generation,execution_generation:claim.generation,claim_owner:f.service.workerId,state:'CLAIMED',lease_live:true});
  expect(row.lease_until).toBeInstanceOf(Date);
}

async function b3cPhFinancial(f:B3CPgFixture){
  const state=await f.inspect(),params=[f.seed.accountId,f.consumer!.executionId];
  const costRows=(await f.admin.pool.query("SELECT cost_item_id,execution_id,component,ordinal,state,actual_usd::text,usage_ref,rate_version,confirmed_at,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY component,ordinal,cost_item_id",params)).rows;
  const expenses=(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',params)).rows;
  const dbCounts=(await f.admin.pool.query<Record<string,number>>(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE account_id=$1) native_reservations,
    (SELECT count(*)::integer FROM manga_web.native_capacity_adoptions WHERE account_id=$1) native_adoptions,
    (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) native_intents,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE account_id=$1) native_observations,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1) result_queries,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_claims WHERE account_id=$1) result_claims,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_acks WHERE account_id=$1) result_acks,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) io_starts,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) io_ends,
    (SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections WHERE account_id=$1) projections,
    (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1) seals,
    (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CALCULATION') calculations,
    (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CLOSURE') closures`,[f.seed.accountId])).rows[0];
  return {cost:state.cost,totals:state.totals,costRows,expenses,counts:state.counts,dbCounts,permits:state.permits,budgets:state.budgets,financialRefs:state.financialRefs};
}

function b3cPhConfirmed(saved:Awaited<ReturnType<typeof b3cPhFinancial>>){
  expect(saved.cost.state).toBe('CONFIRMED');expect(saved.cost.costUsd).toBe('0.013900719925');expect(saved.cost.sealedCalculation).not.toBeNull();
  expect(saved.counts).toMatchObject({go:1,calculation:1,closure:1,seal:1,expense:1});expect(saved.counts.starts).toBe(saved.counts.ends);
  expect(saved.dbCounts.native_reservations).toBe(1);expect(saved.dbCounts.native_intents).toBe(1);expect(saved.dbCounts.native_adoptions).toBeGreaterThanOrEqual(0);
  expect(saved.costRows).toHaveLength(1);expect(saved.costRows[0]).toMatchObject({component:'STAGE_TOTAL',ordinal:0,state:'CONFIRMED',actual_usd:'0.013900719925',evidence_conflict:false});
  expect(saved.costRows[0].confirmed_at).toBeInstanceOf(Date);expect(saved.expenses).toHaveLength(1);
  expect(saved.totals).toHaveLength(1);expect(saved.totals[0]).toMatchObject({stage_usd:'0.013900719925',expense_usd:'0.013900719925'});
  expect(saved.totals[0].usage_ref).toBe('execution-evidence:'+saved.totals[0].evidence_id+':'+saved.totals[0].evidence_digest);
  const calculation=saved.cost.calculations.find(item=>item.evidenceId===saved.cost.sealedCalculation!.evidenceId);
  expect(calculation).toBeDefined();expect(calculation!.evidenceDigest).toBe(saved.cost.sealedCalculation!.evidenceDigest);expect(calculation!.result).toMatchObject({state:'CONFIRMED',actualUsd:'0.013900719925'});
  expect(saved.financialRefs).toHaveLength(3);
  for(const row of saved.financialRefs){expect(digest(row.protected_observation)).toBe(row.evidence_digest);expect(row.received_at).toBeInstanceOf(Date);}
}

// 원 runtime과 명시 합성 제공자 포트에서 실제 callback·비용 pending의 수명을 검사한다.
// 실제 E3의 FINAL callback과 비용 마감 대기만 지연한다. 원 데이터와 반환값은 대체하지 않는다.
it.each(['FINAL','COST'] as const)('W4-C E3 %s pending에서 원 claim 갱신과 stop idle은 비용과 renewal 뒤 한 번 적용하고 finish한다',async phase=>{
  const guard=guardWindowsNativeIo(),restores:B3CPgRestore[]=[],failures:unknown[]=[];
  const entered=deferred<StageInput>(),gate=deferred<void>(),renewEntered=deferred<B3CPhRenew>(),renewGate=deferred<void>(),costDrained=deferred<void>();
  const events:string[]=[];let f:Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>|undefined,observer:B3CPhClient|undefined,baseline:B3CPhWork|undefined,preparedClaim:B3CPhClaim|undefined,gateHits=0,armed=false;
  try{
    f=await createW4CWindowsExecutionFixture({useRuntime:true});const fixture=f,runtime=f.runtime!;expect(runtime).toBeDefined();expect(runtime.execution).toBe(f.service);
    // 첫 OCR은 동일 요청의 원 runOnce로 끝낸다. 감시는 두 번째 TYPESET claim에만 붙인다.
    expect(await f.service.runOnce()).toBe(true);const first=await f.inspect();expect(first.executions).toHaveLength(1);expect(first.financial[0]).toMatchObject({stage_usd:'0.011000000000',expense_usd:'0.011000000000'});expect(first.applications).toEqual([]);
    const current=()=>{const input=fixture.inputs.find(value=>value.stage==='TYPESET');expect(input).toBeDefined();return input!;};
    const claimed=()=>{const claim=fixture.claims.get(current().executionId);expect(claim).toBeDefined();return claim!;};
    const observedOwner={admin:f.admin,seed:f.seed,service:f.service,get consumer(){return fixture.inputs.find(value=>value.stage==='TYPESET')??null;}};
    const before=f.service.hooks.beforeValidateInput!;f.service.hooks.beforeValidateInput=async(...args)=>{await before(...args);if(args[0].stage==='TYPESET'){preparedClaim=claimed();expect(args[1]).toEqual({generation:preparedClaim.generation,ownerId:fixture.service.workerId,workItemId:preparedClaim.workId});baseline=await b3cPhObserve(observer!,observedOwner,preparedClaim);}};restores.push(()=>{fixture.service.hooks.beforeValidateInput=before;});
    const validate=f.provider.validateObservation!.bind(f.provider),validateSpy=vi.spyOn(f.provider,'validateObservation').mockImplementation(async(...args)=>{
      const count=fixture.operations.length;await validate(...args);
      if(phase!=='FINAL'||args[0].stage!=='TYPESET'||fixture.operations.length===count)return;
      const added=fixture.operations.slice(count);expect(added).toHaveLength(1);expect(added[0].input.executionId).toBe(current().executionId);
      const attempts=(await fixture.admin.pool.query<{purpose:string}>("SELECT protected_observation->'value'->>'purpose' purpose FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'attemptId'=$3",[fixture.seed.accountId,current().executionId,added[0].operation.attemptId])).rows;expect(attempts).toEqual([{purpose:'FINAL_COMMIT'}]);expect(added[0].operation.native).toEqual([]);
      gateHits++;armed=true;events.push('FINAL_GATE');entered.resolve(current());await gate.promise;
    });restores.push(()=>validateSpy.mockRestore());
    const runOnce=vi.spyOn(f.service,'runOnce'),stopClaims=vi.spyOn(f.service,'stopClaims');restores.push(()=>runOnce.mockRestore(),()=>stopClaims.mockRestore());
    const queueFinishes:{claim:B3CPhClaim;done:boolean;delay:number|undefined}[]=[],queueCosts:string[]=[],queueRenewals:{claim:B3CPhClaim;ok:boolean}[]=[];
    function originalReconcile(claim:B3CPhClaim){expect(preparedClaim).toBeUndefined();expect(claim).toEqual(fixture.claimSelections.at(-1));expect(claim).toMatchObject({accountId:fixture.seed.accountId,kind:'RECONCILE'});expect(claim.ref).toEqual({executionId:fixture.inputs[0].executionId});}
    const renew=f.service.renew.bind(f.service),finish=f.service.finish.bind(f.service),transaction=f.worker.accountTransaction.bind(f.worker);
    const seen:B3CPhClaim[]=[],renewals:B3CPhRenew[]=[],finishRows:B3CPhWork[]=[],traces=new Map<number,{before:B3CPhWork;after:B3CPhWork}>();
    let routing:number|undefined,serial=0,finishAttempts=0,tick:Promise<void>|undefined,completion:Promise<unknown>|undefined,joining:Promise<unknown>|undefined,idleDone=false;
    const call:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{
      const renewal=routing;
      return transaction(accountId,async tx=>{
        if(renewal===undefined)return run(tx);
        const before=await b3cPhObserve(tx.client,observedOwner,claimed()),result=await run(tx),after=await b3cPhObserve(tx.client,observedOwner,claimed());traces.set(renewal,{before,after});return result;
      },restricted);
    };
    const transactionSpy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(call);restores.push(()=>transactionSpy.mockRestore());
    const renewSpy=vi.spyOn(f.service,'renew').mockImplementation(async claim=>{
      if(claim.kind==='RECONCILE'){originalReconcile(claim);const ok=await renew(claim);queueRenewals.push({claim,ok});return ok;}
      seen.push(claim);const key=++serial;let pending:Promise<boolean>;
      routing=key;try{pending=renew(claim);}finally{routing=undefined;}
      const ok=await pending,trace=traces.get(key);if(!trace)throw Error('E3 pending 원 renew 거래 관측 없음');
      const record={claim,...trace,ok};renewals.push(record);events.push('RENEW_COMMITTED');if(armed){renewEntered.resolve(record);await renewGate.promise;events.push('RENEW_JOINED');}return ok;
    });restores.push(()=>renewSpy.mockRestore());
    const finishSpy=vi.spyOn(f.service,'finish').mockImplementation(async(claim,done,delay)=>{if(claim.kind==='RECONCILE'){originalReconcile(claim);queueFinishes.push({claim,done,delay});await finish(claim,done,delay);return;}finishAttempts++;expect(claim).toBe(claimed());finishRows.push(await b3cPhObserve(observer!,observedOwner,claim));events.push('FINISH');await finish(claim,done,delay);});restores.push(()=>finishSpy.mockRestore());
    const costOwner=f.service as unknown as {finishCostAttempt(input:StageInput):Promise<void>},costFinish=costOwner.finishCostAttempt.bind(costOwner);
    const costSpy=vi.spyOn(costOwner,'finishCostAttempt').mockImplementation(async input=>{
      if(input.stage==='OCR'){const selected=fixture.claimSelections.at(-1);expect(selected).toBeDefined();expect(selected).not.toBeNull();originalReconcile(selected!);expect(input.executionId).toBe(fixture.inputs[0].executionId);queueCosts.push(input.executionId);await costFinish(input);return;}
      expect(input.executionId).toBe(current().executionId);
      if(phase==='COST'){gateHits++;armed=true;events.push('COST_GATE');entered.resolve(input);await gate.promise;}
      await costFinish(input);events.push('COST_RECONCILED');costDrained.resolve();
    });restores.push(()=>costSpy.mockRestore());
    const financial=async()=>{
      const state=await fixture.inspect(),params=[fixture.seed.accountId,current().executionId];
      const cost=await fixture.worker.accountTransaction(fixture.seed.accountId,tx=>fixture.cost.readIn(tx,current()),true);
      const costRows=(await fixture.admin.pool.query("SELECT cost_item_id,execution_id,component,ordinal,state,actual_usd::text,usage_ref,rate_version,confirmed_at,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY component,ordinal,cost_item_id",params)).rows;
      const expenses=(await fixture.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',params)).rows;
      const refs=state.evidence.filter(row=>['WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE'].includes(row.kind));
      const dbCounts=(await fixture.admin.pool.query<Record<string,number>>(`SELECT
        (SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE account_id=$1) native_reservations,
        (SELECT count(*)::integer FROM manga_web.native_capacity_adoptions WHERE account_id=$1) native_adoptions,
        (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) native_intents,
        (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,
        (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE account_id=$1) native_observations,
        (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1) result_queries,
        (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_claims WHERE account_id=$1) result_claims,
        (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_acks WHERE account_id=$1) result_acks,
        (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) io_starts,
        (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) io_ends,
        (SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections WHERE account_id=$1) projections,
        (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1) seals,
        (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CALCULATION') calculations,
        (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CLOSURE') closures`,[fixture.seed.accountId])).rows[0];
      return {cost,costRows,expenses,refs,financial:state.financial,native:await b3cPgNativeCounts(fixture),dbCounts};
    };
    const capacity=async()=>({
      permits:(await fixture.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2 ORDER BY execution_id',[fixture.seed.accountId,current().executionId])).rows,
      budgets:(await fixture.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2 ORDER BY request_id',[fixture.seed.accountId,fixture.requestId])).rows
    });
    await b3cPhFinally(async()=>{
      observer=await f!.admin.pool.connect();const identity=(await observer.query<B3CPhIdentity>('SELECT pg_backend_pid() pid,current_user::text role,session_user::text session_role')).rows[0];
      tick=fixture.runTypeset(()=>runtime.tick());completion=tick.then(()=>null,error=>error);
      const input=await b3cPhDuringTick(entered.promise,completion,'E3 pending callback 경계 전 tick 종료'),renewed=await b3cPhDuringTick(renewEntered.promise,completion,'E3 pending 원 renew 전 tick 종료'),claim=claimed();
      const selectedTicks=fixture.claimSelections.slice(1);expect(selectedTicks.length===1||selectedTicks.length===2).toBe(true);expect(selectedTicks.at(-1)).toMatchObject({accountId:fixture.seed.accountId,kind:'DISPATCH',ref:{requestId:fixture.requestId}});
      const queueCount=selectedTicks.length-1;expect(queueFinishes).toHaveLength(queueCount);expect(queueCosts).toEqual(queueCount?[fixture.inputs[0].executionId]:[]);for(const done of queueFinishes){expect(done.claim).toEqual(selectedTicks[0]);expect(done.done).toBe(true);expect(done.delay).toBe(0);}for(const renewal of queueRenewals){expect(queueCount).toBe(1);expect(renewal.claim).toEqual(selectedTicks[0]);expect(renewal.ok).toBe(true);}if(queueCount)expect(selectedTicks[0]).toMatchObject({kind:'RECONCILE',ref:{executionId:fixture.inputs[0].executionId}});
      expect(runOnce).toHaveBeenCalledTimes(selectedTicks.length);expect(gateHits).toBe(1);expect(preparedClaim).toBe(claim);expect(renewed.claim).toBe(claim);expect(input.executionId).toBe(current().executionId);expect(renewed.ok).toBe(true);
      b3cPhClaimMatches(baseline!,observedOwner,claim);b3cPhClaimMatches(renewed.before,observedOwner,claim);b3cPhClaimMatches(renewed.after,observedOwner,claim);
      expect(renewed.after.role).toBe('trio_web_worker');expect(renewed.after.pid).toBe(renewed.before.pid);expect(renewed.after.pid).not.toBe(identity.pid);expect(BigInt(renewed.after.revision)).toBeGreaterThan(BigInt(renewed.before.revision));expect(renewed.after.lease_until!.valueOf()).toBeGreaterThanOrEqual(renewed.before.lease_until!.valueOf());
      const independent=await b3cPhObserve(observer,observedOwner,claim);b3cPhClaimMatches(independent,observedOwner,claim);expect(independent.pid).toBe(identity.pid);expect(independent.role).toBe(identity.role);expect(independent.session_role).toBe(identity.session_role);expect(independent.lease_until!.valueOf()).toBeGreaterThanOrEqual(renewed.after.lease_until!.valueOf());expect(independent.lease_until!.valueOf()).toBeGreaterThanOrEqual(baseline!.lease_until!.valueOf());
      console.info(JSON.stringify({w4cE3PendingClient:{phase,workerRenew:{pid:renewed.after.pid,role:renewed.after.role},independentObserver:identity,workItemId:claim.workId,generation:claim.generation,owner:fixture.service.workerId}}));
      const waiting=await fixture.inspect(),pre=waiting.views.find(row=>row.input.executionId===current().executionId&&row.view.attempt?.purpose==='PRE_DISPATCH')?.view,final=await fixture.worker.accountTransaction(fixture.seed.accountId,tx=>fixture.checkpoints.lookupIn(tx,current(),'FINAL_COMMIT'),true);
      expect(pre?.state).toBe('VERIFIED');expect(final.state).toBe(phase==='FINAL'?'WAIT':'VERIFIED');expect(waiting.applications).toEqual([]);expect(waiting.results).toEqual([]);expect(waiting.store).toEqual([]);
      const pendingCost=await financial();expect(pendingCost.cost.state).toBe('UNCONFIRMED');expect(pendingCost.cost.costUsd).toBeNull();expect(pendingCost.costRows).toHaveLength(1);expect(pendingCost.costRows[0]).toMatchObject({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,confirmed_at:null,evidence_conflict:false});expect(pendingCost.expenses).toEqual([]);
      expect(pendingCost.native).toMatchObject({go:2,intents:2,bindings:2,cacheUses:1});expect(pendingCost.native.starts).toBeGreaterThan(0);expect(pendingCost.native.starts).toBe(pendingCost.native.ends);expect(pendingCost.dbCounts).toMatchObject({seals:1,calculations:1,closures:1});
      const rows=await b3cPgEvidence(observedOwner),attempts=rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&b3cPgValue<B3CPgContext['attempt']>(row).purpose==='FINAL_COMMIT');expect(attempts).toHaveLength(1);const attempt=b3cPgValue<B3CPgContext['attempt']>(attempts[0]);expect(attempt.consumerExecutionId).toBe(current().executionId);expect(attempt.targets.map(target=>target.sourceExecutionId)).toEqual(fixture.inputs.map(value=>value.executionId));
      const operations=rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION'&&b3cPgValue<B3CPgOperation>(row).attemptId===attempt.attemptId);expect(operations).toHaveLength(2);expect(b3cPgValue<B3CPgOperation>(operations[0]).native[0].origin).toBe('CACHE');expect(b3cPgValue<B3CPgOperation>(operations[1]).native).toEqual([]);expect(rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&b3cPgValue<{attemptId:string}>(row).attemptId===attempt.attemptId)).toHaveLength(phase==='FINAL'?0:1);
      expect((await fixture.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 ORDER BY reservation_id',[fixture.seed.accountId])).rows).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null},{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);expect(fixture.confirmedProofs).toHaveLength(2);expect(pendingCost.dbCounts.native_adoptions).toBe(2);
      runtime.stopClaims();expect(stopClaims).toHaveBeenCalledTimes(1);joining=runtime.idle().then(()=>{idleDone=true;return null;},error=>{idleDone=true;return error;});await new Promise<void>(resolve=>setImmediate(resolve));expect(idleDone).toBe(false);expect(finishAttempts).toBe(0);expect(finishRows).toEqual([]);b3cPhClaimMatches(await b3cPhObserve(observer,observedOwner,claim),observedOwner,claim);
      gate.resolve();await b3cPhDuringTick(costDrained.promise,completion,'E3 pending 원 비용 마감 전 tick 종료');const saved=await financial(),beforePublication=await capacity();expect(beforePublication.permits).toHaveLength(1);expect(beforePublication.budgets).toHaveLength(1);expect(beforePublication.budgets[0]).toMatchObject({state:'HELD',released_at:null,release_evidence_ref:null});
      expect(saved.cost.state).toBe('CONFIRMED');expect(saved.cost.costUsd).toBe('0.014000000000');expect(saved.cost.sealedCalculation).not.toBeNull();expect(saved.costRows).toHaveLength(1);expect(saved.costRows[0]).toMatchObject({component:'STAGE_TOTAL',ordinal:0,state:'CONFIRMED',actual_usd:'0.014000000000',evidence_conflict:false});expect(saved.costRows[0].confirmed_at).toBeInstanceOf(Date);expect(saved.expenses).toHaveLength(1);
      expect(saved.financial.map(row=>[row.stage_usd,row.expense_usd])).toEqual([['0.011000000000','0.011000000000'],['0.014000000000','0.014000000000']]);for(const row of saved.financial)expect(row.usage_ref).toBe('execution-evidence:'+row.evidence_id+':'+row.evidence_digest);expect(saved.refs).toHaveLength(6);for(const row of saved.refs){expect(digest(row.protected_observation)).toBe(row.evidence_digest);expect(row.received_at).toBeInstanceOf(Date);}
      expect(saved.dbCounts).toMatchObject({native_reservations:2,native_intents:2,native_adoptions:2,go:2,seals:2,calculations:2,closures:2});expect(saved.dbCounts.io_starts).toBe(saved.dbCounts.io_ends);expect(saved.native).toEqual(pendingCost.native);expect(await fixture.worker.accountTransaction(fixture.seed.accountId,tx=>fixture.checkpoints.finalCommitIn(tx,current()),true)).toBe('ELIGIBLE');expect((await fixture.inspect()).applications).toEqual([]);
      await new Promise<void>(resolve=>setImmediate(resolve));expect(idleDone).toBe(false);expect(finishAttempts).toBe(0);expect(finishRows).toEqual([]);expect(events).not.toContain('RENEW_JOINED');
      renewGate.resolve();expect(await b3cPhAwait(completion)).toBeNull();expect(await b3cPhAwait(joining)).toBeNull();expect(finishAttempts).toBe(1);expect(finishRows).toHaveLength(1);b3cPhClaimMatches(finishRows[0],observedOwner,claim);expect(events.indexOf('FINISH')).toBeGreaterThan(events.lastIndexOf('RENEW_JOINED'));expect(seen.length).toBeGreaterThan(0);expect(seen.every(value=>value===claim)).toBe(true);expect(renewals.every(record=>record.ok)).toBe(true);
      const finished=await b3cPhObserve(observer,observedOwner,claim);expect(finished).toMatchObject({state:'DONE',claim_owner:null,lease_until:null,claim_generation:claim.generation});const applied=await fixture.inspect();expect(applied.applications).toHaveLength(1);expect(applied.applications[0]).toMatchObject({outcome:'APPLIED',execution_id:current().executionId});expect(applied.results).toHaveLength(1);expect(applied.store).toHaveLength(1);expect(applied.request.state).toBe('COMPLETED');expect(await financial()).toEqual(saved);
      const afterPublication=await capacity();expect(afterPublication.permits).toEqual(beforePublication.permits);expect(afterPublication.budgets).toEqual([{...beforePublication.budgets[0],state:'RELEASED',remaining_usd:'0.000000000000',released_at:applied.request.terminal_at,release_evidence_ref:applied.request.terminal_evidence_ref}]);
      const stable=seen.length,ioBefore={...fixture.objectIo};await runtime.tick();await runtime.idle();await runtime.idle();expect(runOnce).toHaveBeenCalledTimes(selectedTicks.length);expect(seen).toHaveLength(stable);expect(await fixture.service.claim()).toBeNull();expect(await financial()).toEqual(saved);expect(await capacity()).toEqual(afterPublication);expect(await fixture.inspect()).toEqual(applied);expect(fixture.objectIo).toEqual(ioBefore);
    },[()=>gate.resolve(),()=>renewGate.resolve(),()=>runtime.stopClaims(),async()=>{if(tick)await tick;},async()=>{if(joining){const error=await joining;if(error!==null)throw error;}},()=>runtime.idle(),()=>fixture.cost.idle(),()=>observer?.release()]);
  }catch(error){failures.push(error);}
  finally{
    for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
    try{await f?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();}catch(error){failures.push(error);}try{expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 pending 검사와 정리 오류');
},120000);

it('B3-C C3-09 자산 만료와 문맥 종료 뒤 새 비용 인스턴스는 원 FINAL 금융 자료만 읽고 재작업하지 않는다',async()=>{
  await b3cPgCase(()=>({mode:'E2_FINAL'}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores);let reopened:ReturnType<B3CPgFixture['reopenCost']>|undefined;
    await b3cPhFinally(async()=>{
      await f.runBoundary();const before=await b3cPhFinancial(f);b3cPhConfirmed(before);
      expect(io.read.mock.calls.length).toBeGreaterThan(0);expect(io.put.mock.calls.length).toBeGreaterThan(0);const reads=io.read.mock.calls.length,puts=io.put.mock.calls.length;
      expect(f.finalResult).toBe(true);expect((await f.inspect()).final.state).toBe('VERIFIED');
      const closures=before.financialRefs.filter(row=>row.kind==='OPERATIONAL_COST_CLOSURE');expect(closures).toHaveLength(1);
      const closure=(closures[0].protected_observation as {value:B3CPhClosure}).value,joined=closure.workSet.joinedEvidence;
      expect(closure.calculationEvidenceId).toBe(before.cost.sealedCalculation!.evidenceId);expect(closure.calculationEvidenceDigest).toBe(before.cost.sealedCalculation!.evidenceDigest);
      const rows=await b3cPgEvidence(f),final=(await f.inspect()).final.attempt!;
      const originalOwnerRevision=final.owner.ownerRevision,originalWorkspaceRevision=final.owner.workspaceRevision;
      expect(originalOwnerRevision).not.toBeNull();expect(originalWorkspaceRevision).not.toBeNull();
      if(originalOwnerRevision===null||originalWorkspaceRevision===null)throw Error('B3C_HISTORY_ORIGINAL_OWNER_REVISION_MISSING');
      const self=final.targets.find(target=>target.sourceExecutionId===f.consumer!.executionId);expect(self).toBeDefined();
      const operations=rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION'&&b3cPgValue<B3CPgOperation>(row).attemptId===final.attemptId&&b3cPgValue<B3CPgOperation>(row).targetDigest===digest(self!));expect(operations).toHaveLength(1);
      const operation=operations[0],required={evidenceId:operation.evidence_id,evidenceDigest:operation.evidence_digest};expect(joined).toContainEqual(required);
      // 기존 B3-B와 같은 CHECK 충족 종료 자료다. 파일 삭제나 원 금융 row 수정은 수행하지 않는다.
      await f.admin.accountTransaction(f.seed.accountId,async tx=>{
        await tx.client.query("UPDATE processing_requests SET state='COMPLETED',terminal_at=$3,terminal_evidence_ref='B3C_HISTORY_COMPLETED',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.requestId,tx.now]);
        await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.consumer!.contextId,tx.now]);
        await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$2 WHERE account_id=$1",[f.seed.accountId,new Date(tx.now.valueOf()-1000)]);
      });
      const context=(await f.admin.pool.query('SELECT lifecycle,owner_session_id,owner_tab_id,owner_capability_digest,owner_revision::text,workspace_revision::text FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.consumer!.contextId])).rows[0];
      expect(context).toMatchObject({lifecycle:'CLOSED',owner_session_id:null,owner_tab_id:null,owner_capability_digest:null});
      expect(BigInt(context.owner_revision)).toBeGreaterThan(BigInt(originalOwnerRevision));expect(BigInt(context.workspace_revision)).toBeGreaterThan(BigInt(originalWorkspaceRevision));
      const assets=(await f.admin.pool.query<{deletion_state:string;expired:boolean}>('SELECT deletion_state,access_deadline<clock_timestamp() expired FROM manga_web.assets WHERE account_id=$1',[f.seed.accountId])).rows;expect(assets.length).toBeGreaterThan(0);expect(assets.every(asset=>asset.deletion_state==='CONFIRMED'&&asset.expired)).toBe(true);
      reopened=f.reopenCost();
      const view=await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.readIn(tx,f.consumer!),true);expect(view).toEqual(before.cost);
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.checkpoints.finalCommitIn(tx,f.consumer!),true)).toBe('WAIT');
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.checkpoints.sealedFinalCostIn(tx,f.consumer!,joined),true)).toBe('VERIFIED');
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.checkpoints.sealedFinalCostIn(tx,f.consumer!,joined.filter(ref=>ref.evidenceId!==required.evidenceId)),true)).toBe('WAIT');
      const crossed=structuredClone(joined);crossed.find(ref=>ref.evidenceId===required.evidenceId)!.evidenceDigest=sha256('B3C 과거 FINAL 다른 digest');
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.checkpoints.sealedFinalCostIn(tx,f.consumer!,crossed),true)).toBe('WAIT');
      await reopened.finishAttempt(f.consumer!);await reopened.idle();
      const reread=await f.worker.accountTransaction(f.seed.accountId,tx=>reopened!.readIn(tx,f.consumer!),true);expect(reread).toEqual(before.cost);
      expect(await b3cPhFinancial(f)).toEqual(before);expect(io.read.mock.calls).toHaveLength(reads);expect(io.put.mock.calls).toHaveLength(puts);
    },[async()=>{if(reopened)await reopened.idle();},()=>f.cost.idle()]);
  });
},120000);

function b3cPgExactFinancial(state:Awaited<ReturnType<B3CPgFixture['inspect']>>,amount:string){
  const calculations=state.financialRefs.filter(row=>row.kind==='OPERATIONAL_COST_CALCULATION');
  expect(calculations).toHaveLength(1);const original=calculations[0];
  expect(digest(original.protected_observation)).toBe(original.evidence_digest);
  expect(state.cost.sealedCalculation).toEqual({evidenceId:original.evidence_id,evidenceDigest:original.evidence_digest});
  expect(state.totals).toHaveLength(1);
  expect(state.totals[0]).toMatchObject({stage_usd:amount,expense_usd:amount,evidence_id:original.evidence_id,evidence_digest:original.evidence_digest});
  expect(state.totals[0].usage_ref).toBe('execution-evidence:'+original.evidence_id+':'+original.evidence_digest);
  expect(original.received_at).toBeInstanceOf(Date);expect(state.totals[0].confirmed_at).toBeInstanceOf(Date);
  expect(state.permits).toHaveLength(1);expect(state.budgets).toHaveLength(1);
  return original;
}

it.each(['EXECUTION','REQUEST_CHECKPOINT'] as const)('B3-C C3-05 원 %s producer CACHE는 현재 FINAL 비용에 CPU를 다시 귀속하지 않는다',async producer=>{
  await b3cPgCase(()=>({mode:'E2_FINAL',cacheProducer:producer}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores),account=f.seed.accountId;
    expect(f.producerBefore.go).toHaveLength(1);expect(f.producerBefore.intents).toHaveLength(1);
    const originalIntent=f.producerBefore.intents[0],jobId=originalIntent.job_id;
    expect(originalIntent.protected_intent).toMatchObject({jobId,targetKind:producer});
    const originalReceipts=await b3cPgProducerReceipts(f,jobId);
    const oldCostItems=(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 ORDER BY cost_item_id',[account])).rows;
    const oldExpenses=(await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 ORDER BY cost_item_id',[account])).rows;
    const oldFinancial=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY evidence_id",[account])).rows;
    expect(oldCostItems.some(row=>row.actual_usd!==null&&Number(row.actual_usd)>0)).toBe(true);
    expect(oldFinancial).not.toEqual([]);expect(oldExpenses).not.toEqual([]);
    // 과거 요청의 원 RECONCILE이 먼저 선택될 수 있으므로 실제 큐를 제한된 횟수로 진행한다.
    let turns=0;do{await f.runBoundary();turns++;}while(!f.consumer&&turns<4);
    expect(f.consumer).not.toBeNull();expect(turns).toBeLessThanOrEqual(4);
    console.info(JSON.stringify({b3cCacheOriginalQueueClaims:{producer,turns}}));const state=await f.inspect();
    expect(state.inputs).toHaveLength(1);expect(state.enrollments).toHaveLength(1);expect(state.roots).toHaveLength(1);expect(state.bases).toHaveLength(1);
    expect(f.finalResult).toBe(true);expect(f.finalEligible).toBe('ELIGIBLE');expect(state.pre.state).toBe('VERIFIED');expect(state.pre.jobIds).toEqual([]);
    expect(state.final.state).toBe('VERIFIED');expect(state.final.jobIds).toEqual([jobId]);
    expect(state.final.attempt?.targets.map(target=>target.sourceExecutionId)).toEqual([f.source.executionId,f.consumer!.executionId]);
    const operations=(await b3cPgEvidence(f)).filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION').map(row=>b3cPgValue<B3CPgOperation>(row)).filter(op=>op.attemptId===state.final.attempt?.attemptId);
    expect(operations).toHaveLength(2);
    const source=operations.find(op=>op.targetDigest===digest(state.final.attempt!.targets[0])),self=operations.find(op=>op.targetDigest===digest(state.final.attempt!.targets[1]));
    expect(source?.native).toHaveLength(1);expect(source?.native[0]).toMatchObject({origin:'CACHE',intent:originalIntent.protected_intent});
    expect(self?.native).toEqual([]);
    expect(state.cost.state).toBe('CONFIRMED');expect(state.cost.costUsd).toBe('0.013000000000');
    b3cPgExactFinancial(state,'0.013000000000');
    expect(state.counts).toMatchObject({go:1,intents:1,bindings:0,cacheUses:1,calculation:1,closure:1,seal:1,expense:1});
    expect(state.counts.starts).toBeGreaterThan(0);expect(state.counts.ends).toBe(state.counts.starts);
    expect(io.read.mock.calls.length).toBeGreaterThan(0);expect(io.put).not.toHaveBeenCalled();
    const native=await b3cPgNativeCounts(f);expect(native).toMatchObject({admissions:1,intents:1,go:1,bindings:1,cacheUses:1});
    expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',[account])).rows).toEqual(f.producerBefore.intents);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1 ORDER BY job_id',[account])).rows).toEqual(f.producerBefore.go);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY job_id,event,observation_id',[account])).rows).toEqual(f.producerBefore.observations);
    expect(await b3cPgProducerReceipts(f,jobId)).toEqual(originalReceipts);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND cost_item_id=ANY($2::uuid[]) ORDER BY cost_item_id',[account,oldCostItems.map(row=>row.cost_item_id)])).rows).toEqual(oldCostItems);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND cost_item_id=ANY($2::uuid[]) ORDER BY cost_item_id',[account,oldExpenses.map(row=>row.cost_item_id)])).rows).toEqual(oldExpenses);
    expect((await f.admin.pool.query('SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=ANY($2::uuid[]) ORDER BY evidence_id',[account,oldFinancial.map(row=>row.evidence_id)])).rows).toEqual(oldFinancial);
    const calculation=(state.financialRefs.find(row=>row.kind==='OPERATIONAL_COST_CALCULATION')!.protected_observation as {value:{facts:{quantities:{componentId:string;quantity:string}[]}}}).value;
    expect(calculation.facts.quantities.find(q=>q.componentId==='native-image')?.quantity).toBe('0');
    expect(calculation.facts.quantities.find(q=>q.componentId==='semantic')?.quantity).toBe('3');
    const before=await f.inspect();await f.cost.finishAttempt(f.consumer!);await f.cost.idle();expect(await f.inspect()).toEqual(before);
  });
},120000);

it('B3-C 선행 checkpoint를 검증한 새 PRE 작업은 선행 확정 비용의 원 집합을 바꾸지 않는다',async()=>{
  await b3cPgCase(()=>({mode:'PRE_BOUNDARY'}),async f=>{
    const original=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true);
    expect(original.state).toBe('CONFIRMED');expect(original.costUsd).toBe('0.010000000000');expect(original.sealedCalculation).not.toBeNull();
    const sourceFinancial=async()=>({
      records:(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY evidence_id",[f.seed.accountId,f.source.executionId])).rows,
      costs:(await f.admin.pool.query("SELECT cost_item_id,actual_usd::text,usage_ref,confirmed_at,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id",[f.seed.accountId,f.source.executionId])).rows
    });
    const before=await sourceFinancial();expect(before.records).toHaveLength(3);expect(before.costs).toHaveLength(1);expect(before.costs[0].evidence_conflict).toBe(false);
    type RawRow={kind:string;id:string;ref:{evidenceId:string;evidenceDigest:string}|null;contentDigest:string;completedAt:string|null};
    type Census={rows:RawRow[];originals:unknown[];manifest:unknown;rawSetDigest:string};
    const sourceRefs=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{kind:string;evidence_id:string;evidence_digest:string}>("SELECT kind,evidence_id,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind,evidence_id",[f.seed.accountId,f.source.executionId])).rows,true);
    const sourceInputs=sourceRefs.filter(row=>row.kind==='INPUT'),sourceBases=sourceRefs.filter(row=>row.kind==='OPERATIONAL_COST_BASIS');expect(sourceInputs).toHaveLength(1);expect(sourceBases).toHaveLength(1);
    expect(sourceInputs[0].evidence_digest).toBe(digest(canonicalInput(f.source)));
    const sourceSelector={executionId:f.source.executionId,inputEvidenceId:sourceInputs[0].evidence_id,inputFingerprint:sourceInputs[0].evidence_digest,basisRef:{evidenceId:sourceBases[0].evidence_id,evidenceDigest:sourceBases[0].evidence_digest}};
    const census=async()=>{const value=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{value:Census|null}>('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify({version:1,mode:'CENSUS',owner:sourceSelector})])).rows[0].value,true);expect(value).not.toBeNull();return value!;};
    // 공개 CENSUS 원행은 바꾸지 않고 admin의 원 관계만 별도로 관측한다.
    const relations=async(rows:RawRow[])=>(await f.admin.pool.query(`
      WITH raw AS(SELECT kind,id FROM jsonb_to_recordset($2::jsonb) AS x(kind text,id text)),job_rows AS(
        SELECT 'INTENT' kind,job_id::text id,job_id FROM manga_web.native_job_intents WHERE account_id=$1
        UNION ALL SELECT 'RESERVATION',reservation_id::text,job_id FROM manga_web.native_capacity_reservations WHERE account_id=$1
        UNION ALL SELECT 'ADOPTION',d.adoption_id::text,r.job_id FROM manga_web.native_capacity_adoptions d JOIN manga_web.native_capacity_reservations r USING(account_id,reservation_id) WHERE d.account_id=$1
        UNION ALL SELECT 'ATTEMPT',attempt_id::text,job_id FROM manga_web.native_controller_attempts WHERE account_id=$1
        UNION ALL SELECT 'CONTROLLER_EVENT',e.event_id::text,a.job_id FROM manga_web.native_controller_events e JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE e.account_id=$1
        UNION ALL SELECT 'GO_GRANT',job_id::text,job_id FROM manga_web.native_controller_go_grants WHERE account_id=$1
        UNION ALL SELECT 'GO_CONSUMPTION',job_id::text,job_id FROM manga_web.native_job_go_consumptions WHERE account_id=$1
        UNION ALL SELECT 'OBSERVATION',observation_id::text,job_id FROM manga_web.native_job_observations WHERE account_id=$1
        UNION ALL SELECT 'ORIGIN',o.attempt_id::text,a.job_id FROM manga_web.windows_native_origins o JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE o.account_id=$1
        UNION ALL SELECT 'WINDOWS_EVENT',e.event_id::text,a.job_id FROM manga_web.windows_native_events e JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE e.account_id=$1
        UNION ALL SELECT 'WINDOWS_RECORD',r.record_id::text,a.job_id FROM manga_web.windows_native_records r JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE r.account_id=$1
        UNION ALL SELECT 'WINDOWS_LINK',l.link_id::text,a.job_id FROM manga_web.windows_native_links l JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE l.account_id=$1
        UNION ALL SELECT 'RAW_RESULT',r.raw_result_id::text,a.job_id FROM manga_web.native_controller_raw_results r JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE r.account_id=$1
        UNION ALL SELECT 'RAW_OBJECT',o.raw_result_id::text||'/'||o.blob_id,a.job_id FROM manga_web.native_controller_object_receipts o JOIN manga_web.native_controller_raw_results r USING(account_id,raw_result_id) JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE o.account_id=$1
        UNION ALL SELECT 'EVIDENCE',e.evidence_id::text,i.job_id FROM manga_web.execution_evidence e JOIN manga_web.native_job_intents i ON i.account_id=e.account_id AND(i.job_id::text=e.protected_observation->'value'->'binding'->>'jobId' OR i.job_id::text=e.protected_observation->'value'->>'jobId') WHERE e.account_id=$1 AND e.kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')
      )
      SELECT raw.kind,raw.id,e.kind evidence_kind,e.execution_id evidence_execution_id,j.job_id,
        r.source_execution_id,r.source_input_evidence_id,r.base_execution_id,i.target_kind,i.target_id,i.protected_intent->'claim' claim,
        b.execution_id cost_execution_id,b.call_id,c.scope_id,s.execution_id scope_execution_id,root.execution_id root_execution_id,root.owner_identity
      FROM raw LEFT JOIN job_rows j USING(kind,id)
      LEFT JOIN manga_web.execution_evidence e ON e.account_id=$1 AND raw.kind='EVIDENCE' AND e.evidence_id::text=raw.id
      LEFT JOIN manga_web.native_job_intents i ON i.account_id=$1 AND i.job_id=j.job_id
      LEFT JOIN manga_web.native_capacity_reservations r ON r.account_id=i.account_id AND r.job_id=i.job_id
      LEFT JOIN manga_web.windows_native_cost_bindings b ON b.account_id=i.account_id AND b.job_id=i.job_id
      LEFT JOIN manga_web.windows_native_cost_calls c ON c.account_id=b.account_id AND c.call_id=b.call_id
      LEFT JOIN manga_web.windows_native_cost_scopes s ON s.account_id=c.account_id AND s.scope_id=c.scope_id
      LEFT JOIN manga_web.windows_native_cost_roots root ON root.account_id=s.account_id AND root.execution_id=s.execution_id
      ORDER BY raw.kind COLLATE "C",raw.id COLLATE "C",j.job_id`,[f.seed.accountId,JSON.stringify(rows)])).rows;
    const rawBefore=await census(),relationsBefore=await relations(rawBefore.rows);
    await f.runBoundary();
    const rawAfter=await census(),relationsAfter=await relations(rawAfter.rows);
    const difference=(left:RawRow[],right:RawRow[])=>left.filter(row=>!right.some(other=>other.kind===row.kind&&other.id===row.id&&digest(other)===digest(row)));
    const removedOrChanged=difference(rawBefore.rows,rawAfter.rows),addedOrChanged=difference(rawAfter.rows,rawBefore.rows);
    console.info(JSON.stringify({b3cPredecessorRawCensus:{selector:sourceSelector,before:rawBefore,after:rawAfter,difference:{removedOrChanged,addedOrChanged,originalsChanged:digest(rawBefore.originals)!==digest(rawAfter.originals),manifestChanged:digest(rawBefore.manifest)!==digest(rawAfter.manifest),rawSetDigestChanged:rawBefore.rawSetDigest!==rawAfter.rawSetDigest}}}));
    const changedRelations=(values:typeof relationsBefore)=>values.filter(value=>[...removedOrChanged,...addedOrChanged].some(row=>row.kind===value.kind&&row.id===value.id));
    console.info(JSON.stringify({b3cPredecessorRawRelations:{before:changedRelations(relationsBefore),after:changedRelations(relationsAfter)}}));
    const current=await f.inspect();
    expect(current.pre.state).toBe('VERIFIED');expect(current.pre.jobIds).toHaveLength(1);
    expect(f.consumer!.executionId).not.toBe(f.source.executionId);
    const owners=(await f.admin.pool.query("SELECT bi.execution_id AS cost_execution_id,n.source_execution_id,ni.target_kind FROM manga_web.windows_native_cost_bindings bi JOIN manga_web.native_capacity_reservations n USING(account_id,job_id) JOIN manga_web.native_job_intents ni USING(account_id,job_id) WHERE bi.account_id=$1 AND bi.job_id=$2",[f.seed.accountId,current.pre.jobIds[0]])).rows;
    expect(owners).toEqual([{cost_execution_id:f.consumer!.executionId,source_execution_id:f.source.executionId,target_kind:'REQUEST_CHECKPOINT'}]);
    const after=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true),financial=await sourceFinancial();
    console.info(JSON.stringify({b3cPredecessorCost:{before:{state:original.state,costUsd:original.costUsd},after:{state:after.state,costUsd:after.costUsd,conflicts:after.conflicts},owners}}));
    expect.soft(after.state).toBe('CONFIRMED');expect.soft(after.costUsd).toBe(original.costUsd);expect.soft(after.sealedCalculation).toEqual(original.sealedCalculation);
    expect.soft(financial.records).toEqual(before.records);expect.soft(financial.costs).toEqual(before.costs);
    expect(current.cost.state).toBe('UNCONFIRMED');expect(current.counts).toMatchObject({go:1,calculation:0,closure:0,expense:0});
  });
},120000);


async function fixSourceFinancial(f:B3CPgFixture){return {
  costs:(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',[f.seed.accountId,f.source.executionId])).rows,
  refs:(await f.admin.pool.query("SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY evidence_id",[f.seed.accountId,f.source.executionId])).rows,
  expenses:(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',[f.seed.accountId,f.source.executionId])).rows
};}

// GO 전과 GO 직후를 실제 DB 포트에서 지연한다. 성공 응답을 대체하지 않는다.
async function fixSourceSealView(f:B3CPgFixture){
  const row=(await f.admin.pool.query("SELECT owner_body,raw_set_digest,membership_digest,work_set,seal_id,seal_digest FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,f.source.executionId])).rows[0];expect(row).toBeDefined();
  const query={version:1,mode:'CENSUS',owner:(({claim:_claim,validationAttemptRef:_attempt,...rest})=>rest)(row.owner_body)};
  const work=structuredClone(row.work_set);work.terminationEvidence=work.terminationEvidence.filter((ref:{evidenceId:string})=>ref.evidenceId!==row.seal_id);
  const candidate={version:1,rawSetDigest:row.raw_set_digest,membershipDigest:row.membership_digest,nonWindowsWorkSet:work,workSet:work,completion:work.completion};
  return {row,query,candidate};
}
it.each(['BEFORE_GO','AFTER_GO'] as const)('B3-C FIX foreign %s keeps healthy A exact but rejects contradictory unbridged ownership',async phase=>{
  await b3cPgCase(()=>({mode:'PRE_BOUNDARY'}),async(f,restores)=>{
    const old=await fixSourceSealView(f),before=await fixSourceFinancial(f),read=async()=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(old.query)])).rows[0].value,true),original=await read();expect(original).not.toBeNull();
    const normalSeal=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(old.row.owner_body),JSON.stringify(old.candidate)])).rows[0].value,true);expect(normalSeal).not.toBeNull();
    const entered=deferred<void>(),release=deferred<void>(),decision=f.controllerDb.decision.bind(f.controllerDb);let intercepted=false;
    f.controllerDb.decision=async(accountId,sql,values,check)=>{
      const stop=!intercepted&&sql.includes('windows_native_grant_go');
      if(stop){intercepted=true;if(phase==='BEFORE_GO'){entered.resolve();await release.promise;}}
      const result=await decision(accountId,sql,values,check);
      if(stop&&phase==='AFTER_GO'){entered.resolve();await release.promise;}
      return result;
    };
    restores.push(()=>{f.controllerDb.decision=decision;});
    const pending=f.runBoundary(),done=pending.then(value=>({value,error:null}),error=>({value:null,error}));
    try{
      await Promise.race([entered.promise,done.then(result=>{throw result.error??Error('원 GO 경계에 도달하지 않았다');})]);
      expect(f.consumer).not.toBeNull();expect(await read()).toEqual(original);
      const jobs=(await f.admin.pool.query("SELECT r.*,i.owner_service intent_owner FROM manga_web.native_capacity_reservations r JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.windows_native_cost_bindings b USING(account_id,job_id) WHERE r.account_id=$1 AND r.source_execution_id=$2 AND b.execution_id=$3",[f.seed.accountId,f.source.executionId,f.consumer!.executionId])).rows;expect(jobs).toHaveLength(1);
      const job=jobs[0];expect(job.owner_service).toBe(job.intent_owner);expect(job.root_kind).toBe('STANDALONE');expect(job.base_execution_id).toBeNull();
      expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')",[f.seed.accountId,f.source.executionId])).rows).toEqual([{n:0}]);
      expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,job.job_id])).rows).toEqual([{n:phase==='BEFORE_GO'?0:1}]);
      const third=(await f.admin.pool.query('SELECT execution_id FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id<>$2 AND execution_id<>$3 ORDER BY execution_id',[f.seed.accountId,f.source.executionId,f.consumer!.executionId])).rows;expect(third.length).toBeGreaterThan(0);
      for(const fault of ['SERVICE','THIRD_BASE'] as const){
        const result=await f.admin.accountTransaction(f.seed.accountId,async tx=>{
          await tx.client.query('SAVEPOINT ownership_fault');
          try{
            // 폐기 DB의 관리자 손상 주입만 허용한다. 공개 판정 전 원 trigger를 복구한다.
            await tx.client.query('ALTER TABLE manga_web.native_capacity_reservations DISABLE TRIGGER native_capacity_reservation_record');
            if(fault==='SERVICE')await tx.client.query("UPDATE manga_web.native_capacity_reservations SET owner_service='trio_web_api' WHERE account_id=$1 AND reservation_id=$2",[f.seed.accountId,job.reservation_id]);
            else await tx.client.query("UPDATE manga_web.native_capacity_reservations SET root_kind='EXECUTION',base_execution_id=$3 WHERE account_id=$1 AND reservation_id=$2",[f.seed.accountId,job.reservation_id,third[0].execution_id]);
            await tx.client.query('ALTER TABLE manga_web.native_capacity_reservations ENABLE TRIGGER native_capacity_reservation_record');
            expect((await tx.client.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='manga_web.native_capacity_reservations'::regclass AND tgname='native_capacity_reservation_record'")).rows).toEqual([{tgenabled:'O'}]);
            await tx.client.query('SET LOCAL ROLE trio_web_worker');
            const census=(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(old.query)])).rows[0].value;
            const seal=(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(old.row.owner_body),JSON.stringify(old.candidate)])).rows[0].value;
            return {census,seal};
          }finally{await tx.client.query('ROLLBACK TO SAVEPOINT ownership_fault');await tx.client.query('RELEASE SAVEPOINT ownership_fault');}
        },true);
        expect.soft(result.census,fault+' 소속 모순은 원 A의 public CENSUS에서 숨기면 안 된다').toBeNull();
        expect.soft(result.seal,fault+' 소속 모순은 원 A의 public SEAL 재조회도 차단한다').toBeNull();
      }
      expect(await read()).toEqual(original);expect(await fixSourceFinancial(f)).toEqual(before);
      console.info(JSON.stringify({b3cForeignUnbridged:{phase,actualGo:phase==='AFTER_GO',bridgeCount:0,normalRawExact:true,faults:['SERVICE','THIRD_BASE']}}));
    }finally{release.resolve();await done;}
    const result=await done;expect(result.error).toBeNull();expect(result.value).toBeUndefined();
    expect(await read()).toEqual(original);
    expect((await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true)).state).toBe('CONFIRMED');
  });
},120000);



it('B3-C FIX foreign completed source branches retain unknown jobs and reject corrupt bridge refs without changing old money',async()=>{
  await b3cPgCase(()=>({mode:'PRE_BOUNDARY'}),async f=>{
    const old=await fixSourceSealView(f),read=async()=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(old.query)])).rows[0].value,true),original=await read();
    await f.runBoundary();const state=await f.inspect();expect(state.pre.state).toBe('VERIFIED');expect(state.pre.jobIds).toHaveLength(1);expect(await read()).toEqual(original);
    const jobId=state.pre.jobIds[0],account=f.seed.accountId,before=await fixSourceFinancial(f);
    const normalSeal=await f.worker.accountTransaction(account,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(old.row.owner_body),JSON.stringify(old.candidate)])).rows[0].value,true);expect(normalSeal).not.toBeNull();
    const bridge=(await f.admin.pool.query("SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY kind",[account,f.source.executionId])).rows;expect(bridge).toHaveLength(2);
    const alternative=(await f.admin.pool.query('SELECT p.* FROM manga_web.native_capacity_profiles p WHERE p.profile_id<>(SELECT profile_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND job_id=$2) ORDER BY profile_id LIMIT 1',[account,jobId])).rows;expect(alternative).toHaveLength(1);
    const faultNames=['MISSING_BINDING','WRONG_PROFILE','MISSING_OPERATION','MISSING_TERMINATION','DUPLICATE_OPERATION','SOURCE_REF','ORPHAN_BRIDGE','OWN_RAW_EXTRA'] as const;
    for(const fault of faultNames){
      const result=await f.admin.accountTransaction(account,async tx=>{
        await tx.client.query('SAVEPOINT completed_fault');let injectedId:string|null=null;
        try{
          if(fault==='MISSING_BINDING'||fault==='SOURCE_REF'){
            await tx.client.query('ALTER TABLE manga_web.windows_native_cost_bindings DISABLE TRIGGER immutable_record');
            if(fault==='MISSING_BINDING')await tx.client.query('DELETE FROM manga_web.windows_native_cost_bindings WHERE account_id=$1 AND job_id=$2',[account,jobId]);
            else await tx.client.query("UPDATE manga_web.windows_native_cost_bindings SET protected_capacity=jsonb_set(protected_capacity,'{sourceInput,inputEvidenceId}',to_jsonb($3::text)) WHERE account_id=$1 AND job_id=$2",[account,jobId,randomUUID()]);
            await tx.client.query('ALTER TABLE manga_web.windows_native_cost_bindings ENABLE TRIGGER immutable_record');
          }else if(fault==='WRONG_PROFILE'){
            await tx.client.query('ALTER TABLE manga_web.native_capacity_reservations DISABLE TRIGGER native_capacity_reservation_record');
            await tx.client.query('UPDATE manga_web.native_capacity_reservations SET profile_id=$3,profile_digest=$4,profile_version=$5 WHERE account_id=$1 AND job_id=$2',[account,jobId,alternative[0].profile_id,alternative[0].profile_digest,alternative[0].profile_version]);
            await tx.client.query('ALTER TABLE manga_web.native_capacity_reservations ENABLE TRIGGER native_capacity_reservation_record');
          }else if(fault==='MISSING_OPERATION'||fault==='MISSING_TERMINATION'){
            const selected=bridge.find(row=>row.kind===(fault==='MISSING_OPERATION'?'WINDOWS_NATIVE_OPERATION':'WINDOWS_NATIVE_TERMINATION'))!;
            await tx.client.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[account,selected.evidence_id]);
          }else{
            const op=bridge.find(row=>row.kind==='WINDOWS_NATIVE_OPERATION')!;
            const wrapper=fault==='DUPLICATE_OPERATION'?{...op.protected_observation,value:{...op.protected_observation.value,windowsEvidenceRef:{...op.protected_observation.value.windowsEvidenceRef,recordId:randomUUID()}}}:{version:1,accountId:account,executionId:f.source.executionId,inputDigest:f.source.inputDigest,inputFingerprint:digest(canonicalInput(f.source)),kind:fault==='OWN_RAW_EXTRA'?'FIX_OWN_RAW_DRIFT':'WINDOWS_NATIVE_OPERATION',value:fault==='OWN_RAW_EXTRA'?{version:1,eventId:randomUUID()}:{binding:{jobId:'invalid-job-id'}}};
            injectedId=randomUUID();
            await tx.client.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)',[account,injectedId,f.source.executionId,wrapper.kind,digest(wrapper),JSON.stringify(wrapper)]);
          }
          const triggerStates=(await tx.client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE (tgrelid='manga_web.windows_native_cost_bindings'::regclass AND tgname='immutable_record') OR(tgrelid='manga_web.native_capacity_reservations'::regclass AND tgname='native_capacity_reservation_record') ORDER BY tgname")).rows;expect(triggerStates).toHaveLength(2);expect(triggerStates.every(row=>row.tgenabled==='O')).toBe(true);
          await tx.client.query('SET LOCAL ROLE trio_web_worker');
          const census=(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(old.query)])).rows[0].value;
          const seal=(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(old.row.owner_body),JSON.stringify(old.candidate)])).rows[0].value;
          return {census,seal,injectedId};
        }finally{await tx.client.query('ROLLBACK TO SAVEPOINT completed_fault');await tx.client.query('RELEASE SAVEPOINT completed_fault');}
      },true);
      expect.soft(result.seal,fault+' 공개 SEAL은 정확한 정상 후보로도 손상을 거부한다').toBeNull();
      if(fault==='MISSING_BINDING'){
        expect(result.census).not.toBeNull();expect(result.census.rows.some((row:{kind:string;id:string})=>row.kind==='INTENT'&&row.id===jobId)).toBe(true);
        expect(result.census.originals.some((row:{classification:string})=>row.classification==='UNCONFIRMED')).toBe(true);
      }else if(fault==='OWN_RAW_EXTRA'){
        expect(result.census).not.toBeNull();expect(result.census.rows.some((row:{kind:string;id:string})=>row.kind==='EVIDENCE'&&row.id===result.injectedId)).toBe(true);expect(result.census.rawSetDigest).not.toBe(original.rawSetDigest);
      }else expect.soft(result.census,fault+' foreign bridge나 출처의 모순은 제외하면 안 된다').toBeNull();
      expect(await read()).toEqual(original);expect(await fixSourceFinancial(f)).toEqual(before);
    }
    expect((await f.worker.accountTransaction(account,tx=>f.cost.readIn(tx,f.source),true)).state).toBe('CONFIRMED');
    console.info(JSON.stringify({b3cForeignCompleted:{faults:faultNames,oldRawExact:true,oldMoneyExact:true}}));
  });
},120000);


// A 우선의 B 대기는 admission 거래 입구의 accountContext 행 잠금이다. admission SQL 본문 대기로 잘못 보고하지 않는다.
import type {PoolClient as FixForeignRaceClient} from 'pg';

type FixForeignRaceOrder='A_SEAL_FIRST'|'B_ADMIT_FIRST';
type FixForeignRaceResult={value:void|null;error:unknown};
type FixForeignRaceBlock={pid:number;blockers:number[];state:string;wait_event_type:string|null;query:string;blockingPath?:number[]};
type FixForeignRaceTrace={misses:number;admitCalls:number;admitCommits:number;accountWaitPid:number|null;admitPid:number|null;accountAttempt:number|null;admitAttempt:number|null;admitTransactionAttempts:number;intent:Record<string,unknown>|null;capacity:Record<string,unknown>|null;decision:Record<string,unknown>|null;queries:string[]};

async function fixForeignRaceBarrier<T>(barrier:Promise<T>,done:Promise<FixForeignRaceResult>):Promise<T>{
  return Promise.race([barrier,done.then(result=>{throw result.error??new Error('요청한 실제 SQL 경계 전에 실행기가 종료됐다');})]);
}
async function fixForeignRaceBlocked(f:B3CPgFixture,waiter:number,holder:number):Promise<FixForeignRaceBlock>{
  const deadline=Date.now()+5000;let last:FixForeignRaceBlock|undefined;
  do{
    last=(await f.admin.pool.query<FixForeignRaceBlock>("SELECT pid,pg_blocking_pids(pid) blockers,state,wait_event_type,left(query,512) query FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",[waiter])).rows[0];
    let blockingPath:number[]|undefined;
    if(last?.blockers.includes(holder))blockingPath=[waiter,holder];
    else if(last?.blockers.length){
      const paths=await f.admin.pool.query<{path:number[]}>("WITH RECURSIVE lock_waits AS(SELECT pid,pg_blocking_pids(pid) blockers,ARRAY[pid] path FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 UNION ALL SELECT p.pid,pg_blocking_pids(p.pid),w.path||p.pid FROM lock_waits w CROSS JOIN LATERAL unnest(w.blockers) b(pid) JOIN pg_stat_activity p ON p.pid=b.pid WHERE p.datname=current_database() AND NOT(p.pid=ANY(w.path)) AND cardinality(w.path)<8) SELECT path FROM lock_waits WHERE pid=$2 ORDER BY cardinality(path) LIMIT 1",[waiter,holder]);blockingPath=paths.rows[0]?.path;
    }
    if(blockingPath){expect(blockingPath[0]).toBe(waiter);expect(blockingPath.at(-1)).toBe(holder);expect(last!.state).toBe('active');expect(last!.wait_event_type).toBe('Lock');return {...last!,blockingPath};}
    await new Promise(resolve=>setTimeout(resolve,10));
  }while(Date.now()<deadline);
  throw new Error('실제 pg_blocking_pids 장벽에 도달하지 않았다: '+JSON.stringify({waiter,holder,last}));
}
function fixForeignRaceInstall(f:B3CPgFixture,restores:B3CPgRestore[]){
  const transaction=f.worker.transaction.bind(f.worker),missCommitted=deferred<number>(),continueAfterMiss=deferred<void>(),accountIssued=deferred<number>(),beforeAdmit=deferred<number>(),continueAdmit=deferred<void>(),admitted=deferred<number>(),allowCommit=deferred<void>(),committed=deferred<number>(),continueAfterCommit=deferred<void>();
  const trace:FixForeignRaceTrace={misses:0,admitCalls:0,admitCommits:0,accountWaitPid:null,admitPid:null,accountAttempt:null,admitAttempt:null,admitTransactionAttempts:0,intent:null,capacity:null,decision:null,queries:[]};
  let firstMiss=false,observeNextAccount=false,accountObserved=false,transactionAttempt=0;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>{
    let thisMiss=false,thisAdmit=false,pid:number|null=null,attempts=0;const queries:string[]=[];
    const value=await transaction(async client=>{
      const attempt=++transactionAttempt;attempts++;
      const original=client.query,querySpy=vi.spyOn(client,'query');
      const wrapped=(async(...args:unknown[])=>{
        const first=args[0],sql=typeof first==='string'?first:first&&typeof first==='object'&&'text'in first?String((first as {text:unknown}).text):'';queries.push(sql);
        const backend=async()=>{if(pid===null)pid=(await Reflect.apply(original,client,['SELECT pg_backend_pid() pid'])).rows[0].pid as number;return pid;};
        if(observeNextAccount&&!accountObserved&&/SELECT \* FROM accounts WHERE account_id=\$1 FOR UPDATE/.test(sql)){
          accountObserved=true;trace.accountAttempt=attempt;trace.accountWaitPid=await backend();accountIssued.resolve(trace.accountWaitPid);
        }
        const isAdmit=sql.includes('manga_web.windows_native_cost_admit(');
        if(isAdmit){
          trace.admitCalls++;expect(trace.admitCalls).toBe(1);thisAdmit=true;trace.admitAttempt=attempt;trace.admitPid=await backend();
          const values=args[1] as readonly unknown[];trace.intent=JSON.parse(String(values[1])) as Record<string,unknown>;trace.capacity=JSON.parse(String(values[2])) as Record<string,unknown>;
          beforeAdmit.resolve(trace.admitPid);await continueAdmit.promise;
        }
        const answer:unknown=await Reflect.apply(original,client,args);
        if(sql.includes('manga_web.windows_native_cost_receipt_lookup(')){
          const state=(answer as {rows:{state:{state:string}}[]}).rows[0].state;
          if(!firstMiss&&state.state==='MISS'){firstMiss=true;thisMiss=true;trace.misses++;await backend();}
        }
        if(isAdmit){
          const decision=(answer as {rows:{value:Record<string,unknown>}[]}).rows[0].value;expect(decision.allowed).toBe(true);expect(typeof decision.capacityReservationId).toBe('string');trace.decision=structuredClone(decision);admitted.resolve(trace.admitPid!);await allowCommit.promise;
        }
        return answer;
      }) as FixForeignRaceClient['query'];
      querySpy.mockImplementation(wrapped);
      try{return await run(client);}finally{querySpy.mockRestore();}
    });
    if(thisMiss){
      // 원 MISS 거래가 COMMIT된 뒤 다음 admission 거래를 시작하기 전에만 지연한다.
      expect(pid).not.toBeNull();missCommitted.resolve(pid!);await continueAfterMiss.promise;observeNextAccount=true;
    }
    if(thisAdmit){trace.admitTransactionAttempts=attempts;trace.admitCommits++;trace.queries=[...queries];expect(trace.admitCommits).toBe(1);committed.resolve(trace.admitPid!);await continueAfterCommit.promise;}
    return value;
  });
  const releaseAll=()=>{continueAfterMiss.resolve();continueAdmit.resolve();allowCommit.resolve();continueAfterCommit.resolve();};
  restores.push(()=>{releaseAll();spy.mockRestore();});
  return {trace,missCommitted,continueAfterMiss,accountIssued,beforeAdmit,continueAdmit,admitted,allowCommit,committed,continueAfterCommit,releaseAll};
}

it.each(['A_SEAL_FIRST','B_ADMIT_FIRST'] as const)('B3-C F11 foreign 실제 등록과 A 기존 봉인의 %s 순서는 실제 blocking barrier와 원 비용을 보존한다',async(order:FixForeignRaceOrder)=>{
  await b3cPgCase(()=>({mode:'PRE_BOUNDARY'}),async(f,restores)=>{
    const old=await fixSourceSealView(f),financial=await fixSourceFinancial(f),originalCost=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true);
    expect(originalCost.state).toBe('CONFIRMED');expect(originalCost.costUsd).toBe('0.010000000000');expect(originalCost.sealedCalculation).not.toBeNull();expect(f.consumer).toBeNull();
    const a=await f.worker.pool.connect(),errors:unknown[]=[];let inTransaction=false,done:Promise<FixForeignRaceResult>|undefined,aDone:Promise<{value:unknown;error:unknown}>|undefined,gates:ReturnType<typeof fixForeignRaceInstall>|undefined;
    const begin=async()=>{await a.query('BEGIN');inTransaction=true;await a.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);};
    const commit=async()=>{await a.query('COMMIT');inTransaction=false;};
    const census=async()=>(await a.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(old.query)])).rows[0].value;
    const seal=async()=>(await a.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(old.row.owner_body),JSON.stringify(old.candidate)])).rows[0].value;
    try{
      const identity=(await a.query<{pid:number;current_user:string;session_user:string}>('SELECT pg_backend_pid() pid,current_user,session_user')).rows[0];expect(identity.current_user).toBe('trio_web_worker');expect(identity.session_user).not.toBe(identity.current_user);
      await begin();const raw=await census(),baselineSeal=await seal();expect(raw).not.toBeNull();expect(baselineSeal).not.toBeNull();expect(baselineSeal.ref).toEqual({evidenceId:old.row.seal_id,evidenceDigest:old.row.seal_digest});await commit();
      gates=fixForeignRaceInstall(f,restores);const active=gates;
      done=f.runBoundary().then(value=>({value,error:null}),error=>({value:null,error}));
      await fixForeignRaceBarrier(active.missCommitted.promise,done);expect(active.trace.misses).toBe(1);expect(f.consumer).not.toBeNull();expect(f.claim).not.toBeNull();
      const claim=f.claim!;expect(await f.service.renew(claim)).toBe(true);expect(f.claim).toBe(claim);
      const beforeClaim=(await f.admin.pool.query('SELECT claim_generation,claim_owner,state FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim.workId])).rows;expect(beforeClaim).toEqual([{claim_generation:claim.generation,claim_owner:f.service.workerId,state:'CLAIMED'}]);
      let block:FixForeignRaceBlock,raceSeal:unknown;
      if(order==='A_SEAL_FIRST'){
        // A가 실제 공개 SEAL의 계정/owner 잠금을 보유한 상태에서 B의 실제 admission 거래가 계정 잠금에 대기한다.
        await begin();raceSeal=await seal();expect(raceSeal).toEqual(baselineSeal);expect(await census()).toEqual(raw);
        active.continueAfterMiss.resolve();const blockedPid=await fixForeignRaceBarrier(active.accountIssued.promise,done);expect(blockedPid).not.toBe(identity.pid);expect(active.trace.admitCalls).toBe(0);
        block=await fixForeignRaceBlocked(f,blockedPid,identity.pid);expect(block.query).toContain('SELECT * FROM accounts WHERE account_id=$1 FOR UPDATE');
        expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:0}]);
        await commit();const admissionPid=await fixForeignRaceBarrier(active.beforeAdmit.promise,done);expect(admissionPid).toBe(blockedPid);expect(active.trace.admitAttempt).toBe(active.trace.accountAttempt);
        active.continueAdmit.resolve();expect(await fixForeignRaceBarrier(active.admitted.promise,done)).toBe(blockedPid);expect(active.trace.admitCommits).toBe(0);active.allowCommit.resolve();expect(await fixForeignRaceBarrier(active.committed.promise,done)).toBe(blockedPid);
      }else{
        active.continueAfterMiss.resolve();const admissionPid=await fixForeignRaceBarrier(active.beforeAdmit.promise,done);active.continueAdmit.resolve();expect(await fixForeignRaceBarrier(active.admitted.promise,done)).toBe(admissionPid);expect(active.trace.admitCommits).toBe(0);
        const jobId=String(active.trace.intent!.jobId);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,jobId])).rows).toEqual([{n:0}]);
        await begin();aDone=seal().then(value=>({value,error:null}),error=>({value:null,error}));
        block=await fixForeignRaceBlocked(f,identity.pid,admissionPid);expect(block.query).toContain('manga_web.windows_stage_cost_seal(');
        active.allowCommit.resolve();expect(await fixForeignRaceBarrier(active.committed.promise,done)).toBe(admissionPid);
        const result=await aDone;expect(result.error).toBeNull();raceSeal=result.value;expect(raceSeal).toEqual(baselineSeal);expect(await census()).toEqual(raw);await commit();
      }
      expect(active.trace.admitCalls).toBe(1);expect(active.trace.admitCommits).toBe(1);expect(active.trace.admitTransactionAttempts).toBe(1);expect(active.trace.decision!.allowed).toBe(true);expect(active.trace.queries.some(sql=>sql.includes('manga_web.windows_native_cost_admit('))).toBe(true);
      expect(active.trace.intent!.claim).toEqual({generation:claim.generation,ownerId:f.service.workerId,workItemId:claim.workId});expect(active.trace.capacity!.sourceInput).toEqual({executionId:f.source.executionId,inputEvidenceId:(old.query.owner as {inputEvidenceId:string}).inputEvidenceId,stageInputDigest:f.source.inputDigest});
      expect(f.claim).toBe(claim);expect(await f.service.renew(claim)).toBe(true);
      expect((await f.admin.pool.query('SELECT claim_generation,claim_owner,state FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim.workId])).rows).toEqual(beforeClaim);
      expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:0}]);
      const admitted=(await f.admin.pool.query('SELECT r.job_id,r.source_execution_id,b.execution_id cost_execution_id FROM manga_web.native_capacity_reservations r JOIN manga_web.windows_native_cost_bindings b USING(account_id,job_id) WHERE r.account_id=$1',[f.seed.accountId])).rows;expect(admitted).toEqual([{job_id:active.trace.intent!.jobId,source_execution_id:f.source.executionId,cost_execution_id:f.consumer!.executionId}]);
      await begin();expect(await census()).toEqual(raw);expect(await seal()).toEqual(baselineSeal);await commit();expect(await fixSourceFinancial(f)).toEqual(financial);
      active.continueAfterCommit.resolve();const result=await done;expect(result.error).toBeNull();expect(result.value).toBeUndefined();
      const current=await f.inspect();expect(current.pre.state).toBe('VERIFIED');expect(current.pre.jobIds).toEqual([active.trace.intent!.jobId]);expect(current.cost.state).toBe('UNCONFIRMED');expect(current.counts.go).toBe(1);
      expect(f.claim).toBe(claim);expect((await f.admin.pool.query('SELECT claim_generation FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,f.consumer!.executionId])).rows).toEqual([{claim_generation:claim.generation}]);
      await begin();expect(await census()).toEqual(raw);expect(await seal()).toEqual(baselineSeal);await commit();expect(await fixSourceFinancial(f)).toEqual(financial);
      const history=f.reopenCost();try{const recovered=await f.worker.accountTransaction(f.seed.accountId,tx=>history.readIn(tx,f.source),true);expect(recovered.state).toBe('CONFIRMED');expect(recovered.costUsd).toBe(originalCost.costUsd);expect(recovered.sealedCalculation).toEqual(originalCost.sealedCalculation);}finally{await history.idle();}
      console.info(JSON.stringify({fixForeignRace:{order,block,admissionCalls:active.trace.admitCalls,admissionCommits:active.trace.admitCommits,admissionTransactionAttempts:active.trace.admitTransactionAttempts,accountWaitAttempt:active.trace.accountAttempt,admissionAttempt:active.trace.admitAttempt,admissionPid:active.trace.admitPid,sealPid:identity.pid,sealRef:baselineSeal.ref,sourceFinancialExact:true,sourceCensusExact:true,sameClaim:true,manualRetries:0,realNativeChildCalls:0,externalApiModelCalls:0,sealFirstBlockedAtAccountContext:order==='A_SEAL_FIRST'}}));
    }catch(error){errors.push(error);}
    finally{
      gates?.releaseAll();
      if(inTransaction)try{await a.query('ROLLBACK');inTransaction=false;}catch(error){errors.push(error);}
      if(aDone){const result=await aDone;if(result.error&&!errors.includes(result.error))errors.push(result.error);}
      if(done){const result=await done;if(result.error&&!errors.includes(result.error))errors.push(result.error);}
      a.release();
    }
    if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'F11 원 경쟁 검사와 종료 확인이 함께 실패했다');
  });
},120000);


it('B3-C FIX source and consumer history after shared drift preserve both original costs without new file or native work',async()=>{
  await b3cPgCase(()=>({mode:'E2_FINAL'}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores);await f.runBoundary();
    const originalA=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true),originalB=await b3cPhFinancial(f),moneyA=await fixSourceFinancial(f),rawA=await fixSourceSealView(f);
    expect(originalA.state).toBe('CONFIRMED');expect(originalA.costUsd).toBe('0.010000000000');b3cPhConfirmed(originalB);
    expect(io.read.mock.calls.length).toBeGreaterThan(0);expect(io.put.mock.calls.length).toBeGreaterThan(0);
    const reads=io.read.mock.calls.length,puts=io.put.mock.calls.length;
    await f.admin.accountTransaction(f.seed.accountId,async tx=>{
      await tx.client.query("UPDATE processing_requests SET state='COMPLETED',terminal_at=$3,terminal_evidence_ref='FIX_SHARED_HISTORY',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.requestId,tx.now]);
      await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.consumer!.contextId,tx.now]);
      await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$2 WHERE account_id=$1",[f.seed.accountId,new Date(tx.now.valueOf()-1000)]);
    });
    const fresh=f.reopenCost();restores.push(()=>fresh.idle());
    const a=await f.worker.accountTransaction(f.seed.accountId,tx=>fresh.readIn(tx,f.source),true),b=await f.worker.accountTransaction(f.seed.accountId,tx=>fresh.readIn(tx,f.consumer!),true);
    expect(a).toEqual(originalA);expect(b).toEqual(originalB.cost);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>fresh.checkpoints.finalCommitIn(tx,f.consumer!),true)).toBe('WAIT');
    await fresh.finishAttempt(f.source);await fresh.finishAttempt(f.consumer!);await fresh.idle();
    expect(await fixSourceFinancial(f)).toEqual(moneyA);expect(await b3cPhFinancial(f)).toEqual(originalB);
    const reread=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify(rawA.query)])).rows[0].value,true);
    expect(reread).not.toBeNull();expect(reread.rawSetDigest).toBe(rawA.row.raw_set_digest);
    expect(io.read.mock.calls).toHaveLength(reads);expect(io.put.mock.calls).toHaveLength(puts);
  });
},120000);



// 정상 E2와 같은 원 자료를 유지하고 FINAL의 self target 한 곳만 결손으로 만든다.
it.each(['operations','storage','native'] as const)('B3-C 보완 FINAL 단일 %s 결손은 완전한 다른 비용 자료가 있어도 확정을 막는다',async missing=>{
  let original:B3CPgOperation|undefined,captured:B3CPgContext|undefined,selfRef:{evidenceId:string;evidenceDigest:string}|undefined;
  let factsBefore:import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts|undefined,sourceCalls=0;
  const untouched:B3CPgOperation[]=[];let fileIo:ReturnType<typeof b3cPgFileSpies>|undefined,writesBeforeFault:{key:string;sha256:string;bytesLength:string}[]|undefined;
  const successSnapshot=async(f:B3CPgFixture)=>({outcomes:(await b3cPgEvidence(f)).filter(row=>['OUTCOME','STALE_OUTCOME'].includes(row.kind)),checkpoints:(await f.admin.pool.query('SELECT * FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2 ORDER BY checkpoint_id',[f.seed.accountId,f.consumer!.executionId])).rows});
  let successBefore:Awaited<ReturnType<typeof successSnapshot>>|undefined;
  await b3cPgCase(current=>({mode:'E2_FINAL',beforeValidation:async ctx=>{
    if(ctx.attempt.purpose==='FINAL_COMMIT'&&!successBefore){successBefore=await successSnapshot(current());expect(successBefore.outcomes).toHaveLength(1);expect(successBefore.outcomes[0].kind).toBe('OUTCOME');expect(successBefore.checkpoints).toHaveLength(1);}
  },alterOperation:(operation,ctx)=>{
    if(ctx.attempt.purpose!=='FINAL_COMMIT'||ctx.target.sourceExecutionId!==ctx.consumer.executionId){untouched.push(structuredClone(operation));return operation;}
    expect(ctx.target).toEqual(ctx.attempt.targets.at(-1));original=structuredClone(operation);captured=ctx;
    expect(operation.storage.length).toBeGreaterThan(0);expect(operation.native).toHaveLength(1);
    expect(fileIo).toBeDefined();writesBeforeFault=fileIo!.put.mock.calls.map(([key,bytes])=>({key,sha256:sha256(bytes),bytesLength:String(bytes.length)}));expect(writesBeforeFault).toHaveLength(2);
    return missing==='storage'?{...operation,storage:[]}:missing==='native'?{...operation,native:[]}:operation;
  },afterOperation:async(ref,ctx)=>{
    if(ctx.attempt.purpose==='FINAL_COMMIT'&&ctx.target.sourceExecutionId===ctx.consumer.executionId)selfRef=structuredClone(ref);
  },checkpointFacts:(facts,attempt)=>{
    if(attempt.purpose!=='FINAL_COMMIT')return facts;
    expect(selfRef).toBeDefined();expect(facts.operations).toHaveLength(2);factsBefore=structuredClone(facts);
    return missing==='operations'?{...facts,operations:facts.operations.filter(ref=>ref.evidenceId!==selfRef!.evidenceId)}:facts;
  },beforeCost:async input=>{
    const f=current();sourceCalls++;expect(sourceCalls).toBe(1);expect(input.executionId).toBe(f.consumer!.executionId);
    const live=async()=>expect((await f.admin.pool.query("SELECT state,claim_owner,claim_generation,lease_until>clock_timestamp() AS lease_live FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim!.workId])).rows).toEqual([{state:'CLAIMED',claim_owner:f.service.workerId,claim_generation:f.claim!.generation,lease_live:true}]);
    await live();expect(await successSnapshot(f)).toEqual(successBefore);
    await f.prepareSources('0.01','INCOMPLETE_FINAL');await live();
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'PRE_DISPATCH'),true)).toMatchObject({state:'VERIFIED'});
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'FINAL_COMMIT'),true)).toMatchObject({state:'WAIT'});
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.finalCommitIn(tx,input),true)).toBe('WAIT');
  }}),async(f,restores)=>{
    const io=b3cPgFileSpies(f,restores);fileIo=io;await f.runBoundary();
    const checked=await b3cPgUnconfirmed(f),nativeCounts=await b3cPgNativeCounts(f);
    expect(sourceCalls).toBe(1);expect(f.events.filter(event=>event==='ORIGINAL_SOURCES_READY')).toHaveLength(1);
    expect(f.finalResult).toBe(false);expect(f.finalEligible).toBe('WAIT');expect(checked.state.pre.state).toBe('VERIFIED');expect(checked.state.pre.jobIds).toEqual([]);
    expect(checked.state.final.state).toBe('WAIT');expect(checked.state.final.evidenceIds).toEqual([]);expect(checked.state.final.jobIds).toEqual([]);
    expect(captured?.attempt.purpose).toBe('FINAL_COMMIT');expect(captured?.target.sourceExecutionId).toBe(f.consumer!.executionId);
    expect(factsBefore?.operations).toHaveLength(2);expect(factsBefore?.operations).toContainEqual(selfRef);
    expect(original?.native).toHaveLength(1);expect(original?.storage.length).toBeGreaterThan(0);expect(original?.semantic.outcome).toBe('RETURNED');
    const operations=checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION');expect(operations).toHaveLength(3);expect(untouched).toHaveLength(2);
    for(const operation of untouched)expect(operations.map(row=>b3cPgValue<B3CPgOperation>(row))).toContainEqual(operation);
    const self=operations.find(row=>row.evidence_id===selfRef!.evidenceId)!;expect(self).toBeDefined();expect(digest(self.protected_observation)).toBe(self.evidence_digest);
    expect(b3cPgValue<B3CPgOperation>(self)).toEqual(missing==='storage'?{...original!,storage:[]}:missing==='native'?{...original!,native:[]}:original);
    expect(selfRef).toEqual({evidenceId:self.evidence_id,evidenceDigest:self.evidence_digest});
    const sources=checked.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE').map(row=>b3cPgValue<{operationId:string;eventId:string;fact:Record<string,unknown>}>(row));
    const ends=checked.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION').flatMap(row=>b3cPgValue<{operations:{operationId:string;eventId:string;outcome:string}[]}>(row).operations);
    expect(sources.length).toBeGreaterThan(2);expect(ends).toHaveLength(sources.length);
    for(const source of sources)expect(ends.filter(end=>end.operationId===source.operationId&&end.eventId===source.eventId)).toEqual([{operationId:source.operationId,eventId:source.eventId,outcome:'RETURNED'}]);
    expect(sources.map(source=>source.fact)).toContainEqual(expect.objectContaining({scope:'ACTUAL_AI_USD',state:'CONFIRMED',actualUsd:'0.01'}));
    expect(sources.map(source=>source.fact)).toContainEqual(expect.objectContaining({funding:'FREE_OPERATIONS',state:'CONFIRMED',actualUsd:'0'}));
    expect(sources.map(source=>source.fact)).toContainEqual(expect.objectContaining({componentId:'semantic',state:'CONFIRMED',quantity:'3',unit:'event'}));
    expect(checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')).toHaveLength(2);
    expect(checked.rows.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED')).toHaveLength(1);
    expect(await successSnapshot(f)).toEqual(successBefore);expect(successBefore).toBeDefined();
    expect(io.read.mock.calls.length).toBeGreaterThan(0);expect(writesBeforeFault).toBeDefined();expect(io.put.mock.calls.map(([key,bytes])=>({key,sha256:sha256(bytes),bytesLength:String(bytes.length)}))).toEqual(writesBeforeFault);
    expect(nativeCounts).toMatchObject({go:1,intents:1,bindings:1});expect(nativeCounts.starts).toBeGreaterThan(0);expect(nativeCounts.ends).toBe(nativeCounts.starts);
    const originalReceipts=await b3cPgProducerReceipts(f,original!.native[0].intent.jobId);expect(originalReceipts.candidates[0].protected_candidate).toEqual(original!.native[0].candidate);expect(originalReceipts.receipts[0].protected_receipt).toEqual(original!.native[0].receipt);
    const rawReads=(await f.admin.pool.query<{event:{eventId:string;kind:string;state:string;observed:{sha256:string;bytesLength:string}|null}}>("SELECT en.protected_event AS event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 AND st.protected_request->>'kind'='OBJECT_READ'",[f.seed.accountId,f.consumer!.executionId])).rows;
    for(const event of original!.storage)expect(rawReads).toContainEqual({event:expect.objectContaining({eventId:event.eventId,kind:'OBJECT_READ',state:'RETURNED',observed:{sha256:event.sha256,bytesLength:event.bytesLength}})});
    console.info(JSON.stringify({b3cFinalSingleMissing:{missing,sourceCalls,sourceCount:sources.length,finalState:checked.state.final.state,costState:checked.state.cost.state,costUsd:checked.state.cost.costUsd,counts:checked.state.counts}}));
  });
},120000);

// 기존 tests/postgres/execution-cost-preparation.test.ts 뒤에 붙일 초안이다.
// repo 반영·PG 실행 전이며 제품 publication helper가 실제 반영된 뒤에만 실행한다.
// 원 fixture의 operator confirmWindows만 사용하고 HELD·물리 release0을 유지한다.
type W4CPubFixture=Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>;
type W4CPubClaim=import('../../packages/domain/src/execution.js').Claim;
type W4CPubPrivate={finishCostAttempt(input:StageInput):Promise<void>;finishWindowsPublication(claim:W4CPubClaim,input:StageInput):Promise<boolean>};
type W4CPubRow=import('pg').QueryResultRow;
type W4CPubQuery=<T extends W4CPubRow=W4CPubRow>(sql:string,values?:unknown[])=>Promise<import('pg').QueryResult<T>>;
type W4CPubTick={value:boolean}|{error:unknown};
type W4CPubFileCalls={read:number;put:number};
const w4cPubFileCalls=new WeakMap<W4CPubFixture,W4CPubFileCalls>();
function w4cPubFileSnapshot(f:W4CPubFixture){
  const calls=w4cPubFileCalls.get(f);if(!calls)throw Error('publication 실제 파일 호출 관측 미설치');return {...calls};
}
const w4cPubLiveSql=(sql:string)=>sql.startsWith('SELECT 1 FROM work_items WHERE ')&&sql.includes("kind='DISPATCH'")&&sql.includes("target_ref->>'requestId'=$5")&&sql.includes('lease_until>clock_timestamp() FOR UPDATE');
const w4cPubAssetSql=(sql:string)=>sql.startsWith('SELECT asset_id,sha256,bytes_length');

async function w4cPubPublished(query:W4CPubQuery,f:W4CPubFixture){
  const values=[f.seed.accountId,f.requestId];
  return (await query<{applications:number;results:number;store:number;state:string}>("SELECT (SELECT count(*)::integer FROM result_applications a WHERE a.account_id=r.account_id AND a.request_id=r.request_id) applications,(SELECT count(*)::integer FROM results v JOIN result_applications a ON a.account_id=v.account_id AND a.result_id=v.result_id WHERE a.account_id=r.account_id AND a.request_id=r.request_id) results,(SELECT count(*)::integer FROM work_items w JOIN result_applications a ON a.account_id=w.account_id AND w.target_ref->>'resultId'=a.result_id::text WHERE a.account_id=r.account_id AND a.request_id=r.request_id AND w.kind='STORE') store,r.state FROM processing_requests r WHERE r.account_id=$1 AND r.request_id=$2",values)).rows[0];
}
async function w4cPubWork(f:W4CPubFixture,claim:W4CPubClaim){
  return (await f.admin.pool.query<{state:string;claim_owner:string|null;claim_generation:string;lease_until:Date;live:boolean;remaining:number}>('SELECT state,claim_owner,claim_generation,lease_until,lease_until>clock_timestamp() live,EXTRACT(EPOCH FROM (lease_until-clock_timestamp()))::float8 remaining FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim.workId])).rows[0];
}
async function w4cPubStable(f:W4CPubFixture){
  const params=[f.seed.accountId,f.requestId];
  const costs=(await f.admin.pool.query("SELECT c.cost_item_id,c.execution_id,c.component,c.ordinal,c.state,c.actual_usd::text,c.usage_ref,c.rate_version,c.confirmed_at,c.evidence_conflict FROM manga_web.cost_items c JOIN manga_web.executions e USING(account_id,execution_id) WHERE c.account_id=$1 AND e.request_id=$2 ORDER BY c.cost_item_id",params)).rows;
  const expenses=(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) JOIN manga_web.executions e ON e.account_id=c.account_id AND e.execution_id=c.execution_id WHERE x.account_id=$1 AND e.request_id=$2 ORDER BY x.cost_item_id',params)).rows;
  const costEvidence=(await f.admin.pool.query("SELECT z.evidence_id,z.execution_id,z.kind,z.evidence_digest,z.protected_evidence_ref,z.received_at,z.protected_observation FROM manga_web.execution_evidence z JOIN manga_web.executions e USING(account_id,execution_id) WHERE z.account_id=$1 AND e.request_id=$2 AND z.kind IN('OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE','WINDOWS_STAGE_COST_SEAL') ORDER BY z.evidence_id",params)).rows;
  const counts=(await f.admin.pool.query<{go:number;io_start:number;io_end:number;projections:number;seals:number;calculations:number;closures:number}>("SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) io_start,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) io_end,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections WHERE account_id=$1) projections,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CALCULATION') calculations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='OPERATIONAL_COST_CLOSURE') closures",[f.seed.accountId])).rows[0];
  const files=w4cPubFileSnapshot(f);
  console.info(JSON.stringify({w4cPublication실제파일호출:{requestId:f.requestId,...files}}));
  return {costs,expenses,costEvidence,counts,objectIo:{...f.objectIo},files,dispatch:f.synthetic.calls.map(value=>value.executionId),lookup:[...f.synthetic.lookups]};
}
async function w4cPubNoPublication(f:W4CPubFixture){
  const state=await f.inspect();expect(state.applications).toEqual([]);expect(state.results).toEqual([]);expect(state.store).toEqual([]);
}

async function w4cPubAtCostAck(){
  const f=await createW4CWindowsExecutionFixture(),privateService=f.service as unknown as W4CPubPrivate;
  const restores:(()=>void)[]=[],fileCalls:W4CPubFileCalls={read:0,put:0};
  w4cPubFileCalls.set(f,fileCalls);
  const entered=deferred<{input:StageInput;claim:W4CPubClaim}>(),gate=deferred<void>(),cleanupError=Error('publication 검사 경계 종료');
  const intervals:{timer:ReturnType<typeof setInterval>;claim:Readonly<W4CPubClaim>}[]=[],renewing=new Set<Promise<boolean>>();
  const interval=setInterval,renew=f.service.renew.bind(f.service),finishCost=privateService.finishCostAttempt.bind(f.service);
  let abortTick=true,arrived=false,tick:Promise<W4CPubTick>|undefined,renewalsStopped=false;
  // direct helper 대조 때만 실제 interval을 멈추고 이미 시작한 원 renew를 합류한다.
  // claim의 원 30초 lease 값과 DB 시계는 바꾸지 않는다.
  async function stopRenewals(){
    if(renewalsStopped)return;renewalsStopped=true;
    const selected=f.claimSelections;expect(selected.length===2||selected.length===3).toBe(true);expect(f.inputs).toHaveLength(2);
    const first=selected[0],last=selected.at(-1);expect(first).toMatchObject({accountId:f.seed.accountId,kind:'DISPATCH',ref:{requestId:f.requestId}});expect(last).toMatchObject({accountId:f.seed.accountId,kind:'DISPATCH',workId:first!.workId,ref:{requestId:f.requestId}});expect(last!.generation).toBe((BigInt(first!.generation)+1n).toString());
    if(selected.length===3){const middle=selected[1];expect(middle).toMatchObject({accountId:f.seed.accountId,kind:'RECONCILE',ref:{executionId:f.inputs[0].executionId}});expect(middle!.workId).not.toBe(first!.workId);const rows=(await f.admin.pool.query('SELECT kind,state,claim_generation,target_ref FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,middle!.workId])).rows;expect(rows).toEqual([{kind:'RECONCILE',state:'DONE',claim_generation:middle!.generation,target_ref:{executionId:f.inputs[0].executionId}}]);}
    expect(intervals.map(value=>value.claim)).toEqual(selected);expect(new Set(intervals.map(value=>value.timer)).size).toBe(selected.length);for(const value of intervals)clearInterval(value.timer);
    const joined=await Promise.all([...renewing]);expect(joined.every(value=>value===true)).toBe(true);
  }
  async function close(checkAbort=true){
    const failures:unknown[]=[];
    try{
      try{if(tick)await stopRenewals();}catch(error){failures.push(error);}
      gate.resolve();
      try{if(tick){const result=await tick;if(checkAbort&&abortTick&&arrived){expect(result).toEqual({error:cleanupError});if('error'in result)expect(result.error).toBe(cleanupError);}}}catch(error){failures.push(error);}
      try{await f.close();}catch(error){failures.push(error);}
    }finally{
      // 설치 직후 등록한 개별 복원은 fixture 종료·다른 복원이 실패해도 모두 실행한다.
      for(const restore of restores.splice(0).reverse()){try{restore();}catch(error){failures.push(error);}}
      w4cPubFileCalls.delete(f);
    }
    if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'publication 경계 정리 오류');
  }
  try{
    // wrapper counter와 구분하여 실제 FileObjectStore 메서드 호출을 runOnce 전부터 관측한다.
    const read=f.files.read.bind(f.files),readSpy=vi.spyOn(f.files,'read');
    restores.push(()=>readSpy.mockRestore());
    readSpy.mockImplementation((...args)=>{fileCalls.read++;return read(...args);});
    const put=f.files.put.bind(f.files),putSpy=vi.spyOn(f.files,'put');
    restores.push(()=>putSpy.mockRestore());
    putSpy.mockImplementation((...args)=>{fileCalls.put++;return put(...args);});
    const intervalSpy=vi.spyOn(globalThis,'setInterval');
    restores.push(()=>intervalSpy.mockRestore());
    intervalSpy.mockImplementation((...args)=>{
      const timer=Reflect.apply(interval,globalThis,args) as ReturnType<typeof setInterval>;
      if(args[1]===f.service.hooks.heartbeatMilliseconds){const claim=f.claimSelections.at(-1);expect(claim).toBeDefined();expect(claim).not.toBeNull();intervals.push({timer,claim:claim!});}return timer;
    });
    const renewSpy=vi.spyOn(f.service,'renew');
    restores.push(()=>renewSpy.mockRestore());
    renewSpy.mockImplementation(claim=>{
      const pending=renew(claim);renewing.add(pending);void pending.then(()=>renewing.delete(pending),()=>renewing.delete(pending));return pending;
    });
    const costSpy=vi.spyOn(privateService,'finishCostAttempt');
    restores.push(()=>costSpy.mockRestore());
    costSpy.mockImplementation(async input=>{
      await finishCost(input);
      if(input.stage!=='TYPESET')return;
      const claim=f.claims.get(input.executionId);expect(claim).toBeDefined();expect(arrived).toBe(false);arrived=true;
      entered.resolve({input:structuredClone(input),claim:claim!});await gate.promise;if(abortTick)throw cleanupError;
    });
    expect(await f.service.runOnce()).toBe(true);const first=await f.inspect();expect(first.executions.map(row=>[row.logical_step_id,row.state])).toEqual([['OCR','SUCCEEDED']]);await w4cPubNoPublication(f);
    tick=f.runTypeset().then(value=>({value}),error=>({error}));
    const boundary=await b3cPhAwait(Promise.race([entered.promise,tick.then(async result=>{if('error'in result)throw result.error;const failure=Error('TYPESET 비용 경계 전에 runOnce가 반환했다');if(!arrived){try{const queue=(await f.admin.pool.query('SELECT work_item_id,kind,state,claim_owner,claim_generation,lease_until,due_at,target_ref FROM manga_web.work_items WHERE account_id=$1 ORDER BY due_at,work_item_id',[f.seed.accountId])).rows;console.info(JSON.stringify({w4cPublicationEarlyTick:{value:result.value,queue,diagnostic:await f.diagnose('TYPESET 비용 경계 전 반환')}}));}catch(diagnosticError){throw new AggregateError([failure,diagnosticError],'이른 tick 반환과 원 진단 오류');}}throw failure;})]));
    intervalSpy.mockRestore();
    const state=await f.inspect(),final=state.views.filter(value=>value.input.executionId===boundary.input.executionId&&value.view.attempt?.purpose==='FINAL_COMMIT').at(-1)?.view;
    expect(state.executions.map(row=>[row.logical_step_id,row.state])).toEqual([['OCR','SUCCEEDED'],['TYPESET','SUCCEEDED']]);expect(final?.state).toBe('VERIFIED');
    expect(state.financial.map(row=>[row.state,row.stage_usd,row.expense_usd])).toEqual([['CONFIRMED','0.011000000000','0.011000000000'],['CONFIRMED','0.014000000000','0.014000000000']]);await w4cPubNoPublication(f);
    const work=await w4cPubWork(f,boundary.claim);expect(work).toMatchObject({state:'CLAIMED',claim_owner:f.service.workerId,claim_generation:boundary.claim.generation,live:true});expect(work.remaining).toBeGreaterThan(0);expect(work.remaining).toBeLessThanOrEqual(30);
    expect(f.confirmedProofs).toHaveLength(2);
    const held=(await f.admin.pool.query('SELECT state,released_at,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[f.seed.accountId])).rows;expect(held).toEqual([{state:'HELD',released_at:null,windows_release_proof_id:null},{state:'HELD',released_at:null,windows_release_proof_id:null}]);
    expect(fileCalls.read).toBeGreaterThan(0);expect(fileCalls.put).toBeGreaterThan(0);
    const stable=await w4cPubStable(f);
    return {f,...boundary,stable,tick,stopRenewals,close,call:()=>privateService.finishWindowsPublication(boundary.claim,boundary.input),release:async()=>{abortTick=false;gate.resolve();return tick!;},abort:async()=>{gate.resolve();const result=await tick!;expect(result).toEqual({error:cleanupError});if('error'in result)expect(result.error).toBe(cleanupError);return result;}};
  }catch(error){try{await close(false);}catch(cleanup){throw new AggregateError([error,cleanup],'publication 경계 조립과 정리 오류');}throw error;}
}
type W4CPubBoundary=Awaited<ReturnType<typeof w4cPubAtCostAck>>;
async function w4cPubCase(run:(boundary:W4CPubBoundary)=>Promise<void>){
  const guard=guardWindowsNativeIo(),failures:unknown[]=[];let boundary:W4CPubBoundary|undefined;
  try{boundary=await w4cPubAtCostAck();await run(boundary);}catch(error){failures.push(error);}
  finally{
    try{await boundary?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'publication 검사와 정리 오류');
}

type W4CPubTrace={sql:string[];live:number;liveRows:number[];assets:number;final:number;cost:number;value?:unknown;inside?:Awaited<ReturnType<typeof w4cPubPublished>>;driverError?:unknown;applicationBeforeExpiry?:Awaited<ReturnType<typeof w4cPubPublished>>};
type W4CPubProbeMode={rollback?:boolean;ack?:boolean;sqlState?:'42501'|'40001'|'40P01';changePageAfterRollback?:boolean;expireAtFinal?:boolean;assetMismatch?:boolean};
function w4cPubProbe(boundary:W4CPubBoundary,mode:W4CPubProbeMode){
  const {f,claim}=boundary,transaction=f.worker.accountTransaction.bind(f.worker),traces:W4CPubTrace[]=[],observers:(()=>void)[]=[];
  const rollbackError=Error('publication 실제 적용 뒤 검사 rollback'),ackError=Error('publication 실제 COMMIT 뒤 ACK 유실');
  let active:W4CPubTrace|undefined,injected=false,pageChanged=false,committed=false,rawFault:unknown,retryMutationError:unknown;
  const finalCommit=f.checkpoints.finalCommitIn.bind(f.checkpoints),read=f.cost.readIn.bind(f.cost);
  const finalSpy=vi.spyOn(f.checkpoints,'finalCommitIn').mockImplementation((...args)=>{if(active)active.final++;return finalCommit(...args);});
  const costSpy=vi.spyOn(f.cost,'readIn').mockImplementation((...args)=>{if(active)active.cost++;return read(...args);});
  const call:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{
    let matched=false;
    const result=await transaction(accountId,async tx=>{
      const trace:W4CPubTrace|undefined=accountId===f.seed.accountId?{sql:[],live:0,liveRows:[],assets:0,final:0,cost:0}:undefined;
      if(trace){traces.push(trace);active=trace;matched=true;}
      let callbackLive=true,restored=false;
      const query=tx.client.query,raw:W4CPubQuery=(sql,values=[])=>Reflect.apply(query,tx.client,[sql,values]);
      const restore=()=>{if(!restored){restored=true;observer.mockRestore();}};
      const observer=vi.spyOn(tx.client,'query').mockImplementation((...args)=>{
        const sql=typeof args[0]==='string'?args[0]:'';
        if(!callbackLive){
          const result:unknown=Reflect.apply(query,tx.client,args);
          if(sql==='ROLLBACK')return (result as Promise<unknown>).then(async value=>{
            restore();
            if(trace?.driverError&&mode.changePageAfterRollback&&!pageChanged){
              try{expect((await f.admin.pool.query('UPDATE manga_web.workspace_pages SET result_revision=result_revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,boundary.input.contextId,boundary.input.envelope!.pageLineageId])).rowCount).toBe(1);pageChanged=true;}
              catch(error){retryMutationError=error;throw error;}
            }
            return value;
          });
          if(sql==='COMMIT')return (result as Promise<unknown>).then(value=>{restore();return value;});
          return result;
        }
        if(trace&&w4cPubLiveSql(sql))trace.live++;
        if(trace)trace.sql.push(sql);
        if(trace&&w4cPubAssetSql(sql)){
          trace.assets++;
          if(mode.assetMismatch&&!injected){
            injected=true;
            // FINAL 뒤 원 자산 SELECT 직전에 같은 worker 거래의 metadata 한 값만 바꾼다.
            // 원 SELECT를 실행하여 실제 불일치가 DomainError 의미 거부로 남는지 확인한다.
            return (async()=>{expect((await raw('UPDATE assets SET bytes_length=bytes_length+1 WHERE account_id=$1 AND asset_id=$2',[f.seed.accountId,f.renderAssetId])).rowCount).toBe(1);return Reflect.apply(query,tx.client,args);})();
          }
          if(mode.sqlState&&!injected){
            injected=true;
            // 실제 서버의 실패 거래와 driver 오류를 사용한다. 실제 ACL·deadlock 경쟁 증거와 구분한다.
            return raw("DO $publication$ BEGIN RAISE EXCEPTION USING ERRCODE='"+mode.sqlState+"',MESSAGE='publication 자산 조회 원 서버 오류'; END $publication$").catch(error=>{trace!.driverError=error;rawFault=error;throw error;});
          }
        }
        if(trace&&w4cPubLiveSql(sql)&&trace.live===2&&mode.expireAtFinal)return (async()=>{
          trace!.applicationBeforeExpiry=await w4cPubPublished(raw,f);expect(trace!.applicationBeforeExpiry).toMatchObject({applications:1,results:1,store:1,state:'COMPLETED'});
          await raw('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (lease_until-clock_timestamp())))::float8+0.05) FROM work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim.workId]);
          return Reflect.apply(query,tx.client,args);
        })();
        if(trace&&w4cPubLiveSql(sql)){
          const result:unknown=Reflect.apply(query,tx.client,args);
          return (result as Promise<import('pg').QueryResult>).then(value=>{trace.liveRows.push(value.rowCount??0);return value;});
        }
        return Reflect.apply(query,tx.client,args);
      });
      observers.push(restore);
      try{
        const value=await run(tx);
        if(trace){trace.value=value;trace.inside=await w4cPubPublished(raw,f);if(mode.rollback)throw rollbackError;}
        return value;
      }finally{callbackLive=false;if(active===trace)active=undefined;if(!trace)restore();}
    },restricted);
    if(matched){committed=true;if(mode.ack)throw ackError;}
    return result;
  };
  const transactionSpy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(call);
  return {traces,rollbackError,ackError,get rawFault(){return rawFault;},get retryMutationError(){return retryMutationError;},get committed(){return committed;},get pageChanged(){return pageChanged;},restore:()=>{transactionSpy.mockRestore();for(const restore of observers.reverse())restore();finalSpy.mockRestore();costSpy.mockRestore();}};
}
async function w4cPubControl(boundary:W4CPubBoundary){
  const probe=w4cPubProbe(boundary,{rollback:true});
  try{
    await expect(boundary.call()).rejects.toBe(probe.rollbackError);expect(probe.committed).toBe(false);expect(probe.traces).toHaveLength(1);
    const trace=probe.traces[0];expect(trace.value).toBe(true);expect(trace.live).toBe(2);expect(trace.sql.filter(sql=>sql.startsWith('/* checkpoint-validation:windows-current */'))).toHaveLength(1);expect(trace.assets).toBeGreaterThan(0);expect(trace.final).toBeGreaterThan(0);expect(trace.cost).toBeGreaterThan(0);
    expect(trace.inside).toMatchObject({applications:1,results:1,store:1,state:'COMPLETED'});expect(w4cPubLiveSql(trace.sql.at(-1)!)).toBe(true);
  }finally{probe.restore();}
  await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);
}

const w4cPubFaults=['ACCOUNT','STOP','SESSION','BINDING','CONTEXT','PAGE','ACTIVE','CLAIM_OWNER','CLAIM_GENERATION','CLAIM_LEASE','LAST_STEP','INPUT','OUTCOME','CHECKPOINT'] as const;
type W4CPubFault=typeof w4cPubFaults[number];
async function w4cPubFault(boundary:W4CPubBoundary,kind:W4CPubFault){
  const {f,input,claim}=boundary,account=f.seed.accountId;
  const change=async(sql:string,values:unknown[],undoSql:string,undoValues:unknown[])=>{
    expect((await f.admin.pool.query(sql,values)).rowCount).toBe(1);
    return async()=>{expect((await f.admin.pool.query(undoSql,undoValues)).rowCount).toBe(1);};
  };
  // 관리자 fault는 합성 계정 한 행에만 넣고 원 값으로 복원한다.
  // helper 본문은 원 worker LOGIN/role과 원 DB 거래로 실행하며 권한을 바꾸지 않는다.
  if(kind==='ACCOUNT'){
    const row=(await f.admin.pool.query('SELECT access_state FROM manga_web.accounts WHERE account_id=$1',[account])).rows[0];expect(row.access_state).toBe('ACTIVE');
    return change("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[account],'UPDATE manga_web.accounts SET access_state=$2 WHERE account_id=$1',[account,row.access_state]);
  }
  if(kind==='STOP'){
    const row=(await f.inspect()).request;
    return change("UPDATE manga_web.processing_requests SET state='STOP_REQUESTED' WHERE account_id=$1 AND request_id=$2",[account,f.requestId],'UPDATE manga_web.processing_requests SET state=$3 WHERE account_id=$1 AND request_id=$2',[account,f.requestId,row.state]);
  }
  if(kind==='SESSION'){
    const row=(await f.admin.pool.query('SELECT s.session_id,s.revoked_at,s.revocation_reason FROM manga_web.app_sessions s JOIN manga_web.workspace_contexts c ON c.account_id=s.account_id AND c.owner_session_id=s.session_id WHERE c.account_id=$1 AND c.context_id=$2',[account,input.contextId])).rows[0];
    return change("UPDATE manga_web.app_sessions SET revoked_at=clock_timestamp(),revocation_reason='PUBLICATION_TEST' WHERE account_id=$1 AND session_id=$2",[account,row.session_id],'UPDATE manga_web.app_sessions SET revoked_at=$3,revocation_reason=$4 WHERE account_id=$1 AND session_id=$2',[account,row.session_id,row.revoked_at,row.revocation_reason]);
  }
  if(kind==='BINDING'){
    const row=(await f.admin.pool.query('SELECT b.binding_id,b.state,b.revoked_at FROM manga_web.login_bindings b JOIN manga_web.app_sessions s USING(account_id,binding_id) JOIN manga_web.workspace_contexts c ON c.account_id=s.account_id AND c.owner_session_id=s.session_id WHERE c.account_id=$1 AND c.context_id=$2',[account,input.contextId])).rows[0];
    return change("UPDATE manga_web.login_bindings SET state='REVOKED',revoked_at=clock_timestamp() WHERE account_id=$1 AND binding_id=$2",[account,row.binding_id],'UPDATE manga_web.login_bindings SET state=$3,revoked_at=$4 WHERE account_id=$1 AND binding_id=$2',[account,row.binding_id,row.state,row.revoked_at]);
  }
  if(kind==='CONTEXT'){
    const values=[account,input.contextId],row=(await f.admin.pool.query('SELECT * FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',values)).rows[0];expect(row).toBeDefined();
    // 원 generation과 live slot FK는 유지하고 CLOSED의 원 CHECK에 필요한 값만 바꾼다.
    const undo=await change("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL WHERE account_id=$1 AND context_id=$2",values,'UPDATE manga_web.workspace_contexts SET lifecycle=$3,closed_at=$4,close_reason=$5,owner_session_id=$6,owner_tab_id=$7,owner_capability_digest=$8 WHERE account_id=$1 AND context_id=$2',[...values,row.lifecycle,row.closed_at,row.close_reason,row.owner_session_id,row.owner_tab_id,row.owner_capability_digest]);
    return async()=>{await undo();expect((await f.admin.pool.query('SELECT * FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',values)).rows).toEqual([row]);};
  }
  if(kind==='PAGE'){
    const values=[account,input.contextId,input.envelope!.pageLineageId],row=(await f.admin.pool.query('SELECT result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',values)).rows[0];
    return change('UPDATE manga_web.workspace_pages SET result_revision=result_revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',values,'UPDATE manga_web.workspace_pages SET result_revision=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[...values,row.result_revision]);
  }
  if(kind==='ACTIVE'){
    const values=[account,f.requestId],row=(await f.admin.pool.query('SELECT * FROM manga_web.active_page_requests WHERE account_id=$1 AND request_id=$2',values)).rows[0];expect(row).toBeDefined();
    const undo=await change('DELETE FROM manga_web.active_page_requests WHERE account_id=$1 AND request_id=$2',values,'INSERT INTO manga_web.active_page_requests(account_id,project_lineage_id,page_lineage_id,request_id,revision) VALUES($1,$2,$3,$4,$5)',[row.account_id,row.project_lineage_id,row.page_lineage_id,row.request_id,row.revision]);
    return async()=>{await undo();expect((await f.admin.pool.query('SELECT * FROM manga_web.active_page_requests WHERE account_id=$1 AND request_id=$2',values)).rows).toEqual([row]);};
  }
  if(kind==='CLAIM_OWNER'||kind==='CLAIM_GENERATION'||kind==='CLAIM_LEASE'){
    const row=await w4cPubWork(f,claim);
    if(kind==='CLAIM_OWNER')return change('UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[account,claim.workId,randomUUID()],'UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[account,claim.workId,row.claim_owner]);
    if(kind==='CLAIM_GENERATION')return change('UPDATE manga_web.work_items SET claim_generation=claim_generation+1 WHERE account_id=$1 AND work_item_id=$2',[account,claim.workId],'UPDATE manga_web.work_items SET claim_generation=$3 WHERE account_id=$1 AND work_item_id=$2',[account,claim.workId,row.claim_generation]);
    return change("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[account,claim.workId],'UPDATE manga_web.work_items SET lease_until=$3 WHERE account_id=$1 AND work_item_id=$2',[account,claim.workId,row.lease_until]);
  }
  if(kind==='LAST_STEP'){
    const row=(await f.admin.pool.query('SELECT current_execution_id FROM manga_web.request_steps WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[account,f.requestId,input.stage])).rows[0];
    return change('UPDATE manga_web.request_steps SET current_execution_id=NULL WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[account,f.requestId,input.stage],'UPDATE manga_web.request_steps SET current_execution_id=$4 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3',[account,f.requestId,input.stage,row.current_execution_id]);
  }
  if(kind==='INPUT'||kind==='OUTCOME'){
    const row=(await f.admin.pool.query('SELECT evidence_id,evidence_digest,protected_evidence_ref FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3',[account,input.executionId,kind])).rows;expect(row).toHaveLength(1);
    if(kind==='INPUT')return change('UPDATE manga_web.execution_evidence SET evidence_digest=$3 WHERE account_id=$1 AND evidence_id=$2',[account,row[0].evidence_id,sha256('publication 원 INPUT 단일 손상')],'UPDATE manga_web.execution_evidence SET evidence_digest=$3 WHERE account_id=$1 AND evidence_id=$2',[account,row[0].evidence_id,row[0].evidence_digest]);
    return change('UPDATE manga_web.execution_evidence SET protected_evidence_ref=$3 WHERE account_id=$1 AND evidence_id=$2',[account,row[0].evidence_id,randomUUID()],'UPDATE manga_web.execution_evidence SET protected_evidence_ref=$3 WHERE account_id=$1 AND evidence_id=$2',[account,row[0].evidence_id,row[0].protected_evidence_ref]);
  }
  const row=(await f.admin.pool.query('SELECT checkpoint_id,dependency_digest FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2',[account,input.executionId])).rows;expect(row).toHaveLength(1);
  return change('UPDATE manga_web.checkpoints SET dependency_digest=$3 WHERE account_id=$1 AND checkpoint_id=$2',[account,row[0].checkpoint_id,sha256('publication 원 checkpoint 단일 손상')],'UPDATE manga_web.checkpoints SET dependency_digest=$3 WHERE account_id=$1 AND checkpoint_id=$2',[account,row[0].checkpoint_id,row[0].dependency_digest]);
}

describe('W4-C publication 실제 거래 초안',()=>{
  it('W4-C 원 TYPESET 비용 ACK 대기 뒤 실제 runOnce가 원 claim으로 한 번 적용한다',async()=>w4cPubCase(async boundary=>{
    const {f,claim}=boundary,finish=vi.spyOn(f.service,'finish');
    try{
      await w4cPubNoPublication(f);expect(finish).not.toHaveBeenCalled();expect(await w4cPubWork(f,claim)).toMatchObject({state:'CLAIMED',live:true});
      expect(await boundary.release()).toEqual({value:true});expect(finish).toHaveBeenCalledExactlyOnceWith(claim,true,0);
      const state=await f.inspect();expect(state.applications).toHaveLength(1);expect(state.results).toHaveLength(1);expect(state.store).toHaveLength(1);expect(state.request.state).toBe('COMPLETED');
      expect(await w4cPubStable(f)).toEqual(boundary.stable);expect(await w4cPubWork(f,claim)).toMatchObject({state:'DONE',claim_owner:null});
    }finally{finish.mockRestore();}
  }),120000);
  it('W4-C 정상 원 helper의 결과와 STORE까지 실제 적용한 거래를 sentinel로 전부 rollback한다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);expect(await w4cPubWork(boundary.f,boundary.claim)).toMatchObject({state:'CLAIMED',live:true});
  }),120000);
  it.each(w4cPubFaults)('W4-C 원 publication의 %s 단일 결손은 원 확정 비용을 보존하고 적용하지 않는다',async kind=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const undo=await w4cPubFault(boundary,kind),probe=w4cPubProbe(boundary,{rollback:true});
    try{
      if(kind==='INPUT')await expect(boundary.call()).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});
      else{await expect(boundary.call()).rejects.toBe(probe.rollbackError);expect(probe.traces).toHaveLength(1);expect(probe.traces[0].value).toBe(false);}
      expect(probe.committed).toBe(false);await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);
    }finally{probe.restore();await undo();}
    await w4cPubControl(boundary);
  }),120000);
  it('W4-C 실제 새 claim은 첫 live 판정을 통과해도 옛 generation의 FINAL을 승격하지 않는다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const {f,claim,input}=boundary,before=await f.inspect(),originalExecution=before.executions.find(row=>row.execution_id===input.executionId);
    const next=new ExecutionService(f.service.db,f.service.provider,f.service.policy,f.service.hooks,f.service.nativeGateway,f.service.operationalCost);
    const failures:unknown[]=[],finish=vi.spyOn(f.service,'finish');let selected:W4CPubClaim|null=null;
    const selectedWork=async()=>selected?(await f.admin.pool.query('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[selected.accountId,selected.workId])).rows[0]:undefined;
    try{
      expect(next.db).toBe(f.worker);expect(next.nativeGateway).toBe(f.service.nativeGateway);expect(next.operationalCost).toBe(f.cost);expect(next.workerId).not.toBe(f.service.workerId);
      expect(originalExecution?.claim_generation).toBe(claim.generation);expect(await w4cPubWork(f,claim)).toMatchObject({state:'CLAIMED',live:true});
      // 원 lease 한 값만 만료시킨다. work 선택·generation·owner는 원 claim()이 결정한다.
      expect((await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[claim.accountId,claim.workId])).rowCount).toBe(1);
      selected=await next.claim();
      if(!selected||selected.accountId!==claim.accountId||selected.workId!==claim.workId||selected.kind!=='DISPATCH'){
        const work=(await f.admin.pool.query('SELECT work_item_id,kind,state,due_at,lease_until,claim_generation,claim_owner FROM manga_web.work_items WHERE account_id=$1 ORDER BY due_at,work_item_id',[claim.accountId])).rows;
        console.info(JSON.stringify({w4cPublication신규claim조립:{expected:claim,selected,work}}));
        throw Error('publication 신규 claim fixture 선택 불일치: 보조 work를 바꾸지 않고 중단한다');
      }
      expect(selected.ref).toEqual(claim.ref);expect(BigInt(selected.generation)).toBeGreaterThan(BigInt(claim.generation));
      expect(await w4cPubWork(f,selected)).toMatchObject({state:'CLAIMED',claim_owner:next.workerId,claim_generation:selected.generation,live:true});
      const probe=w4cPubProbe(boundary,{});
      try{
        expect(await (next as unknown as W4CPubPrivate).finishWindowsPublication(selected,input)).toBe(false);
        expect(probe.committed).toBe(true);expect(probe.traces).toHaveLength(1);
        const trace=probe.traces[0];expect(trace.live).toBe(1);expect(trace.liveRows).toEqual([1]);expect(trace.value).toBe(false);
        expect(trace.sql.some(sql=>sql.startsWith('SELECT * FROM executions')&&sql.endsWith('FOR UPDATE'))).toBe(true);
        expect(trace.sql.some(sql=>sql.includes('FROM request_steps')&&sql.includes('current_execution_id'))).toBe(true);
        expect(trace.final).toBe(0);expect(trace.cost).toBe(0);expect(trace.assets).toBe(0);
        expect(trace.inside).toMatchObject({applications:0,results:0,store:0,state:before.request.state});
      }finally{probe.restore();}
      const after=await f.inspect();expect(after.executions).toEqual(before.executions);expect(after.evidence).toEqual(before.evidence);expect(after.checkpoints).toEqual(before.checkpoints);expect(after.financial).toEqual(before.financial);
      await w4cPubNoPublication(f);expect(await w4cPubStable(f)).toEqual(boundary.stable);
    }catch(error){failures.push(error);}
    finally{
      next.stopClaims();
      // 옛 runOnce의 원 종료 오류를 합류하고 foreign claim이 옛 finally에서 반환되지 않음을 확인한다.
      try{
        const foreign=await selectedWork();expect(finish).not.toHaveBeenCalled();await boundary.abort();expect(finish).toHaveBeenCalledExactlyOnceWith(claim,false,5000);
        if(selected)expect(await selectedWork()).toEqual(foreign);
        await w4cPubNoPublication(f);expect(await w4cPubStable(f)).toEqual(boundary.stable);
      }catch(error){failures.push(error);}
      // 새 service는 runOnce·heartbeat를 시작하지 않는다. 실제 획득한 자기 claim만 원 finish로 반환한다.
      try{if(selected){await next.finish(selected,false,5000);expect(await selectedWork()).toMatchObject({state:'READY',claim_owner:null,lease_until:null,claim_generation:selected.generation});}}catch(error){failures.push(error);}
      try{expect(await next.claim()).toBeNull();}catch(error){failures.push(error);}
      try{await f.cost.idle();}catch(error){failures.push(error);}
      try{await f.remote.gateway.idle();}catch(error){failures.push(error);}
      try{finish.mockRestore();}catch(error){failures.push(error);}
    }
    if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'publication 신규 claim 음성과 정리 오류');
  }),120000);
  it('W4-C 실제 publication COMMIT 뒤 sentinel ACK 유실과 재조회는 기존 적용1과 원 비용을 유지한다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const probe=w4cPubProbe(boundary,{ack:true});
    try{await expect(boundary.call()).rejects.toBe(probe.ackError);expect(probe.committed).toBe(true);expect(probe.traces).toHaveLength(1);expect(probe.traces[0].value).toBe(true);}
    finally{probe.restore();}
    const before=await boundary.f.inspect();expect(before.applications).toHaveLength(1);expect(before.results).toHaveLength(1);expect(before.store).toHaveLength(1);expect(before.request.state).toBe('COMPLETED');
    expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);
    expect(await boundary.call()).toBe(true);const after=await boundary.f.inspect();expect(after.applications).toEqual(before.applications);expect(after.results).toEqual(before.results);expect(after.store).toEqual(before.store);
    expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);
  }),120000);
  it('W4-C 원 30초 lease가 거래 끝에 만료되면 결과와 STORE와 예산 쓰기를 전부 rollback한다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const before=await w4cPubWork(boundary.f,boundary.claim),probe=w4cPubProbe(boundary,{expireAtFinal:true});
    const budgets=(await boundary.f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[boundary.f.seed.accountId,boundary.f.requestId])).rows;
    try{
      expect(before.live).toBe(true);expect(before.remaining).toBeGreaterThan(0);expect(before.remaining).toBeLessThanOrEqual(30);
      expect(await boundary.call()).toBe(false);expect(probe.committed).toBe(false);expect(probe.traces).toHaveLength(1);
      expect(probe.traces[0].applicationBeforeExpiry).toMatchObject({applications:1,results:1,store:1,state:'COMPLETED'});expect(w4cPubLiveSql(probe.traces[0].sql.at(-1)!)).toBe(true);
    }finally{probe.restore();}
    await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);expect(await w4cPubWork(boundary.f,boundary.claim)).toMatchObject({lease_until:before.lease_until,live:false});
    expect((await boundary.f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[boundary.f.seed.accountId,boundary.f.requestId])).rows).toEqual(budgets);
  }),120000);
  it('W4-C 자산 SELECT 경계의 실제 서버 42501은 원 오류로 나가고 거래를 적용하지 않는다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const probe=w4cPubProbe(boundary,{sqlState:'42501'});
    try{
      const result=await boundary.call().then(value=>({value}),error=>({error}));expect(result).toHaveProperty('error');if('error'in result)expect(result.error).toBe(probe.rawFault);expect(probe.rawFault).toMatchObject({code:'42501'});
      expect(probe.traces).toHaveLength(1);expect(probe.traces[0].assets).toBe(1);expect(probe.committed).toBe(false);
    }finally{probe.restore();}
    await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);await w4cPubControl(boundary);
  }),120000);
  it('W4-C 실제 자산 metadata 불일치의 DomainError는 기존 의미 실패로 남는다',async()=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const probe=w4cPubProbe(boundary,{assetMismatch:true,rollback:true});
    try{
      await expect(boundary.call()).rejects.toBe(probe.rollbackError);expect(probe.traces).toHaveLength(1);expect(probe.rawFault).toBeUndefined();
      const trace=probe.traces[0];expect(trace.assets).toBe(1);expect(trace.final).toBeGreaterThan(0);expect(trace.value).toBe(false);expect(trace.inside).toMatchObject({applications:0,results:0,store:0,state:'FAILED'});expect(probe.committed).toBe(false);
    }finally{probe.restore();}
    await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);await w4cPubControl(boundary);
  }),120000);
  it.each(['40001','40P01'] as const)('W4-C 자산 SELECT의 실제 서버 %s 뒤 원 guard를 다시 읽고 두 번째 적용 거래도 rollback한다',async sqlState=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const probe=w4cPubProbe(boundary,{sqlState,rollback:true});
    try{
      await expect(boundary.call()).rejects.toBe(probe.rollbackError);expect(probe.rawFault).toMatchObject({code:sqlState});expect(probe.traces).toHaveLength(2);
      for(const trace of probe.traces){
        expect(trace.sql.some(sql=>sql.includes("kind='INPUT'"))).toBe(true);expect(trace.sql.some(sql=>sql.includes("kind='OUTCOME'"))).toBe(true);
        expect(trace.sql.some(sql=>sql.includes('FROM checkpoints'))).toBe(true);expect(trace.sql.some(sql=>sql.includes('FROM processing_requests'))).toBe(true);expect(trace.sql.some(sql=>sql.includes('FROM workspace_pages'))).toBe(true);
        expect(trace.final).toBeGreaterThan(0);expect(trace.cost).toBeGreaterThan(0);expect(trace.assets).toBeGreaterThan(0);
      }
      expect(probe.traces[0].driverError).toBe(probe.rawFault);expect(probe.traces[1].value).toBe(true);expect(probe.traces[1].live).toBe(2);expect(probe.traces[1].inside).toMatchObject({applications:1,results:1,store:1,state:'COMPLETED'});
      expect(w4cPubLiveSql(probe.traces[1].sql.at(-1)!)).toBe(true);expect(probe.committed).toBe(false);
    }finally{probe.restore();}
    await w4cPubNoPublication(boundary.f);expect(await w4cPubStable(boundary.f)).toEqual(boundary.stable);
  }),120000);
  it.each(['40001','40P01'] as const)('W4-C %s 첫 rollback 뒤 바뀐 페이지는 다음 시도의 원 현재성 판정에서 막힌다',async sqlState=>w4cPubCase(async boundary=>{
    await boundary.stopRenewals();await w4cPubControl(boundary);
    const {f,input}=boundary,params=[f.seed.accountId,input.contextId,input.envelope!.pageLineageId],page=(await f.admin.pool.query('SELECT result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',params)).rows[0],probe=w4cPubProbe(boundary,{sqlState,rollback:true,changePageAfterRollback:true});
    try{
      await expect(boundary.call()).rejects.toBe(probe.rollbackError);expect(probe.rawFault).toMatchObject({code:sqlState});expect(probe.retryMutationError).toBeUndefined();expect(probe.pageChanged).toBe(true);expect(probe.traces).toHaveLength(2);
      const last=probe.traces[1];expect(last.sql.some(sql=>sql.includes('FROM workspace_pages'))).toBe(true);expect(last.value).toBe(false);expect(last.assets).toBe(0);expect(last.final).toBe(0);expect(probe.committed).toBe(false);
      await w4cPubNoPublication(f);expect(await w4cPubStable(f)).toEqual(boundary.stable);
    }finally{probe.restore();await f.admin.pool.query('UPDATE manga_web.workspace_pages SET result_revision=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[...params,page.result_revision]);}
    await w4cPubControl(boundary);
  }),120000);
});

// 원 OCR이 예약한 RECONCILE의 정상 queue 선택만 앞당기고 공통 운전부의 최대 두 추가 tick을 검증한다.
it('W4-C E3 원 OCR RECONCILE을 먼저 선택해도 같은 요청 TYPESET 비용 경계에 도달한다',async()=>{
  const guard=guardWindowsNativeIo(),restores:B3CPgRestore[]=[],failures:unknown[]=[],entered=deferred<StageInput>(),gate=deferred<void>();
  let f:Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>|undefined,tick:Promise<{value:boolean}|{error:unknown}>|undefined,arrived=false;
  try{
    f=await createW4CWindowsExecutionFixture();const fixture=f;
    // 이 독립 회귀에만 원 file 포트의 호출 수를 관측한다. 공유 fixture와 PUB 관측은 그대로 둔다.
    const fileRead=vi.spyOn(f.files,'read');restores.push(()=>fileRead.mockRestore());
    const filePut=vi.spyOn(f.files,'put');restores.push(()=>filePut.mockRestore());
    const owner=f.service as unknown as {finishCostAttempt(input:StageInput):Promise<void>},finishCost=owner.finishCostAttempt.bind(owner);
    const costSpy=vi.spyOn(owner,'finishCostAttempt').mockImplementation(async input=>{await finishCost(input);if(input.stage!=='TYPESET')return;expect(arrived).toBe(false);arrived=true;entered.resolve(input);await gate.promise;});restores.push(()=>costSpy.mockRestore());
    expect(await f.service.runOnce()).toBe(true);const first=await f.inspect();
    expect(first.executions).toHaveLength(1);expect(first.executions[0]).toMatchObject({logical_step_id:'OCR',state:'SUCCEEDED'});expect(first.financial).toHaveLength(1);expect(first.financial[0]).toMatchObject({state:'CONFIRMED',stage_usd:'0.011000000000',expense_usd:'0.011000000000'});expect(first.checkpoints).toHaveLength(1);expect(first.applications).toEqual([]);expect(first.results).toEqual([]);expect(first.store).toEqual([]);
    const ocr=f.inputs[0];expect(ocr.stage).toBe('OCR');expect(f.claimSelections).toHaveLength(1);const firstClaim=f.claimSelections[0];expect(firstClaim).toMatchObject({accountId:f.seed.accountId,kind:'DISPATCH',ref:{requestId:f.requestId}});expect(firstClaim!.workId).toBe(f.claims.get(ocr.executionId)!.workId);
    type Work={account_id:string;work_item_id:string;kind:string;state:string;due_at:Date;claim_generation:string;claim_owner:string|null;lease_until:Date|null;revision:string;target_ref:Record<string,string>};
    const selected=await f.admin.accountTransaction(f.seed.accountId,async tx=>{
      const reconcile=(await tx.client.query<Work>("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE' AND target_ref=$2::jsonb ORDER BY due_at,work_item_id FOR UPDATE",[fixture.seed.accountId,JSON.stringify({executionId:ocr.executionId})])).rows;
      const dispatch=(await tx.client.query<Work>("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND kind='DISPATCH' AND target_ref=$2::jsonb ORDER BY due_at,work_item_id FOR UPDATE",[fixture.seed.accountId,JSON.stringify({requestId:fixture.requestId})])).rows;
      expect(reconcile).toHaveLength(1);expect(dispatch).toHaveLength(1);expect(reconcile[0]).toMatchObject({state:'READY',claim_owner:null,lease_until:null});expect(dispatch[0]).toMatchObject({work_item_id:firstClaim!.workId,state:'READY',claim_owner:null,lease_until:null});
      const changed=(await tx.client.query<Work>("UPDATE manga_web.work_items SET due_at=LEAST(due_at,$3::timestamptz,clock_timestamp())-interval '1 second' WHERE account_id=$1 AND work_item_id=$2 AND kind='RECONCILE' RETURNING *",[fixture.seed.accountId,reconcile[0].work_item_id,dispatch[0].due_at])).rows;
      expect(changed).toHaveLength(1);expect(changed[0]).toEqual({...reconcile[0],due_at:changed[0].due_at});expect(changed[0].due_at.valueOf()).toBeLessThan(dispatch[0].due_at.valueOf());
      expect((await tx.client.query<Work>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[fixture.seed.accountId,dispatch[0].work_item_id])).rows).toEqual(dispatch);
      return {reconcile:changed[0],dispatch:dispatch[0]};
    });
    const candidates=(await f.worker.pool.query<{account_id:string;work_item_id:string}>('SELECT * FROM manga_web.dispatch_candidates()')).rows;expect(candidates[0]).toMatchObject({account_id:f.seed.accountId,work_item_id:selected.reconcile.work_item_id});
    const sourceMoney=first.financial,sourceEvidence=first.evidence.filter(row=>row.execution_id===ocr.executionId),ioBefore={...f.objectIo};expect(f.synthetic.calls.map(input=>input.stage)).toEqual(['OCR']);
    const fileBefore={read:fileRead.mock.calls.length,put:filePut.mock.calls.length};let reconcileFileChecks=0;
    const originalRunOnce=f.service.runOnce.bind(f.service),runOnceSpy=vi.spyOn(f.service,'runOnce').mockImplementation(async()=>{
      const offset=fixture.claimSelections.length,result=await originalRunOnce();expect(fixture.claimSelections).toHaveLength(offset+1);
      const chosen=fixture.claimSelections[offset];
      if(chosen?.kind==='RECONCILE'){
        expect(result).toBe(true);expect(chosen).toEqual({accountId:fixture.seed.accountId,workId:selected.reconcile.work_item_id,generation:(BigInt(selected.reconcile.claim_generation)+1n).toString(),kind:'RECONCILE',ref:{executionId:ocr.executionId}});
        // 원 RECONCILE 반환 직후이며 다음 TYPESET tick보다 앞이다.
        expect({read:fileRead.mock.calls.length,put:filePut.mock.calls.length}).toEqual(fileBefore);expect(++reconcileFileChecks).toBe(1);
      }
      return result;
    });restores.push(()=>runOnceSpy.mockRestore());
    tick=f.runTypeset().then(value=>({value}),error=>({error}));
    const input=await b3cPhAwait(Promise.race([entered.promise,tick.then(async result=>{
      if('error'in result)throw result.error;
      const failure=Error('TYPESET 비용 경계 전에 runOnce가 반환했다');
      if(!arrived){
        try{
          expect(result.value).toBe(true);expect(fixture.claimSelections).toHaveLength(2);const chosen=fixture.claimSelections[1];expect(chosen).toEqual({accountId:fixture.seed.accountId,workId:selected.reconcile.work_item_id,generation:(BigInt(selected.reconcile.claim_generation)+1n).toString(),kind:'RECONCILE',ref:{executionId:ocr.executionId}});
          const after=await fixture.inspect(),work=(await fixture.admin.pool.query<Work>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[fixture.seed.accountId,selected.reconcile.work_item_id])).rows;
          expect(work).toHaveLength(1);expect(work[0]).toMatchObject({work_item_id:selected.reconcile.work_item_id,kind:'RECONCILE',state:'DONE',claim_generation:chosen!.generation,claim_owner:null,lease_until:null,target_ref:{executionId:ocr.executionId}});
          expect(after.financial).toEqual(sourceMoney);expect(after.evidence.filter(row=>row.execution_id===ocr.executionId)).toEqual(sourceEvidence);expect(fixture.objectIo).toEqual(ioBefore);expect(fixture.synthetic.calls.map(value=>value.stage)).toEqual(['OCR']);expect(after.executions).toHaveLength(1);expect(after.applications).toEqual([]);expect(after.results).toEqual([]);expect(after.store).toEqual([]);
          console.info(JSON.stringify({w4cE3원Queue:{단계:'TYPESET 비용 경계 전 반환',value:result.value,claimSelections:fixture.claimSelections,원OCR:ocr.executionId,원RECONCILE:work[0],원DISPATCH:selected.dispatch,원금액:after.financial.map(row=>row.stage_usd),단계dispatch:fixture.synthetic.calls.map(value=>value.stage),objectIo:fixture.objectIo}}));
        }catch(diagnosticError){throw new AggregateError([failure,diagnosticError],'이른 tick 반환과 원 queue 진단 오류');}
      }
      throw failure;
    })]));
    expect(reconcileFileChecks).toBe(1);
    // 아래 정상 기대는 RED 때 미도달이다. 후속 공통 driver 보완 뒤 같은 계약으로 검증한다.
    expect(input.stage).toBe('TYPESET');const selections=f.claimSelections;expect(selections).toHaveLength(3);expect(selections[1]).toMatchObject({kind:'RECONCILE',workId:selected.reconcile.work_item_id,ref:{executionId:ocr.executionId}});expect(selections[2]).toMatchObject({kind:'DISPATCH',workId:selected.dispatch.work_item_id,ref:{requestId:f.requestId}});expect(selections[2]!.generation).toBe((BigInt(selected.dispatch.claim_generation)+1n).toString());expect(f.claims.get(input.executionId)!.workId).toBe(selections[2]!.workId);
    const waiting=await f.inspect();expect(waiting.executions.map(row=>[row.logical_step_id,row.state])).toEqual([['OCR','SUCCEEDED'],['TYPESET','SUCCEEDED']]);expect(waiting.financial.map(row=>[row.stage_usd,row.expense_usd])).toEqual([['0.011000000000','0.011000000000'],['0.014000000000','0.014000000000']]);expect(waiting.financial.find(row=>row.execution_id===ocr.executionId)).toEqual(sourceMoney[0]);expect(waiting.evidence.filter(row=>row.execution_id===ocr.executionId&&sourceEvidence.some(original=>original.evidence_id===row.evidence_id))).toEqual(sourceEvidence);expect(waiting.applications).toEqual([]);expect(waiting.results).toEqual([]);expect(waiting.store).toEqual([]);expect(f.synthetic.calls.map(value=>value.stage)).toEqual(['OCR','TYPESET']);expect(f.confirmedProofs).toHaveLength(2);
    // TYPESET PRE의 두 번째 원 FRESH만 OCR에 OP/TERM을 한 쌍 추가한다. 기존 각 행은 위에서 전체 exact 대조했다.
    const sourceAfter=waiting.evidence.filter(row=>row.execution_id===ocr.executionId),appended=sourceAfter.filter(row=>!sourceEvidence.some(original=>original.evidence_id===row.evidence_id));
    expect(sourceAfter).toHaveLength(sourceEvidence.length+2);expect(appended).toHaveLength(2);expect(appended.map(row=>row.kind).sort()).toEqual(['WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION']);
    const pre=waiting.views.filter(item=>item.input.executionId===input.executionId&&item.view.attempt?.purpose==='PRE_DISPATCH').at(-1)!.view;expect(pre.state).toBe('VERIFIED');expect(pre.attempt!.targets).toHaveLength(1);const target=pre.attempt!.targets[0];expect(target.sourceExecutionId).toBe(ocr.executionId);
    const preOperations=waiting.operations.filter(item=>item.operation.attemptId===pre.attempt!.attemptId);expect(preOperations).toHaveLength(1);expect(preOperations[0].operation.native).toHaveLength(1);const fresh=preOperations[0].operation.native[0];expect(fresh.origin).toBe('FRESH');expect(pre.jobIds).toEqual([fresh.intent.jobId]);
    if(!('windowsEvidenceRef' in fresh.candidate))throw Error('원 Windows FRESH 참조 누락');
    const proofs=f.confirmedProofs.filter(value=>value.input.executionId===input.executionId);expect(proofs).toHaveLength(1);const key=proofs[0].key;expect(key.binding.jobId).toBe(fresh.intent.jobId);expect(key.binding.parentInstanceId).toBe(fresh.intent.parentInstanceId);expect(key.expected).toEqual(fresh.candidate.windowsEvidenceRef);
    const firstProof=f.confirmedProofs.find(value=>value.input.executionId===ocr.executionId)!;expect(key.binding.jobId).not.toBe(firstProof.key.binding.jobId);
    const native=waiting.native.filter(row=>row.job_id===fresh.intent.jobId);expect(native).toHaveLength(1);expect(native[0].protected_intent).toEqual(fresh.intent);
    const originals=sourceEvidence.filter(row=>row.kind==='INPUT'),bases=sourceEvidence.filter(row=>row.kind==='OPERATIONAL_COST_BASIS');expect(originals).toHaveLength(1);expect(bases).toHaveLength(1);
    const source={input:{executionId:ocr.executionId,inputEvidenceId:originals[0].evidence_id,stageInputDigest:ocr.inputDigest},inputEvidence:{evidenceId:originals[0].evidence_id,evidenceDigest:originals[0].evidence_digest},inputFingerprint:digest(canonicalInput(ocr)),basisRef:{evidenceId:bases[0].evidence_id,evidenceDigest:bases[0].evidence_digest}};
    expect(source.inputEvidence).toEqual(target.input);expect(source.basisRef).toEqual(target.basis);expect(source.inputFingerprint).toBe(target.inputFingerprint);
    const operation=appended.find(row=>row.kind==='WINDOWS_NATIVE_OPERATION')!,termination=appended.find(row=>row.kind==='WINDOWS_NATIVE_TERMINATION')!,op=operation.protected_observation.value as import('../../packages/domain/src/native-receipts.js').WindowsNativeOperationValue,term=termination.protected_observation.value as import('../../packages/domain/src/native-receipts.js').WindowsNativeTerminationValue;
    for(const row of appended){expect(row.account_id).toBe(f.seed.accountId);expect(row.execution_id).toBe(ocr.executionId);expect(row.protected_evidence_ref).toBe(row.evidence_id);expect(digest(row.protected_observation)).toBe(row.evidence_digest);expect(row.protected_observation).toEqual({version:1,accountId:f.seed.accountId,executionId:ocr.executionId,inputDigest:ocr.inputDigest,inputFingerprint:source.inputFingerprint,kind:row.kind,value:row.protected_observation.value});expect(row.received_at).toBeInstanceOf(Date);}
    expect(op.binding).toEqual(key.binding);expect(op.source).toEqual(source);expect(op.intentDigest).toBe(native[0].intent_digest);expect(op.windowsEvidenceRef).toEqual(key.expected);expect(op.observations.result).toEqual({evidenceId:fresh.candidate.resultObservationId,evidenceDigest:fresh.candidate.resultObservationDigest});
    expect(term).toEqual({version:1,jobId:key.binding.jobId,parentInstanceId:key.binding.parentInstanceId,capacityReservationId:key.binding.capacityReservationId,source,originDigest:op.originDigest,windowsEvidenceRef:key.expected,terminationObservation:op.observations.termination,termination:fresh.termination,records:op.records});
    // 원 readonly journal 포트가 검증한 두 ref와 exact 비교하여 같은 kind의 무관한 추가 행도 거부한다.
    const pair=await f.worker.accountTransaction(f.seed.accountId,tx=>fixture.remote.costs.lookupIn(tx,key),true);expect(pair.state).toBe('VERIFIED');expect(pair.operation).toEqual({evidenceId:operation.evidence_id,evidenceDigest:operation.evidence_digest});expect(pair.termination).toEqual({evidenceId:termination.evidence_id,evidenceDigest:termination.evidence_digest});
    gate.resolve();const done=await b3cPhAwait(tick);if('error'in done)throw done.error;expect(done.value).toBe(true);const state=await f.inspect();expect(state.applications).toHaveLength(1);expect(state.applications[0]).toMatchObject({outcome:'APPLIED',execution_id:input.executionId});expect(state.results).toHaveLength(1);expect(state.store).toHaveLength(1);expect(state.request.state).toBe('COMPLETED');expect(state.native).toHaveLength(2);expect(state.cache).toHaveLength(1);expect(f.claimSelections).toEqual(selections);
    expect((await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 ORDER BY reservation_id',[f.seed.accountId])).rows).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null},{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);
    const beforeClose=await f.inspect(),stableIo={...f.objectIo};for(const current of f.inputs)await f.cost.finishAttempt(current);await f.cost.idle();expect(await f.inspect()).toEqual(beforeClose);expect(f.objectIo).toEqual(stableIo);
  }catch(error){failures.push(error);}
  finally{
    gate.resolve();if(tick){try{const result=await tick;if('error'in result&&!failures.includes(result.error))failures.push(result.error);}catch(error){failures.push(error);}}
    for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
    try{await f?.close();}catch(error){failures.push(error);}
    const denied=[...guard.denied];try{guard.restore();}catch(error){failures.push(error);}try{expect(denied).toEqual([]);}catch(error){failures.push(error);}
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 원 queue 회귀와 정리 오류');
},120000);

// E3 통합 음성만 추가한다. 원 queue 선택과 runOnce 수명은 그대로 실행한다.
type E3NegativeFixture=Awaited<ReturnType<typeof createW4CWindowsExecutionFixture>>;
type E3NegativeFiles={read:number;put:number};
type E3NegativeNativeRow=import('pg').QueryResultRow&{observation_id:string;job_id:string;event:string;observation_digest:string;protected_observation:Record<string,unknown>};
function e3NegativeLife(f:E3NegativeFixture,restores:(()=>void)[]){
  const owner=f.service as unknown as {finishCostAttempt(input:StageInput):Promise<void>};
  const cost=vi.spyOn(owner,'finishCostAttempt');restores.push(()=>cost.mockRestore());
  const finish=vi.spyOn(f.service,'finish');restores.push(()=>finish.mockRestore());
  return {cost,finish};
}
async function e3NegativeCase(options:Parameters<typeof createW4CWindowsExecutionFixture>[0],run:(f:E3NegativeFixture,tools:{files:E3NegativeFiles;restores:(()=>void)[];undos:(()=>Promise<void>)[];life:ReturnType<typeof e3NegativeLife>})=>Promise<void>){
  const guard=guardWindowsNativeIo(),restores:(()=>void)[]=[],undos:(()=>Promise<void>)[]=[],failures:unknown[]=[];let f:E3NegativeFixture|undefined;
  try{
    f=await createW4CWindowsExecutionFixture(options);const fixture=f,files:E3NegativeFiles={read:0,put:0};
    const read=f.files.read.bind(f.files),readSpy=vi.spyOn(f.files,'read');restores.push(()=>readSpy.mockRestore());readSpy.mockImplementation((...args)=>{files.read++;return read(...args);});
    const put=f.files.put.bind(f.files),putSpy=vi.spyOn(f.files,'put');restores.push(()=>putSpy.mockRestore());putSpy.mockImplementation((...args)=>{files.put++;return put(...args);});
    await run(fixture,{files,restores,undos,life:e3NegativeLife(fixture,restores)});
  }catch(error){failures.push(error);}
  finally{
    try{
      for(const undo of undos.reverse()){try{await undo();}catch(error){failures.push(error);}}
      try{f?.service.stopClaims();}catch(error){failures.push(error);}
      try{await f?.cost.idle();}catch(error){failures.push(error);}
      try{await f?.remote.gateway.idle();}catch(error){failures.push(error);}
      try{await f?.close();}catch(error){failures.push(error);}
    }finally{
      for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
      const denied=[...guard.denied];try{guard.restore();expect(denied).toEqual([]);}catch(error){failures.push(error);}
    }
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 통합 음성과 원 정리 오류');
}
async function e3NegativeGate(f:E3NegativeFixture){
  const {nativeExecutionWaiting}=await import('../../packages/domain/src/native-execution-wait.js');
  return f.worker.accountTransaction(f.seed.accountId,async tx=>{
    const request=(await tx.client.query<import('../../packages/domain/src/model.js').RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows[0];
    expect(request).toBeDefined();return {waiting:await nativeExecutionWaiting(tx,request),hold:[...request.hold_reasons]};
  },true);
}
async function e3NegativeWriter(f:E3NegativeFixture){
  const account=[f.seed.accountId];
  return {
    intents:(await f.admin.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',account)).rows,
    go:(await f.admin.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1 ORDER BY job_id',account)).rows,
    candidates:(await f.admin.pool.query('SELECT * FROM manga_web.native_result_candidates WHERE account_id=$1 ORDER BY candidate_id',account)).rows,
    receipts:(await f.admin.pool.query('SELECT * FROM manga_web.native_result_receipts WHERE account_id=$1 ORDER BY candidate_id',account)).rows,
    events:(await f.admin.pool.query('SELECT * FROM manga_web.native_controller_events WHERE account_id=$1 ORDER BY event_id',account)).rows
  };
}
async function e3NegativeNativeWrite(f:E3NegativeFixture,row:E3NegativeNativeRow,body:Record<string,unknown>,originalDigest:string|null=null){
  // 승인 폐기 DB의 공격 조립이다. 같은 거래에서 단일 immutable trigger를 원복한 뒤 COMMIT한다.
  // 원 trigger 정의·FK·grants는 바꾸지 않으며 실제 worker가 재개될 때는 원 trigger가 켜져 있다.
  return f.admin.transaction(async client=>{
    const mode=async()=>(await client.query<{tgenabled:string}>("SELECT tgenabled FROM pg_trigger WHERE tgrelid='manga_web.native_job_observations'::regclass AND tgname='immutable_native_job_observations'")).rows;
    expect(await mode()).toEqual([{tgenabled:'O'}]);
    await client.query('ALTER TABLE manga_web.native_job_observations DISABLE TRIGGER immutable_native_job_observations');
    const changed=(await client.query<E3NegativeNativeRow>("UPDATE manga_web.native_job_observations SET protected_observation=$3::jsonb,observation_digest=COALESCE($4::text,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex')) WHERE account_id=$1 AND observation_id=$2 RETURNING *",[f.seed.accountId,row.observation_id,JSON.stringify(body),originalDigest])).rows;
    expect(changed).toHaveLength(1);
    await client.query('ALTER TABLE manga_web.native_job_observations ENABLE TRIGGER immutable_native_job_observations');expect(await mode()).toEqual([{tgenabled:'O'}]);
    return changed[0];
  });
}
async function e3NegativeClaimReturned(f:E3NegativeFixture,input:StageInput,life:ReturnType<typeof e3NegativeLife>,delay:number){
  const claim=f.claims.get(input.executionId);expect(claim).toBeDefined();
  const cost=life.cost.mock.calls.flatMap((args,index)=>args[0].executionId===input.executionId?[index]:[]),finish=life.finish.mock.calls.flatMap((args,index)=>args[0].workId===claim!.workId&&args[0].generation===claim!.generation?[index]:[]);
  expect(cost).toHaveLength(1);expect(finish).toHaveLength(1);expect(life.finish.mock.calls[finish[0]]).toEqual([claim,false,delay]);
  expect(life.cost.mock.invocationCallOrder[cost[0]]).toBeLessThan(life.finish.mock.invocationCallOrder[finish[0]]);
  await expect(life.cost.mock.results[cost[0]].value).resolves.toBeUndefined();await expect(life.finish.mock.results[finish[0]].value).resolves.toBeUndefined();
  expect((await f.admin.pool.query('SELECT state,claim_owner,claim_generation,lease_until FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[claim!.accountId,claim!.workId])).rows).toEqual([{state:'READY',claim_owner:null,claim_generation:claim!.generation,lease_until:null}]);
}
async function e3NegativeOcrMoney(f:E3NegativeFixture,executionId:string){
  const values=[f.seed.accountId,executionId];
  return {
    costs:(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',values)).rows,
    expenses:(await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',values)).rows,
    evidence:(await f.admin.pool.query("SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE','WINDOWS_STAGE_COST_SEAL') ORDER BY evidence_id",values)).rows
  };
}
it('W4-C E3 통합 음성 native RESULT 필수관측 결손은 원 preflight와 적용을 막고 claim을 반환한다',async()=>e3NegativeCase({},async(f,{files,restores,undos,life})=>{
  const prepare=f.service.hooks.afterPrepare!,preflight=vi.spyOn(f.service,'preflight');restores.push(()=>preflight.mockRestore());
  let hits=0,input:StageInput|undefined,ioBefore:E3NegativeFiles|undefined,writer:Awaited<ReturnType<typeof e3NegativeWriter>>|undefined,rows:E3NegativeNativeRow[]|undefined,changedRows:E3NegativeNativeRow[]|undefined,inputBasis:import('pg').QueryResultRow[]|undefined;
  f.service.hooks.afterPrepare=async current=>{
    await prepare(current);expect(current.stage).toBe('OCR');hits++;expect(hits).toBe(1);input=current;
    expect(f.events).toContain('INPUT_NATIVE_RETURNED:OCR');expect(f.events).toContain('OPERATOR_PROOF_ACK:OCR');expect(f.synthetic.calls).toEqual([]);
    const healthy=await e3NegativeGate(f);expect(healthy).toEqual({waiting:false,hold:[]});
    const claim=f.claims.get(current.executionId);expect(claim).toBeDefined();
    expect((await f.admin.pool.query('SELECT claim_owner,claim_generation,lease_until>clock_timestamp() live FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,claim!.workId])).rows).toEqual([{claim_owner:f.service.workerId,claim_generation:claim!.generation,live:true}]);
    inputBasis=(await f.inspect()).evidence.filter(row=>['INPUT','OPERATIONAL_COST_BASIS'].includes(row.kind));
    rows=(await f.admin.pool.query<E3NegativeNativeRow>('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY event,observation_id',[f.seed.accountId])).rows;
    expect(rows.map(row=>row.event)).toEqual(['RESULT','TERMINATION']);for(const row of rows)expect(row.protected_observation).toMatchObject({version:2,code:'OK',termination:{kind:'WINDOWS_JOB_EMPTY',operationJoined:true}});
    writer=await e3NegativeWriter(f);expect(writer.go).toHaveLength(1);expect(writer.candidates).toHaveLength(1);expect(writer.receipts).toHaveLength(1);
    expect(files.read).toBeGreaterThan(0);expect(files.put).toBeGreaterThan(0);ioBefore={...files};
    const original=rows[0],body=structuredClone(original.protected_observation);delete body.code;
    const changed=await e3NegativeNativeWrite(f,original,body);
    undos.push(async()=>{await e3NegativeNativeWrite(f,original,original.protected_observation,original.observation_digest);expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY event,observation_id',[f.seed.accountId])).rows).toEqual(rows);});
    changedRows=[changed,rows[1]];
    expect(changed).toEqual({...original,protected_observation:body,observation_digest:changed.observation_digest});
    expect(await e3NegativeGate(f)).toEqual({waiting:true,hold:[]});
  };restores.push(()=>{f.service.hooks.afterPrepare=prepare;});
  expect(await f.service.runOnce()).toBe(true);expect(hits).toBe(1);expect(input).toBeDefined();
  expect(preflight).toHaveBeenCalledExactlyOnceWith(f.claims.get(input!.executionId),input);await expect(preflight.mock.results[0].value).resolves.toBe(false);
  const after=await f.inspect();expect(after.request.state).toBe('WAITING');expect(after.request.hold_reasons).toContain('NATIVE_EXECUTION_UNCONFIRMED');expect(after.executions).toHaveLength(1);expect(after.executions[0]).toMatchObject({state:'PREPARED',dispatch_attempted_at:null,start_confirmed_at:null});
  expect(after.evidence.filter(row=>row.kind==='OUTCOME')).toEqual([]);expect(after.checkpoints).toEqual([]);expect(after.applications).toEqual([]);expect(after.results).toEqual([]);expect(after.store).toEqual([]);expect(f.synthetic.calls).toEqual([]);
  expect(after.evidence.filter(row=>['INPUT','OPERATIONAL_COST_BASIS'].includes(row.kind))).toEqual(inputBasis);
  expect((await f.admin.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY event,observation_id',[f.seed.accountId])).rows).toEqual(changedRows);
  expect(await e3NegativeWriter(f)).toEqual(writer);expect(files).toEqual(ioBefore);await e3NegativeClaimReturned(f,input!,life,5000);
  const view=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,input!),true);expect(view).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  expect((await f.admin.pool.query('SELECT state,released_at,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{state:'HELD',released_at:null,windows_release_proof_id:null}]);
  console.info(JSON.stringify({e3통합native결손:{field:'RESULT.code',healthyGate:false,faultGate:true,preflight:false,receiptCompletedBeforeFault:true,filesBefore:ioBefore,filesAfter:files,claim:f.claims.get(input!.executionId),events:f.events}}));
}),120000);

it('W4-C E3 통합 음성 FINAL self OP 소속결손은 원 성공과 OCR 금액을 보존하고 비용확정과 적용을 막는다',async()=>e3NegativeCase({expectFinalSelfOperationMissing:true},async(f,{files,restores,undos,life})=>{
  expect(await f.service.runOnce()).toBe(true);const first=await f.inspect(),ocr=f.inputs[0];expect(ocr.stage).toBe('OCR');expect(first.executions).toHaveLength(1);expect(first.financial).toHaveLength(1);expect(first.financial[0]).toMatchObject({state:'CONFIRMED',stage_usd:'0.011000000000',expense_usd:'0.011000000000'});
  const money=await e3NegativeOcrMoney(f,ocr.executionId),validate=f.provider.validateObservation!.bind(f.provider);
  let hits=0,current:StageInput|undefined,ioBefore:E3NegativeFiles|undefined,writer:Awaited<ReturnType<typeof e3NegativeWriter>>|undefined,success:Awaited<ReturnType<typeof f.inspect>>|undefined,selfId:string|undefined,finalId:string|undefined;
  const collect=vi.spyOn(f.cost,'collectCheckpointIn');restores.push(()=>collect.mockRestore());
  const validation=vi.spyOn(f.provider,'validateObservation');restores.push(()=>validation.mockRestore());
  validation.mockImplementation(async(...args)=>{
    const count=f.operations.length;await validate(...args);const added=f.operations.slice(count);if(!added.length)return;expect(added).toHaveLength(1);
    const item=added[0];if(item.input.stage!=='TYPESET'||args[0].executionId!==item.input.executionId)return;
    const attempt=(await f.admin.pool.query("SELECT protected_observation->'value' value FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'attemptId'=$3",[f.seed.accountId,item.input.executionId,item.operation.attemptId])).rows;expect(attempt).toHaveLength(1);if(attempt[0].value.purpose!=='FINAL_COMMIT')return;
    hits++;expect(hits).toBe(1);current=item.input;selfId=item.ref.evidenceId;finalId=item.operation.attemptId;
    expect(item.operation.native).toEqual([]);expect(item.operation.storage.length).toBeGreaterThan(0);expect(item.operation.semantic.outcome).toBe('RETURNED');expect(attempt[0].value.targets).toHaveLength(2);
    success=await f.inspect();const own=success.executions.find(row=>row.execution_id===current!.executionId);expect(own).toMatchObject({state:'SUCCEEDED',claim_generation:f.claims.get(current.executionId)!.generation});
    const outcomes=success.evidence.filter(row=>row.execution_id===current!.executionId&&row.kind==='OUTCOME');expect(outcomes).toHaveLength(1);expect(outcomes[0].protected_observation).toMatchObject({outcome:'SUCCESS',started:true});
    const checkpoints=success.checkpoints.filter(row=>row.execution_id===current!.executionId);expect(checkpoints).toHaveLength(1);expect(checkpoints[0].verification_state).toBe('VERIFIED');
    const pre=success.views.find(row=>row.input.executionId===current!.executionId&&row.view.attempt?.purpose==='PRE_DISPATCH')?.view;expect(pre?.state).toBe('VERIFIED');expect(pre?.attempt?.targets).toHaveLength(1);
    const operations=success.operations.filter(row=>row.input.executionId===current!.executionId);expect(operations).toHaveLength(3);expect(operations[0].operation.native).toHaveLength(1);expect(operations[0].operation.native[0].origin).toBe('FRESH');
    expect(operations[1].operation.native).toHaveLength(1);expect(operations[1].operation.native[0].origin).toBe('CACHE');expect(operations[2].operation.native).toEqual([]);
    writer=await e3NegativeWriter(f);expect(writer.go).toHaveLength(2);expect(files.read).toBeGreaterThan(0);expect(files.put).toBeGreaterThan(0);ioBefore={...files};
    const original=(await f.admin.pool.query('SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,selfId])).rows;expect(original).toHaveLength(1);
    const body=structuredClone(original[0].protected_observation);body.value.attemptId=randomUUID();
    // 실제 self OP 한 행의 소속만 손상시킨다. 원 SOURCE/END·OP 내용·I/O는 삭제하거나 합성하지 않는다.
    expect((await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND evidence_id=$2 AND evidence_digest=$5',[f.seed.accountId,selfId,JSON.stringify(body),digest(body),original[0].evidence_digest])).rowCount).toBe(1);
    undos.push(async()=>{expect((await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,selfId,JSON.stringify(original[0].protected_observation),original[0].evidence_digest])).rowCount).toBe(1);expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,selfId])).rows).toEqual(original);});
  });
  // 별도 담당의 공통 bounded driver를 사용한다. queue 행과 우선순위는 바꾸지 않는다.
  expect(await f.runTypeset()).toBe(true);
  if(hits!==1){console.info(JSON.stringify({e3통합FINAL미도달:{claimSelections:f.claimSelections,diagnosis:await f.diagnose('E3 FINAL 음성 주입점 미도달')}}));throw Error('E3 FINAL 음성 원 경계 미도달');}
  const input=current!,after=await f.inspect(),own=after.executions.find(row=>row.execution_id===input.executionId);expect(own).toEqual(success!.executions.find(row=>row.execution_id===input.executionId));
  expect(after.evidence.filter(row=>row.execution_id===input.executionId&&row.kind==='OUTCOME')).toEqual(success!.evidence.filter(row=>row.execution_id===input.executionId&&row.kind==='OUTCOME'));expect(after.checkpoints).toEqual(success!.checkpoints);
  const preId=success!.views.find(row=>row.input.executionId===input.executionId&&row.view.attempt?.purpose==='PRE_DISPATCH')!.view.attempt!.attemptId;
  const preRows=(state:typeof after)=>state.evidence.filter(row=>row.execution_id===input.executionId&&row.kind.startsWith('CHECKPOINT_VALIDATION_')&&row.protected_observation.value.attemptId===preId);
  expect(preRows(after)).toEqual(preRows(success!));
  const verifiedPre=preRows(after).filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED');expect(verifiedPre).toHaveLength(1);expect(verifiedPre).toEqual(preRows(success!).filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED'));expect(verifiedPre[0].protected_evidence_ref).toBe(verifiedPre[0].evidence_id);expect(digest(verifiedPre[0].protected_observation)).toBe(verifiedPre[0].evidence_digest);
  const finalFacts=collect.mock.calls.flatMap((args,index)=>args[1].executionId===input.executionId&&args[2].purpose==='FINAL_COMMIT'?[index]:[]);expect(finalFacts).toHaveLength(1);
  const facts:import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts|null=await collect.mock.results[finalFacts[0]].value;expect(facts?.operations).toHaveLength(1);expect(facts?.operations.map(ref=>ref.evidenceId)).not.toContain(selfId);
  // 원 finally가 claim을 반환한 뒤 CURRENT 재검증은 WAIT이며 원 PRE 봉인 행은 위에서 exact 보존한다.
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'PRE_DISPATCH'),true)).toMatchObject({state:'WAIT'});
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,input,'FINAL_COMMIT'),true)).toMatchObject({state:'WAIT'});
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.finalCommitIn(tx,input),true)).toBe('WAIT');
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,input),true)).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  expect(after.financial.find(row=>row.execution_id===input.executionId)).toMatchObject({state:'UNCONFIRMED',stage_usd:null,expense_usd:null});expect(await e3NegativeOcrMoney(f,ocr.executionId)).toEqual(money);
  const evidence=after.evidence.filter(row=>row.execution_id===input.executionId),sources=evidence.filter(row=>row.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE').map(row=>row.protected_observation.value),ends=evidence.filter(row=>row.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION').flatMap(row=>row.protected_observation.value.operations);
  expect(sources.length).toBeGreaterThan(2);expect(ends).toHaveLength(sources.length);for(const source of sources)expect(ends.filter(end=>end.operationId===source.operationId&&end.eventId===source.eventId)).toEqual([{operationId:source.operationId,eventId:source.eventId,outcome:'RETURNED'}]);
  expect(sources.map(row=>row.fact)).toContainEqual(expect.objectContaining({componentId:'semantic',quantity:'3',state:'CONFIRMED'}));
  expect(evidence.filter(row=>['OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE','WINDOWS_STAGE_COST_SEAL'].includes(row.kind))).toEqual([]);
  expect(evidence.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&row.protected_observation.value.attemptId===finalId)).toEqual([]);
  expect(after.applications).toEqual([]);expect(after.results).toEqual([]);expect(after.store).toEqual([]);expect(f.synthetic.calls).toHaveLength(2);expect(after.executions.filter(row=>row.start_confirmed_at!==null)).toHaveLength(2);
  expect(await e3NegativeWriter(f)).toEqual(writer);expect(files).toEqual(ioBefore);await e3NegativeClaimReturned(f,input,life,0);
  expect((await f.admin.pool.query('SELECT state,released_at,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 ORDER BY reservation_id',[f.seed.accountId])).rows).toEqual([{state:'HELD',released_at:null,windows_release_proof_id:null},{state:'HELD',released_at:null,windows_release_proof_id:null}]);
  console.info(JSON.stringify({e3통합FINAL결손:{field:'self OP.attemptId',finalId,selfId,actualMatchingOperations:facts?.operations.length,filesBefore:ioBefore,filesAfter:files,claimSelections:f.claimSelections,events:f.events}}));
}),120000);
