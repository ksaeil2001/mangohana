import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Database } from '../../packages/storage/src/database.js';
import { migrate } from '../../packages/storage/src/migrations.js';
import { seedIdentity, seedWorkspace, testDatabase } from '../fixtures/database.js';

describe.sequential('isolated PG18 migrations and ownership constraints', () => {
  let db: Database;
  const legacyPools: Database[] = [];
  beforeAll(async () => { db = await testDatabase(); });
  afterAll(async () => { const failures: unknown[] = []; for (const owned of [...legacyPools.splice(0).reverse(), db].filter(Boolean)) { try { await owned.close(); } catch (error) { failures.push(error); } } if (failures.length) throw new AggregateError(failures, 'OWNED_MIGRATION_DB_CLOSE_UNCONFIRMED'); });
  it('applies real PG syntax, is idempotent and preserves all 47 reference records', async () => {
    const version = (await db.pool.query('SHOW server_version')).rows[0].server_version;
    expect(version).toMatch(/^18\./);
    expect(await migrate(db.pool)).toEqual([]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0011_export_builds.sql'")).rows).toEqual([{name:'0011_export_builds.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0012_execution_limits.sql'")).rows).toEqual([{name:'0012_execution_limits.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0013_native_jobs.sql'")).rows).toEqual([{name:'0013_native_jobs.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0014_native_receipts.sql'")).rows).toEqual([{name:'0014_native_receipts.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0015_native_capacity.sql'")).rows).toEqual([{name:'0015_native_capacity.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0016_native_controller.sql'")).rows).toEqual([{name:'0016_native_controller.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0017_checkpoint_result_origin.sql'")).rows).toEqual([{name:'0017_checkpoint_result_origin.sql'}]);
    expect((await db.pool.query("SELECT column_name,is_nullable,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='manga_web' AND table_name='result_applications' AND column_name IN ('origin_request_id','execution_origin_request_id') ORDER BY column_name")).rows).toEqual([{column_name:'execution_origin_request_id',is_nullable:'YES',is_generated:'ALWAYS',generation_expression:'COALESCE(origin_request_id, request_id)'},{column_name:'origin_request_id',is_nullable:'YES',is_generated:'NEVER',generation_expression:null}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0018_operational_execution_limits.sql'")).rows).toEqual([{name:'0018_operational_execution_limits.sql'}]);
    expect((await db.pool.query("SELECT name FROM trio_migrations.applied WHERE name='0019_stage_cost_projection.sql'")).rows).toEqual([{name:'0019_stage_cost_projection.sql'}]);
    const applicationConstraints=(await db.pool.query("SELECT conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE conrelid='manga_web.result_applications'::regclass")).rows;
    expect(applicationConstraints).toContainEqual({conname:'one_result_application_per_request',definition:'UNIQUE (account_id, request_id)'});
    expect(applicationConstraints).toContainEqual({conname:'result_application_execution_origin_fk',definition:expect.stringMatching(/^FOREIGN KEY \(account_id, execution_origin_request_id, execution_id\) REFERENCES (?:manga_web\.)?executions\(account_id, request_id, execution_id\)$/)});
    expect(applicationConstraints.some(row=>row.conname==='result_applications_account_id_request_id_execution_id_fkey')).toBe(false);
    expect((await db.pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='manga_web.result_applications'::regclass")).rows).toEqual([{relrowsecurity:true}]);
    expect((await db.pool.query("SELECT roles::text[] AS roles,qual,with_check FROM pg_policies WHERE schemaname='manga_web' AND tablename='result_applications' AND policyname='account_scope'")).rows).toEqual([{roles:['trio_web_api','trio_web_worker'],qual:expect.stringMatching(/^\(account_id = (?:manga_web\.)?current_account\(\)\)$/),with_check:expect.stringMatching(/^\(account_id = (?:manga_web\.)?current_account\(\)\)$/)}]);
    expect((await db.pool.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='manga_web.verify_checkpoint_result_origin()'::regprocedure")).rows).toEqual([{prosecdef:false,proconfig:['search_path=pg_catalog, manga_web, pg_temp']}]);
    const tables = (await db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='manga_web' AND table_type='BASE TABLE'")).rows.map((row) => row.table_name);
    expect(tables).toContain('request_steps'); expect(tables).toContain('file_attestations'); expect(tables).toContain('result_render_holds'); expect(tables).toContain('s3_object_puts'); expect(tables).toContain('s3_put_confirmations'); expect(tables).toContain('export_builds'); expect(tables).toContain('export_build_candidates'); expect(tables.length).toBe(80);
    for(const table of ['native_controller_attempts','native_controller_events','native_controller_go_grants','native_controller_raw_results','native_controller_object_receipts'])expect(tables).toContain(table);
    for(const table of ['native_capacity_profiles','native_capacity_authority','native_capacity_reservations','native_capacity_adoptions','native_capacity_termination_proofs'])expect(tables).toContain(table);
    expect((await db.pool.query('SELECT current_profile_id,state,revision FROM manga_web.native_capacity_authority')).rows).toEqual([{current_profile_id:null,state:'UNMEASURED',revision:'0'}]);
    for(const table of ['native_result_candidates','native_result_receipts'])expect(tables).toContain(table);
    for(const table of ['operational_limit_evidence','execution_limit_profiles','execution_limit_authority','execution_request_bounds','execution_budget_reservations','execution_capacity_permits','execution_limit_expenses'])expect(tables).toContain(table);
    expect((await db.pool.query('SELECT current_profile_id,state,last_observed_at,halt_reason FROM manga_web.execution_limit_authority')).rows).toEqual([{current_profile_id:null,state:'UNMEASURED',last_observed_at:null,halt_reason:null}]);
    const limits=(await db.pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='manga_web' AND relname IN ('execution_request_bounds','execution_budget_reservations','execution_capacity_permits','execution_limit_expenses')")).rows;
    expect(limits).toHaveLength(4);expect(limits.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    expect((await db.pool.query("SELECT bool_and(prosecdef) AS secured FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND proname IN ('capture_execution_limits','reserve_execution_limits','reconcile_execution_limits','release_request_execution_budget')")).rows[0].secured).toBe(true);
    const native=(await db.pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='manga_web' AND relname IN ('native_job_intents','native_job_go_consumptions','native_job_observations')")).rows;
    expect(native).toHaveLength(3);expect(native.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    const owning=(await db.pool.query("SELECT proname,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND proname IN ('native_job_create_intent','native_job_consume_go','native_job_append_observation','native_job_unresolved')")).rows;
    expect(owning).toHaveLength(4);expect(owning.every(row=>row.prosecdef&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, manga_web, pg_temp')).toBe(true);
    expect((await db.pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='manga_web' AND relname IN ('export_builds','export_build_candidates') ORDER BY relname")).rows).toEqual([{relname:'export_build_candidates',relrowsecurity:true,relforcerowsecurity:true},{relname:'export_builds',relrowsecurity:true,relforcerowsecurity:true}]);
  });
  it('rejects cross-account page lineage references instead of mixing identity', async () => {
    const first = await seedWorkspace(db, await seedIdentity(db)); const second = await seedWorkspace(db, await seedIdentity(db));
    await expect(db.transaction((client) => client.query("INSERT INTO workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,paid_baseline_credit,baseline_contribution_refs,revision) VALUES($1,$2,$3,$4,99,false,false,0,0,'[]',0)", [first.accountId,first.contextId,first.projectId,second.pageIds[0]]))).rejects.toMatchObject({ code: '23503' });
  });
  it('enforces one live context slot and finite money values', async () => {
    const fixture = await seedWorkspace(db, await seedIdentity(db));
    await expect(db.transaction((client) => client.query('INSERT INTO account_live_context_slots(account_id,context_id,generation,revision) VALUES($1,$2,1,0)', [fixture.accountId,fixture.contextId]))).rejects.toMatchObject({ code: '23505' });
    for (const [value, code] of [['NaN','23514'],['Infinity','22003'],['-Infinity','22003']]) {
      await expect(db.transaction((client) => client.query('UPDATE accounts SET balance_credit=$2::numeric WHERE account_id=$1', [fixture.accountId,value]))).rejects.toMatchObject({ code });
    }
    expect((await db.pool.query('SELECT balance_credit FROM manga_web.accounts WHERE account_id=$1', [fixture.accountId])).rows[0].balance_credit).toBe('100.000000000000');
  });
  it('rejects stored success without its exact 30-day expiry and preserves UNCONFIRMED baseline', async () => {
    const fixture = await seedWorkspace(db, await seedIdentity(db)); const assetId = randomUUID(); const resultId = randomUUID();
    await db.transaction(async (client) => {
      await client.query("INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state) VALUES($1,$2,'LIVE','synthetic',($2::uuid)::text,repeat('a',64),1,'image/png','NOT_DUE')", [fixture.accountId,assetId]);
      await client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin) VALUES($1,$2,$3,$4,1,$5,'synthetic','UPLOAD')", [fixture.accountId,resultId,fixture.contextId,fixture.pageIds[0],assetId]);
      await client.query("UPDATE workspace_pages SET paid_baseline_state='UNCONFIRMED',baseline_unsettled_refs=$4,paid_baseline_credit='1.123456789012' WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3", [fixture.accountId,fixture.contextId,fixture.pageIds[0],JSON.stringify([{ requestId: randomUUID() }])]);
    });
    const insert = (expiry: string | null) => db.transaction((client) => client.query("INSERT INTO library_store_operations(account_id,store_operation_id,source_context_id,page_lineage_id,result_id,render_digest,purpose,state,store_completed_at,expires_at,revision) VALUES($1,$2,$3,$4,$5,repeat('a',64),'LIBRARY_RESULT','SUCCEEDED','2026-10-03',$6,0)", [fixture.accountId,randomUUID(),fixture.contextId,fixture.pageIds[0],resultId,expiry]));
    await expect(insert(null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('2026-11-03')).rejects.toMatchObject({ code: '23514' });
    await insert('2026-11-02');
    const row = (await db.pool.query('SELECT paid_baseline_state,paid_baseline_credit,baseline_unsettled_refs FROM manga_web.workspace_pages WHERE account_id=$1', [fixture.accountId])).rows[0];
    expect(row.paid_baseline_state).toBe('UNCONFIRMED'); expect(row.paid_baseline_credit).toBe('1.123456789012'); expect(row.baseline_unsettled_refs).toHaveLength(1);
  });

  async function legacyDatabase(before=17) {
    // Original 0001-0016 bytes and SHA ledger in a separate owned test DB.
    // No current constraint is dropped and no migrator is replaced.
    const name='trio_checkpoint_upgrade_'+randomUUID().replaceAll('-','');
    await db.pool.query('CREATE DATABASE "'+name+'"');
    const url=new URL(db.connectionString);url.pathname='/'+name;
    const legacy=new Database(url.toString());legacyPools.push(legacy);
    const directory=fileURLToPath(new URL('../../db/migrations/',import.meta.url));
    const names=(await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)&&Number(name.slice(0,4))<before).sort();expect(names).toHaveLength(before-1);
    const records: {name:string;sha256:string}[]=[];
    await legacy.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(847103031)');
      await client.query('CREATE SCHEMA trio_migrations');
      await client.query('CREATE TABLE trio_migrations.applied(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      for(const name of names){const sql=await readFile(directory+'/'+name,'utf8'),sha256=createHash('sha256').update(sql).digest('hex');await client.query(sql);await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2)',[name,sha256]);records.push({name,sha256});}
    });
    expect((await legacy.pool.query('SELECT name,sha256 FROM trio_migrations.applied ORDER BY name')).rows).toEqual(records);
    return {legacy,records};
  }
  async function legacyApplications(legacy:Database,count:number) {
    const now=(await legacy.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(legacy,await seedIdentity(legacy,now),1,now),requestId=randomUUID(),executionId=randomUUID();
    const originalAsset=(await legacy.pool.query('SELECT original_asset_id FROM manga_web.results WHERE account_id=$1',[seed.accountId])).rows[0].original_asset_id;
    await legacy.transaction(async client=>{
      await client.query("INSERT INTO settings_revisions(account_id,context_id,settings_revision,contract_version,captured_settings) VALUES($1,$2,0,'synthetic-v1','{}')",[seed.accountId,seed.contextId]);
      await client.query("INSERT INTO processing_requests(account_id,request_id,context_id,context_generation,project_lineage_id,page_lineage_id,settings_revision,scope_digest,captured_scope,state,hold_reasons,mode,revision,terminal_at,terminal_evidence_ref,captured_stage_order) VALUES($1,$2,$3,1,$4,$5,0,repeat('a',64),'{}','COMPLETED','[]','FREE',0,$6,'synthetic-confirmed-terminal','[\"OCR\"]')",[seed.accountId,requestId,seed.contextId,seed.projectId,seed.pageIds[0],now]);
      await client.query("INSERT INTO request_steps(account_id,request_id,logical_step_id,execution_generation,revision,ordinal) VALUES($1,$2,'OCR',0,0,0)",[seed.accountId,requestId]);
      await client.query("INSERT INTO executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) VALUES($1,$2,$3,'OCR','synthetic-v1',repeat('b',64),'[]',0,'SUCCEEDED',0)",[seed.accountId,executionId,requestId]);
      await client.query("UPDATE request_steps SET current_execution_id=$3 WHERE account_id=$1 AND request_id=$2",[seed.accountId,requestId,executionId]);
      await client.query("INSERT INTO checkpoints(account_id,checkpoint_id,execution_id,stage_contract,dependency_digest,protected_manifest_ref,verification_state) VALUES($1,$2,$3,'synthetic-v1',repeat('b',64),$3::uuid::text,'VERIFIED')",[seed.accountId,randomUUID(),executionId]);
      for(let at=0;at<count;at++){
        const resultId=randomUUID();await client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin) VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text,'AI_APPLIED')",[seed.accountId,resultId,seed.contextId,seed.pageIds[0],at+1,originalAsset]);
        await client.query("INSERT INTO result_applications(account_id,application_id,request_id,execution_id,result_id,context_id,page_lineage_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'NOT_APPLICABLE')",[seed.accountId,randomUUID(),requestId,executionId,resultId,seed.contextId,seed.pageIds[0]]);
      }
    });
    return {seed,requestId,executionId};
  }
  it('upgrades a valid legacy application without updating business facts and keeps NULL origin semantics',async()=>{
    const {legacy,records}=await legacyDatabase(),fixture=await legacyApplications(legacy,1);
    const before=(await legacy.pool.query('SELECT to_jsonb(a) AS facts FROM manga_web.result_applications a ORDER BY application_id')).rows;
    expect(await migrate(legacy.pool)).toEqual(['0017_checkpoint_result_origin.sql','0018_operational_execution_limits.sql','0019_stage_cost_projection.sql']);expect(await migrate(legacy.pool)).toEqual([]);
    expect((await legacy.pool.query("SELECT to_jsonb(a)-'origin_request_id'-'execution_origin_request_id' AS facts FROM manga_web.result_applications a ORDER BY application_id")).rows).toEqual(before);
    expect((await legacy.pool.query('SELECT request_id,origin_request_id,execution_origin_request_id,execution_id FROM manga_web.result_applications')).rows).toEqual([{request_id:fixture.requestId,origin_request_id:null,execution_origin_request_id:fixture.requestId,execution_id:fixture.executionId}]);
    expect((await legacy.pool.query("SELECT name,sha256 FROM trio_migrations.applied WHERE name<'0017' ORDER BY name")).rows).toEqual(records);
  });
  it('holds a legacy duplicate request before schema changes and preserves both original application rows',async()=>{
    const {legacy,records}=await legacyDatabase();await legacyApplications(legacy,2);
    const before=(await legacy.pool.query('SELECT * FROM manga_web.result_applications ORDER BY application_id')).rows;expect(before).toHaveLength(2);
    await expect(migrate(legacy.pool)).rejects.toMatchObject({code:'23505',message:'CHECKPOINT_RESULT_ORIGIN_MIGRATION_HOLD_DUPLICATE_REQUEST'});
    expect((await legacy.pool.query('SELECT * FROM manga_web.result_applications ORDER BY application_id')).rows).toEqual(before);
    expect((await legacy.pool.query('SELECT name,sha256 FROM trio_migrations.applied ORDER BY name')).rows).toEqual(records);
    expect((await legacy.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='manga_web' AND table_name='result_applications' AND column_name IN ('origin_request_id','execution_origin_request_id')")).rows).toEqual([]);
    expect((await legacy.pool.query("SELECT conname FROM pg_constraint WHERE conrelid='manga_web.result_applications'::regclass AND conname='result_applications_account_id_request_id_execution_id_fkey'")).rows).toEqual([{conname:'result_applications_account_id_request_id_execution_id_fkey'}]);
    expect((await legacy.pool.query("SELECT conname FROM pg_constraint WHERE conrelid='manga_web.result_applications'::regclass AND conname IN ('one_result_application_per_request','result_application_execution_origin_fk')")).rows).toEqual([]);
  });
  it('upgrades existing OWNED profile/authority records without rewriting facts, validator or old migration bytes',async()=>{
    const {legacy,records}=await legacyDatabase(18),id=randomUUID(),start=new Date('2026-10-15T00:00:00.000Z'),end=new Date(start.valueOf()+86400000);
    const payload={kind:'OWNED_FIXTURE',version:'legacy-owned-v1',maxSlots:1,requestLimitUsd:'1',dailyLimitUsd:'2',fullBoundUsd:'1',
      stages:{OCR:{boundUsd:'1',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:legacy/ocr']}},fullBoundEvidenceRefs:['owned-fixture:legacy/full'],
      window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:start.toISOString(),endAt:end.toISOString()}};
    await legacy.pool.query("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,1,1,2,1,$4,$5,'OWNED_EXPLICIT_WINDOW',$6,$7)",
      [id,JSON.stringify(payload),payload.version,JSON.stringify(payload.stages),JSON.stringify(payload.fullBoundEvidenceRefs),start,end]);
    await legacy.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',revision=1 WHERE singleton",[id]);
    const profiles=(await legacy.pool.query('SELECT * FROM manga_web.execution_limit_profiles')).rows,authority=(await legacy.pool.query('SELECT * FROM manga_web.execution_limit_authority')).rows;
    const validator=(await legacy.pool.query("SELECT pg_get_functiondef('manga_web.validate_execution_limit_profile()'::regprocedure) AS definition")).rows;
    // The public wrapper retains its header/ACL/owner/search_path and exact
    // native body. Only the approved clock branch restores the v12 halt record.
    const wrapperQuery="SELECT p.oid::text AS id,pg_get_functiondef(p.oid) AS definition,p.prosrc AS body,p.proacl::text AS acl,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid='manga_web.reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb)'::regprocedure";
    const wrapperBefore=(await legacy.pool.query(wrapperQuery)).rows[0];
    const clockBranch="IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;";
    const haltRecord="UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE 'GLOBAL_CLOCK_UNCONFIRMED' END,revision=revision+1 WHERE singleton;";
    const restoredClockBranch=clockBranch.replace('THEN RETURN','THEN '+haltRecord+'RETURN');
    expect(wrapperBefore.body.split(clockBranch)).toHaveLength(2);
    // 0019가 변경하는 함수는 본문 보존 대상에서만 제외하고 기존 권한과 OID는 그대로 대조한다.
    const reconciliationQuery="SELECT p.oid::text AS id,p.proacl::text AS acl,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid='manga_web.reconcile_execution_limits(uuid)'::regprocedure";
    const reconciliationBefore=(await legacy.pool.query(reconciliationQuery)).rows[0];
    const preservedFunctions=(await legacy.pool.query("SELECT p.oid::text AS id,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND p.proname NOT IN ('capture_execution_limits','native_capacity_base_reserve_execution_v12','reserve_execution_limits') AND p.oid<>'manga_web.reconcile_execution_limits(uuid)'::regprocedure ORDER BY p.oid")).rows;

    expect(await migrate(legacy.pool)).toEqual(['0018_operational_execution_limits.sql','0019_stage_cost_projection.sql']);expect(await migrate(legacy.pool)).toEqual([]);
    expect((await legacy.pool.query('SELECT * FROM manga_web.execution_limit_profiles')).rows).toEqual(profiles);
    expect((await legacy.pool.query('SELECT * FROM manga_web.execution_limit_authority')).rows).toEqual(authority);
    expect((await legacy.pool.query("SELECT pg_get_functiondef('manga_web.validate_execution_limit_profile()'::regprocedure) AS definition")).rows).toEqual(validator);
    expect((await legacy.pool.query("SELECT name,sha256 FROM trio_migrations.applied WHERE name<'0018' ORDER BY name")).rows).toEqual(records);
    expect((await legacy.pool.query("SELECT p.oid::text AS id,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid=ANY($1::oid[]) ORDER BY p.oid",[preservedFunctions.map(row=>row.id)])).rows).toEqual(preservedFunctions);
    expect((await legacy.pool.query(reconciliationQuery)).rows[0]).toEqual(reconciliationBefore);
    const wrapperAfter=(await legacy.pool.query(wrapperQuery)).rows[0];
    expect(wrapperAfter.body).toBe(wrapperBefore.body.replace(clockBranch,restoredClockBranch));
    expect(wrapperAfter.definition).toBe(wrapperBefore.definition.replace(clockBranch,restoredClockBranch));
    expect({...wrapperAfter,body:wrapperBefore.body,definition:wrapperBefore.definition}).toEqual(wrapperBefore);
    for(const role of ['trio_web_api','trio_web_worker','trio_web_operator'])
      expect((await legacy.pool.query("SELECT has_function_privilege($1,'manga_web.native_capacity_base_reserve_execution_v12(uuid,uuid,bigint,uuid,jsonb)','EXECUTE') AS allowed",[role])).rows[0].allowed).toBe(false);
    expect((await legacy.pool.query('SELECT count(*) AS n FROM manga_web.operational_limit_evidence')).rows[0].n).toBe('0');
  });

});


