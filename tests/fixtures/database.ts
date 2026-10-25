import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Database, type Clock } from '../../packages/storage/src/database.js';
import { migrate } from '../../packages/storage/src/migrations.js';
import { sha256 } from '../../packages/contracts/src/intent.js';

export async function testDatabase(clock?: Clock): Promise<Database> {
  const connectionString = process.env.TRIO_TEST_DATABASE_URL;
  if (!connectionString || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/.test(connectionString)) throw new Error('Use npm run test:postgres with its explicitly isolated PG18 runtime.');
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const name = `trio_test_${randomUUID().replaceAll('-', '')}`;
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const url = new URL(connectionString); url.pathname = `/${name}`;
  const db = new Database(url.toString(), clock);
  await migrate(db.pool);
  return db;
}
export async function seedIdentity(db: Database, now = new Date('2026-10-03T00:00:00.000Z'), freeStarted = 0) {
  const accountId = randomUUID(); const bindingId = randomUUID(); const attemptId = randomUUID(); const evidenceId = randomUUID(); const sessionId = randomUUID();
  await db.transaction(async (client) => {
    await client.query("INSERT INTO accounts(account_id,access_state,revision,auth_generation,balance_credit,free_started_count,created_at) VALUES($1,'ACTIVE',0,0,'100',$2,$3)", [accountId, freeStarted, now]);
    await client.query("INSERT INTO login_bindings(account_id,binding_id,issuer,subject,method,state,revision) VALUES($1,$2,'https://synthetic.invalid','synthetic-'||($1::uuid)::text,'EMAIL_OTP','ACTIVE',0)", [accountId,bindingId]);
    await client.query("INSERT INTO auth_attempts(attempt_id,purpose,method,correlation_digest,provider_scope_version,created_at,expires_at,failed_count,next_send_at,state) VALUES($1,'LOGIN','EMAIL_OTP','synthetic-correlation','synthetic-v1',$2,$2::timestamptz+interval '5 minutes',0,$2,'CONSUMED')", [attemptId,now]);
    await client.query("INSERT INTO auth_evidence(account_id,evidence_id,attempt_id,binding_id,purpose,issuer,subject,verified_at,expires_at) VALUES($1,$2,$3,$4,'LOGIN','https://synthetic.invalid','synthetic-'||($1::uuid)::text,$5,$5::timestamptz+interval '5 minutes')", [accountId,evidenceId,attemptId,bindingId,now]);
    await client.query("INSERT INTO app_sessions(account_id,session_id,binding_id,login_evidence_id,cookie_digest,csrf_digest,auth_generation,fresh_login_verified_at,absolute_expires_at) VALUES($1,$2,$3,$4,($2::uuid)::text,($2::uuid)::text,0,$5,$5::timestamptz+interval '7 days')", [accountId,sessionId,bindingId,evidenceId,now]);
  });
  return { accountId,bindingId,sessionId };
}
export async function seedWorkspace(db: Database, identity: Awaited<ReturnType<typeof seedIdentity>>, pages = 1, now = new Date('2026-10-03T00:00:00Z')) {
  const contextId = randomUUID(); const projectId = randomUUID(); const tabId = randomUUID(); const pageIds: string[] = [];
  await db.transaction(async (client) => {
    await client.query('INSERT INTO project_lineages(account_id,project_lineage_id) VALUES($1,$2)', [identity.accountId,projectId]);
    await client.query("INSERT INTO workspace_contexts(account_id,context_id,project_lineage_id,generation,lifecycle,owner_session_id,owner_tab_id,owner_revision,workspace_revision,connection_generation,heartbeat_seq,last_valid_heartbeat_at,owner_capability_digest,project_status,title) VALUES($1,$2,$3,1,'OPEN',$4,$5,0,0,1,0,$6,$7,'IN_PROGRESS','합성 프로젝트')", [identity.accountId,contextId,projectId,identity.sessionId,tabId,now,sha256('synthetic-owner')]);
    await client.query('INSERT INTO account_live_context_slots(account_id,context_id,generation,revision) VALUES($1,$2,1,0)', [identity.accountId,contextId]);
    for (let order = 0; order < pages; order++) {
      const pageId = randomUUID(); pageIds.push(pageId);
      await client.query('INSERT INTO page_lineages(account_id,page_lineage_id,project_lineage_id) VALUES($1,$2,$3)', [identity.accountId,pageId,projectId]);
      await client.query("INSERT INTO workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,paid_baseline_credit,baseline_contribution_refs,revision,image_width,image_height) VALUES($1,$2,$3,$4,$5,false,false,0,0,'[]',0,100,100)", [identity.accountId,contextId,projectId,pageId,order]);
      const assetId=randomUUID();const resultId=randomUUID();
      await client.query("INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id) VALUES($1,$2,'LIVE','synthetic',$2::uuid::text,repeat('a',64),1,'image/png','NOT_DUE',$3)",[identity.accountId,assetId,contextId]);
      await client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,0,$5,$2::uuid::text,'UPLOAD',$6)",[identity.accountId,resultId,contextId,pageId,assetId,JSON.stringify({blocks:[],geometryContract:'geometry-v1',renderContract:'render-v1',cleanupQa:'NOT_RUN'})]);
      await client.query('UPDATE workspace_pages SET current_result_id=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[identity.accountId,contextId,pageId,resultId]);
    }
  });
  return { ...identity,contextId,projectId,tabId,pageIds,ownerCapability:'synthetic-owner' };
}
