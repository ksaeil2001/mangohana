import {afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {LibraryService} from '../../packages/domain/src/library.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {queueWork,type RequestPolicy} from '../../packages/domain/src/requests.js';
import {finalizeSafe} from '../../packages/domain/src/liveness.js';
import type {RequestRow} from '../../packages/domain/src/model.js';
import type {Assets} from '../../packages/domain/src/assets.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {testDatabase,seedIdentity,seedWorkspace} from '../fixtures/database.js';

const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
async function fixture(floor?:number,minFontSizePx=12.5){
  const now=new Date('2026-10-03T00:00:00Z'),clock=async()=>now,admin=await testDatabase(clock);connections.push(admin);
  const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now),api=await provisionLocalService(admin,'trio_web_api',clock),worker=await provisionLocalService(admin,'trio_web_worker',clock);connections.push(api,worker);
  const policy:RequestPolicy={synthetic:true,realProviderEnabled:false,paidEnabled:false,stageOrder:['OCR'],...(floor===undefined?{}:{minReadableFontSizePx:floor})},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=async(operation:WorkspaceCommand['operation'])=>{const c=(await admin.pool.query('SELECT workspace_revision FROM manga_web.workspace_contexts WHERE context_id=$1',[seed.contextId])).rows[0];return workspace.handle(actor,{commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:c.workspace_revision},operation});};
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx};await command({kind:'PATCH_SETTINGS',payload:{settings}});
  const request=()=>command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}});
  const failBeforeStart=async(id:string)=>worker.accountTransaction(seed.accountId,async tx=>{const row=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[seed.accountId,id])).rows[0];expect(await finalizeSafe(tx,row,'FAILED','OWNED_CONFIRMED_PRESTART_FAILURE')).toBe(true);},true);
  return {admin,api,worker,seed,policy,workspace,provider,execution,command,request,settings,failBeforeStart};
}
it('refuses a new automatic request below its measured floor before reservations or dispatch while preserving the explicit settings',async()=>{
  const f=await fixture(12.5,12.49);await expect(f.api.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_api'});
  await expect(f.request()).rejects.toMatchObject({code:'LIMIT_PROFILE_UNCONFIRMED',nextAction:'WAIT'});
  for(const table of ['processing_requests','free_reservations','work_items'])expect((await f.admin.pool.query(`SELECT count(*) AS count FROM manga_web.${table}`)).rows[0].count).toBe('0');
  expect((await f.admin.pool.query('SELECT captured_settings FROM manga_web.settings_revisions')).rows[0].captured_settings).toEqual(f.settings);expect(f.provider.calls).toEqual([]);
});
it('captures the fractional automatic floor and retries original settings after a newer profile raises its floor',async()=>{
  const f=await fixture(12.5),first=(await f.request()).reply.operationRef.id!,before=(await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE request_id=$1',[first])).rows[0].captured_input;expect(before.minReadableFontSizePx).toBe(12.5);
  await f.failBeforeStart(first);f.policy.minReadableFontSizePx=24;const next=(await f.command({kind:'RETRY_REQUEST',payload:{requestId:first}})).reply.operationRef.id!;
  const row=(await f.admin.pool.query('SELECT retry_of_request_id,captured_input,settings_revision FROM manga_web.processing_requests WHERE request_id=$1',[next])).rows[0];expect(row).toMatchObject({retry_of_request_id:first,settings_revision:'1',captured_input:before});expect(f.provider.calls).toEqual([]);
});
it('preserves a legacy retry capture without introducing the current measured floor or changing its digest',async()=>{
  const f=await fixture(undefined,4.25),first=(await f.request()).reply.operationRef.id!,before=(await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE request_id=$1',[first])).rows[0].captured_input;expect(Object.hasOwn(before,'minReadableFontSizePx')).toBe(false);
  await f.failBeforeStart(first);f.policy.minReadableFontSizePx=24;const next=(await f.command({kind:'RETRY_REQUEST',payload:{requestId:first}})).reply.operationRef.id!;
  expect((await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE request_id=$1',[next])).rows[0].captured_input).toEqual(before);expect(f.provider.calls).toEqual([]);
});
async function blockedClaim(f:Awaited<ReturnType<typeof fixture>>,start:()=>Promise<unknown>,stop:()=>void){
  const lock=await f.admin.pool.connect();try{
    await lock.query('BEGIN');await lock.query('SELECT account_id FROM manga_web.accounts WHERE account_id=$1 FOR UPDATE',[f.seed.accountId]);
    const pending=start();let waiting=false;for(let attempt=0;attempt<100;attempt++){
      waiting=!!(await f.admin.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'",[decodeURIComponent(new URL(f.worker.connectionString).username)])).rowCount;
      if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(waiting).toBe(true);stop();await lock.query('COMMIT');return await pending;
  }finally{await lock.query('ROLLBACK').catch(()=>undefined);lock.release();}
}
it('stops a worker execution claim that is already waiting on the account lock before UPDATE or provider transport',async()=>{
  const f=await fixture();await f.request();await expect(f.worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
  expect(await blockedClaim(f,()=>f.execution.runOnce(),()=>f.execution.stopClaims())).toBe(false);expect(await f.execution.runOnce()).toBe(false);expect(f.provider.calls).toEqual([]);
  expect((await f.admin.pool.query('SELECT state,claim_generation,claim_owner FROM manga_web.work_items')).rows).toEqual([{state:'READY',claim_generation:'0',claim_owner:null}]);expect((await f.admin.pool.query('SELECT count(*) AS count FROM manga_web.executions')).rows[0].count).toBe('0');
});
it('stops an already waiting library claim before UPDATE and leaves its queued storage work untouched',async()=>{
  const f=await fixture();await f.worker.accountTransaction(f.seed.accountId,tx=>queueWork(tx,'STORE',{resultId:randomUUID()}));
  // These deliberately unavailable dependencies must remain unreachable before a claim is acquired.
  const unavailable=new Proxy({}, {get(){throw Error('Unexpected media access before claim');}}),library=new LibraryService(f.worker,unavailable as Assets,unavailable as FontCatalog,syntheticProfile);
  expect(await blockedClaim(f,()=>library.runOnce(),()=>library.stopClaims())).toBe(false);expect(await library.runOnce()).toBe(false);
  expect((await f.admin.pool.query('SELECT state,claim_generation,claim_owner FROM manga_web.work_items')).rows).toEqual([{state:'READY',claim_generation:'0',claim_owner:null}]);expect((await f.admin.pool.query('SELECT count(*) AS count FROM manga_web.library_store_attempts')).rows[0].count).toBe('0');
});
