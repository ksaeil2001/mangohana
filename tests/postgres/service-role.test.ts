import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.doMock('sharp',()=>({default:()=>{throw new Error('W4B2_SHARP_FORBIDDEN');}}));});
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {validateServiceRole,type ServiceRole} from '../../packages/storage/src/service-role.js';
import {FileObjectStore} from '../../packages/storage/src/objects.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {createWorkerRuntime,type WorkerRuntimeOptions} from '../../apps/api/src/runtime.js';
import {testDatabase} from '../fixtures/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob} from '../../packages/native/src/dto.js';
import {decodeWindowsHostMessage,type WindowsPrepareInput,type OriginalCapture} from '../../packages/native/src/windows-job-backend.js';
import {windowsNativeScript,windowsNativeLimits,createWindowsNativeBroker,windowsNativeFixture,createWindowsNativeCostOriginalFixture,guardWindowsNativeIo,createWindowsNativeMigrationEpoch,type WindowsNativeAccountingOverrides} from '../fixtures/windows-native.js';
import {validateWindowsNativeEvidenceBundle} from '../../packages/domain/src/native-receipts.js';

const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
const identifier=(name:string)=>{if(!/^[a-z0-9_]+$/.test(name))throw Error('Unsafe generated test role');return `"${name}"`;};
const name=(prefix:string)=>`${prefix}_${randomUUID().replaceAll('-','')}`;
async function fixture(serviceRole:ServiceRole='trio_web_api') {const admin=await testDatabase();connections.push(admin);const db=await provisionLocalService(admin,serviceRole);connections.push(db);const loginRole=decodeURIComponent(new URL(db.connectionString).username);return {admin,db,loginRole,serviceRole};}

describe('read-only startup service-role validation against actual LOGIN roles',()=>{
  it('accepts only the expected API and worker LOGIN/group pairs using SELECT in a read-only transaction',async()=>{
    const f=await fixture();const worker=await provisionLocalService(f.admin,'trio_web_worker');connections.push(worker);
    await expect(f.db.validateServiceRole()).resolves.toMatchObject({sessionUser:f.loginRole,currentUser:'trio_web_api',membershipRoles:[f.loginRole,'trio_web_api'].sort()});
    await expect(worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
    const client=await f.db.pool.connect();try{await client.query('BEGIN READ ONLY');const query=vi.spyOn(client,'query');await expect(validateServiceRole(client,{serviceRole:f.serviceRole,loginRole:f.loginRole})).resolves.toMatchObject({currentUser:f.serviceRole});expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0][0]).toMatch(/^WITH RECURSIVE/);query.mockRestore();await client.query('ROLLBACK');}finally{client.release();}
  });
  it('applies the expected role to fresh connections, restores startup RESET ROLE and reselects it for each transaction',async()=>{
    const f=await fixture('trio_web_worker');const clients=await Promise.all([f.db.pool.connect(),f.db.pool.connect()]);let secondReleased=false;try{
      for(const client of clients)expect((await client.query('SELECT session_user,current_user')).rows[0]).toEqual({session_user:f.loginRole,current_user:'trio_web_worker'});
      await clients[0].query(`SET ROLE ${identifier(f.loginRole)}`);expect((await clients[0].query('SELECT current_user')).rows[0].current_user).toBe(f.loginRole);
      await clients[0].query('RESET ROLE');expect((await clients[0].query('SELECT current_user')).rows[0].current_user).toBe('trio_web_worker');
      await clients[1].query(`SET ROLE ${identifier(f.loginRole)}`);expect((await clients[1].query('SELECT current_user')).rows[0].current_user).toBe(f.loginRole);
      clients[1].release();secondReleased=true;await expect(f.db.transaction(async client=>(await client.query('SELECT current_user')).rows[0].current_user)).resolves.toBe('trio_web_worker');
    }finally{clients[0].release();if(!secondReleased)clients[1].release();}
  });
  it('rejects wrong login identity, the absence of SET ROLE and an admin login hidden behind the API group',async()=>{
    const f=await fixture();await expect(f.db.validateServiceRole({serviceRole:'trio_web_api',loginRole:'unexpected_login'})).rejects.toMatchObject({code:'SERVICE_ROLE_IDENTITY_MISMATCH'});
    const unselected=new Database(f.db.connectionString);connections.push(unselected);await expect(unselected.validateServiceRole({serviceRole:'trio_web_api',loginRole:f.loginRole})).rejects.toMatchObject({code:'SERVICE_ROLE_IDENTITY_MISMATCH'});
    const maskedAdmin=new Database(f.admin.connectionString,undefined,'trio_web_api');connections.push(maskedAdmin);await expect(maskedAdmin.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FLAGS_UNSAFE'});
  });
  it('rejects direct API membership in the opposite worker service group',async()=>{const f=await fixture();await f.admin.pool.query(`GRANT trio_web_worker TO ${identifier(f.loginRole)}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_CROSS_MEMBERSHIP'});});
  it.each(['trio_web_api','trio_web_worker'] as const)('rejects RLS-bypassing TRUNCATE drift granted to %s without changing the operator grant',async role=>{const f=await fixture(role);await f.admin.pool.query(`GRANT TRUNCATE ON manga_web.execution_evidence TO ${role}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});expect((await f.db.pool.query("SELECT has_table_privilege(current_user,'manga_web.execution_evidence','TRUNCATE') AS allowed")).rows[0].allowed).toBe(true);});
  it.each(['trio_web_api','trio_web_worker'] as const)('includes new render hold tables in the forbidden TRUNCATE check for %s',async role=>{const f=await fixture(role);await f.admin.pool.query(`GRANT TRUNCATE ON manga_web.result_render_holds TO ${role}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});});
  it('traverses indirect membership even when INHERIT and SET are disabled on the first edge',async()=>{const f=await fixture();const bridge=name('role_bridge');await f.admin.pool.query(`CREATE ROLE ${identifier(bridge)} NOLOGIN`);await f.admin.pool.query(`GRANT trio_web_worker TO ${identifier(bridge)}`);await f.admin.pool.query(`GRANT ${identifier(bridge)} TO ${identifier(f.loginRole)} WITH INHERIT FALSE, SET FALSE`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_CROSS_MEMBERSHIP'});});
  it('rejects a superuser reachable through an indirect role path',async()=>{const f=await fixture('trio_web_worker');const bridge=name('role_bridge');const privileged=name('role_privileged');await f.admin.pool.query(`CREATE ROLE ${identifier(bridge)} NOLOGIN`);await f.admin.pool.query(`CREATE ROLE ${identifier(privileged)} NOLOGIN SUPERUSER`);await f.admin.pool.query(`GRANT ${identifier(privileged)} TO ${identifier(bridge)}`);await f.admin.pool.query(`GRANT ${identifier(bridge)} TO ${identifier(f.loginRole)}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FLAGS_UNSAFE'});});
  it.each(['SUPERUSER','BYPASSRLS','CREATEDB','CREATEROLE','REPLICATION'])('rejects a LOGIN role with %s',async flag=>{const f=await fixture();await f.admin.pool.query(`ALTER ROLE ${identifier(f.loginRole)} ${flag}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FLAGS_UNSAFE'});});
  it('requires the selected service group to remain NOLOGIN',async()=>{const f=await fixture();await f.admin.pool.query('ALTER ROLE trio_web_api LOGIN');try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FLAGS_UNSAFE'});}finally{await f.admin.pool.query('ALTER ROLE trio_web_api NOLOGIN');}});
  it.each(['pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program'])('rejects privileged %s membership',async role=>{const f=await fixture('trio_web_worker');await f.admin.pool.query(`GRANT ${identifier(role)} TO ${identifier(f.loginRole)}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_PRIVILEGED_MEMBERSHIP'});});
  it('rejects an unnecessary otherwise harmless SET ROLE target',async()=>{const f=await fixture();const extra=name('role_extra');await f.admin.pool.query(`CREATE ROLE ${identifier(extra)} NOLOGIN`);await f.admin.pool.query(`GRANT ${identifier(extra)} TO ${identifier(f.loginRole)}`);expect((await f.db.pool.query("SELECT pg_has_role(session_user,$1,'SET') AS allowed",[extra])).rows[0].allowed).toBe(true);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_UNEXPECTED_MEMBERSHIP'});});
  it('rejects ADMIN OPTION on its required service membership',async()=>{const f=await fixture();await f.admin.pool.query(`GRANT trio_web_api TO ${identifier(f.loginRole)} WITH ADMIN OPTION`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_ADMIN_OPTION'});});
  it.each(['SCHEMA','TABLE','FUNCTION'] as const)('rejects service LOGIN ownership of a %s',async kind=>{
    const f=await fixture();const object=name('role_owned');if(kind==='SCHEMA')await f.admin.pool.query(`CREATE SCHEMA ${identifier(object)} AUTHORIZATION ${identifier(f.loginRole)}`);
    if(kind==='TABLE'){await f.admin.pool.query(`CREATE TABLE public.${identifier(object)}(id integer)`);await f.admin.pool.query(`ALTER TABLE public.${identifier(object)} OWNER TO ${identifier(f.loginRole)}`);}
    if(kind==='FUNCTION'){await f.admin.pool.query(`CREATE FUNCTION public.${identifier(object)}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);await f.admin.pool.query(`ALTER FUNCTION public.${identifier(object)}() OWNER TO ${identifier(f.loginRole)}`);}
    await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_OWNERSHIP'});
  });
  it('rejects schema CREATE privileges without silently changing the grant',async()=>{const f=await fixture();await f.admin.pool.query(`GRANT CREATE ON SCHEMA manga_web TO ${identifier(f.loginRole)}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_CREATE_PRIVILEGE'});expect((await f.db.pool.query("SELECT has_schema_privilege(session_user,'manga_web','CREATE') AS allowed")).rows[0].allowed).toBe(true);});
  it('rejects direct secret-column grants while preserving the existing grant for the operator to inspect',async()=>{const f=await fixture('trio_web_worker');await f.admin.pool.query(`GRANT SELECT(cookie_digest) ON manga_web.app_sessions TO ${identifier(f.loginRole)}`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_DIRECT_PRIVILEGES'});expect((await f.db.pool.query("SELECT has_column_privilege(session_user,'manga_web.app_sessions','cookie_digest','SELECT') AS allowed")).rows[0].allowed).toBe(true);});
  it.each([
    ['trio_web_api','UPDATE(balance_credit) ON manga_web.accounts'],
    ['trio_web_api','UPDATE(free_started_count) ON manga_web.accounts'],
    ['trio_web_api','INSERT ON manga_web.executions'],
    ['trio_web_api','UPDATE(state) ON manga_web.executions'],
    ['trio_web_api','UPDATE(actual_usd) ON manga_web.cost_items'],
    ['trio_web_api','INSERT ON manga_web.settlements'],
    ['trio_web_worker','SELECT(cookie_digest) ON manga_web.app_sessions'],
    ['trio_web_worker','SELECT(csrf_digest) ON manga_web.app_sessions'],
    ['trio_web_worker','SELECT(protected_intent) ON manga_web.auth_attempts'],
    ['trio_web_worker','SELECT ON manga_web.auth_evidence'],
    ['trio_web_worker','SELECT ON manga_web.signing_verifiers'],
    ['trio_web_worker','UPDATE(credit_delta) ON manga_web.ledger_entries'],
    ['trio_web_worker','EXECUTE ON FUNCTION manga_web.resolve_session(text)'],
    ['trio_web_worker','EXECUTE ON FUNCTION manga_web.export_build_scan(timestamptz)'],
    ['trio_web_worker','SELECT ON manga_web.export_builds'],
    ['trio_web_worker','UPDATE(lease_until) ON manga_web.export_builds'],
    ['trio_web_worker','SELECT(sha256) ON manga_web.export_build_candidates'],
    ['trio_web_worker','INSERT ON manga_web.export_build_candidates'],
    ['trio_web_api','UPDATE(sha256) ON manga_web.export_build_candidates'],
    ['trio_web_api','DELETE ON manga_web.export_build_candidates'],
    ['trio_web_api','EXECUTE ON FUNCTION manga_web.dispatch_candidates()'],
    ['trio_web_api','SELECT ON manga_web.operational_limit_evidence'],
    ['trio_web_worker','SELECT ON manga_web.operational_limit_evidence'],
    ['trio_web_api','INSERT ON manga_web.operational_limit_evidence'],
    ['trio_web_worker','UPDATE(reviewed_by) ON manga_web.operational_limit_evidence'],
    ['trio_web_api','TRUNCATE ON manga_web.operational_limit_evidence'],
    ['trio_web_worker','DELETE ON manga_web.operational_limit_evidence'],
    ['trio_web_api','EXECUTE ON FUNCTION manga_web.operational_limit_measurement(jsonb)'],
    ['trio_web_worker','EXECUTE ON FUNCTION manga_web.operational_execution_limit_valid(manga_web.execution_limit_profiles)'],
    ['trio_web_api','EXECUTE ON FUNCTION manga_web.validate_operational_limit_evidence()'],
    ['trio_web_worker','EXECUTE ON FUNCTION manga_web.validate_operational_execution_limit_profile()']
  ] as const)('rejects forbidden %s group privilege: %s',async(serviceRole,grant)=>{
    const f=await fixture(serviceRole);await f.admin.pool.query(`GRANT ${grant} TO ${serviceRole}`);try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query(`REVOKE ${grant} FROM ${serviceRole}`);}
    await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:serviceRole});
  });
  it('constructs and runs worker-only services without any API, auth or signing option',async()=>{
    const f=await fixture('trio_web_worker');const options:WorkerRuntimeOptions={worker:f.db,objects:new FileObjectStore(await mkdtemp(path.join(tmpdir(),'trio-worker-factory-')),syntheticProfile.maxZipBytes),fonts:await FontCatalog.load(),profile:syntheticProfile,policy:{stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:true,paidEnabled:false,realProviderEnabled:false},provider:new SyntheticProvider()};
    const guarded=new Proxy(options,{get(target,key,receiver){if(['api','authProvider','signer','allowedAccounts','limiterSecret'].includes(String(key)))throw Error('Worker referenced an API-only option');return Reflect.get(target,key,receiver);}});const worker=createWorkerRuntime(guarded);expect(Object.keys(worker.options).sort()).toEqual(['fonts','objects','policy','profile','provider','worker']);expect(Object.keys(worker)).not.toContain('auth');expect(Object.keys(worker)).not.toContain('files');expect(Object.keys(worker)).not.toContain('workspace');await expect(worker.tick()).resolves.toBeUndefined();await expect(worker.maintenance()).resolves.toBeUndefined();await expect(worker.idle()).resolves.toBeUndefined();
  });
});


const operationalHelpers=["operational_limit_object(jsonb,text[])","operational_limit_decimal(jsonb,boolean)","operational_limit_uuid(jsonb)","operational_limit_refs(jsonb)","operational_limit_timestamp(jsonb)","operational_limit_identity(jsonb)","operational_limit_window(jsonb)","operational_limit_measurement(jsonb)","operational_execution_limit_valid(manga_web.execution_limit_profiles)","validate_operational_limit_evidence()","validate_operational_execution_limit_profile()"] as const;

describe('operational execution limit grants on actual service LOGINs',()=>{
  it.each(['trio_web_api','trio_web_worker'] as const)('rejects every internal helper EXECUTE grant to %s and preserves grants for operator inspection',async role=>{
    const f=await fixture(role);
    for(const helper of operationalHelpers){
      await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.'+helper+' TO '+role);
      try{
        await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
        expect((await f.db.pool.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",['manga_web.'+helper])).rows[0].allowed).toBe(true);
      }finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.'+helper+' FROM '+role);}
      await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
    }
  });
  it.each(['trio_web_api','trio_web_worker'] as const)('rejects PUBLIC reader EXECUTE drift for %s without changing the grant',async role=>{
    const f=await fixture(role);await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.read_operational_execution_limit(jsonb) TO PUBLIC');
    try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}
    finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.read_operational_execution_limit(jsonb) FROM PUBLIC');}
    await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
  });
});


const windowsPrivateFunctions=[
  "windows_native_offer(jsonb)",
  "windows_native_capture(jsonb,text,text)",
  "windows_native_current(jsonb)",
  "windows_native_ready(jsonb,text)",
  "windows_native_grant_go(jsonb)",
  "windows_native_append(jsonb,text,text)",
  "windows_native_event(jsonb,uuid)",
  "windows_native_scan(jsonb,integer)",
  "windows_native_record(jsonb,text,uuid,text)",
  "windows_native_finish(jsonb,text)",
  "windows_native_link(jsonb,uuid,text,text)",
  "windows_native_read(jsonb)",
  "windows_native_canonical(jsonb,integer)",
  "windows_native_hash(jsonb)",
  "windows_native_parse(text,integer)",
  "windows_native_object(jsonb,text[])",
  "windows_native_context(jsonb)",
  "windows_native_scope(jsonb)",
  "windows_native_basis(uuid,uuid,jsonb)",
  "windows_native_go_ref(uuid,uuid)",
  "windows_native_store(jsonb,text,uuid,text)",
  "windows_native_facts(uuid,uuid)",
  "windows_native_link_body(uuid,uuid)",
  "windows_native_view(uuid,uuid)",
  "windows_native_capacity_go_ready(uuid,uuid,uuid,text,jsonb)",
  "windows_native_reference(uuid,jsonb)",
  "native_capacity_windows_profile_valid(jsonb)",
  "native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text)",
  "native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid)",
  "native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid)",
  "native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid)",
  "native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text)",
  "native_job_observation_owned_v16(uuid,jsonb,text)",
  "native_controller_snapshot_v16(uuid,uuid)",
  "native_job_unresolved_v13(text)",
  "native_receipt_windows_job(uuid)",
  "native_receipt_windows_raw_valid(uuid,jsonb,text,text,jsonb)",
  "native_receipt_windows_candidate_valid(jsonb)",
  "native_receipt_windows_receipt_valid(jsonb,jsonb)",
  "native_receipt_prepare_v1_14(jsonb,jsonb)",
  "native_receipt_verify_v1_14(uuid,jsonb,jsonb)",
  "native_receipt_lookup_v1_14(jsonb)",
  "native_receipt_register_asset_v1_14(uuid,text,jsonb,text,jsonb)",
  "native_receipt_prepare_windows_v2(jsonb,jsonb)",
  "native_receipt_verify_windows_v2(uuid,jsonb,jsonb)",
  "native_receipt_lookup_windows_v2(jsonb)",
  "native_receipt_register_asset_windows_v2(uuid,text,jsonb,text,jsonb)",
  "windows_native_shape(jsonb,jsonb)",
  "windows_native_win_value(text,jsonb)",
  "windows_native_fact_valid(jsonb)",
  "windows_native_accounting_valid(jsonb)",
  "windows_native_source_valid(uuid,uuid,jsonb,jsonb)",
  "windows_native_seal_valid(uuid,uuid,jsonb)",
  "windows_native_owner_current(jsonb)"
] as const;
describe('W3-A Windows 원자료 역할 경계',()=>{
  it.each(['trio_web_api','trio_web_worker'] as const)('%s의 원자료 직접 권한과 모든 private EXECUTE 누출을 거부한다',async role=>{
    const f=await fixture(role);await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
    for(const table of ['windows_native_origins','windows_native_events','windows_native_records','windows_native_links']){
      await expect(f.db.pool.query('SELECT * FROM manga_web.'+table+' LIMIT 1')).rejects.toMatchObject({code:'42501'});
      for(const privilege of ['SELECT','INSERT','UPDATE','DELETE']){
        await f.admin.pool.query('GRANT '+privilege+' ON manga_web.'+table+' TO '+role);
        try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}
        finally{await f.admin.pool.query('REVOKE '+privilege+' ON manga_web.'+table+' FROM '+role);}
      }
      await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
    }
    for(const fn of windowsPrivateFunctions){
      expect((await f.db.pool.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",['manga_web.'+fn])).rows[0].allowed).toBe(false);
      await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.'+fn+' TO '+role);
      try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}
      finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.'+fn+' FROM '+role);}
    }
    await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
  });
  it.each(['trio_web_api','trio_web_worker'] as const)('%s에서 owning reader의 PUBLIC 권한과 FORCE RLS 유실을 거부한다',async role=>{
    const f=await fixture(role);await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.windows_native_lookup(jsonb) TO PUBLIC');
    try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}
    finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.windows_native_lookup(jsonb) FROM PUBLIC');}
    await f.admin.pool.query('ALTER TABLE manga_web.windows_native_events NO FORCE ROW LEVEL SECURITY');
    try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}
    finally{await f.admin.pool.query('ALTER TABLE manga_web.windows_native_events FORCE ROW LEVEL SECURITY');}
    await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
  });
});

describe('W4-B1 cost owner capability ACL',()=>{
 it('W4-B1 accepts original API/worker startup with all scoped capabilities and no protected table reads',async()=>{
  const f=await fixture('trio_web_worker');await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
  const api=await provisionLocalService(f.admin,'trio_web_api');connections.push(api);await expect(api.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_api'});
  const privileges=(await f.admin.pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND c.relkind='r' AND relname LIKE 'windows_native_cost_%' AND(has_table_privilege('trio_web_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('trio_web_api',c.oid,'SELECT,INSERT,UPDATE,DELETE'))")).rows;expect(privileges).toEqual([]);
 });
 it.each(['windows_native_cost_enroll_input(jsonb)','windows_native_cost_activate(jsonb,jsonb)','windows_native_cost_begin(jsonb,jsonb)',
  'windows_native_cost_register_call(uuid,jsonb)','windows_native_cost_admit(uuid,jsonb,jsonb,text)','windows_native_cost_join(uuid,jsonb)','windows_native_cost_lookup(jsonb,integer)',
  'windows_native_cost_receipt_lookup(uuid,jsonb)','windows_native_cost_receipt_prepare(uuid,jsonb,jsonb)','windows_native_cost_receipt_register_asset(uuid,uuid,text,jsonb,text,jsonb)','windows_native_cost_receipt_verify(uuid,uuid,jsonb,jsonb)',
  'windows_native_cost_io_begin(jsonb)','windows_native_cost_io_end(jsonb)','windows_native_cost_io_lookup(jsonb)','windows_native_cost_cache_use(uuid,jsonb)',
  'windows_native_cost_authorize_result_query(uuid,jsonb)','windows_native_cost_finish_result_query(uuid,jsonb,jsonb)'])('W4-B1 rejects a missing required worker entrypoint %s',async signature=>{
  const f=await fixture('trio_web_worker');await f.admin.pool.query(`REVOKE EXECUTE ON FUNCTION manga_web.${signature} FROM trio_web_worker`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
 });
 it.each(['windows_native_cost_lock_call(uuid,boolean)','windows_native_cost_native_capacity_create_intent_core(jsonb,boolean,jsonb)','windows_native_cost_claim_result_query(jsonb,uuid,text,jsonb)','windows_native_cost_controller_io_end(jsonb,uuid,text,jsonb,jsonb)'])('W4-B1 rejects a leaked private/controller function %s',async signature=>{
  const f=await fixture('trio_web_worker');await f.admin.pool.query(`GRANT EXECUTE ON FUNCTION manga_web.${signature} TO trio_web_worker`);await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
 });
 it('W4-B1 rejects protected column-only reads and API cost capability grants',async()=>{
  const f=await fixture('trio_web_worker');await f.admin.pool.query('GRANT SELECT(protected_scope) ON manga_web.windows_native_cost_scopes TO trio_web_worker');await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
  await f.admin.pool.query('REVOKE SELECT(protected_scope) ON manga_web.windows_native_cost_scopes FROM trio_web_worker');await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
  const api=await provisionLocalService(f.admin,'trio_web_api');connections.push(api);await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.windows_native_cost_begin(jsonb,jsonb) TO trio_web_api');await expect(api.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
 });
});
it('W4-B1 refuses FORCE RLS and PUBLIC helper privilege drift without repairing it',async()=>{
 const f=await fixture('trio_web_worker');await f.admin.pool.query('ALTER TABLE manga_web.windows_native_cost_io_starts NO FORCE ROW LEVEL SECURITY');await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});
 await f.admin.pool.query('ALTER TABLE manga_web.windows_native_cost_io_starts FORCE ROW LEVEL SECURITY');await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.windows_native_cost_raw_context(jsonb,uuid,text,jsonb,boolean) TO PUBLIC');
 await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});expect((await f.admin.pool.query("SELECT has_function_privilege('trio_web_api','manga_web.windows_native_cost_raw_context(jsonb,uuid,text,jsonb,boolean)','EXECUTE') AS leaked")).rows).toEqual([{leaked:true}]);
});
it('W4-B1 scope-end metadata arithmetic for 127 128 129 refs stays inside 32KiB',async()=>{
 const f=await fixture('trio_web_worker');
 for(const [count,expectedBytes] of [[127,18278],[128,18420],[129,18562]]){
  const ending={version:1,scopeId:randomUUID(),scopeDigest:'a'.repeat(64),eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:Array.from({length:count},()=>({evidenceId:randomUUID(),evidenceDigest:'b'.repeat(64)}))};
  const actual=(await f.admin.pool.query('SELECT octet_length($1::jsonb::text)::integer AS bytes',[JSON.stringify(ending)])).rows[0];
  expect(actual.bytes).toBe(expectedBytes);expect(actual.bytes).toBeLessThanOrEqual(32768);console.info(JSON.stringify({w4b1ScopeEndMetadata:{refs:count,sqlBytes:actual.bytes,evidence:'metadata-width-only; actual join unverified'}}));
 }
});

function accountingInput():WindowsPrepareInput{
 const blobs=new Map([['source',Buffer.from('W4-B2 synthetic accounting input')]]),job=createNativeJob('DECODE_IMAGE',sha256('w4b2 profile'),{},blobs,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
 const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
 return {identity:{binding:{accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:sha256('w4b2 kernel')},intentDigest:sha256('w4b2 intent'),sourceInput:{executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('w4b2 input')},inputEvidenceDigest:sha256('w4b2 input record'),inputFingerprint:sha256('w4b2 fingerprint'),basisRef:null},authority:{attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:'w4b2-fixture',keyVersion:'key-v1',environmentDigest:sha256('w4b2 environment'),hostEpochId:randomUUID(),sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:sha256('w4b2 controller'),childSidDigest:sha256('w4b2 child'),appContainerSidDigest:sha256('w4b2 appcontainer')},pins:{executableDigest:sha256('w4b2 node'),bootstrapDigest:sha256('w4b2 bootstrap'),helperRuntimeDigest:sha256('w4b2 python'),helperScriptDigest:sha256('w4b2 helper'),runtimeFilesDigest:sha256('w4b2 runtime'),nativeLimitsDigest:digest(windowsNativeLimits)},policy,limits:windowsNativeLimits,frame:{envelope:job,blobs}};
}
function accountingSource(script:ReturnType<typeof windowsNativeScript>){
 const row=script.entries.find(row=>row.event.kind==='FINAL_ACCOUNTING');expect(row).toBeDefined();
 const source=(api:string,informationClass?:string)=>{
  const fact=row!.source.facts.find(fact=>fact.kind==='WIN32'&&fact.api===api&&(informationClass===undefined||(fact.value as {informationClass:string}).informationClass===informationClass));expect(fact?.kind).toBe('WIN32');
  return (fact as Extract<typeof fact,{kind:'WIN32'}>).value as Record<string,unknown>;
 };
 return {row:row!,source};
}
function expectAccountingSource(script:ReturnType<typeof windowsNativeScript>,overrides:WindowsNativeAccountingOverrides){
 const evidence=script.evidence(),accounting=evidence.final.accounting!;expect(accounting).toMatchObject(overrides);
 const {row,source}=accountingSource(script),basic=source('QueryInformationJobObject','BASIC_AND_IO').values as {BasicInfo:Record<string,unknown>;IoInfo:Record<string,unknown>},extended=source('QueryInformationJobObject','EXTENDED_LIMITS').values;
 expect(row.event.payload).toEqual({accounting});
 expect(basic.BasicInfo).toMatchObject({TotalUserTime:accounting.userTime100ns,TotalKernelTime:accounting.kernelTime100ns,ThisPeriodTotalUserTime:accounting.userTime100ns,ThisPeriodTotalKernelTime:accounting.kernelTime100ns,TotalProcesses:Number(accounting.totalProcesses),TotalTerminatedProcesses:Number(accounting.totalProcesses)});
 const io={ReadOperationCount:accounting.readOperations,WriteOperationCount:accounting.writeOperations,OtherOperationCount:accounting.otherOperations,ReadTransferCount:accounting.readBytes,WriteTransferCount:accounting.writeBytes,OtherTransferCount:accounting.otherBytes};
 expect(basic.IoInfo).toEqual(io);expect(extended).toMatchObject({IoInfo:io,PeakProcessMemoryUsed:accounting.peakProcessMemoryBytes,PeakJobMemoryUsed:accounting.peakJobMemoryBytes});
 expect(source('QueryPerformanceFrequency')).toEqual({frequency:accounting.qpcFrequency});expect(source('QueryPerformanceCounter')).toEqual({ticks:accounting.endQpcTicks});
 expect(evidence.lifecycle.events.find(event=>event.kind==='CREATED_SUSPENDED')?.qpcTicks).toBe(accounting.startQpcTicks);expect(row.event.qpcTicks).toBe(accounting.endQpcTicks);
 for(const [index,entry] of script.entries.entries()){
  const {payloadDigest,...body}=entry.event;expect(payloadDigest).toBe(digest(body));expect(entry.sourceDigest).toBe(digest(entry.source));expect(entry.event.previousDigest).toBe(index?script.entries[index-1].event.payloadDigest:null);
  const message={version:1,requestId:randomUUID(),originDigest:script.originDigest,attemptId:evidence.authority.attemptId,sessionId:evidence.authority.sessionId,launchId:evidence.authority.launchId,message:'EVENT',payload:entry},bytes=Buffer.from(JSON.stringify(message)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(bytes.length);
  expect(decodeWindowsHostMessage(Buffer.concat([prefix,bytes]))).toEqual(message);
 }
 expect(script.seal().evidence).toEqual(evidence);
}
describe('W4-B2 fixture 원 accounting source',()=>{
 it.each([{userTime100ns:'9007199254740995',kernelTime100ns:'0'},{userTime100ns:'18446744073709551615',kernelTime100ns:'18446744073709551615'},{userTime100ns:'0',kernelTime100ns:'0'}])('W4-B2 fixture preserves exact CPU decimal strings in raw sources: %j',overrides=>{
  const guard=guardWindowsNativeIo();try{const input=accountingInput(),script=windowsNativeScript(input,'CREATED',overrides);script.complete({jobId:input.frame.envelope.jobId,rowDigest:sha256('w4b2 original GO')});expectAccountingSource(script,overrides);expect(script.evidence().final.accounting).toMatchObject({readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0'});expect(guard.denied).toEqual([]);}finally{guard.restore();}
 });
 it('W4-B2 fixture composes memory IO and QPC overrides before the original source chain',()=>{
  const guard=guardWindowsNativeIo();try{
   const input=accountingInput(),overrides={userTime100ns:'9007199254740995',kernelTime100ns:'18446744073709551615',peakJobMemoryBytes:'32768',peakProcessMemoryBytes:'12288',readOperations:'7',writeOperations:'9',otherOperations:'11',readBytes:'1234',writeBytes:'5678',otherBytes:'90',totalProcesses:'3',startQpcTicks:'1120',endQpcTicks:'1222',qpcFrequency:'10000019'},script=windowsNativeScript(input,'CREATED',overrides);
   script.complete({jobId:input.frame.envelope.jobId,rowDigest:sha256('w4b2 original GO')});expectAccountingSource(script,overrides);expect(guard.denied).toEqual([]);
  }finally{guard.restore();}
 });
 it('W4-B2 fixture forwards accounting through the synthetic broker without creating a child',async()=>{
  const guard=guardWindowsNativeIo();try{
   const input=accountingInput(),accounting={userTime100ns:'18446744073709551615',kernelTime100ns:'18446744073709551615'},host=createWindowsNativeBroker(input,{accounting}),{frame,...origin}=input,capture:OriginalCapture={origin,originDigest:digest({identity:input.identity,authority:input.authority,pins:input.pins,policy:input.policy,nativeLimitsDigest:digest(input.limits),frameInputDigest:frame.envelope.inputDigest}),frameInputDigest:frame.envelope.inputDigest,launchRef:randomUUID()},session=await host.broker.open(capture);
   try{host.script!.complete({jobId:frame.envelope.jobId,rowDigest:sha256('w4b2 original GO')});expectAccountingSource(host.script!,accounting);}
   finally{await session.send({version:1,requestId:randomUUID(),originDigest:capture.originDigest,attemptId:input.authority.attemptId,sessionId:input.authority.sessionId,launchId:input.authority.launchId,command:'STOP',payload:{reason:'CALLER_ABORT'}});}
   expect(host.failures).toEqual([]);expect(guard.denied).toEqual([]);
  }finally{guard.restore();}
 });
 it('W4-B2 fixture keeps original defaults and does not invent accounting for no-create or unknown',()=>{
  const guard=guardWindowsNativeIo();try{
   const input=accountingInput(),script=windowsNativeScript(input);script.complete({jobId:input.frame.envelope.jobId,rowDigest:sha256('w4b2 original GO')});expectAccountingSource(script,{userTime100ns:'9007199254740993',kernelTime100ns:'300',startQpcTicks:'120',endQpcTicks:'210',qpcFrequency:'10000000'});
   for(const mode of ['NOT_ATTEMPTED','UNKNOWN'] as const){const absent=windowsNativeScript(input,mode,{userTime100ns:'18446744073709551615'});expect(absent.evidence().final.accounting).toBeNull();expect(absent.entries.some(row=>row.event.kind==='FINAL_ACCOUNTING')).toBe(false);}
   expect(guard.denied).toEqual([]);
  }finally{guard.restore();}
 });
});

const stageCostPublic=['windows_stage_cost_project(jsonb,jsonb,jsonb,jsonb)','windows_stage_cost_seal(jsonb,jsonb)','windows_stage_cost_lookup(jsonb,integer)'] as const;
const stageCostTables="SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND c.relkind IN('r','p') AND pg_catalog.starts_with(c.relname,'windows_stage_cost_') ORDER BY c.relname";
const stageCostFunctions="SELECT p.oid,'manga_web.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' AS signature,p.oid=ANY(ARRAY[pg_catalog.to_regprocedure('manga_web.windows_stage_cost_project(jsonb,jsonb,jsonb,jsonb)'),pg_catalog.to_regprocedure('manga_web.windows_stage_cost_seal(jsonb,jsonb)'),pg_catalog.to_regprocedure('manga_web.windows_stage_cost_lookup(jsonb,integer)')]) AS public FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND pg_catalog.starts_with(p.proname,'windows_stage_cost_') ORDER BY p.oid";
describe('W4-B2 stage cost capability ACL',()=>{
 let guard:ReturnType<typeof guardWindowsNativeIo>;
 beforeEach(()=>{guard=guardWindowsNativeIo();});
 afterEach(()=>{try{expect(guard.denied).toEqual([]);console.info(JSON.stringify({w4b2AclGuard:{denied:guard.denied}}));}finally{guard.restore();}});
 it('W4-B2 requires actual non-NULL public3 capabilities in the migrated database',async()=>{
   const f=await fixture('trio_web_worker');
   for(const signature of stageCostPublic){const actual=(await f.admin.pool.query('SELECT pg_catalog.to_regprocedure($1)::text AS actual',['manga_web.'+signature])).rows[0].actual;expect(actual,'W4-B2 public3 capability is absent: '+signature).not.toBeNull();}
   await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
   const tables=(await f.admin.pool.query(stageCostTables)).rows;expect(tables.length).toBeGreaterThan(0);expect(tables.map(row=>row.relname)).toContain('windows_stage_cost_owners');
   const functions=(await f.admin.pool.query(stageCostFunctions)).rows;expect(functions.filter(row=>row.public)).toHaveLength(3);expect(functions.some(row=>!row.public)).toBe(true);
   for(const fn of functions)for(const role of ['trio_web_worker','trio_web_api','trio_web_controller'])expect((await f.admin.pool.query("SELECT pg_catalog.has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",[role,fn.oid])).rows[0].allowed,role+' '+fn.signature).toBe(role==='trio_web_worker'&&fn.public);
 });
 it.each([{userTime100ns:'9007199254740995',kernelTime100ns:'0'},{userTime100ns:'18446744073709551615',kernelTime100ns:'18446744073709551615'}])('W4-B2 original fixture signs and validates exact wide accounting from raw OS sources: %j',async accounting=>{
  const f=await windowsNativeFixture();try{
   const original=await createWindowsNativeCostOriginalFixture(f,{mode:'CREATED',accounting}),bundle=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_native_evidence_lookup($1::jsonb) AS bundle',[JSON.stringify(original.key)])).rows[0].bundle,true),facts=validateWindowsNativeEvidenceBundle(bundle,original.key,'trio_web_worker');
   expect(facts.accounting?.value).toMatchObject(accounting);expectAccountingSource(original.script,accounting);expect(facts.link.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);expect(f.provider.calls).toEqual([]);
  }finally{await f.close();}
 });
 it.each(stageCostPublic)('W4-B2 rejects REVOKE of required exact worker signature %s',async signature=>{
  const f=await fixture('trio_web_worker');await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.'+signature+' FROM trio_web_worker');
  try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.'+signature+' TO trio_web_worker');}
  await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
 });
 it.each(['trio_web_worker','trio_web_api'] as const)('W4-B2 checks every protected table and column-only grant for %s',async role=>{
  const f=await fixture(role),tables=(await f.admin.pool.query(stageCostTables)).rows;expect(tables.length).toBeGreaterThan(0);
  for(const table of tables){
   expect(table).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});await expect(f.db.pool.query('SELECT * FROM manga_web.'+identifier(table.relname)+' LIMIT 1')).rejects.toMatchObject({code:'42501'});
   for(const actor of ['trio_web_worker','trio_web_api','trio_web_controller'])expect((await f.admin.pool.query("SELECT pg_catalog.has_table_privilege($1,$2::oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege($1,$2::oid,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed",[actor,table.oid])).rows[0].allowed).toBe(false);
   for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
    await f.admin.pool.query('GRANT '+privilege+' ON manga_web.'+identifier(table.relname)+' TO '+role);
    try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('REVOKE '+privilege+' ON manga_web.'+identifier(table.relname)+' FROM '+role);}
   }
   const columns=(await f.admin.pool.query('SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table.oid])).rows;
   for(const column of columns)for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']){
    const grant=privilege+'('+identifier(column.attname)+') ON manga_web.'+identifier(table.relname);await f.admin.pool.query('GRANT '+grant+' TO '+role);
    try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});expect((await f.admin.pool.query('SELECT has_column_privilege($1,$2::oid,$3,$4) AS allowed',[role,table.oid,column.attname,privilege])).rows[0].allowed).toBe(true);}finally{await f.admin.pool.query('REVOKE '+grant+' FROM '+role);}
   }
   await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
  }
 },120000);
 it.each(['trio_web_worker','trio_web_api'] as const)('W4-B2 rejects every leaked private helper for %s without repairing the grant',async role=>{
  const f=await fixture(role),functions=(await f.admin.pool.query(stageCostFunctions)).rows.filter(row=>!row.public);expect(functions.length).toBeGreaterThan(0);
  for(const fn of functions){await f.admin.pool.query('GRANT EXECUTE ON FUNCTION '+fn.signature+' TO '+role);try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});expect((await f.admin.pool.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",[role,fn.oid])).rows[0].allowed).toBe(true);}finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION '+fn.signature+' FROM '+role);}}
  await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
 });
 it.each(['trio_web_worker','trio_web_api'] as const)('W4-B2 rejects PUBLIC function leakage and RLS/FORCE RLS loss for %s',async role=>{
  const f=await fixture(role),functions=(await f.admin.pool.query(stageCostFunctions)).rows,tables=(await f.admin.pool.query(stageCostTables)).rows;expect(functions.length).toBeGreaterThanOrEqual(3);expect(tables.length).toBeGreaterThan(0);
  for(const fn of functions){await f.admin.pool.query('GRANT EXECUTE ON FUNCTION '+fn.signature+' TO PUBLIC');try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION '+fn.signature+' FROM PUBLIC');}}
  for(const table of tables)for(const toggle of ['FORCE ROW LEVEL SECURITY','ENABLE ROW LEVEL SECURITY']){
   const undo=toggle==='FORCE ROW LEVEL SECURITY'?'NO FORCE ROW LEVEL SECURITY':'DISABLE ROW LEVEL SECURITY';await f.admin.pool.query('ALTER TABLE manga_web.'+identifier(table.relname)+' '+undo);
   try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('ALTER TABLE manga_web.'+identifier(table.relname)+' '+toggle);}
  }
  await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:role});
 });
 it.each(['trio_web_api','trio_web_controller'] as const)('W4-B2 worker startup rejects public3 grants to %s',async role=>{
  const f=await fixture('trio_web_worker');for(const signature of stageCostPublic){await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.'+signature+' TO '+role);try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.'+signature+' FROM '+role);}}
  await expect(f.db.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
 });
 it('W4-B2 rejects API capability drift and a worker overload with the same public function name',async()=>{
  const f=await fixture('trio_web_api');for(const signature of stageCostPublic){await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.'+signature+' TO trio_web_api');try{await expect(f.db.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.'+signature+' FROM trio_web_api');}}
  const worker=await provisionLocalService(f.admin,'trio_web_worker');connections.push(worker);await f.admin.pool.query("CREATE FUNCTION manga_web.windows_stage_cost_lookup(jsonb,text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS 'SELECT $1'");
  try{await f.admin.pool.query('REVOKE ALL ON FUNCTION manga_web.windows_stage_cost_lookup(jsonb,text) FROM PUBLIC');await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.windows_stage_cost_lookup(jsonb,text) TO trio_web_worker');await expect(worker.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});}finally{await f.admin.pool.query('DROP FUNCTION manga_web.windows_stage_cost_lookup(jsonb,text)');}
  await expect(worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
 });
});


import pgB3 from 'pg';
import {readFile as readB3Migration,readdir as listB3Migrations} from 'node:fs/promises';
import {migrate as migrateB3} from '../../packages/storage/src/migrations.js';

type B3FunctionRow=Record<string,unknown>&{oid:number;signature:string;prosrc:string};
const b3ReplacementSignatures=[
  'manga_web.windows_stage_cost_owner(jsonb)',
  'manga_web.windows_stage_cost_original(jsonb,uuid)',
  'manga_web.windows_stage_cost_non_windows(jsonb,jsonb)'
] as const;

// 0024 검사의 pg_proc/OID 비교와 이 파일의 stageCostFunctions ACL 열거를
// 재사용한다. 과거 검사 본문은 보존하며 실제 1..24 -> 25만 별도로 검증한다.
it('W4-B3-B 0025 preserves 1..24 OIDs owners ACL search_path security types roles and replaces exactly private3 bodies',async()=>{
  const connectionString=process.env.TRIO_TEST_DATABASE_URL;
  expect(connectionString,'메인이 배정한 격리 PG18 슬롯에서만 실행한다').toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/);
  const guard=guardWindowsNativeIo(),root=new pgB3.Client({connectionString});
  try{
    await root.connect();
    expect((await root.query('SHOW server_version')).rows[0].server_version).toMatch(/^18\./);
    const databaseName=name('trio_w4b3b_old');
    await root.query('CREATE DATABASE '+identifier(databaseName));
    const url=new URL(connectionString!);url.pathname='/'+databaseName;
    const db=new Database(url.toString());connections.push(db);
    const directory=new URL('../../db/migrations/',import.meta.url);
    const oldNames=(await listB3Migrations(directory)).filter(entry=>/^\d{4}_[a-z0-9_]+\.sql$/.test(entry)&&entry.slice(0,4)<='0024').sort();
    expect(oldNames.map(entry=>entry.slice(0,4))).toEqual(Array.from({length:24},(_value,index)=>String(index+1).padStart(4,'0')));
    const oldSources=await Promise.all(oldNames.map(async entry=>{
      const bytes=await readB3Migration(new URL(entry,directory));
      return {name:entry,sql:bytes.toString('utf8'),sha256:sha256(bytes)};
    }));
    await db.transaction(async client=>{
      await client.query('CREATE SCHEMA trio_migrations; CREATE TABLE trio_migrations.applied(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      for(const source of oldSources){
        await client.query(source.sql);
        await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2)',[source.name,source.sha256]);
      }
    });
    const worker=await provisionLocalService(db,'trio_web_worker'),api=await provisionLocalService(db,'trio_web_api');connections.push(worker,api);
    await expect(worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
    await expect(api.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_api'});
    const signatureSql="'manga_web.'||p.proname||'('||replace(pg_catalog.oidvectortypes(p.proargtypes),' ','')||')'";
    const functionFrom=" FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid";
    const metadataSql='SELECT p.oid,'+signatureSql+' signature,p.proname,p.proowner,p.proacl::text,p.proconfig,p.prosecdef,p.prorettype,p.proretset,p.proisstrict,p.proargtypes::text,p.proallargtypes::text,p.proargmodes,p.proargnames,p.prolang,p.provolatile,p.proparallel,p.proleakproof,p.prokind,p.probin'+functionFrom;
    const bodySql='SELECT p.oid,'+signatureSql+' signature,p.prosrc,pg_catalog.pg_get_functiondef(p.oid) definition'+functionFrom;
    const rolesSql='SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolconnlimit,rolvaliduntil,rolconfig FROM pg_catalog.pg_roles ORDER BY oid';
    const membershipSql='SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members ORDER BY roleid,member,grantor';
    const typesSql="SELECT t.oid,t.typname,t.typowner,t.typtype,t.typcategory,t.typrelid,t.typelem,t.typarray,t.typbasetype,t.typnotnull,t.typacl::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='manga_web' ORDER BY t.oid";
    const relationsSql="SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' ORDER BY c.oid";
    const columnsSql="SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum";
    const schemasSql="SELECT oid,nspname,nspowner,nspacl::text FROM pg_catalog.pg_namespace WHERE nspname='manga_web'";
    const functionGrantsSql="SELECT p.oid,r.rolname,pg_catalog.has_function_privilege(r.rolname,p.oid,'EXECUTE') allowed,EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_catalog.pg_roles r WHERE n.nspname='manga_web' AND r.rolname IN('trio_web_worker','trio_web_api','trio_web_controller') ORDER BY p.oid,r.rolname";
    const preservedSql={roles:rolesSql,memberships:membershipSql,types:typesSql,relations:relationsSql,columns:columnsSql,schemas:schemasSql,functionGrants:functionGrantsSql};
    const metadataBefore=(await db.pool.query(metadataSql)).rows,bodiesBefore=(await db.pool.query<B3FunctionRow>(bodySql)).rows;
    expect(metadataBefore.length).toBeGreaterThan(0);
    const originals=bodiesBefore.filter(row=>b3ReplacementSignatures.some(signature=>signature===row.signature));
    expect(originals.map(row=>row.signature).sort()).toEqual([...b3ReplacementSignatures].sort());
    const preservedBefore=new Map<string,unknown[]>();
    for(const [kind,sql] of Object.entries(preservedSql))preservedBefore.set(kind,(await db.pool.query(sql)).rows);
    const appliedSql='SELECT name,sha256,applied_at::text AS applied_at FROM trio_migrations.applied ORDER BY name';
    const appliedBefore=(await db.pool.query<{name:string;sha256:string;applied_at:string}>(appliedSql)).rows;
    expect(appliedBefore.map(({name,sha256})=>({name,sha256}))).toEqual(oldSources.map(({name,sha256})=>({name,sha256})));

    const epoch=await createWindowsNativeMigrationEpoch(),applied=await epoch.migrate(db.pool);
    const metadataAfter=(await db.pool.query(metadataSql)).rows,bodiesAfter=(await db.pool.query<B3FunctionRow>(bodySql)).rows;
    // SQL0025 부재의 기능 RED는 원 3개 본문 교체가 0개라는 실제 DB 차이다.
    // 파일 import/환경 오류나 예상 오류를 잡아 성공시키는 경로는 없다.
    const changed=bodiesBefore.filter(old=>bodiesAfter.find(next=>next.oid===old.oid)?.prosrc!==old.prosrc);
    expect(changed.map(row=>row.signature).sort(),'0025는 기존 private3 본문을 정확히 교체해야 한다').toEqual([...b3ReplacementSignatures].sort());
    expect(applied).toEqual(['0025_windows_checkpoint_cost.sql']);
    expect(metadataAfter,'기존 전체 OID/owner/ACL/search_path/security/입출력 type을 그대로 보존한다').toEqual(metadataBefore);
    for(const old of bodiesBefore){
      const next=bodiesAfter.find(row=>row.oid===old.oid);
      if(b3ReplacementSignatures.some(signature=>signature===old.signature))expect(next!.prosrc).not.toBe(old.prosrc);
      else expect(next,'교체 대상 밖 함수 본문 보존: '+old.signature).toEqual(old);
    }
    for(const [kind,sql] of Object.entries(preservedSql))expect((await db.pool.query(sql)).rows,'원 catalog 보존: '+kind).toEqual(preservedBefore.get(kind));

    const functions=(await db.pool.query<{oid:number;signature:string;public:boolean}>(stageCostFunctions)).rows;
    expect(functions.filter(fn=>fn.public)).toHaveLength(stageCostPublic.length);
    for(const fn of functions)for(const role of ['trio_web_worker','trio_web_api','trio_web_controller']){
      expect((await db.pool.query<{allowed:boolean}>("SELECT pg_catalog.has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,fn.oid])).rows[0].allowed,role+' '+fn.signature).toBe(role==='trio_web_worker'&&fn.public);
    }
    for(const original of originals){
      const row=metadataAfter.find(row=>row.oid===original.oid)!;
      expect(row.prosecdef).toBe(true);expect(row.proconfig).toEqual(['search_path=pg_catalog, manga_web, pg_temp']);
      for(const role of ['trio_web_worker','trio_web_api','trio_web_controller'])expect((await db.pool.query<{allowed:boolean}>("SELECT pg_catalog.has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,original.oid])).rows[0].allowed).toBe(false);
    }
    await expect(worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
    await expect(api.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_api'});
    const migrationName='0025_windows_checkpoint_cost.sql',migrationSha=sha256(await readB3Migration(new URL(migrationName,directory)));
    const appliedAfter=(await db.pool.query<{name:string;sha256:string;applied_at:string}>(appliedSql)).rows;
    expect(appliedAfter.filter(row=>row.name<migrationName)).toEqual(appliedBefore);
    expect(appliedAfter.map(({name,sha256})=>({name,sha256}))).toEqual([...oldSources.map(({name,sha256})=>({name,sha256})),{name:migrationName,sha256:migrationSha}]);

    expect(await epoch.migrate(db.pool)).toEqual([]);
    expect((await db.pool.query(appliedSql)).rows).toEqual(appliedAfter);
    expect((await db.pool.query(metadataSql)).rows).toEqual(metadataAfter);
    expect((await db.pool.query(bodySql)).rows).toEqual(bodiesAfter);
    for(const [kind,sql] of Object.entries(preservedSql))expect((await db.pool.query(sql)).rows,'재적용 뒤 catalog 보존: '+kind).toEqual(preservedBefore.get(kind));
    expect(await Promise.all(oldSources.map(async source=>({name:source.name,sha256:sha256(await readB3Migration(new URL(source.name,directory)))})))).toEqual(oldSources.map(({name,sha256})=>({name,sha256})));
    expect(sha256(await readB3Migration(new URL(migrationName,directory)))).toBe(migrationSha);
    console.info(JSON.stringify({w4b3bMigration:{oldMigrations:24,unchangedMetadata:metadataBefore.length,exactReplacements:b3ReplacementSignatures,rolesAndTypesPreserved:true,workerApiControllerPrivateGrantsPreserved:true,originalAppliedHashesAndTimesPreserved:true,migrationName,migrationSha256:migrationSha,reapplied:0}}));
  }finally{
    try{await root.end();expect(guard.denied).toEqual([]);}
    finally{guard.restore();}
  }
},120000);

it('B3-C FIX 0026 private ownership transition contract exists with one protected collector',async()=>{
  const f=await fixture('trio_web_worker');
  const rows=(await f.admin.pool.query("SELECT (SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('manga_web.windows_stage_cost_ownership_transitions')) AS installed,pg_get_function_identity_arguments('manga_web.windows_stage_cost_collect(jsonb,integer,boolean)'::regprocedure) AS arguments")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].installed,'승인된 과거 봉인 전환 표가 실제 DB에 있어야 한다').toBe('manga_web.windows_stage_cost_ownership_transitions');
  expect(rows[0].arguments).toContain('jsonb');
});

// 기존 0025의 종료 세대와 0026의 변경 경계를 별도 DB에서 확인한다.
type FixFunctionCatalog={oid:string;signature:string;metadata:Record<string,unknown>;prosrc:string};
async function fixOwnershipEpochDatabase(){
  const connectionString=process.env.TRIO_TEST_DATABASE_URL;
  expect(connectionString).toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/);
  const root=new pgB3.Client({connectionString});await root.connect();
  const databaseName=name('trio_b3c_ownership_epoch');try{await root.query('CREATE DATABASE '+identifier(databaseName));}finally{await root.end();}
  const url=new URL(connectionString!);url.pathname='/'+databaseName;
  const db=new Database(url.toString());connections.push(db);
  const epoch=await createWindowsNativeMigrationEpoch(),applied=await epoch.migrate(db.pool);
  expect(applied.map(file=>file.slice(0,4))).toEqual(Array.from({length:25},(_value,index)=>String(index+1).padStart(4,'0')));
  return {db,epoch};
}
it('B3-C FIX 0026 preserves exact old function identity privileges and applies only collect plus a private immutable transition table',async()=>{
  const guard=guardWindowsNativeIo();
  try{
    const {db}=await fixOwnershipEpochDatabase(),worker=await provisionLocalService(db,'trio_web_worker'),api=await provisionLocalService(db,'trio_web_api');connections.push(worker,api);
    const functionSql="SELECT p.oid::text AS oid,'manga_web.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),' ','')||')' AS signature,to_jsonb(p)-'prosrc' AS metadata,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid";
    const functionsBefore=(await db.pool.query<FixFunctionCatalog>(functionSql)).rows;
    const catalogSql={
      roles:"SELECT oid,to_jsonb(r)-'rolpassword' AS value FROM pg_roles r ORDER BY oid",
      memberships:"SELECT to_jsonb(m) AS value FROM pg_auth_members m ORDER BY roleid,member,grantor",
      types:"SELECT t.oid,to_jsonb(t) AS value FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='manga_web' ORDER BY t.oid",
      relations:"SELECT c.oid,to_jsonb(c) AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' ORDER BY c.oid",
      columns:"SELECT a.attrelid,a.attnum,to_jsonb(a) AS value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum",
      schemas:"SELECT oid,nspname,nspowner,nspacl::text FROM pg_namespace WHERE nspname='manga_web'",
      functionGrants:"SELECT p.oid,r.rolname,has_function_privilege(r.rolname,p.oid,'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_roles r WHERE n.nspname='manga_web' AND r.rolname IN('trio_web_worker','trio_web_api','trio_web_controller','trio_web_operator') ORDER BY p.oid,r.rolname"
    };
    const before=new Map<string,Record<string,unknown>[]>();for(const [kind,sql] of Object.entries(catalogSql))before.set(kind,(await db.pool.query(sql)).rows);
    const appliedSql='SELECT name,sha256,applied_at::text AS applied_at FROM trio_migrations.applied ORDER BY name',appliedBefore=(await db.pool.query(appliedSql)).rows;
    expect(appliedBefore).toHaveLength(25);
    const roleBefore=(await db.pool.query('SELECT current_user,session_user')).rows;
    expect(await migrateB3(db.pool)).toEqual(['0026_windows_stage_cost_ownership.sql']);
    const functionsAfter=(await db.pool.query<FixFunctionCatalog>(functionSql)).rows;
    expect(functionsAfter.map(({prosrc:_body,...metadata})=>metadata)).toEqual(functionsBefore.map(({prosrc:_body,...metadata})=>metadata));
    expect(functionsBefore.filter(old=>functionsAfter.find(row=>row.oid===old.oid)?.prosrc!==old.prosrc).map(row=>row.signature)).toEqual(['manga_web.windows_stage_cost_collect(jsonb,integer,boolean)']);
    for(const old of functionsBefore)if(old.signature!=='manga_web.windows_stage_cost_collect(jsonb,integer,boolean)')expect(functionsAfter.find(row=>row.oid===old.oid)).toEqual(old);
    for(const [kind,sql] of Object.entries(catalogSql)){
      const after=(await db.pool.query(sql)).rows,saved=before.get(kind)!;
      if(kind==='types'||kind==='relations'){const oldIds=new Set(saved.map(row=>row.oid));expect(after.filter(row=>oldIds.has(row.oid))).toEqual(saved);}
      else if(kind==='columns'){const oldIds=new Set(saved.map(row=>row.attrelid));expect(after.filter(row=>oldIds.has(row.attrelid))).toEqual(saved);}
      else expect(after).toEqual(saved);
    }
    const oldRelationIds=new Set(before.get('relations')!.map(row=>row.oid)),newTables=(await db.pool.query("SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND c.relkind='r' ORDER BY c.oid")).rows.filter(row=>!oldRelationIds.has(row.oid));
    expect(newTables).toEqual([{oid:newTables[0]?.oid,relname:'windows_stage_cost_ownership_transitions',relrowsecurity:true,relforcerowsecurity:true}]);
    const table='manga_web.windows_stage_cost_ownership_transitions';
    for(const role of ['trio_web_api','trio_web_worker','trio_web_controller','trio_web_operator']){
      for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])expect((await db.pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,table,privilege])).rows).toEqual([{allowed:false}]);
      for(const sql of ['SELECT * FROM '+table,'INSERT INTO '+table+' DEFAULT VALUES','UPDATE '+table+" SET reason='EXACT'",'DELETE FROM '+table,'TRUNCATE '+table]){
        await expect(db.transaction(async client=>{await client.query('SET LOCAL ROLE '+identifier(role));await client.query(sql);})).rejects.toMatchObject({code:'42501'});
      }
    }
    for(const sql of ['UPDATE '+table+" SET reason='EXACT'",'DELETE FROM '+table,'TRUNCATE '+table])await expect(db.pool.query(sql)).rejects.toMatchObject({code:'23514',message:'NATIVE_JOB_RECORD_IMMUTABLE'});
    expect((await db.pool.query('SELECT count(*)::integer n FROM '+table)).rows).toEqual([{n:0}]);
    expect((await db.pool.query("SELECT to_regclass('pg_temp.windows_stage_cost_transition_stage')::text AS temporary")).rows).toEqual([{temporary:null}]);
    await expect(worker.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_worker'});
    await expect(api.validateServiceRole()).resolves.toMatchObject({currentUser:'trio_web_api'});
    expect((await db.pool.query('SELECT current_user,session_user')).rows).toEqual(roleBefore);
    const appliedAfter=(await db.pool.query(appliedSql)).rows;
    expect(appliedAfter.filter(row=>String(row.name).slice(0,4)<='0025')).toEqual(appliedBefore);expect(appliedAfter).toHaveLength(26);
    expect(appliedAfter[25].sha256).toBe(sha256(await readB3Migration(new URL('../../db/migrations/0026_windows_stage_cost_ownership.sql',import.meta.url))));
    expect(await migrateB3(db.pool)).toEqual([]);
    expect((await db.pool.query(appliedSql)).rows).toEqual(appliedAfter);expect((await db.pool.query(functionSql)).rows).toEqual(functionsAfter);
    console.info(JSON.stringify({b3cOwnershipMigrationAcl:{oldFunctions:functionsBefore.length,changedFunctions:1,oldMigrations:25,privateTables:newTables.map(row=>row.relname),directServicePrivileges:0}}));
  }finally{expect(guard.denied).toEqual([]);guard.restore();}
},120000);
