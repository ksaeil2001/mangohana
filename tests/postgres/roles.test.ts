import {afterEach,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {testDatabase,seedIdentity,seedWorkspace} from '../fixtures/database.js';
import {AuthService} from '../../packages/domain/src/auth.js';
import {SyntheticAuthProvider} from '../../packages/domain/src/auth-provider.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0))await db.close();});
it('uses minimum API/worker roles, confines RLS and resists temporary auth table shadowing',async()=>{
  const now=new Date();const admin=await testDatabase(async()=>now);connections.push(admin);const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);const other=await seedIdentity(admin,now);
  const api=await provisionLocalService(admin,'trio_web_api',async()=>now);const worker=await provisionLocalService(admin,'trio_web_worker',async()=>now);connections.push(api,worker);
  expect((await api.pool.query('SELECT current_user')).rows[0].current_user).toBe('trio_web_api');
  await api.accountTransaction(seed.accountId,async tx=>{expect((await tx.client.query('SELECT account_id FROM accounts')).rows).toEqual([{account_id:seed.accountId}]);expect((await tx.client.query('SELECT 1 FROM accounts WHERE account_id=$1',[other.accountId])).rowCount).toBe(0);});
  await expect(worker.pool.query('SELECT protected_intent FROM manga_web.auth_attempts')).rejects.toMatchObject({code:'42501'});
  await expect(worker.pool.query('SELECT cookie_digest FROM manga_web.app_sessions')).rejects.toMatchObject({code:'42501'});
  await worker.pool.query('RESET ROLE');
  expect((await worker.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toMatchObject({rolsuper:false,rolbypassrls:false});
  await expect(worker.pool.query('SELECT cookie_digest FROM manga_web.app_sessions')).rejects.toMatchObject({code:'42501'});
  await expect(api.accountTransaction(seed.accountId,tx=>tx.client.query('UPDATE library_store_operations SET expires_at=clock_timestamp() WHERE account_id=$1',[seed.accountId]))).rejects.toMatchObject({code:'42501'});
  await expect(api.accountTransaction(seed.accountId,tx=>tx.client.query('UPDATE accounts SET balance_credit=0 WHERE account_id=$1',[seed.accountId]))).rejects.toMatchObject({code:'42501'});
  const client=await api.pool.connect();try{
    await client.query('CREATE TEMP TABLE login_bindings AS SELECT * FROM manga_web.login_bindings WITH NO DATA');await client.query('CREATE TEMP TABLE app_sessions AS SELECT * FROM manga_web.app_sessions WITH NO DATA');await client.query('CREATE TEMP TABLE accounts AS SELECT * FROM manga_web.accounts WITH NO DATA');
    expect((await client.query('SELECT * FROM manga_web.resolve_session($1)',[seed.sessionId])).rows[0].account_id).toBe(seed.accountId);
    expect((await client.query('SELECT * FROM manga_web.binding_owner($1,$2)',['https://synthetic.invalid',`synthetic-${seed.accountId}`])).rows[0].binding_id).toBe(seed.bindingId);
  }finally{client.release();}
  const policy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false};const workspace=new WorkspaceService(api,policy);const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const auth=new AuthService(api,workspace,new SyntheticAuthProvider(()=>`synthetic-${seed.accountId}`),new Set([seed.accountId]),randomBytes(32));const browser={correlation:randomUUID(),ip:'127.0.0.1'};
  const start=await auth.begin(actor,browser,{commandId:randomUUID(),intentVersion:1,method:'EMAIL_OTP',purpose:'CONFIRM_CURRENT_ACCOUNT',bindingId:seed.bindingId,email:'test@example.invalid'});
  expect((await admin.pool.query('SELECT protected_intent FROM manga_web.auth_attempts WHERE attempt_id=$1',[start.attemptId])).rows[0].protected_intent.actor).not.toHaveProperty('ownerCapability');
  expect((await auth.verify(browser,{commandId:randomUUID(),intentVersion:1,attemptId:start.attemptId,code:'123456'})).proofId).toBeTruthy();
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:18,minFontSizePx:8};
  const send=async(operation:unknown)=>{const c=(await admin.pool.query('SELECT * FROM manga_web.workspace_contexts WHERE context_id=$1',[seed.contextId])).rows[0];return workspace.handle(actor,{commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:c.generation,tabId:seed.tabId,expectedOwnerRevision:c.owner_revision,expectedWorkspaceRevision:c.workspace_revision},operation});};
  await send({kind:'PATCH_SETTINGS',payload:{settings}});const request=await send({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}});const provider=new SyntheticProvider();const execution=new ExecutionService(worker,provider,policy);
  for(let i=0;i<12;i++){if(!await execution.runOnce())break;}
  expect(provider.calls).toHaveLength(2);expect((await admin.pool.query('SELECT state FROM manga_web.processing_requests WHERE request_id=$1',[request.reply.operationRef.id])).rows[0].state).toBe('COMPLETED');
  await expect(worker.accountTransaction(seed.accountId,tx=>tx.client.query('DELETE FROM free_starts WHERE account_id=$1',[seed.accountId]))).rejects.toMatchObject({code:'42501'});
});
