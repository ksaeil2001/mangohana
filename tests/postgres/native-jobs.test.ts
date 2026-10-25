import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {createNativeJob,type NativeJob} from '../../packages/native/src/dto.js';
import {sha256} from '../../packages/contracts/src/intent.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent,type NativeJobObservation,type NativeTargetKind} from '../../packages/domain/src/native-jobs.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

const connections:Database[]=[];
let admin:Database,api:Database,secondApi:Database,worker:Database;
beforeAll(async()=>{
  console.info(JSON.stringify({nativeJobsTrace:'shared_fixture',phase:'database_start'}));
  admin=await testDatabase();connections.push(admin);
  console.info(JSON.stringify({nativeJobsTrace:'shared_fixture',phase:'migrations_done'}));
  api=await provisionLocalService(admin,'trio_web_api');connections.push(api);secondApi=await provisionLocalService(admin,'trio_web_api');connections.push(secondApi);worker=await provisionLocalService(admin,'trio_web_worker');connections.push(worker);
  for(const db of [api,secondApi,worker])await db.validateServiceRole();
  console.info(JSON.stringify({nativeJobsTrace:'shared_fixture',phase:'login_roles_verified'}));
});
afterAll(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
async function workspace(){const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;return seedWorkspace(admin,await seedIdentity(admin,now),1,now);}
type Workspace=Awaited<ReturnType<typeof workspace>>;
function input(task:'DECODE_IMAGE'|'GEMINI_APPLY'='DECODE_IMAGE'):NativeJob{
  const metadata:Record<string,unknown>=task==='DECODE_IMAGE'?{sourceBlobId:'owned-source'}:{input:{requestId:randomUUID(),inputDigest:sha256('owned-stage-input'),claimGeneration:'1'},novelRegionIds:[randomUUID(),randomUUID()],proposal:{owned:'proposal'}};
  return createNativeJob(task,sha256('owned-native-profile'),metadata,new Map([['owned-source',Buffer.from('owned-native-bytes')]]),{maxMetadataBytes:8192,maxBinaryBytes:8192,maxItems:4});
}
function captured(seed:Workspace,targetKind:NativeTargetKind,targetId:string,claim:{generation:string;ownerId:string;workItemId:string|null},job=input()):NativeJobIntent{
  const value={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind,targetId,semanticCaptureDigest:sha256(`owned-capture:${targetKind}:${targetId}`),
    protectedOwnerCapture:{contextId:seed.contextId,contextGeneration:'1',ownerSessionId:seed.sessionId,ownerTabId:seed.tabId,ownerRevision:'0',workspaceRevision:'0'},claim};
  return {...value,logicalOperationKey:nativeLogicalOperationKey(value)};
}
async function upload(seed:Workspace,purpose:'PAGE_IMAGES'|'PROJECT_IMPORT'='PAGE_IMAGES'){
  const id=randomUUID(),ownerId=randomUUID();await admin.pool.query(`INSERT INTO manga_web.uploads(account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,owner_revision,context_generation,owner_session_id,owner_tab_id,captured_workspace_revision)
    SELECT $1,$2,$3,$4,0,'PREPARED',n,n+interval '1 hour',0,1,$5,$6,0 FROM (SELECT clock_timestamp() n) t`,[seed.accountId,id,seed.contextId,purpose,seed.sessionId,seed.tabId]);
  // One sampled DB timestamp preserves the exact one-hour immutable expiry.
  return {id,claim:{generation:'0',ownerId,workItemId:null}};
}
async function prepared(seed:Workspace){
  const requestId=randomUUID(),executionId=randomUUID(),workItemId=randomUUID(),ownerId=randomUUID();
  await admin.transaction(async client=>{
    await client.query("INSERT INTO manga_web.settings_revisions(account_id,context_id,settings_revision,contract_version,captured_settings) VALUES($1,$2,1,'synthetic-v1','{}')",[seed.accountId,seed.contextId]);
    await client.query(`INSERT INTO manga_web.processing_requests(account_id,request_id,context_id,context_generation,project_lineage_id,page_lineage_id,settings_revision,scope_digest,captured_scope,state,hold_reasons,mode,revision)
      VALUES($1,$2,$3,1,$4,$5,1,$6,'{"kind":"PAGE"}','ACTIVE','[]','FREE',0)`,[seed.accountId,requestId,seed.contextId,seed.projectId,seed.pageIds[0],sha256('owned-scope')]);
    await client.query("INSERT INTO manga_web.request_steps(account_id,request_id,logical_step_id,execution_generation,revision) VALUES($1,$2,'OCR',1,0)",[seed.accountId,requestId]);
    await client.query("INSERT INTO manga_web.executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) VALUES($1,$2,$3,'OCR','synthetic-v1',$4,'[]',1,'PREPARED',0)",[seed.accountId,executionId,requestId,sha256('owned-stage-input')]);
    await client.query("INSERT INTO manga_web.work_items(account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision) VALUES($1,$2,'DISPATCH',$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',$5,1,'CLAIMED',0)",[seed.accountId,workItemId,sha256(workItemId),JSON.stringify({requestId}),ownerId]);
  });
  return {requestId,executionId,claim:{generation:'1',ownerId,workItemId}};
}
function error(intent:NativeJobIntent):NativeJobObservation{return {version:1,parentInstanceId:intent.parentInstanceId,event:'ERROR',code:'NATIVE_JOB_TIMEOUT',resultDigest:null,termination:{jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,isolation:'OWNED_FIXTURE',kind:'UNCONFIRMED'}};}
const createRaw=(db:Database,accountId:string,value:unknown)=>db.accountTransaction(accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string}}>('SELECT manga_web.native_job_create_intent($1::jsonb) AS decision',[JSON.stringify(value)])).rows[0].decision);

describe('durable native jobs under actual API and worker LOGIN roles',()=>{
  it('creates account-scoped immutable intent with no child DB or direct service write authority',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),store=new NativeJobStore(api,seed.accountId);await expect(store.beforeIntent(intent)).resolves.toMatchObject({allowed:true,reason:'CREATED'});
    const row=(await api.accountTransaction(seed.accountId,tx=>tx.client.query('SELECT protected_intent FROM manga_web.native_job_intents WHERE job_id=$1',[intent.jobId]))).rows[0];expect(row.protected_intent).toEqual(intent);expect(JSON.stringify(row)).not.toContain('owned-native-bytes');
    const other=await workspace();expect((await api.accountTransaction(other.accountId,tx=>tx.client.query('SELECT job_id FROM manga_web.native_job_intents'))).rows).toEqual([]);
    await expect(new NativeJobStore(api,other.accountId).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_INTENT_FENCE_REJECTED');
    for(const db of [api,worker])for(const table of ['native_job_intents','native_job_go_consumptions','native_job_observations']){
      expect((await db.pool.query('SELECT has_table_privilege(current_user,$1,\'INSERT\') AS insert,has_table_privilege(current_user,$1,\'UPDATE\') AS update,has_table_privilege(current_user,$1,\'DELETE\') AS delete',['manga_web.'+table])).rows[0]).toEqual({insert:false,update:false,delete:false});
      await expect(db.accountTransaction(seed.accountId,tx=>tx.client.query(`UPDATE manga_web.${table} SET account_id=account_id`))).rejects.toMatchObject({code:'42501'});
    }
    await expect(admin.pool.query('UPDATE manga_web.native_job_intents SET input_digest=repeat(\'b\',64) WHERE account_id=$1',[seed.accountId])).rejects.toMatchObject({code:'23514',message:'NATIVE_JOB_RECORD_IMMUTABLE'});
  });
  it('consumes GO exactly once across concurrent LOGIN connections and refuses lost-response restart',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),first=new NativeJobStore(api,seed.accountId),second=new NativeJobStore(secondApi,seed.accountId);await first.beforeIntent(intent);
    const results=await Promise.allSettled([first.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture),second.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect((await admin.pool.query('SELECT count(*)::integer AS count FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[seed.accountId])).rows[0].count).toBe(1);
    const shadowed=await api.accountTransaction(seed.accountId,async tx=>{
      await tx.client.query('CREATE TEMP TABLE native_job_intents(account_id uuid,job_id uuid) ON COMMIT DROP');await tx.client.query('CREATE TEMP TABLE native_job_go_consumptions(account_id uuid,job_id uuid) ON COMMIT DROP');
      return (await tx.client.query('SELECT manga_web.native_job_consume_go($1,$2,$3::jsonb,$4::jsonb) AS decision',[intent.jobId,intent.parentInstanceId,JSON.stringify(intent.claim),JSON.stringify(intent.protectedOwnerCapture)])).rows[0].decision;
    });expect(shadowed).toMatchObject({allowed:false,reason:'NATIVE_GO_ALREADY_CONSUMED'});
    await expect(first.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_GO_ALREADY_CONSUMED');await expect(first.beforeIntent({...intent,jobId:randomUUID(),parentInstanceId:randomUUID()})).rejects.toThrow('NATIVE_JOB_UNRESOLVED');
    expect(await first.unresolved(intent.logicalOperationKey)).toMatchObject([{jobId:intent.jobId,go:'CONSUMED',result:'UNOBSERVED',termination:'UNCONFIRMED',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true}]);
  });
  it('checks original parent, capture and current target revision before granting any GO',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),store=new NativeJobStore(api,seed.accountId);await store.beforeIntent(intent);
    await expect(store.beforeGo(intent.jobId,randomUUID(),intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_INTENT_FENCE_REJECTED');
    await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,{...intent.claim,generation:'1'},intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_INTENT_FENCE_REJECTED');
    await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,{...intent.protectedOwnerCapture,ownerRevision:'1'})).rejects.toThrow('NATIVE_INTENT_FENCE_REJECTED');
    await admin.pool.query('UPDATE manga_web.uploads SET owner_session_id=$3 WHERE account_id=$1 AND upload_id=$2',[seed.accountId,target.id,randomUUID()]);await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');await admin.pool.query('UPDATE manga_web.uploads SET owner_session_id=$3 WHERE account_id=$1 AND upload_id=$2',[seed.accountId,target.id,seed.sessionId]);
    await admin.pool.query('UPDATE manga_web.uploads SET owner_tab_id=$3 WHERE account_id=$1 AND upload_id=$2',[seed.accountId,target.id,randomUUID()]);await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');await admin.pool.query('UPDATE manga_web.uploads SET owner_tab_id=$3 WHERE account_id=$1 AND upload_id=$2',[seed.accountId,target.id,seed.tabId]);
    await admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=1 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId]);await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');await admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=0 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId]);
    await admin.pool.query('UPDATE manga_web.uploads SET preview_revision=1 WHERE account_id=$1 AND upload_id=$2',[seed.accountId,target.id]);await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');
    expect((await admin.pool.query('SELECT count(*)::integer AS count FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[seed.accountId])).rows[0].count).toBe(0);
  });
  it('holds the same logical input after new job UUID, claim generation and novel output UUIDs',async()=>{
    const seed=await workspace(),target=await prepared(seed),job=input('GEMINI_APPLY'),intent=captured(seed,'EXECUTION',target.executionId,target.claim,job),store=new NativeJobStore(worker,seed.accountId);await store.beforeIntent(intent);await store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture);
    await admin.pool.query('UPDATE manga_web.executions SET claim_generation=2 WHERE account_id=$1 AND execution_id=$2',[seed.accountId,target.executionId]);await admin.pool.query('UPDATE manga_web.work_items SET claim_generation=2 WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,target.claim.workItemId]);
    const changed=structuredClone(job);changed.jobId=randomUUID();changed.inputDigest=sha256('new-native-frame');(changed.metadata.input as Record<string,unknown>).claimGeneration='2';changed.metadata.novelRegionIds=[randomUUID(),randomUUID()];
    const retry={...intent,jobId:changed.jobId,parentInstanceId:randomUUID(),inputDigest:changed.inputDigest,operationInputDigest:nativeOperationInputDigest(changed),claim:{...target.claim,generation:'2'}};expect(nativeLogicalOperationKey(retry)).toBe(intent.logicalOperationKey);await expect(store.beforeIntent(retry)).rejects.toThrow('NATIVE_JOB_UNRESOLVED');
    const original=(await admin.pool.query('SELECT input_digest,protected_intent FROM manga_web.native_job_intents WHERE account_id=$1',[seed.accountId])).rows;expect(original).toEqual([{input_digest:intent.inputDigest,protected_intent:intent}]);
  });
  it('appends the original ERROR and later result/termination without confirming cost, application or retry',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),store=new NativeJobStore(api,seed.accountId);await store.beforeIntent(intent);await store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture);
    await admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[seed.accountId]);
    const original=error(intent),id=randomUUID();await store.observe(id,original);
    const later:NativeJobObservation={...original,event:'TERMINATION',code:'NATIVE_TERMINATION_OBSERVED',termination:{...original.termination,operationJoined:true,subtreeTerminationConfirmed:true,isolation:'LINUX_CGROUP_V2',kind:'CGROUP_EMPTY'}};await store.observe(randomUUID(),later);
    await store.observe(randomUUID(),{...later,event:'RESULT',code:'OK',resultDigest:sha256('owned-output')});
    const state=(await store.unresolved(intent.logicalOperationKey))[0];expect(state).toMatchObject({go:'CONSUMED',result:'OBSERVED',termination:'UNTRUSTED_CGROUP_CANDIDATE',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true,firstError:{observationId:id,snapshot:original}});
    expect((await admin.pool.query('SELECT protected_observation FROM manga_web.native_job_observations WHERE account_id=$1 AND observation_id=$2',[seed.accountId,id])).rows[0].protected_observation).toEqual(original);
    await expect(store.beforeIntent({...intent,jobId:randomUUID()})).rejects.toThrow('ACCOUNT_ACCESS_DENIED');await expect(store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture)).rejects.toThrow('ACCOUNT_ACCESS_DENIED');
    await admin.pool.query("UPDATE manga_web.accounts SET access_state='ACTIVE' WHERE account_id=$1",[seed.accountId]);await expect(store.beforeIntent({...intent,jobId:randomUUID()})).rejects.toThrow('NATIVE_JOB_UNRESOLVED');
  });
  it('keeps explicit NO_CHILD and OWNED direct-child observations as candidates with no release authority',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),store=new NativeJobStore(api,seed.accountId);await store.beforeIntent(intent);
    const candidate:NativeJobObservation={...error(intent),event:'TERMINATION',code:'NATIVE_TERMINATION_OBSERVED',termination:{...error(intent).termination,goAttempted:false,startedComputation:false,directChildClosed:false,operationJoined:true,kind:'NO_CHILD_CREATED'}};await store.observe(randomUUID(),candidate);
    expect((await store.unresolved(intent.logicalOperationKey))[0]).toMatchObject({go:'UNCONSUMED',termination:'NO_CHILD_CANDIDATE',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true});await expect(store.beforeIntent({...intent,jobId:randomUUID()})).rejects.toThrow('NATIVE_JOB_UNRESOLVED');
    await store.observe(randomUUID(),{...candidate,termination:{...candidate.termination,directChildClosed:true,kind:'DIRECT_CHILD_ONLY'}});expect((await store.unresolved(intent.logicalOperationKey))[0]).toMatchObject({termination:'UNCONFIRMED',unresolved:true});await expect(store.beforeIntent({...intent,jobId:randomUUID()})).rejects.toThrow('NATIVE_JOB_UNRESOLVED');
  });
  it('rejects a duplicate observation ID with a different digest and fences late observations to the original parent',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim),store=new NativeJobStore(api,seed.accountId);await store.beforeIntent(intent);await store.beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture);const original=error(intent),id=randomUUID();const recorded=await store.observe(id,original);expect(await store.observe(id,original)).toMatchObject({allowed:true,reason:'OBSERVATION_EXISTS',observationDigest:recorded.observationDigest});
    await expect(store.observe(id,{...original,code:'NATIVE_EVIDENCE_UNCONFIRMED'})).rejects.toThrow('NATIVE_OBSERVATION_CONFLICT');await expect(store.observe(randomUUID(),{...original,parentInstanceId:randomUUID()})).rejects.toThrow('NATIVE_OBSERVATION_FENCE_REJECTED');await expect(store.observe(randomUUID(),{...original,termination:{...original.termination,inputDigest:sha256('different-frame')}})).rejects.toThrow('NATIVE_OBSERVATION_FENCE_REJECTED');
    await expect(new NativeJobStore(worker,seed.accountId).observe(randomUUID(),original)).rejects.toThrow('NATIVE_OBSERVATION_FENCE_REJECTED');expect((await admin.pool.query('SELECT observation_id,protected_observation FROM manga_web.native_job_observations WHERE account_id=$1',[seed.accountId])).rows).toEqual([{observation_id:id,protected_observation:original}]);
    for(const table of ['native_job_go_consumptions','native_job_observations'])await expect(admin.pool.query(`DELETE FROM manga_web.${table} WHERE account_id=$1`,[seed.accountId])).rejects.toMatchObject({code:'23514',message:'NATIVE_JOB_RECORD_IMMUTABLE'});
  });
  it('rejects raw SQL shape and forged keys, missing/foreign targets, and the opposite process whitelist',async()=>{
    const seed=await workspace(),target=await upload(seed),intent=captured(seed,'UPLOAD',target.id,target.claim);
    for(const raw of [{...intent,path:'owned-path'},{...intent,claim:{...intent.claim,generation:null}},{...intent,task:null},{...intent,taskVersion:null},{...intent,profileDigest:null},{...intent,protectedOwnerCapture:{...intent.protectedOwnerCapture,contextGeneration:null}},{...intent,logicalOperationKey:sha256('forged-key')}])await expect(createRaw(api,seed.accountId,raw)).rejects.toMatchObject({code:'23514'});
    const foreign=await workspace(),foreignTarget=await upload(foreign);for(const id of [randomUUID(),foreignTarget.id]){const missing={...intent,jobId:randomUUID(),targetId:id};missing.logicalOperationKey=nativeLogicalOperationKey(missing);expect(await createRaw(api,seed.accountId,missing)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});}
    expect(await createRaw(worker,seed.accountId,intent)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});
    const request=await prepared(seed),execution=captured(seed,'EXECUTION',request.executionId,request.claim);expect(await createRaw(api,seed.accountId,execution)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});
    const restore={...intent,jobId:randomUUID(),targetKind:'RESTORE' as const};restore.logicalOperationKey=nativeLogicalOperationKey(restore);expect(await createRaw(api,seed.accountId,restore)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});
  });
  it('uses the actual closed upload, restore, raster, export, library, execution and checkpoint targets',async()=>{
    const seed=await workspace(),page=await upload(seed),restore=await upload(seed,'PROJECT_IMPORT'),preparedTarget=await prepared(seed),rasterOwner=randomUUID(),exportOwner=randomUUID(),exportId=randomUUID(),libraryId=randomUUID(),storeWork=randomUUID(),storeOwner=randomUUID();
    const resultId=(await admin.pool.query('SELECT result_id FROM manga_web.results WHERE account_id=$1',[seed.accountId])).rows[0].result_id;
    await admin.transaction(async client=>{
      await client.query("INSERT INTO manga_web.result_render_claims(account_id,result_id,render_digest,generation,owner_id,lease_until) VALUES($1,$2,$3,1,$4,clock_timestamp()+interval '5 minutes')",[seed.accountId,resultId,sha256('owned-render'),rasterOwner]);
      await client.query("INSERT INTO manga_web.exports(account_id,export_id,context_id,context_generation,kind,snapshot_revision,protected_manifest_ref,captured_at,retry_deadline,state) SELECT $1,$2,$3,1,'PROJECT_FILE',0,'owned-manifest',n,n+interval '30 minutes','ACCEPTED' FROM (SELECT clock_timestamp() n) t",[seed.accountId,exportId,seed.contextId]);
      await client.query("INSERT INTO manga_web.export_builds(account_id,export_id,capture_digest,runtime_fingerprint,protected_runtime,captured_authorization,claim_authorization,generation,owner_id,lease_until,state,captured_at) VALUES($1,$2,$3,$3,'{}',$5,$5,1,$4,clock_timestamp()+interval '5 minutes','BUILDING',clock_timestamp())",[seed.accountId,exportId,sha256('owned-export'),exportOwner,JSON.stringify({sessionId:seed.sessionId,tabId:seed.tabId,ownerRevision:'0',contextGeneration:'1',bindingId:seed.bindingId,authGeneration:'0'})]);
      await client.query("INSERT INTO manga_web.library_store_operations(account_id,store_operation_id,source_context_id,page_lineage_id,result_id,render_digest,purpose,state,revision) VALUES($1,$2,$3,$4,$5,$6,'LIBRARY_RESULT','ACCEPTED',0)",[seed.accountId,libraryId,seed.contextId,seed.pageIds[0],resultId,sha256('owned-render')]);
      await client.query("INSERT INTO manga_web.work_items(account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision) VALUES($1,$2,'STORE',$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',$5,1,'CLAIMED',0)",[seed.accountId,storeWork,sha256(storeWork),JSON.stringify({storeOperationId:libraryId}),storeOwner]);
    });
    await admin.pool.query('UPDATE manga_web.workspace_contexts SET workspace_revision=9 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId]);
    const cases:[Database,NativeTargetKind,string,NativeJobIntent['claim']][]=[[api,'UPLOAD',page.id,page.claim],[api,'RESTORE',restore.id,restore.claim],[api,'RASTER',resultId,{generation:'1',ownerId:rasterOwner,workItemId:null}],[api,'EXPORT',exportId,{generation:'1',ownerId:exportOwner,workItemId:null}],[api,'LIBRARY',libraryId,{generation:'0',ownerId:randomUUID(),workItemId:null}],[worker,'EXECUTION',preparedTarget.executionId,preparedTarget.claim],[worker,'REQUEST_CHECKPOINT',preparedTarget.requestId,preparedTarget.claim],[worker,'RASTER',resultId,{generation:'1',ownerId:rasterOwner,workItemId:null}],[worker,'LIBRARY',libraryId,{generation:'1',ownerId:storeOwner,workItemId:storeWork}]];
    for(const [db,kind,id,claim] of cases){const value=captured(seed,kind,id,claim);if(db===worker)value.semanticCaptureDigest=sha256('distinct-owned-worker-capture');value.logicalOperationKey=nativeLogicalOperationKey(value);const store=new NativeJobStore(db,seed.accountId);await expect(store.beforeIntent(value)).resolves.toMatchObject({allowed:true});await expect(store.beforeGo(value.jobId,value.parentInstanceId,value.claim,value.protectedOwnerCapture)).resolves.toMatchObject({allowed:true});}
  });
  it('matches RECONCILE executionId and initial STORE resultId to their actual account-owned targets',async()=>{
    const seed=await workspace(),target=await prepared(seed),reconcileId=randomUUID(),reconcileOwner=randomUUID(),storeWorkId=randomUUID(),storeOwner=randomUUID(),libraryId=randomUUID();
    const resultId=(await admin.pool.query('SELECT result_id FROM manga_web.results WHERE account_id=$1',[seed.accountId])).rows[0].result_id;
    await admin.transaction(async client=>{
      await client.query("INSERT INTO manga_web.work_items(account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision) VALUES($1,$2,'RECONCILE',$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',$5,2,'CLAIMED',0)",[seed.accountId,reconcileId,sha256(reconcileId),JSON.stringify({executionId:target.executionId}),reconcileOwner]);
      await client.query("INSERT INTO manga_web.library_store_operations(account_id,store_operation_id,source_context_id,page_lineage_id,result_id,render_digest,purpose,state,revision,retry_group_id) VALUES($1,$2,$3,$4,$5,$6,'LIBRARY_RESULT','ACCEPTED',0,$7)",[seed.accountId,libraryId,seed.contextId,seed.pageIds[0],resultId,sha256('owned-render'),randomUUID()]);
      await client.query("INSERT INTO manga_web.work_items(account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision) VALUES($1,$2,'STORE',$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',$5,1,'CLAIMED',0)",[seed.accountId,storeWorkId,sha256(storeWorkId),JSON.stringify({resultId}),storeOwner]);
    });
    const store=new NativeJobStore(worker,seed.accountId),reconcileClaim={generation:'2',ownerId:reconcileOwner,workItemId:reconcileId};
    const execution=captured(seed,'EXECUTION',target.executionId,reconcileClaim);await store.beforeIntent(execution);
    await admin.pool.query('UPDATE manga_web.work_items SET target_ref=$3 WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,reconcileId,JSON.stringify({executionId:randomUUID()})]);await expect(store.beforeGo(execution.jobId,execution.parentInstanceId,execution.claim,execution.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');
    await admin.pool.query('UPDATE manga_web.work_items SET target_ref=$3 WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,reconcileId,JSON.stringify({executionId:target.executionId})]);await store.beforeGo(execution.jobId,execution.parentInstanceId,execution.claim,execution.protectedOwnerCapture);
    const checkpoint=captured(seed,'REQUEST_CHECKPOINT',target.requestId,reconcileClaim);await store.beforeIntent(checkpoint);await store.beforeGo(checkpoint.jobId,checkpoint.parentInstanceId,checkpoint.claim,checkpoint.protectedOwnerCapture);
    await admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,workspace_revision=9 WHERE account_id=$1 AND context_id=$2",[seed.accountId,seed.contextId]);
    const library=captured(seed,'LIBRARY',libraryId,{generation:'1',ownerId:storeOwner,workItemId:storeWorkId});await store.beforeIntent(library);
    await admin.pool.query('UPDATE manga_web.work_items SET target_ref=$3 WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,storeWorkId,JSON.stringify({resultId:randomUUID()})]);await expect(store.beforeGo(library.jobId,library.parentInstanceId,library.claim,library.protectedOwnerCapture)).rejects.toThrow('NATIVE_TARGET_FENCE_REJECTED');
    await admin.pool.query('UPDATE manga_web.work_items SET target_ref=$3 WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,storeWorkId,JSON.stringify({resultId})]);await store.beforeGo(library.jobId,library.parentInstanceId,library.claim,library.protectedOwnerCapture);
    expect((await admin.pool.query('SELECT count(*)::integer AS count FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[seed.accountId])).rows[0].count).toBe(3);
  });
  it('allows only ZIP_READ and DECODE_IMAGE for a completed available project-file export with sealed capture',async()=>{
    const seed=await workspace(),id=randomUUID(),assetId=randomUUID(),ownerId=randomUUID(),authorization={sessionId:seed.sessionId,tabId:seed.tabId,ownerRevision:'0',contextGeneration:'1',bindingId:seed.bindingId,authGeneration:'0'};
    await admin.transaction(async client=>{
      await client.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state) VALUES($1,$2,'EXPORT','owned-no-object',$2::uuid::text,$3,1,'application/zip','NOT_DUE')",[seed.accountId,assetId,sha256('owned-archive')]);
      await client.query("INSERT INTO manga_web.exports(account_id,export_id,context_id,context_generation,kind,snapshot_revision,protected_manifest_ref,captured_at,retry_deadline,state,output_asset_id) SELECT $1,$2,$3,1,'PROJECT_FILE',0,'owned-manifest',n,n+interval '30 minutes','AVAILABLE',$4 FROM (SELECT clock_timestamp() n) t",[seed.accountId,id,seed.contextId,assetId]);
      await client.query("INSERT INTO manga_web.export_builds(account_id,export_id,capture_digest,runtime_fingerprint,protected_runtime,captured_authorization,claim_authorization,generation,owner_id,lease_until,state,captured_at,completed_at) VALUES($1,$2,$3,$3,'{}',$4,$4,1,$5,clock_timestamp()-interval '1 minute','COMPLETE',clock_timestamp(),clock_timestamp())",[seed.accountId,id,sha256('owned-export'),JSON.stringify(authorization),ownerId]);
      await client.query('UPDATE manga_web.workspace_contexts SET owner_revision=1,workspace_revision=9,owner_tab_id=$3 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId,randomUUID()]);
    });
    const store=new NativeJobStore(api,seed.accountId);for(const task of ['ZIP_READ','DECODE_IMAGE'] as const){const job=createNativeJob(task,sha256('owned-native-profile'),task==='ZIP_READ'?{archiveBlobId:'owned-source'}:{sourceBlobId:'owned-source'},new Map([['owned-source',Buffer.from('owned-native-bytes')]]),{maxMetadataBytes:8192,maxBinaryBytes:8192,maxItems:4});const value=captured(seed,'EXPORT',id,{generation:'1',ownerId,workItemId:null},job);await store.beforeIntent(value);await store.beforeGo(value.jobId,value.parentInstanceId,value.claim,value.protectedOwnerCapture);}
    const render=captured(seed,'EXPORT',id,{generation:'1',ownerId,workItemId:null});render.task='RENDER_PAGE';render.operationInputDigest=sha256('owned-render-task');render.logicalOperationKey=nativeLogicalOperationKey(render);expect(await createRaw(api,seed.accountId,render)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});
    const wrong=captured(seed,'EXPORT',id,{generation:'1',ownerId,workItemId:null});wrong.operationInputDigest=sha256('different-owned-decode');wrong.logicalOperationKey=nativeLogicalOperationKey(wrong);wrong.protectedOwnerCapture.workspaceRevision='9';expect(await createRaw(api,seed.accountId,wrong)).toMatchObject({allowed:false,reason:'NATIVE_TARGET_FENCE_REJECTED'});
  });
  it('detects direct write, helper EXECUTE, FORCE RLS and owning function search_path drift without repairing grants',async()=>{
    for(const db of [api,worker]){
      const role=db.role!;for(const grant of ['INSERT ON manga_web.native_job_intents','UPDATE(protected_observation) ON manga_web.native_job_observations','EXECUTE ON FUNCTION manga_web.native_job_target_current(jsonb,text,timestamptz)']){
        await admin.pool.query(`GRANT ${grant} TO ${role}`);try{await expect(db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await admin.pool.query(`REVOKE ${grant} FROM ${role}`);}await db.validateServiceRole();
      }
    }
    await admin.pool.query('ALTER TABLE manga_web.native_job_intents NO FORCE ROW LEVEL SECURITY');try{await expect(api.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await admin.pool.query('ALTER TABLE manga_web.native_job_intents FORCE ROW LEVEL SECURITY');}
    await admin.pool.query('ALTER FUNCTION manga_web.native_job_create_intent(jsonb) SET search_path=pg_temp,manga_web,pg_catalog');try{await expect(worker.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await admin.pool.query('ALTER FUNCTION manga_web.native_job_create_intent(jsonb) SET search_path=pg_catalog,manga_web,pg_temp');}
    await admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.native_job_consume_go(uuid,uuid,jsonb,jsonb) FROM trio_web_api');try{await expect(api.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.native_job_consume_go(uuid,uuid,jsonb,jsonb) TO trio_web_api');}
    await api.validateServiceRole();await worker.validateServiceRole();
  });
});
