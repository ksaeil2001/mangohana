import type {PoolClient} from 'pg';

export type ServiceRole='trio_web_api'|'trio_web_worker';
export type ServiceRoleExpectation={serviceRole:ServiceRole;loginRole:string};
export type ServiceRoleVerification={serviceRole:ServiceRole;sessionUser:string;currentUser:string;membershipRoles:string[]};
export class ServiceRoleError extends Error {constructor(readonly code:string){super(code);}}
type Role={oid:string;name:string;login:boolean;superuser:boolean;bypassRls:boolean;createDb:boolean;createRole:boolean;replication:boolean};
type Membership={role:string;member:string;admin:boolean;inherit:boolean;set:boolean};
type Snapshot={session_user:string;current_user:string;roles:Role[];memberships:Membership[];set_roles:string[];ownership:{kind:string}[];create_schemas:string[];direct_privileges:{kind:string}[];forbidden_privileges:{kind:string}[]};
const privilegedRoles=new Set(['pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_database_owner','pg_signal_backend','pg_checkpoint','pg_monitor','pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables','pg_maintain','pg_create_subscription','pg_use_reserved_connections']);
const reject=(code:string):never=>{throw new ServiceRoleError(code);};

// One catalog snapshot, SELECT only. Provisioning, grants and migrations belong to a separate operator boundary.
const inspectionSql=`WITH RECURSIVE reachable(role_oid) AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user
  UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON m.member=r.role_oid
), owned AS (
  SELECT 'SCHEMA'::text AS kind FROM pg_catalog.pg_namespace WHERE nspowner IN(SELECT role_oid FROM reachable)
  UNION ALL SELECT 'TABLE' FROM pg_catalog.pg_class WHERE relowner IN(SELECT role_oid FROM reachable)
  UNION ALL SELECT 'FUNCTION' FROM pg_catalog.pg_proc WHERE proowner IN(SELECT role_oid FROM reachable)
  UNION ALL SELECT 'DATABASE' FROM pg_catalog.pg_database WHERE datdba IN(SELECT role_oid FROM reachable)
), explicit_privileges AS (
  SELECT 'SCHEMA'::text AS kind,n.nspname AS namespace,a.grantee FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
  UNION ALL SELECT 'TABLE',n.nspname,a.grantee FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  UNION ALL SELECT 'COLUMN',n.nspname,a.grantee FROM pg_catalog.pg_attribute c JOIN pg_catalog.pg_class t ON t.oid=c.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
  UNION ALL SELECT 'FUNCTION',n.nspname,a.grantee FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
), core_tables(service_role,relation,privilege) AS (
  VALUES
    ('trio_web_api','executions','INSERT'),('trio_web_api','executions','UPDATE'),('trio_web_api','executions','DELETE'),
    ('trio_web_api','cost_items','INSERT'),('trio_web_api','cost_items','UPDATE'),('trio_web_api','cost_items','DELETE'),
    ('trio_web_api','execution_evidence','INSERT'),('trio_web_api','free_starts','INSERT'),('trio_web_api','ledger_entries','INSERT'),('trio_web_api','settlements','INSERT'),
    ('trio_web_worker','auth_attempts','SELECT'),('trio_web_worker','auth_evidence','SELECT'),('trio_web_worker','auth_limiter_events','SELECT'),('trio_web_worker','signing_verifiers','SELECT'),
    ('trio_web_worker','export_builds','SELECT'),('trio_web_worker','export_builds','INSERT'),('trio_web_worker','export_builds','UPDATE'),('trio_web_worker','export_builds','DELETE'),
    ('trio_web_worker','export_build_candidates','SELECT'),('trio_web_worker','export_build_candidates','INSERT'),('trio_web_worker','export_build_candidates','UPDATE'),('trio_web_worker','export_build_candidates','DELETE'),
    ('trio_web_worker','app_sessions','INSERT'),('trio_web_worker','app_sessions','UPDATE'),('trio_web_worker','app_sessions','DELETE'),
    ('trio_web_worker','auth_attempts','INSERT'),('trio_web_worker','auth_attempts','UPDATE'),('trio_web_worker','auth_attempts','DELETE'),
    ('trio_web_worker','auth_evidence','INSERT'),('trio_web_worker','auth_evidence','UPDATE'),('trio_web_worker','auth_evidence','DELETE')
), core_columns(service_role,relation,column_name,privilege) AS (
  VALUES ('trio_web_api','accounts','balance_credit','UPDATE'),('trio_web_api','accounts','free_started_count','UPDATE'),
    ('trio_web_worker','app_sessions','cookie_digest','SELECT'),('trio_web_worker','app_sessions','csrf_digest','SELECT'),('trio_web_worker','app_sessions','login_evidence_id','SELECT'),
    ('trio_web_worker','login_bindings','issuer','SELECT'),('trio_web_worker','login_bindings','subject','SELECT'),
    ('trio_web_api','native_result_candidates','protected_candidate','SELECT'),('trio_web_worker','native_result_candidates','protected_candidate','SELECT'),
    ('trio_web_api','native_result_candidates','source_asset_dependencies','SELECT'),('trio_web_worker','native_result_candidates','source_asset_dependencies','SELECT'),
    ('trio_web_api','native_result_receipts','protected_receipt','SELECT'),('trio_web_worker','native_result_receipts','protected_receipt','SELECT')
), core_functions(service_role,function_name) AS (
  -- These SECURITY DEFINER functions expose cross-account facts; only the owning process may execute them.
  VALUES ('trio_web_worker','resolve_session(text)'),('trio_web_worker','binding_owner(text,text)'),
    ('trio_web_worker','export_build_scan(timestamptz)'),
    ('trio_web_api','dispatch_candidates()'),('trio_web_api','active_accounts()'),('trio_web_api','media_candidates()'),('trio_web_api','retention_accounts()'),
    ('trio_web_api','capture_execution_limits(uuid)'),('trio_web_api','reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb)'),
    ('trio_web_api','reconcile_execution_limits(uuid)'),('trio_web_api','release_request_execution_budget(uuid)'),
    ('trio_web_api','verify_execution_limit_input()'),('trio_web_worker','verify_execution_limit_input()'),
    ('trio_web_api','native_receipt_library_candidates(timestamptz,uuid,timestamptz)')
), internal_limit_tables(relation,global_authority) AS (
  VALUES ('execution_limit_profiles',true),('execution_limit_authority',true),('operational_limit_evidence',true),('execution_request_bounds',false),
    ('execution_budget_reservations',false),('execution_capacity_permits',false),('execution_limit_expenses',false)
), internal_native_tables(relation) AS (
  VALUES ('native_job_intents'),('native_job_go_consumptions'),('native_job_observations'),('native_result_candidates'),('native_result_receipts')
), internal_capacity_tables(relation,protected_read) AS (
  VALUES ('native_capacity_profiles',true),('native_capacity_authority',true),('native_capacity_reservations',false),('native_capacity_adoptions',false),('native_capacity_termination_proofs',true)
), controller_tables(relation) AS (
  VALUES ('native_controller_attempts'),('native_controller_events'),('native_controller_go_grants'),('native_controller_raw_results'),('native_controller_object_receipts'),('windows_native_origins'),('windows_native_events'),('windows_native_records'),('windows_native_links')
), native_helpers(function_name) AS (
  VALUES ('windows_native_offer(jsonb)'),('windows_native_capture(jsonb,text,text)'),('windows_native_current(jsonb)'),('windows_native_ready(jsonb,text)'),('windows_native_grant_go(jsonb)'),('windows_native_append(jsonb,text,text)'),('windows_native_event(jsonb,uuid)'),('windows_native_scan(jsonb,integer)'),('windows_native_record(jsonb,text,uuid,text)'),('windows_native_finish(jsonb,text)'),('windows_native_link(jsonb,uuid,text,text)'),('windows_native_read(jsonb)'),('windows_native_canonical(jsonb,integer)'),('windows_native_hash(jsonb)'),('windows_native_parse(text,integer)'),('windows_native_object(jsonb,text[])'),('windows_native_context(jsonb)'),('windows_native_scope(jsonb)'),('windows_native_basis(uuid,uuid,jsonb)'),('windows_native_go_ref(uuid,uuid)'),('windows_native_store(jsonb,text,uuid,text)'),('windows_native_facts(uuid,uuid)'),('windows_native_link_body(uuid,uuid)'),('windows_native_view(uuid,uuid)'),('windows_native_capacity_go_ready(uuid,uuid,uuid,text,jsonb)'),('windows_native_reference(uuid,jsonb)'),('native_capacity_windows_profile_valid(jsonb)'),('native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text)'),('native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid)'),('native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid)'),('native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid)'),('native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text)'),('native_job_observation_owned_v16(uuid,jsonb,text)'),('native_controller_snapshot_v16(uuid,uuid)'),('native_job_unresolved_v13(text)'),('native_receipt_windows_job(uuid)'),('native_receipt_windows_raw_valid(uuid,jsonb,text,text,jsonb)'),('native_receipt_windows_candidate_valid(jsonb)'),('native_receipt_windows_receipt_valid(jsonb,jsonb)'),('native_receipt_prepare_v1_14(jsonb,jsonb)'),('native_receipt_verify_v1_14(uuid,jsonb,jsonb)'),('native_receipt_lookup_v1_14(jsonb)'),('native_receipt_register_asset_v1_14(uuid,text,jsonb,text,jsonb)'),('native_receipt_prepare_windows_v2(jsonb,jsonb)'),('native_receipt_verify_windows_v2(uuid,jsonb,jsonb)'),('native_receipt_lookup_windows_v2(jsonb)'),('native_receipt_register_asset_windows_v2(uuid,text,jsonb,text,jsonb)'),('windows_native_reference(uuid,jsonb)'),('windows_native_shape(jsonb,jsonb)'),('windows_native_win_value(text,jsonb)'),('windows_native_fact_valid(jsonb)'),('windows_native_accounting_valid(jsonb)'),('windows_native_source_valid(uuid,uuid,jsonb,jsonb)'),('windows_native_seal_valid(uuid,uuid,jsonb)'),('windows_native_owner_current(jsonb)'),('immutable_native_job_record()'),('native_job_caller()'),('native_job_logical_key(jsonb)'),
    ('native_job_valid_tuple(jsonb)'),('native_job_capture_current(uuid,jsonb,timestamptz)'),('native_job_context_reference(uuid,jsonb)'),('native_job_target_current(jsonb,text,timestamptz)'),
    ('native_receipt_lookup_valid(jsonb)'),('native_receipt_retention(jsonb,timestamptz)'),('native_receipt_assets_current(jsonb,timestamptz)'),('native_receipt_source_assets(jsonb,jsonb,timestamptz)'),('native_receipt_object_valid(jsonb)'),
    ('native_capacity_profile_record()'),('native_capacity_immutable_record()'),('native_capacity_reservation_record()'),('native_capacity_roots()'),('native_capacity_required()'),('native_capacity_reference_valid(jsonb)'),('native_capacity_configuration_valid(jsonb)'),('native_capacity_source_valid(jsonb)'),('native_capacity_source_current(jsonb,jsonb)'),('native_capacity_base_intent(jsonb,boolean)'),('native_capacity_operator_caller()'),
    ('native_capacity_base_create_intent_v13(jsonb)'),('native_capacity_base_consume_go_v13(uuid,uuid,jsonb,jsonb)'),('native_capacity_base_reserve_execution_v12(uuid,uuid,bigint,uuid,jsonb)'),
    ('native_capacity_operator_profile(uuid,uuid)'),('native_capacity_confirm_proof(text,text)'),('native_capacity_release(uuid,uuid,uuid)'),
    ('native_job_go_current_owned(uuid,uuid,jsonb,jsonb,text)'),('native_job_go_owned(uuid,uuid,jsonb,jsonb,text)'),('native_job_observation_owned(uuid,jsonb,text)'),('native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text)'),('native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text)'),
    ('native_controller_caller()'),('native_controller_binding_valid(jsonb)'),('native_controller_original(jsonb,uuid,text)'),('native_controller_snapshot(uuid,uuid)'),
    ('native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid)'),('native_controller_load(jsonb,uuid,text)'),('native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid)'),('native_controller_grant_go(jsonb,uuid,uuid,uuid,text)'),('native_controller_observe(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb)'),
    ('native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text)'),('native_controller_raw_lookup(jsonb,uuid,text,text)'),('native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text)'),
    ('operational_limit_object(jsonb,text[])'),('operational_limit_decimal(jsonb,boolean)'),('operational_limit_uuid(jsonb)'),('operational_limit_refs(jsonb)'),('operational_limit_timestamp(jsonb)'),('operational_limit_identity(jsonb)'),('operational_limit_window(jsonb)'),('operational_limit_measurement(jsonb)'),('validate_operational_limit_evidence()'),('operational_execution_limit_valid(manga_web.execution_limit_profiles)'),('validate_operational_execution_limit_profile()')
), native_owning_functions(function_name) AS (
  VALUES ('windows_native_lookup(jsonb)'),('read_operational_execution_limit(jsonb)'),('native_job_create_intent(jsonb)'),('native_job_consume_go(uuid,uuid,jsonb,jsonb)'),
    ('native_job_append_observation(uuid,jsonb)'),('native_job_unresolved(text)'),
    ('native_receipt_create_intent(jsonb)'),('native_receipt_lookup(jsonb)'),('native_receipt_prepare(jsonb,jsonb)'),('native_receipt_register_asset(uuid,text,jsonb,text,jsonb)'),('native_receipt_verify(uuid,jsonb,jsonb)'),
    ('native_capacity_create_intent(jsonb,boolean,jsonb)'),('native_capacity_consume_go(uuid,uuid,jsonb,jsonb,jsonb)'),('native_capacity_recovery(text,uuid)')
    UNION ALL SELECT 'native_receipt_library_candidates(timestamptz,uuid,timestamptz)' WHERE $1='trio_web_worker'
), cost_owner_tables(relation) AS (
  VALUES ('windows_native_cost_enrollments'),('windows_native_cost_roots'),('windows_native_cost_scopes'),('windows_native_cost_calls'),('windows_native_cost_scope_ends'),('windows_native_cost_bindings'),
    ('windows_native_cost_io_starts'),('windows_native_cost_io_ends'),('windows_native_cost_cache_uses'),('windows_native_cost_result_queries'),('windows_native_cost_result_claims'),('windows_native_cost_result_acks')
), cost_owner_public(function_name) AS (
  VALUES ('windows_native_cost_enroll_input(jsonb)'),('windows_native_cost_activate(jsonb,jsonb)'),('windows_native_cost_begin(jsonb,jsonb)'),
    ('windows_native_cost_register_call(uuid,jsonb)'),('windows_native_cost_admit(uuid,jsonb,jsonb,text)'),('windows_native_cost_join(uuid,jsonb)'),('windows_native_cost_lookup(jsonb,integer)'),
    ('windows_native_cost_receipt_lookup(uuid,jsonb)'),('windows_native_cost_receipt_prepare(uuid,jsonb,jsonb)'),('windows_native_cost_receipt_register_asset(uuid,uuid,text,jsonb,text,jsonb)'),('windows_native_cost_receipt_verify(uuid,uuid,jsonb,jsonb)'),
    ('windows_native_cost_io_begin(jsonb)'),('windows_native_cost_io_end(jsonb)'),('windows_native_cost_io_lookup(jsonb)'),('windows_native_cost_cache_use(uuid,jsonb)'),
    ('windows_native_cost_authorize_result_query(uuid,jsonb)'),('windows_native_cost_finish_result_query(uuid,jsonb,jsonb)')
), stage_cost_tables AS (
  SELECT c.oid,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='manga_web' AND c.relkind IN('r','p') AND pg_catalog.starts_with(c.relname,'windows_stage_cost_')
), stage_cost_public(function_name) AS (
  VALUES ('windows_stage_cost_project(jsonb,jsonb,jsonb,jsonb)'),('windows_stage_cost_seal(jsonb,jsonb)'),('windows_stage_cost_lookup(jsonb,integer)')
), inspected_actors(name) AS (SELECT session_user::text UNION SELECT current_user::text), forbidden AS (
  SELECT 'TABLE'::text AS kind FROM core_tables t CROSS JOIN inspected_actors a WHERE t.service_role=$1 AND (
    pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,t.privilege) OR
    CASE WHEN t.privilege IN('SELECT','INSERT','UPDATE') THEN pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,t.privilege) ELSE false END)
  UNION ALL SELECT 'COLUMN' FROM core_columns c CROSS JOIN inspected_actors a WHERE c.service_role=$1 AND pg_catalog.has_column_privilege(a.name,'manga_web.'||c.relation,c.column_name,c.privilege)
  UNION ALL SELECT 'INTERNAL_LIMIT' FROM internal_limit_tables t CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(privilege) CROSS JOIN inspected_actors a
    WHERE (t.global_authority OR $1='trio_web_api' OR p.privilege<>'SELECT') AND (pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,p.privilege) OR CASE WHEN p.privilege IN('SELECT','INSERT','UPDATE') THEN pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,p.privilege) ELSE false END)
  UNION ALL SELECT 'IRREVERSIBLE' FROM (VALUES('execution_evidence'),('free_starts'),('ledger_entries'),('settlements'),('export_build_candidates')) t(relation) CROSS JOIN (VALUES('UPDATE'),('DELETE')) p(privilege) CROSS JOIN inspected_actors a
    WHERE pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,p.privilege) OR CASE WHEN p.privilege='UPDATE' THEN pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,p.privilege) ELSE false END
  UNION ALL SELECT 'FUNCTION' FROM core_functions f CROSS JOIN inspected_actors a WHERE f.service_role=$1 AND pg_catalog.has_function_privilege(a.name,'manga_web.'||f.function_name,'EXECUTE')
  UNION ALL SELECT 'CONTROLLER_PRIVILEGE' FROM controller_tables t CROSS JOIN inspected_actors a WHERE pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,'SELECT,INSERT,UPDATE,REFERENCES')
  UNION ALL SELECT 'CONTROLLER_RLS' FROM controller_tables t LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('manga_web.'||t.relation) WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
  UNION ALL SELECT 'NATIVE_WRITE' FROM internal_native_tables t CROSS JOIN (VALUES('INSERT'),('UPDATE'),('DELETE')) p(privilege) CROSS JOIN inspected_actors a
    WHERE pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,p.privilege) OR CASE WHEN p.privilege IN('INSERT','UPDATE') THEN pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,p.privilege) ELSE false END
  UNION ALL SELECT 'NATIVE_RLS' FROM internal_native_tables t LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('manga_web.'||t.relation)
    WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
  UNION ALL SELECT 'NATIVE_CAPACITY_WRITE' FROM internal_capacity_tables t CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(privilege) CROSS JOIN inspected_actors a
    WHERE (p.privilege<>'SELECT' OR t.protected_read) AND (pg_catalog.has_table_privilege(a.name,'manga_web.'||t.relation,p.privilege) OR CASE WHEN p.privilege IN('SELECT','INSERT','UPDATE') THEN pg_catalog.has_any_column_privilege(a.name,'manga_web.'||t.relation,p.privilege) ELSE false END)
  UNION ALL SELECT 'NATIVE_CAPACITY_RLS' FROM internal_capacity_tables t LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('manga_web.'||t.relation)
    WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
  UNION ALL SELECT 'NATIVE_HELPER' FROM native_helpers f CROSS JOIN inspected_actors a WHERE pg_catalog.has_function_privilege(a.name,'manga_web.'||f.function_name,'EXECUTE')
  UNION ALL SELECT 'NATIVE_FUNCTION' FROM native_owning_functions f LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure('manga_web.'||f.function_name)
    WHERE p.oid IS NULL OR NOT p.prosecdef OR NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, manga_web, pg_temp']::text[] OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
  UNION ALL SELECT 'COST_OWNER_TABLE' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN inspected_actors a
    WHERE n.nspname='manga_web' AND c.relkind='r' AND c.relname LIKE 'windows_native_cost_%' AND
      (pg_catalog.has_table_privilege(a.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(a.name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  UNION ALL SELECT 'COST_OWNER_RLS' FROM cost_owner_tables t LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('manga_web.'||t.relation)
    WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
  UNION ALL SELECT 'COST_OWNER_HELPER' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN inspected_actors a
    WHERE n.nspname='manga_web' AND p.proname LIKE 'windows_native_cost_%' AND pg_catalog.has_function_privilege(a.name,p.oid,'EXECUTE') AND
      ($1<>'trio_web_worker' OR NOT EXISTS(SELECT 1 FROM cost_owner_public f WHERE p.oid=pg_catalog.to_regprocedure('manga_web.'||f.function_name)))
  UNION ALL SELECT 'COST_OWNER_CAPABILITY' FROM cost_owner_public f LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure('manga_web.'||f.function_name)
    WHERE p.oid IS NULL OR NOT p.prosecdef OR p.proowner IS DISTINCT FROM(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='manga_web.native_receipt_lookup(jsonb)'::regprocedure) OR
      p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, manga_web, pg_temp']::text[] OR
      ($1='trio_web_worker' AND NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) OR
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
  UNION ALL SELECT 'STAGE_COST_TABLE' FROM stage_cost_tables t CROSS JOIN inspected_actors a
    WHERE pg_catalog.has_table_privilege(a.name,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(a.name,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')
  UNION ALL SELECT 'STAGE_COST_RLS' FROM stage_cost_tables t WHERE NOT t.relrowsecurity OR NOT t.relforcerowsecurity
  UNION ALL SELECT 'STAGE_COST_HELPER' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN inspected_actors a
    WHERE n.nspname='manga_web' AND pg_catalog.starts_with(p.proname,'windows_stage_cost_') AND pg_catalog.has_function_privilege(a.name,p.oid,'EXECUTE') AND
      ($1<>'trio_web_worker' OR NOT EXISTS(SELECT 1 FROM stage_cost_public f WHERE p.oid=pg_catalog.to_regprocedure('manga_web.'||f.function_name)))
  UNION ALL SELECT 'STAGE_COST_CAPABILITY' FROM stage_cost_public f LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure('manga_web.'||f.function_name)
    WHERE p.oid IS NULL OR NOT p.prosecdef OR p.proowner IS DISTINCT FROM(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='manga_web.native_receipt_lookup(jsonb)'::regprocedure) OR
      p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, manga_web, pg_temp']::text[] OR
      ($1='trio_web_worker' AND NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) OR
      pg_catalog.has_function_privilege('trio_web_api',p.oid,'EXECUTE') OR pg_catalog.has_function_privilege('trio_web_controller',p.oid,'EXECUTE') OR
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
  UNION ALL SELECT 'TRUNCATE' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN inspected_actors a
    WHERE n.nspname='manga_web' AND c.relkind IN('r','p') AND pg_catalog.has_table_privilege(a.name,c.oid,'TRUNCATE')
)
SELECT session_user::text AS session_user,current_user::text AS current_user,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('oid',r.oid::text,'name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,'bypassRls',r.rolbypassrls,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'replication',r.rolreplication) ORDER BY r.oid) FROM pg_catalog.pg_roles r WHERE r.oid IN(SELECT role_oid FROM reachable)),'[]'::jsonb) AS roles,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('role',parent.rolname,'member',child.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid JOIN pg_catalog.pg_roles child ON child.oid=m.member WHERE m.member IN(SELECT role_oid FROM reachable)),'[]'::jsonb) AS memberships,
  COALESCE((SELECT jsonb_agg(r.rolname ORDER BY r.rolname) FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(session_user,r.oid,'SET')),'[]'::jsonb) AS set_roles,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind)) FROM owned),'[]'::jsonb) AS ownership,
  COALESCE((SELECT jsonb_agg(n.nspname ORDER BY n.nspname) FROM pg_catalog.pg_namespace n CROSS JOIN inspected_actors a WHERE pg_catalog.has_schema_privilege(a.name,n.oid,'CREATE')),'[]'::jsonb) AS create_schemas,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',p.kind)) FROM explicit_privileges p WHERE p.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user) OR(p.grantee IN(SELECT role_oid FROM reachable) AND p.namespace<>'manga_web')),'[]'::jsonb) AS direct_privileges,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind)) FROM forbidden),'[]'::jsonb) AS forbidden_privileges`;

export async function validateServiceRole(client:Pick<PoolClient,'query'>,expected:ServiceRoleExpectation):Promise<ServiceRoleVerification> {
  if(!['trio_web_api','trio_web_worker'].includes(expected.serviceRole)||!expected.loginRole||expected.loginRole===expected.serviceRole)reject('SERVICE_ROLE_CONFIG_INVALID');
  let snapshot:Snapshot;
  try {snapshot=(await client.query<Snapshot>(inspectionSql,[expected.serviceRole])).rows[0];}
  catch {return reject('SERVICE_ROLE_UNVERIFIED');}
  if(!snapshot||snapshot.session_user!==expected.loginRole||snapshot.current_user!==expected.serviceRole)reject('SERVICE_ROLE_IDENTITY_MISMATCH');
  const login=snapshot.roles.find(role=>role.name===expected.loginRole);const service=snapshot.roles.find(role=>role.name===expected.serviceRole);
  if(!login?.login||!service||service.login||snapshot.roles.some(role=>role.superuser||role.bypassRls||role.createDb||role.createRole||role.replication))reject('SERVICE_ROLE_FLAGS_UNSAFE');
  const opposite=expected.serviceRole==='trio_web_api'?'trio_web_worker':'trio_web_api';
  if(snapshot.roles.some(role=>role.name===opposite))reject('SERVICE_ROLE_CROSS_MEMBERSHIP');
  if(snapshot.roles.some(role=>privilegedRoles.has(role.name)||role.name.startsWith('pg_')))reject('SERVICE_ROLE_PRIVILEGED_MEMBERSHIP');
  if(snapshot.memberships.some(edge=>edge.admin))reject('SERVICE_ROLE_ADMIN_OPTION');
  const allowed=new Set([expected.loginRole,expected.serviceRole]);
  if(snapshot.roles.some(role=>!allowed.has(role.name)))reject('SERVICE_ROLE_UNEXPECTED_MEMBERSHIP');
  if(!snapshot.set_roles.includes(expected.serviceRole)||snapshot.set_roles.some(role=>!allowed.has(role)))reject('SERVICE_ROLE_SET_UNSAFE');
  if(snapshot.ownership.length)reject('SERVICE_ROLE_OWNERSHIP');
  if(snapshot.create_schemas.length)reject('SERVICE_ROLE_CREATE_PRIVILEGE');
  if(snapshot.direct_privileges.length)reject('SERVICE_ROLE_DIRECT_PRIVILEGES');
  if(snapshot.forbidden_privileges.length)reject('SERVICE_ROLE_FORBIDDEN_PRIVILEGES');
  return {serviceRole:expected.serviceRole,sessionUser:snapshot.session_user,currentUser:snapshot.current_user,membershipRoles:snapshot.roles.map(role=>role.name).sort()};
}
