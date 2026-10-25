import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {manualCommands} from '../../packages/domain/src/manual.js';
import {Projections} from '../../packages/domain/src/projections.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0))await db.close();});
async function fixture(free=0,pages=3,realServiceRoles=false){let now=new Date('2026-10-03T00:00:00Z');const db=await testDatabase(async()=>now);connections.push(db);const seed=await seedWorkspace(db,await seedIdentity(db,now,free),pages,now);const api=realServiceRoles?await provisionLocalService(db,'trio_web_api',async()=>now):db;const workerDb=realServiceRoles?await provisionLocalService(db,'trio_web_worker',async()=>now):db;if(realServiceRoles){connections.push(api,workerDb);await api.validateServiceRole();await workerDb.validateServiceRole();}const policy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:true,realProviderEnabled:false};const workspace=new WorkspaceService(api,policy);workspace.extensions.push(manualCommands(()=>true,8000,256));const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:18,minFontSizePx:8};const command=async(operation:unknown,commandId=randomUUID())=>{const c=(await db.pool.query('SELECT * FROM manga_web.workspace_contexts WHERE context_id=$1',[seed.contextId])).rows[0];return workspace.handle(actor,{commandId,intentVersion:1,target:{contextId:seed.contextId,contextGeneration:c.generation,tabId:seed.tabId,expectedOwnerRevision:c.owner_revision,expectedWorkspaceRevision:c.workspace_revision},operation});};await command({kind:'PATCH_SETTINGS',payload:{settings}});const provider=new SyntheticProvider();const worker=new ExecutionService(workerDb,provider,policy);const second=new ExecutionService(workerDb,provider,policy);const step=async()=>{await Promise.all([worker.runOnce(),second.runOnce()]);now=new Date(now.valueOf()+500);};return {db,seed,actor,workspace,settings,provider,worker,second,step,command,advance:(ms:number)=>{now=new Date(now.valueOf()+ms);}};}
it('captures ordered targets/settings, admits only one current page and completes only after every target succeeds',async()=>{
  const f=await fixture();const id=randomUUID();const batch=await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}},id);expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.active_page_requests')).rows[0].count).toBe('1');expect((await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}},id)).reply.operationRef).toEqual(batch.reply.operationRef);await f.command({kind:'PATCH_SETTINGS',payload:{settings:{...f.settings,settingsVersion:'2',targetLanguage:'en'}}});await expect(f.command({kind:'EXCLUDE_PAGES',payload:{pageIds:[f.seed.pageIds[2]]}})).rejects.toMatchObject({code:'WORKSPACE_BUSY'});
  for(let i=0;i<40;i++)await f.step();expect(f.provider.calls).toHaveLength(6);expect(f.provider.calls.map(c=>c.requestId).filter((id,i,list)=>i===0||id!==list[i-1])).toHaveLength(3);expect(f.provider.calls.every(c=>c.settings.settingsVersion==='1'&&c.settings.targetLanguage==='ko')).toBe(true);expect((await f.db.pool.query('SELECT state,started_page_ids FROM manga_web.batches')).rows[0]).toMatchObject({state:'COMPLETED',started_page_ids:f.seed.pageIds});expect((await f.db.pool.query('SELECT project_status FROM manga_web.workspace_contexts')).rows[0].project_status).toBe('COMPLETED');expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(3);
});
it('leaves three remaining pages pending after two free starts without automatically choosing paid mode',async()=>{
  const f=await fixture(8,5);await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}});for(let i=0;i<35;i++)await f.step();expect(f.provider.calls).toHaveLength(4);expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(10);expect((await f.db.pool.query('SELECT state,pause_reason,next_target_index FROM manga_web.batches')).rows[0]).toMatchObject({state:'WAITING',pause_reason:'FREE_LIMIT_REACHED',next_target_index:2});expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.processing_requests WHERE mode=\'PAID\'')).rows[0].count).toBe('0');expect((await f.db.pool.query('SELECT project_status FROM manga_web.workspace_contexts')).rows[0].project_status).toBe('IN_PROGRESS');
});
it('keeps zero-target project status unchanged and stops an unstarted batch without provider submission',async()=>{
  const f=await fixture();await f.command({kind:'SET_SKIP',payload:{pageIds:f.seed.pageIds,skip:true}});const zero=await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:[],settingsVersion:'1'}});expect(zero.reply.operationRef.kind).toBe('NONE');expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.batches')).rows[0].count).toBe('0');await f.command({kind:'SET_SKIP',payload:{pageIds:f.seed.pageIds,skip:false}});const batch=await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}});await f.command({kind:'REQUEST_STOP',payload:{operationKind:'BATCH',operationId:batch.reply.operationRef.id}});for(let i=0;i<6;i++)await f.step();expect(f.provider.calls).toHaveLength(0);expect((await f.db.pool.query('SELECT state FROM manga_web.batches')).rows[0].state).toBe('STOPPED');expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(0);
});
it('waits at a confirmed failure and an explicit fenced choice advances in captured order without marking the skipped batch complete',async()=>{
  const f=await fixture();f.workspace.policy.batchFailureAction='WAIT';
  const failedAsset=(await f.db.pool.query('SELECT original_asset_id FROM manga_web.results WHERE page_lineage_id=$1',[f.seed.pageIds[1]])).rows[0].original_asset_id;
  const success=f.provider.success.bind(f.provider);f.provider.success=input=>input.originalAssetId===failedAsset?{...success(input),outcome:'FAILURE',data:null,finishReason:'SYNTHETIC_FAILURE'}:success(input);
  const admitted=await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}});const batchId=admitted.reply.operationRef.id;
  for(let i=0;i<20;i++)await f.step();
  const view=await new Projections(f.db).workspace(f.actor,f.seed.contextId);const paused=view.batches[0];
  const failedRequestId=paused.currentRequestId!;
  expect(paused).toMatchObject({state:'WAITING',pauseReason:'CONFIRMED_PAGE_FAILURE',currentRequestId:failedRequestId,completedTargets:1});
  const pageBefore=(await f.db.pool.query('SELECT current_result_id,result_revision FROM manga_web.workspace_pages ORDER BY display_order')).rows;
  const failedBefore=(await f.db.pool.query('SELECT state,first_start_at FROM manga_web.processing_requests WHERE request_id=$1',[failedRequestId])).rows[0];
  const costQuery='SELECT c.cost_item_id,c.state,c.actual_usd FROM manga_web.cost_items c JOIN manga_web.executions e USING(account_id,execution_id) WHERE e.request_id=$1 ORDER BY c.cost_item_id';
  const costBefore=(await f.db.pool.query(costQuery,[failedRequestId])).rows;
  expect(f.provider.calls.filter(call=>call.requestId!==failedRequestId)).toHaveLength(2);
  await f.command({kind:'PATCH_SETTINGS',payload:{settings:{...f.settings,settingsVersion:'2',targetLanguage:'en'}}});
  const payload={batchId,expectedBatchRevision:paused.revision,failedRequestId};
  await expect(f.command({kind:'CONTINUE_BATCH',payload:{...payload,failedRequestId:randomUUID()}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await expect(f.command({kind:'CONTINUE_BATCH',payload:{...payload,expectedBatchRevision:'999'}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  const commandId=randomUUID();const choice=await f.command({kind:'CONTINUE_BATCH',payload},commandId);
  expect((await f.command({kind:'CONTINUE_BATCH',payload},commandId)).reply).toMatchObject({disposition:'EXISTING',operationRef:choice.reply.operationRef});
  for(let i=0;i<15;i++)await f.step();
  const pageAfter=(await f.db.pool.query('SELECT current_result_id,result_revision FROM manga_web.workspace_pages ORDER BY display_order')).rows;
  expect(pageAfter.slice(0,2)).toEqual(pageBefore.slice(0,2));
  expect((await f.db.pool.query('SELECT state,first_start_at FROM manga_web.processing_requests WHERE request_id=$1',[failedRequestId])).rows[0]).toEqual(failedBefore);
  expect(costBefore).toHaveLength(1);expect((await f.db.pool.query(costQuery,[failedRequestId])).rows).toEqual(costBefore);
  expect(f.provider.calls).toHaveLength(5);expect(f.provider.calls.every(call=>call.settings.settingsVersion==='1'&&call.settings.targetLanguage==='ko')).toBe(true);
  expect((await f.db.pool.query('SELECT state FROM manga_web.batches')).rows[0].state).toBe('FAILED');
  expect((await f.db.pool.query('SELECT project_status FROM manga_web.workspace_contexts')).rows[0].project_status).toBe('IN_PROGRESS');
  expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(3);
});
it('retries the current failed batch page with actual API/worker LOGIN roles, then admits the next page and counts each request once',async()=>{
  const f=await fixture(0,2,true);f.workspace.policy.batchFailureAction='WAIT';const success=f.provider.success.bind(f.provider);
  f.provider.success=input=>({...success(input),outcome:'FAILURE',data:null,finishReason:'SYNTHETIC_FAILURE'});
  await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}});
  for(let i=0;i<8;i++)await f.step();
  const previous=(await f.db.pool.query('SELECT current_request_id FROM manga_web.batches')).rows[0].current_request_id;
  await f.command({kind:'PATCH_SETTINGS',payload:{settings:{...f.settings,settingsVersion:'2',targetLanguage:'en'}}});f.provider.success=success;
  const retry=await f.command({kind:'RETRY_REQUEST',payload:{requestId:previous}});
  expect(retry.reply.operationRef.id).not.toBe(previous);
  await expect(f.command({kind:'CONTINUE_BATCH',payload:{batchId:(await f.db.pool.query('SELECT batch_id FROM manga_web.batches')).rows[0].batch_id,expectedBatchRevision:'0',failedRequestId:previous}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  for(let i=0;i<30;i++)await f.step();
  expect(f.provider.calls).toHaveLength(5);expect(f.provider.calls.every(call=>call.settings.settingsVersion==='1'&&call.settings.targetLanguage==='ko')).toBe(true);
  expect((await f.db.pool.query('SELECT state FROM manga_web.batches')).rows[0].state).toBe('COMPLETED');
  expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(3);
});
it('refuses to skip an unknown execution or a free admission hold',async()=>{
  const f=await fixture(0,2);f.workspace.policy.batchFailureAction='WAIT';const success=f.provider.success.bind(f.provider);
  f.provider.success=input=>({...success(input),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,data:null,finishReason:'SYNTHETIC_UNKNOWN'});
  await f.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:f.seed.pageIds,settingsVersion:'1'}});for(let i=0;i<8;i++)await f.step();
  const unknown=(await new Projections(f.db).workspace(f.actor,f.seed.contextId)).batches[0];
  await expect(f.command({kind:'CONTINUE_BATCH',payload:{batchId:unknown.batchId,expectedBatchRevision:unknown.revision,failedRequestId:unknown.currentRequestId}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect(f.provider.calls).toHaveLength(1);expect((await f.db.pool.query('SELECT count(*) FROM manga_web.processing_requests')).rows[0].count).toBe('1');
  const exhausted=await fixture(10,2);exhausted.workspace.policy.batchFailureAction='WAIT';await exhausted.command({kind:'BATCH_TRANSLATION',payload:{pageIdsInOrder:exhausted.seed.pageIds,settingsVersion:'1'}});
  const held=(await new Projections(exhausted.db).workspace(exhausted.actor,exhausted.seed.contextId)).batches[0];expect(held.pauseReason).toBe('FREE_LIMIT_REACHED');
  await expect(exhausted.command({kind:'CONTINUE_BATCH',payload:{batchId:held.batchId,expectedBatchRevision:held.revision,failedRequestId:randomUUID()}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect(exhausted.provider.calls).toHaveLength(0);
});
