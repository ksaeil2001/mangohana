import pg from 'pg';
import type {PoolClient} from 'pg';
import {requireCondition} from '../../contracts/src/errors.js';

export const nativeControllerFunctions=Object.freeze([
  'native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid)',
  'native_controller_load(jsonb,uuid,text)',
  'native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid)',
  'native_controller_grant_go(jsonb,uuid,uuid,uuid,text)',
  'native_controller_observe(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb)',
  'native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text)',
  'native_controller_raw_lookup(jsonb,uuid,text,text)',
  'native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text)',
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
  "windows_native_cost_claim_result_query(jsonb,uuid,text,jsonb)",
  "windows_native_cost_raw_lookup(jsonb,uuid,text,text,jsonb)",
  "windows_native_cost_controller_io_begin(jsonb,uuid,text,jsonb,jsonb)",
  "windows_native_cost_controller_io_end(jsonb,uuid,text,jsonb,jsonb)",
  "windows_native_cost_controller_io_lookup(jsonb,uuid,text,jsonb,jsonb)"
]);
const tables=Object.freeze(['native_controller_attempts','native_controller_events','native_controller_go_grants','native_controller_raw_results','native_controller_object_receipts','windows_native_origins','windows_native_events','windows_native_records','windows_native_links']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const inspection=`WITH RECURSIVE reachable(oid) AS(
 SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user
 UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON m.member=r.oid
), actors AS(SELECT rolname,oid FROM pg_catalog.pg_roles WHERE oid IN(SELECT oid FROM reachable)), functions AS(
 SELECT p.oid,p.proname,p.prosecdef,p.proconfig,n.nspname,p.proowner,pg_catalog.pg_get_function_identity_arguments(p.oid) args
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web'
), forbidden AS(
 SELECT 'ROLE_FLAGS' AS kind FROM pg_catalog.pg_roles WHERE oid IN(SELECT oid FROM reachable) AND(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
 UNION ALL SELECT 'ROLE_MEMBER' FROM actors WHERE rolname NOT IN(session_user,'trio_web_controller')
 UNION ALL SELECT 'ROLE_ADMIN' FROM pg_catalog.pg_auth_members WHERE member IN(SELECT oid FROM reachable) AND admin_option
 UNION ALL SELECT 'ROLE_SET' FROM pg_catalog.pg_roles WHERE pg_catalog.pg_has_role(session_user,oid,'SET') AND rolname NOT IN(session_user,'trio_web_controller')
 UNION ALL SELECT 'ROLE_LOGIN' FROM pg_catalog.pg_roles WHERE rolname='trio_web_controller' AND rolcanlogin
 UNION ALL SELECT 'OWNER' FROM pg_catalog.pg_class WHERE relowner IN(SELECT oid FROM reachable)
 UNION ALL SELECT 'OWNER' FROM pg_catalog.pg_namespace WHERE nspowner IN(SELECT oid FROM reachable)
 UNION ALL SELECT 'OWNER' FROM pg_catalog.pg_proc WHERE proowner IN(SELECT oid FROM reachable)
 UNION ALL SELECT 'OWNER' FROM pg_catalog.pg_database WHERE datdba IN(SELECT oid FROM reachable)
 UNION ALL SELECT 'SCHEMA_CREATE' FROM pg_catalog.pg_namespace n CROSS JOIN actors a WHERE pg_catalog.has_schema_privilege(a.rolname,n.oid,'CREATE')
 UNION ALL SELECT 'TABLE_PRIVILEGE' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN actors a WHERE n.nspname='manga_web' AND c.relkind IN('r','p','v','m') AND pg_catalog.has_table_privilege(a.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 UNION ALL SELECT 'SEQUENCE_PRIVILEGE' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN actors a WHERE n.nspname='manga_web' AND c.relkind='S' AND pg_catalog.has_sequence_privilege(a.rolname,c.oid,'SELECT,UPDATE,USAGE')
 UNION ALL SELECT 'COLUMN_PRIVILEGE' FROM pg_catalog.pg_attribute c JOIN pg_catalog.pg_class t ON t.oid=c.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace CROSS JOIN actors a WHERE n.nspname='manga_web' AND c.attnum>0 AND NOT c.attisdropped AND pg_catalog.has_column_privilege(a.rolname,t.oid,c.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
 UNION ALL SELECT 'LOGIN_DIRECT' FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)
 UNION ALL SELECT 'LOGIN_DIRECT' FROM pg_catalog.pg_class p CROSS JOIN LATERAL pg_catalog.aclexplode(p.relacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)
 UNION ALL SELECT 'LOGIN_DIRECT' FROM pg_catalog.pg_namespace p CROSS JOIN LATERAL pg_catalog.aclexplode(p.nspacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)
 UNION ALL SELECT 'FUNCTION_EXTRA' FROM functions f CROSS JOIN actors a WHERE pg_catalog.has_function_privilege(a.rolname,f.oid,'EXECUTE') AND f.oid NOT IN(SELECT pg_catalog.to_regprocedure('manga_web.'||name) FROM unnest($1::text[]) name) AND f.oid<>pg_catalog.to_regprocedure('manga_web.current_account()')
 UNION ALL SELECT 'FUNCTION_BOUNDARY' FROM unnest($1::text[]) name LEFT JOIN functions f ON f.oid=pg_catalog.to_regprocedure('manga_web.'||name) WHERE f.oid IS NULL OR NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, manga_web, pg_temp']::text[] OR NOT pg_catalog.has_function_privilege('trio_web_controller',f.oid,'EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=f.oid)) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE')
 UNION ALL SELECT 'FORCE_RLS' FROM unnest($2::text[]) name LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('manga_web.'||name) WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
)
SELECT session_user::text AS login,current_user::text AS role,
 (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=session_user) AS login_enabled,
 pg_catalog.pg_has_role(session_user,'trio_web_controller','USAGE') AS member,
 COALESCE((SELECT jsonb_agg(kind) FROM forbidden),'[]'::jsonb) AS forbidden`;

// This pool has no API/worker/operator membership. It cannot provision roles,
// migrate, release capacity, mutate profiles or write general project tables.
export class NativeControllerDatabase{
  private readonly pool:pg.Pool;
  private verified=false;
  constructor(connectionString:string,private readonly loginRole:string){
    requireCondition(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(loginRole)&&loginRole!=='trio_web_controller','NATIVE_CONTROLLER_ROLE_CONFIG_INVALID',409,'WAIT');
    this.pool=new pg.Pool({connectionString,max:12,connectionTimeoutMillis:5000,application_name:'trio-native-controller',options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp -c role=trio_web_controller'});
  }
  async validate():Promise<void>{
    this.verified=false;
    const client=await this.pool.connect();
    try{const record=(await client.query<{login:string;role:string;login_enabled:boolean;member:boolean;forbidden:string[]}>(inspection,[nativeControllerFunctions,tables])).rows[0];
      requireCondition(record?.login===this.loginRole&&record.role==='trio_web_controller'&&record.login_enabled&&record.member,'NATIVE_CONTROLLER_ROLE_IDENTITY_MISMATCH',409,'WAIT');
      requireCondition(!record.forbidden.length,'NATIVE_CONTROLLER_ROLE_UNSAFE',409,'WAIT');
      this.verified=true;
    }finally{client.release();}
  }
  async decision<T extends {allowed:boolean;reason?:string}>(accountId:string,query:string,values:unknown[],check?:(value:T)=>void):Promise<T>{
    requireCondition(this.verified,'NATIVE_CONTROLLER_ROLE_UNVERIFIED',409,'WAIT');requireCondition(uuid.test(accountId),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');
    for(let attempt=0;;attempt++){
      const client:PoolClient=await this.pool.connect();let committing=false;
      try{
        await client.query('BEGIN');await client.query('SET LOCAL ROLE trio_web_controller');
        await client.query("SELECT set_config('trio.account_id',$1,true)",[accountId]);
        const record=(await client.query<{decision:T}>(query,values)).rows[0]?.decision;
        requireCondition(record?.allowed,record?.reason??'NATIVE_CONTROLLER_RECORD_UNCONFIRMED',409,'WAIT');check?.(record);
        committing=true;await client.query('COMMIT');return record;
      }catch(error){await client.query('ROLLBACK').catch(()=>{});const code=error&&typeof error==='object'&&'code'in error?error.code:null;
        if(!committing&&attempt<2&&(code==='40001'||code==='40P01'))continue;throw error;
      }finally{client.release();}
    }
  }
  async close():Promise<void>{await this.pool.end();}
}
