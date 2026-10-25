import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,type ProviderAdapter,type Observation} from '../../packages/domain/src/provider.js';
import {contextRow,type RequestRow,type ResultRow} from '../../packages/domain/src/model.js';
import {manualCommands} from '../../packages/domain/src/manual.js';
import type {Settings,WorkspaceCommand,Block} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Actual restricted LOGIN/claim/INPUT/semantic validation with owned synthetic
// stages. No operational provider/native task/object PUT/listener/price runs.
const databases:Database[]=[],fixturePools:Database[]=[];
let shared:{admin:Database;api:Database;worker:Database}|null=null;
async function closePools(pools:Database[]):Promise<void>{const failures:unknown[]=[];for(const db of pools.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_CHECKPOINT_DB_CLOSE_UNCONFIRMED');}
beforeAll(async()=>{const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api');databases.push(api);const worker=await provisionLocalService(admin,'trio_web_worker');databases.push(worker);await api.validateServiceRole();await worker.validateServiceRole();shared={admin,api,worker};});
afterEach(async()=>{vi.restoreAllMocks();await closePools(fixturePools);});
afterAll(async()=>{const failures:unknown[]=[];for(const pools of [fixturePools,databases]){try{await closePools(pools);}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_CHECKPOINT_DB_CLOSE_UNCONFIRMED');});
async function drain(service:ExecutionService){for(let at=0;at<32;at++)if(!await service.runOnce())return;throw Error('OWNED_READY_WORK_DID_NOT_QUIESCE');}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

async function fixture(pageCount=1){
  if(shared===null)throw Error('OWNED_CHECKPOINT_DB_NOT_READY');const {admin,api}=shared,worker=new Database(shared.worker.connectionString,undefined,'trio_web_worker');fixturePools.push(worker);await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),pageCount,now);
  const policy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider() as SyntheticProvider&ProviderAdapter,service=new ExecutionService(worker,provider,policy);
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const current=async()=>(await admin.pool.query<ResultRow>('SELECT r.* FROM manga_web.results r JOIN manga_web.workspace_pages p ON p.account_id=r.account_id AND p.current_result_id=r.result_id WHERE p.account_id=$1 AND p.context_id=$2 AND p.page_lineage_id=$3',[seed.accountId,seed.contextId,seed.pageIds[0]])).rows[0];
  const command=async(operation:WorkspaceCommand['operation'])=>{const revision=(await admin.pool.query<{workspace_revision:string}>('SELECT workspace_revision FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId])).rows[0].workspace_revision;return workspace.handle(actor,{commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});};
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  workspace.extensions.push(manualCommands(id=>id===settings.fontAssetId,2048,256,{fontCatalogVersion:'noto-cjk-2.004-v1'}));
  const block:Block={regionId:randomUUID(),geometry:{polygon:[{x:15,y:8},{x:85,y:8},{x:85,y:20},{x:15,y:20}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'合成入力',status:'AI_PROPOSED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:settings.fontAssetId,fontSizePx:20,appliedTranslation:null};
  // A stable pre-existing block makes a newly executed OCR semantically equal
  // to the original OCR; final-checkpoint reuse still passes the real digest.
  const data={blocks:[block],geometryContract:'geometry-v1',renderContract:'render-v1',cleanupQa:'NOT_RUN',renderSpecification:{version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[{regionId:block.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'}]}};
  await admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE account_id=$1 AND result_id=$3',[seed.accountId,JSON.stringify(data),(await current()).result_id]);
  await command({kind:'PATCH_SETTINGS',payload:{settings}});
  await command({kind:'MANUAL_EDIT',payload:{pageId:seed.pageIds[0],regionId:block.regionId,expectedResultRevision:'0',patch:{fontSizePx:22}}});
  const request=async()=>(await command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:(await current()).result_revision,settingsVersion:'1'}})).reply.operationRef.id!;
  const retry=async(requestId:string)=>(await command({kind:'RETRY_REQUEST',payload:{requestId}})).reply.operationRef.id!;
  // Filter only actual dispatch_candidates() discovery. Restricted claim,
  // owner/generation/lease and authorize all remain the original SQL path.
  const candidateQuery=worker.pool.query.bind(worker.pool);
  vi.spyOn(worker.pool,'query').mockImplementation(((query:unknown)=>{expect(query).toBe('SELECT * FROM manga_web.dispatch_candidates()');return candidateQuery('SELECT * FROM manga_web.dispatch_candidates() WHERE account_id=$1',[seed.accountId]);}) as typeof worker.pool.query);
  return {admin,worker,seed,provider,service,current,request,retry,command};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type SelectedStep={logical_step_id:string;execution_id:string;checkpoint_id:string;output_envelope:Observation};
async function selectedSteps(f:Fixture,requestId:string):Promise<SelectedStep[]>{return (await f.admin.pool.query<SelectedStep>('SELECT s.logical_step_id,e.execution_id,c.checkpoint_id,c.output_envelope FROM manga_web.request_steps s JOIN manga_web.executions e ON e.account_id=s.account_id AND e.execution_id=s.current_execution_id JOIN manga_web.checkpoints c ON c.account_id=e.account_id AND c.execution_id=e.execution_id WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal',[f.seed.accountId,requestId])).rows;}
async function failedOriginal(f:Fixture){
  const original=await f.request();let rejected=false;
  f.provider.validateObservation=async input=>{
    if(input.requestId!==original)return;
    const confirmed=(await f.admin.pool.query<{n:number}>("SELECT count(*)::integer AS n FROM manga_web.request_steps s JOIN manga_web.executions e ON e.account_id=s.account_id AND e.execution_id=s.current_execution_id JOIN manga_web.checkpoints c ON c.account_id=e.account_id AND c.execution_id=e.execution_id WHERE s.account_id=$1 AND s.request_id=$2 AND e.state='SUCCEEDED' AND c.verification_state='VERIFIED'",[f.seed.accountId,original])).rows[0].n;
    if(confirmed===2&&!rejected){rejected=true;throw Error('OWNED_ORIGINAL_CHECKPOINT_REJECTED_ONCE');}
  };
  await drain(f.service);expect(rejected).toBe(true);
  expect((await f.admin.pool.query('SELECT state,terminal_evidence_ref FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,original])).rows[0]).toEqual({state:'FAILED',terminal_evidence_ref:'CHECKPOINT_DEPENDENCY_INVALID'});
  const selected=await selectedSteps(f,original);expect(selected).toHaveLength(2);return {original,selected};
}
async function prepareRetry(f:Fixture){const original=await failedOriginal(f),retried=await f.retry(original.original);const steps=(await f.admin.pool.query('SELECT current_execution_id,reuse_checkpoint_id FROM manga_web.request_steps WHERE account_id=$1 AND request_id=$2 ORDER BY ordinal',[f.seed.accountId,retried])).rows;expect(steps).toHaveLength(2);expect(steps.every(row=>row.current_execution_id===null&&row.reuse_checkpoint_id!==null)).toBe(true);return {...original,retried};}
async function facts(f:Fixture){
  const rows=async(sql:string)=>(await f.admin.pool.query(sql,[f.seed.accountId])).rows;
  return {executions:await rows('SELECT * FROM manga_web.executions WHERE account_id=$1 ORDER BY execution_id'),costs:await rows('SELECT * FROM manga_web.cost_items WHERE account_id=$1 ORDER BY cost_item_id'),starts:await rows("SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='START' ORDER BY evidence_id"),freeStarts:await rows('SELECT * FROM manga_web.free_starts WHERE account_id=$1 ORDER BY request_id'),checkpoints:await rows('SELECT * FROM manga_web.checkpoints WHERE account_id=$1 ORDER BY checkpoint_id'),settlements:await rows('SELECT * FROM manga_web.settlements WHERE account_id=$1 ORDER BY cost_item_id'),account:await rows('SELECT free_started_count,balance_credit FROM manga_web.accounts WHERE account_id=$1')};
}
async function effects(f:Fixture){
  const rows=async(sql:string)=>(await f.admin.pool.query(sql,[f.seed.accountId])).rows;
  return {applications:await rows('SELECT * FROM manga_web.result_applications WHERE account_id=$1 ORDER BY application_id'),results:await rows("SELECT * FROM manga_web.results WHERE account_id=$1 AND origin='AI_APPLIED' ORDER BY result_id"),pages:await rows('SELECT * FROM manga_web.workspace_pages WHERE account_id=$1 ORDER BY page_lineage_id'),history:await rows('SELECT * FROM manga_web.manual_history WHERE account_id=$1 ORDER BY history_id'),cursors:await rows('SELECT * FROM manga_web.history_cursors WHERE account_id=$1 ORDER BY page_lineage_id'),workspace:await rows('SELECT workspace_revision FROM manga_web.workspace_contexts WHERE account_id=$1'),stores:await rows("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND kind='STORE' ORDER BY work_item_id"),reservations:await rows('SELECT * FROM manga_web.free_reservations WHERE account_id=$1 ORDER BY request_id')};
}
async function applications(f:Fixture,requestId:string){return (await f.admin.pool.query('SELECT request_id,origin_request_id,execution_origin_request_id,execution_id,outcome,applied_at FROM manga_web.result_applications WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,requestId])).rows;}
async function directComplete(f:Fixture,requestId:string,observation:Observation){await f.worker.accountTransaction(f.seed.accountId,async tx=>{const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,requestId])).rows[0];await f.service.applyComplete(tx,await contextRow(tx,f.seed.contextId),request,observation.data!,observation);},true);}
async function insertApplication(f:Fixture,requestId:string,executionId:string,originRequestId:string|null){const result=await f.current();return f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO result_applications(account_id,application_id,request_id,execution_id,origin_request_id,result_id,context_id,page_lineage_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'NOT_APPLICABLE')",[f.seed.accountId,randomUUID(),requestId,executionId,originRequestId,result.result_id,f.seed.contextId,f.seed.pageIds[0]]),true);}

describe.sequential('original checkpoint-only result completion',()=>{
  it('completes all-checkpoint reuse with the exact final origin and no new execution/start/cost/settlement',async()=>{
    const f=await fixture(),p=await prepareRetry(f),before=await facts(f),initial=await effects(f);await drain(f.service);
    const applied=await applications(f,p.retried);expect(applied).toHaveLength(1);expect(applied[0]).toMatchObject({request_id:p.retried,origin_request_id:p.original,execution_origin_request_id:p.original,execution_id:p.selected[1].execution_id,outcome:'APPLIED'});expect(applied[0].applied_at).toBeInstanceOf(Date);
    expect((await f.admin.pool.query('SELECT state,first_start_at FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,p.retried])).rows).toEqual([{state:'COMPLETED',first_start_at:null}]);
    expect(await facts(f)).toEqual(before);expect(f.provider.calls.map(input=>input.stage)).toEqual(['OCR','TRANSLATE']);
    const after=await effects(f);expect(after.results).toHaveLength(1);expect(after.pages[0].result_revision).toBe((BigInt(initial.pages[0].result_revision)+1n).toString());expect(after.stores.length-initial.stores.length).toBe(1);expect(after.history).toHaveLength(1);expect(after.history[0].validity).toBe('INVALIDATED');expect(after.reservations.find(row=>row.request_id===p.retried)).toMatchObject({state:'RELEASED_CONFIRMED',revision:'1'});
    expect((await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("SELECT has_table_privilege(current_user,'manga_web.checkpoints','UPDATE') AS update,has_table_privilege(current_user,'manga_web.checkpoints','DELETE') AS delete"))).rows).toEqual([{update:false,delete:false}]);
  });
  it('keeps normal completion origin NULL and enforces one application even with another result id',async()=>{
    const f=await fixture(),request=await f.request();await drain(f.service);const final=(await selectedSteps(f,request))[1],before=await effects(f);
    expect((await applications(f,request))[0]).toMatchObject({request_id:request,origin_request_id:null,execution_origin_request_id:request,execution_id:final.execution_id,outcome:'APPLIED'});
    const result=await f.current();await expect(f.worker.accountTransaction(f.seed.accountId,async tx=>{const resultId=randomUUID(),revision=(BigInt(result.result_revision)+1n).toString();await tx.client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text,'AI_APPLIED',$7)",[f.seed.accountId,resultId,f.seed.contextId,f.seed.pageIds[0],revision,result.original_asset_id,JSON.stringify(result.edit_data)]);await tx.client.query("INSERT INTO result_applications(account_id,application_id,request_id,execution_id,result_id,context_id,page_lineage_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'NOT_APPLICABLE')",[f.seed.accountId,randomUUID(),request,final.execution_id,resultId,f.seed.contextId,f.seed.pageIds[0]]);},true)).rejects.toMatchObject({code:'23505',constraint:'one_result_application_per_request'});
    expect(await effects(f)).toEqual(before);
  });
  it('uses the reused final TRANSLATE rather than a newly executed intermediate OCR',async()=>{
    const f=await fixture(),p=await prepareRetry(f),originalFacts=await facts(f);
    await f.admin.pool.query("UPDATE manga_web.request_steps SET reuse_checkpoint_id=NULL WHERE account_id=$1 AND request_id=$2 AND logical_step_id='OCR'",[f.seed.accountId,p.retried]);await drain(f.service);
    const own=(await f.admin.pool.query('SELECT execution_id,logical_step_id,state FROM manga_web.executions WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,p.retried])).rows;expect(own).toHaveLength(1);expect(own[0]).toMatchObject({logical_step_id:'OCR',state:'SUCCEEDED'});
    expect((await applications(f,p.retried))[0]).toMatchObject({origin_request_id:p.original,execution_origin_request_id:p.original,execution_id:p.selected[1].execution_id,outcome:'APPLIED'});expect(own[0].execution_id).not.toBe(p.selected[1].execution_id);expect(f.provider.calls.map(input=>input.stage)).toEqual(['OCR','TRANSLATE','OCR']);
    const after=await facts(f);expect(after.executions.filter(row=>row.request_id===p.original)).toEqual(originalFacts.executions);expect(after.costs.filter(row=>originalFacts.executions.some(prior=>prior.execution_id===row.execution_id))).toEqual(originalFacts.costs);expect(after.freeStarts).toHaveLength(2);expect(after.costs).toHaveLength(3);
  });
  it('keeps page/history/STORE/reservation effects single after a lost commit ACK and competing completion',async()=>{
    const f=await fixture(),p=await prepareRetry(f),before=await effects(f),beforeFacts=await facts(f),claim=await f.service.claim();expect(claim).not.toBeNull();
    const entered=deferred(),proceed=deferred(),apply=f.service.applyComplete.bind(f.service);let calls=0;
    vi.spyOn(f.service,'applyComplete').mockImplementation(async(...args)=>{if(++calls===1){entered.resolve();await proceed.promise;}await apply(...args);});
    const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false;
    // Wrap the real restricted transaction. Reject only after its actual
    // completion commit returns, while preserving all production behavior.
    const acknowledgement=vi.spyOn(f.worker,'accountTransaction').mockImplementation((async(accountId:string,run:Parameters<Database['accountTransaction']>[1],allowRestricted=false)=>{
      let completed=false;const value=await transaction(accountId,async tx=>{const prior=(await tx.client.query('SELECT 1 FROM result_applications WHERE account_id=$1 AND request_id=$2',[accountId,p.retried])).rowCount;const result=await run(tx);completed=!prior&&!!(await tx.client.query('SELECT 1 FROM result_applications WHERE account_id=$1 AND request_id=$2',[accountId,p.retried])).rowCount;return result;},allowRestricted);
      if(completed&&!lost){lost=true;throw Error('OWNED_ACK_LOST_AFTER_COMMIT');}return value;
    }) as typeof f.worker.accountTransaction);
    const first=f.service.authorize(claim!);await entered.promise;const duplicate=directComplete(f,p.retried,p.selected[1].output_envelope);proceed.resolve();
    try{await expect(first).rejects.toThrow('OWNED_ACK_LOST_AFTER_COMMIT');}finally{acknowledgement.mockRestore();}await duplicate;expect(lost).toBe(true);
    const committed=await effects(f);expect(await f.service.authorize(claim!)).toBeNull();await Promise.all([directComplete(f,p.retried,p.selected[1].output_envelope),directComplete(f,p.retried,p.selected[1].output_envelope)]);expect(await effects(f)).toEqual(committed);expect(await facts(f)).toEqual(beforeFacts);
    expect(committed.results).toHaveLength(1);expect(committed.stores.length-before.stores.length).toBe(1);expect(committed.pages[0].revision).toBe((BigInt(before.pages[0].revision)+1n).toString());expect(committed.cursors[0].revision).toBe((BigInt(before.cursors[0].revision)+1n).toString());expect(committed.reservations.find(row=>row.request_id===p.retried)).toMatchObject({state:'RELEASED_CONFIRMED',revision:'1'});
  });
  it('preserves the original final origin for a late NOT_APPLICABLE completion',async()=>{
    const f=await fixture(),p=await prepareRetry(f),before=await effects(f),beforeFacts=await facts(f);
    // Owned late-context fixture. Canonical/semantic validation still runs in
    // authorize; only result applicability changes after context closure.
    await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);await drain(f.service);
    expect((await applications(f,p.retried))[0]).toMatchObject({origin_request_id:p.original,execution_origin_request_id:p.original,execution_id:p.selected[1].execution_id,outcome:'NOT_APPLICABLE',applied_at:null});expect(await facts(f)).toEqual(beforeFacts);
    const after=await effects(f);expect(after.pages).toEqual(before.pages);expect(after.history).toEqual(before.history);expect(after.cursors).toEqual(before.cursors);expect(after.stores).toEqual(before.stores);expect(after.results).toHaveLength(1);expect(after.reservations.find(row=>row.request_id===p.retried)).toMatchObject({state:'RELEASED_CONFIRMED'});
  });
  it.each(['middle incomplete','middle not succeeded','different final stage','unverified final','uncertain own execution'] as const)('rejects %s before any result effect in source and restricted SQL',async kind=>{
    const f=await fixture(),p=await prepareRetry(f);
    if(kind==='middle incomplete')await f.admin.pool.query("UPDATE manga_web.request_steps SET reuse_checkpoint_id=NULL WHERE account_id=$1 AND request_id=$2 AND logical_step_id='OCR'",[f.seed.accountId,p.retried]);
    if(kind==='middle not succeeded')await f.admin.pool.query("UPDATE manga_web.executions SET state='FAILED' WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,p.selected[0].execution_id]);
    if(kind==='different final stage')await f.admin.pool.query("UPDATE manga_web.request_steps SET reuse_checkpoint_id=$3 WHERE account_id=$1 AND request_id=$2 AND logical_step_id='TRANSLATE'",[f.seed.accountId,p.retried,p.selected[0].checkpoint_id]);
    if(kind==='unverified final')await f.admin.pool.query("UPDATE manga_web.checkpoints SET verification_state='PENDING' WHERE account_id=$1 AND checkpoint_id=$2",[f.seed.accountId,p.selected[1].checkpoint_id]);
    if(kind==='uncertain own execution')await f.admin.pool.query("INSERT INTO manga_web.executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) VALUES($1,$2,$3,'OCR','synthetic-v1',repeat('b',64),'[]',0,'UNKNOWN',0)",[f.seed.accountId,randomUUID(),p.retried]);
    const before=await effects(f);await expect(directComplete(f,p.retried,p.selected[1].output_envelope)).rejects.toMatchObject({code:'CHECKPOINT_DEPENDENCY_INVALID'});await expect(insertApplication(f,p.retried,p.selected[1].execution_id,p.original)).rejects.toMatchObject({code:'23514',message:'CHECKPOINT_RESULT_ORIGIN_INVALID'});expect(await effects(f)).toEqual(before);
  });
  it('rejects an unrelated same-account final execution and an unselected checkpoint origin',async()=>{
    const f=await fixture(),first=await failedOriginal(f),unrelated=await failedOriginal(f),retried=await f.retry(first.original),before=await effects(f);
    await expect(insertApplication(f,retried,unrelated.selected[1].execution_id,unrelated.original)).rejects.toMatchObject({code:'23514',message:'CHECKPOINT_RESULT_ORIGIN_INVALID'});
    await expect(insertApplication(f,retried,first.selected[0].execution_id,first.original)).rejects.toMatchObject({code:'23514',message:'CHECKPOINT_RESULT_ORIGIN_INVALID'});expect(await effects(f)).toEqual(before);
    await drain(f.service);expect((await applications(f,retried))[0]).toMatchObject({origin_request_id:first.original,execution_id:first.selected[1].execution_id,outcome:'APPLIED'});
  });
  it('rejects a cross-account origin and checkpoint pointer under existing FK and RLS',async()=>{
    const f=await fixture(),p=await prepareRetry(f),other=await fixture(),foreign=await failedOriginal(other),before=await effects(f);
    expect((await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT checkpoint_id FROM checkpoints WHERE account_id=$1',[other.seed.accountId]))).rows).toEqual([]);
    await expect(insertApplication(f,p.retried,foreign.selected[1].execution_id,foreign.original)).rejects.toMatchObject({code:'23514',message:'CHECKPOINT_RESULT_ORIGIN_INVALID'});
    await expect(f.admin.pool.query("UPDATE manga_web.request_steps SET reuse_checkpoint_id=$3 WHERE account_id=$1 AND request_id=$2 AND logical_step_id='TRANSLATE'",[f.seed.accountId,p.retried,foreign.selected[1].checkpoint_id])).rejects.toMatchObject({code:'23503',constraint:'reuse_checkpoint_fk'});expect(await effects(f)).toEqual(before);
    await drain(f.service);expect((await applications(f,p.retried))[0]).toMatchObject({origin_request_id:p.original,execution_id:p.selected[1].execution_id,outcome:'APPLIED'});
  });
});


// C2: 실제 원 INPUT/checkpoint를 보존한 상태에서 비용 투영만 검사한다.
// 비용 검증 포트는 합성이고 실제 요율/모델/저장소 실행 근거가 아니다.
async function costProjection(f:Fixture,executionId:string){
  const {storedInput,canonicalInput}=await import('../../packages/domain/src/provider.js');
  const {FullStageCostCalculator}=await import('../../packages/domain/src/full-stage-cost.js');
  const {digest,sha256}=await import('../../packages/contracts/src/intent.js');
  const input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,executionId),true),profileDigest=sha256('C2-owned-projection');
  const snapshot={version:1 as const,state:'MEASURED' as const,stage:input.stage as 'OCR',profileDigest,basisVersion:'C2-owned-basis',usdScale:12 as const,rounding:'HALF_UP' as const,evidenceRefs:['owned:catalog'],components:[{componentId:'image',kind:'IMAGE' as const,unit:'operation',rateVersion:'owned:rate',usdPerUnit:'0',evidenceRefs:['owned:no-charge-rate']}]};
  const calculator=new FullStageCostCalculator(snapshot,{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:8,maxEvidenceRefs:64,maxStringBytes:512});
  const capture={accountId:f.seed.accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage as 'OCR',profileDigest,mode:'FREE' as const},captured=calculator.capture(capture);
  const view=(amount:string)=>{
    const result=calculator.calculate(capture,{provider:{scope:'ACTUAL_AI_USD',captureDigest:captured.captureDigest,state:'CONFIRMED',actualUsd:amount,evidenceRefs:['owned:provider']},quantities:[{componentId:'image',captureDigest:captured.captureDigest,state:'CONFIRMED',quantity:'0',unit:'operation',evidenceRefs:['owned:no-image-work']}],allocation:{captureDigest:captured.captureDigest,mode:'FREE',funding:'FREE_OPERATIONS',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0',evidenceRefs:['owned:no-allocation']}});
    const record={evidenceId:randomUUID(),evidenceDigest:sha256('owned:calculation'),result};return {basis:{version:1 as const,capture:result.capture,captureDigest:result.captureDigest,snapshot,snapshotDigest:result.snapshotDigest},state:'CONFIRMED' as const,costUsd:result.actualUsd,conflicts:[],calculations:[record],sealedCalculation:{evidenceId:record.evidenceId,evidenceDigest:record.evidenceDigest}};
  };
  const state:{view:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostView}={view:view('0.12')};
  const port={prepare:vi.fn(async()=>{}),finishAttempt:vi.fn(async()=>{}),idle:vi.fn(async()=>{}),hasPendingOtherIn:vi.fn(async()=>false),readIn:vi.fn(async()=>structuredClone(state.view))};
  const service=Reflect.construct(ExecutionService,[f.worker,f.provider,f.service.policy,{},undefined,port]) as ExecutionService;
  const costs=async()=>(await f.admin.pool.query("SELECT state,actual_usd,evidence_conflict,usage_ref FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 AND component='STAGE_TOTAL'",[f.seed.accountId,executionId])).rows;
  return {input,state,view,port,service,costs};
}
describe.sequential('C2 original execution cost-only projection',()=>{
  it('late_cost_on_duplicate_observation_projects_once',async()=>{
    const f=await fixture(),success=f.provider.success.bind(f.provider);vi.spyOn(f.provider,'success').mockImplementation(input=>({...success(input),costUsd:null,usageConfirmed:false}));const request=await f.request();await f.service.runOnce();const first=(await selectedSteps(f,request))[0],p=await costProjection(f,first.execution_id);
    const before=(await facts(f)).checkpoints,observation=structuredClone(first.output_envelope);
    await p.service.observe(f.seed.accountId,first.execution_id,observation);
    expect(await p.costs()).toMatchObject([{state:'CONFIRMED',actual_usd:'0.120000000000',evidence_conflict:false}]);
    const original=await p.costs();await p.service.observe(f.seed.accountId,first.execution_id,observation);
    expect(await p.costs()).toEqual(original);expect((await facts(f)).checkpoints).toEqual(before);expect(f.provider.calls).toHaveLength(1);
    expect(p.port.readIn).toHaveBeenCalledTimes(2);
  });
  it('conflicting_actual_cost_keeps_first_amount_and_original_checkpoint',async()=>{
    const f=await fixture(),success=f.provider.success.bind(f.provider);vi.spyOn(f.provider,'success').mockImplementation(input=>({...success(input),costUsd:null,usageConfirmed:false}));const request=await f.request();await f.service.runOnce();const first=(await selectedSteps(f,request))[0],p=await costProjection(f,first.execution_id),before=(await facts(f)).checkpoints;
    await p.service.observe(f.seed.accountId,first.execution_id,first.output_envelope);p.state.view=p.view('0.23');
    await p.service.observe(f.seed.accountId,first.execution_id,first.output_envelope);
    expect(await p.costs()).toMatchObject([{state:'CONFIRMED',actual_usd:'0.120000000000',evidence_conflict:true}]);expect(await p.service.reconciled(f.seed.accountId,first.execution_id)).toBe(false);
    expect((await facts(f)).checkpoints).toEqual(before);expect(f.provider.calls).toHaveLength(1);
  });
});

describe.sequential('C2 basis before validation and preparation failure tracking',()=>{
  it('basis_precedes_checkpoint_and_input_io_and_preflight_failure_keeps_preparation_cost',async()=>{
    const f=await fixture(),request=await f.request(),events:string[]=[];
    const {FullStageCostJournal}=await import('../../packages/domain/src/full-stage-cost-journal.js');
    const {FullStageCostPreparation}=await import('../../packages/domain/src/full-stage-cost-preparation.js');
    const {sha256}=await import('../../packages/contracts/src/intent.js');
    const profileDigest=sha256('C2-owned-first-IO'),bounds={maxRecordBytes:262144,maxRecords:8,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:8,maxEvidenceRefs:64,maxStringBytes:512}},journal=new FullStageCostJournal(f.worker,bounds);
    const preparation=new FullStageCostPreparation(journal,[{stage:'OCR',profileDigest,snapshot:{version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'owned:before-validation',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned:catalog'],components:[{componentId:'image',kind:'IMAGE',unit:'operation',rateVersion:'owned:rate',usdPerUnit:'0.01',evidenceRefs:['owned:rate']}]} }],bounds.calculator);
    const checkpoints={beginIn:vi.fn(async()=>({attemptId:randomUUID(),targets:[]})),lookupIn:vi.fn(async()=>({state:'VERIFIED'})),recordIn:vi.fn(async()=>({state:'VERIFIED'})),finalCommitIn:vi.fn(async()=> 'WAIT')};
    const port={checkpoints,prepare:vi.fn(async(...args:Parameters<typeof preparation.prepare>)=>{await preparation.prepare(...args);events.push('BASIS');}),finishAttempt:vi.fn(async()=>{events.push('FINISH_ATTEMPT');}),readIn:vi.fn(async(tx:import('../../packages/storage/src/database.js').Transaction,input:import('../../packages/domain/src/provider.js').StageInput)=>journal.lookupIn(tx,input)),hasPendingOtherIn:vi.fn(async()=>false),collectCheckpointIn:vi.fn(async()=>({attemptId:randomUUID(),operations:[]}))};
    const service=Reflect.construct(ExecutionService,[f.worker,f.provider,f.service.policy,{},undefined,port]) as ExecutionService;
    f.provider.validateInput=async input=>{
      const rows=(await f.admin.pool.query("SELECT kind FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN ('INPUT','OPERATIONAL_COST_BASIS')",[f.seed.accountId,input.executionId])).rows;
      expect(rows.map(row=>row.kind).sort()).toEqual(['INPUT','OPERATIONAL_COST_BASIS']);events.push('INPUT_IO');throw Error('OWNED_INPUT_VALIDATION_FAILURE');
    };
    await service.runOnce();expect(events).toEqual(['BASIS','INPUT_IO','FINISH_ATTEMPT']);expect(f.provider.calls).toHaveLength(0);
    expect((await f.admin.pool.query('SELECT state FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,request])).rows[0].state).toBe('FAILED');
    expect(port.finishAttempt).toHaveBeenCalledTimes(1);
    expect((await f.admin.pool.query("SELECT state FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows).toEqual([{state:'READY'}]);
  });
});

async function originalUnknown(f:Fixture){
  vi.spyOn(f.provider,'success').mockImplementation(input=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'OWNED_ORIGINAL_REPLY_UNKNOWN',providerRef:input.executionId,data:null}));
  await f.request();await f.service.runOnce();
  const rows=(await f.admin.pool.query<{execution_id:string;state:string}>('SELECT execution_id,state FROM manga_web.executions WHERE account_id=$1',[f.seed.accountId])).rows;expect(rows).toHaveLength(1);expect(rows[0].state).toBe('UNKNOWN');
  const p=await costProjection(f,rows[0].execution_id);
  await f.admin.pool.query("UPDATE manga_web.work_items SET due_at=CASE WHEN kind='RECONCILE' THEN clock_timestamp()-interval '1 second' ELSE '2100-01-01T00:00:00Z' END WHERE account_id=$1",[f.seed.accountId]);
  return p;
}
describe.sequential('C2 cost reconciliation without new outcome or submission',()=>{
  it('reconcile_without_observation_preserves_cost_and_unknown_execution',async()=>{
    const f=await fixture(),p=await originalUnknown(f),before=await facts(f);vi.spyOn(f.provider,'lookup').mockResolvedValue(null);
    expect(await p.service.runOnce()).toBe(true);
    expect(await p.costs()).toMatchObject([{state:'CONFIRMED',actual_usd:'0.120000000000',evidence_conflict:false}]);
    const after=await facts(f);expect(after.executions).toEqual(before.executions);expect(after.checkpoints).toEqual(before.checkpoints);expect(after.starts).toEqual(before.starts);expect(f.provider.calls).toHaveLength(1);expect(p.port.prepare).not.toHaveBeenCalled();
    expect((await f.admin.pool.query("SELECT state FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows).toEqual([{state:'READY'}]);
  });
  it('native_wait_does_not_erase_known_cost_facts_or_call_lookup',async()=>{
    const f=await fixture(),p=await originalUnknown(f);await f.admin.pool.query('UPDATE manga_web.processing_requests SET hold_reasons=$2,state=$3 WHERE account_id=$1',[f.seed.accountId,JSON.stringify(['NATIVE_EXECUTION_UNCONFIRMED']),'WAITING']);
    const lookup=vi.spyOn(f.provider,'lookup');expect(await p.service.runOnce()).toBe(true);
    expect(await p.costs()).toMatchObject([{state:'CONFIRMED',actual_usd:'0.120000000000',evidence_conflict:false}]);expect(lookup).not.toHaveBeenCalled();expect(f.provider.calls).toHaveLength(1);
    expect((await f.admin.pool.query('SELECT state,hold_reasons FROM manga_web.processing_requests WHERE account_id=$1',[f.seed.accountId])).rows[0]).toMatchObject({state:'WAITING',hold_reasons:['NATIVE_EXECUTION_UNCONFIRMED']});
  });
  it('reconcile_before_basis_never_captures_rates_or_calls_provider',async()=>{
    const f=await fixture(),p=await originalUnknown(f),lookup=vi.spyOn(f.provider,'lookup');
    p.state.view={basis:null,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[],sealedCalculation:null};
    await p.service.runOnce();expect(p.port.prepare).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();expect(await p.costs()).toMatchObject([{state:'UNCONFIRMED',actual_usd:null}]);expect(f.provider.calls).toHaveLength(1);
  });
});

describe.sequential('C2 sealed completion boundary',()=>{
  it('all_checkpoints_reused_without_consumer_waits_without_validation_io',async()=>{
    const f=await fixture(),p=await prepareRetry(f),cost=await costProjection(f,p.selected[1].execution_id),before=await facts(f),effectsBefore=await effects(f);
    const validation=vi.fn(async()=>{});f.provider.validateObservation=validation;
    const claim=await cost.service.claim();expect(claim).not.toBeNull();expect(await cost.service.authorize(claim!)).toBeNull();
    expect(validation).not.toHaveBeenCalled();expect(cost.port.prepare).not.toHaveBeenCalled();expect(await facts(f)).toEqual(before);expect(await effects(f)).toEqual(effectsBefore);
  });
  it('direct_completion_cannot_bypass_the_consumer_seal',async()=>{
    const f=await fixture(),p=await prepareRetry(f),cost=await costProjection(f,p.selected[1].execution_id),before=await effects(f);f.service=cost.service;
    await directComplete(f,p.retried,p.selected[1].output_envelope);
    expect(await effects(f)).toEqual(before);expect(await applications(f,p.retried)).toEqual([]);
  });
});

describe.sequential('C2 original INPUT admission race with real cost journal',()=>{
  it('prepared_input_without_basis_blocks_other_execution',async()=>{
    const f=await fixture(2),firstRequest=await f.request();
    const {OperationalStageCost}=await import('../../packages/domain/src/pipeline-stage-cost.js');
    const {CheckpointValidationJournal}=await import('../../packages/domain/src/checkpoint-validation.js');
    const {FullStageCostJournal}=await import('../../packages/domain/src/full-stage-cost-journal.js');
    const {FullStageCostPreparation}=await import('../../packages/domain/src/full-stage-cost-preparation.js');
    const bounds={maxRecordBytes:262144,maxRecords:64,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:8,maxEvidenceRefs:64,maxStringBytes:512}},journal=new FullStageCostJournal(f.worker,bounds),checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:262144,maxRecords:128,maxTargets:4,maxJobs:32});
    const reader={workSetIn:vi.fn(async()=>null),checkpointFactsIn:vi.fn(async()=>null)},cost=new OperationalStageCost({db:f.worker,preparation:new FullStageCostPreparation(journal,[],bounds.calculator),journal,reader,checkpoints,bounds:{maxRecordBytes:262144,maxRecords:64,maxSources:32,maxExecutions:64,maxInFlight:4}});
    const a=new ExecutionService(f.worker,f.provider,f.service.policy,{},undefined,cost),b=new ExecutionService(f.worker,f.provider,f.service.policy,{},undefined,cost);
    const claimA=await a.claim();expect(claimA?.ref.requestId).toBe(firstRequest);const inputA=await a.authorize(claimA!);expect(inputA).not.toBeNull();
    const second=(await f.command({kind:'REQUEST_TRANSLATION',payload:{pageId:f.seed.pageIds[1],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}})).reply.operationRef.id!;
    const claimB=await b.claim();expect(claimB?.ref.requestId).toBe(second);expect(await b.authorize(claimB!)).toBeNull();
    expect((await f.admin.pool.query('SELECT request_id FROM manga_web.executions WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{request_id:firstRequest}]);
    expect((await f.admin.pool.query("SELECT kind FROM manga_web.execution_evidence WHERE account_id=$1 AND kind<>'INPUT'",[f.seed.accountId])).rows).toEqual([]);
    expect((await f.admin.pool.query("SELECT kind,state FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows).toEqual([{kind:'RECONCILE',state:'READY'}]);expect(f.provider.calls).toHaveLength(0);expect(reader.workSetIn).not.toHaveBeenCalled();expect(reader.checkpointFactsIn).not.toHaveBeenCalled();
    await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:firstRequest}});
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>cost.hasPendingOtherIn(tx,null),true)).toBe(true);
  });
});

describe.sequential('C2 conflict facts cannot create an unsealed actual amount',()=>{
  it('model_price_or_conflicting_calculations_do_not_confirm_stage_cost',async()=>{
    const f=await fixture(),p=await originalUnknown(f);
    p.state.view={...p.state.view,state:'CONFLICT',costUsd:null,conflicts:['PROVIDER_COST_CONFLICT']};
    await p.service.runOnce();
    expect(await p.costs()).toMatchObject([{state:'UNCONFIRMED',actual_usd:null,evidence_conflict:true}]);
    expect(f.provider.calls).toHaveLength(1);expect(p.port.prepare).not.toHaveBeenCalled();
  });
});

describe.sequential('C2 projection follows the calculation sealed by the original closure',()=>{
  it('same_amount_with_earlier_other_facts_uses_exact_sealed_calculation',async()=>{
    const f=await fixture(),p=await originalUnknown(f),selected=p.state.view.calculations[0];
    const earlier={...structuredClone(selected),evidenceId:randomUUID(),evidenceDigest:'b'.repeat(64),result:{...structuredClone(selected.result),factsDigest:'c'.repeat(64)}};
    p.state.view.calculations.unshift(earlier);
    await p.service.runOnce();
    expect((await p.costs())[0]).toMatchObject({state:'CONFIRMED',actual_usd:'0.120000000000',usage_ref:'execution-evidence:'+selected.evidenceId+':'+selected.evidenceDigest,evidence_conflict:false});
  });
});
