-- W4-B2: protected original census, attribution and complete-set cost seals.
-- This capability has no default/operational reader and starts no native work.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE TABLE windows_stage_cost_owners(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,owner_body jsonb NOT NULL,owner_capture jsonb NOT NULL,
 created_at timestamptz NOT NULL,PRIMARY KEY(account_id,execution_id),
 FOREIGN KEY(account_id,execution_id) REFERENCES windows_native_cost_roots(account_id,execution_id),
 CHECK(octet_length(owner_body::text)<=16384));
CREATE TABLE windows_stage_cost_projections(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,key_digest text NOT NULL,key_body jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN('NATIVE','ABSENCE')),component_id text NOT NULL,job_id uuid,
 raw_set_digest text NOT NULL,operation_id uuid NOT NULL,operation_digest text NOT NULL,operation_body jsonb NOT NULL,
 termination_id uuid NOT NULL,termination_digest text NOT NULL,termination_body jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,execution_id,key_digest),CHECK(operation_id<>termination_id),
 FOREIGN KEY(account_id,execution_id) REFERENCES windows_stage_cost_owners(account_id,execution_id),
 CHECK(octet_length(operation_body::text)<=32768 AND octet_length(termination_body::text)<=32768));
CREATE TABLE windows_stage_cost_allocations(
 account_id uuid NOT NULL,event_id uuid NOT NULL,execution_id uuid NOT NULL,component_id text,
 target text NOT NULL CHECK(target IN('PROVIDER','QUANTITY','ALLOCATION')),source_operation_id uuid NOT NULL,source_event_id uuid NOT NULL,
 seal_id uuid NOT NULL,PRIMARY KEY(account_id,event_id));
CREATE TABLE windows_stage_cost_seals(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,owner_body jsonb NOT NULL,
 raw_set_digest text NOT NULL,membership_digest text NOT NULL,seal_id uuid NOT NULL,seal_digest text NOT NULL,seal_body jsonb NOT NULL,
 work_set jsonb NOT NULL,work_set_digest text NOT NULL,created_at timestamptz NOT NULL,lookup_membership jsonb NOT NULL,
 PRIMARY KEY(account_id,execution_id),UNIQUE(account_id,seal_id),
 FOREIGN KEY(account_id,execution_id) REFERENCES windows_stage_cost_owners(account_id,execution_id),
 CHECK(octet_length(seal_body::text)<=1048576 AND octet_length(work_set::text)<=1048576));

DO $tables$ DECLARE t text;BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='manga_web' AND c.relkind='r' AND c.relname LIKE 'windows_stage_cost_%' LOOP
  EXECUTE format('REVOKE ALL ON TABLE manga_web.%I FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator',t);
  EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE OR TRUNCATE ON manga_web.%I FOR EACH STATEMENT EXECUTE FUNCTION manga_web.immutable_native_job_record()',t);
 END LOOP;
END $tables$;

-- Preserve the B1 root bytes and the original public OID/owner/ACL/configuration.
DO $core$ DECLARE d text;BEGIN
 SELECT pg_get_functiondef('manga_web.windows_native_cost_activate(jsonb,jsonb)'::regprocedure) INTO d;
 EXECUTE replace(d,'FUNCTION manga_web.windows_native_cost_activate(','FUNCTION manga_web.windows_stage_cost_activate_core(');
END $core$;
CREATE OR REPLACE FUNCTION windows_native_cost_activate(owner jsonb,components jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE answer jsonb;saved jsonb;legacy jsonb;captured jsonb;n integer;a uuid:=manga_web.current_account();e uuid;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();
 IF manga_web.windows_native_cost_owner_valid(owner) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 e:=(owner->>'executionId')::uuid;PERFORM manga_web.windows_native_cost_lock_owner(e);
 SELECT owner_body INTO saved FROM manga_web.windows_stage_cost_owners WHERE account_id=a AND execution_id=e;
 IF FOUND AND saved IS DISTINCT FROM owner THEN RETURN NULL;END IF;
 IF saved IS NULL AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_roots WHERE account_id=a AND execution_id=e) THEN
  SELECT count(*),min(v::text)::jsonb INTO n,legacy FROM(SELECT DISTINCT protected_scope->'owner' v FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=e) s;
  IF n<>1 OR legacy IS DISTINCT FROM owner THEN RETURN NULL;END IF;
  SELECT protected_scope->'target'->'protectedOwnerCapture' INTO captured FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=e ORDER BY scope_id LIMIT 1;
 END IF;
 IF saved IS NULL AND legacy IS NULL AND NOT EXISTS(
  SELECT 1 FROM manga_web.executions x JOIN manga_web.work_items w ON w.account_id=x.account_id AND w.work_item_id::text=owner->'claim'->>'workItemId'
  WHERE x.account_id=a AND x.execution_id=e AND x.claim_generation::text=owner->'claim'->>'generation'
   AND w.claim_generation::text=owner->'claim'->>'generation' AND w.claim_owner=owner->'claim'->>'ownerId'
   AND w.state='CLAIMED' AND w.lease_until>clock_timestamp()
   AND((w.kind IN('DISPATCH','APPLY') AND w.target_ref->>'requestId'=x.request_id::text) OR(w.kind='RECONCILE' AND w.target_ref->>'executionId'=e::text))) THEN RETURN NULL;END IF;
 IF saved IS NULL AND captured IS NULL THEN
  SELECT jsonb_build_object('contextId',c.context_id,'contextGeneration',c.generation::text,'ownerSessionId',c.owner_session_id,'ownerTabId',c.owner_tab_id,'ownerRevision',c.owner_revision::text,'workspaceRevision',c.workspace_revision::text) INTO captured
   FROM manga_web.workspace_contexts c JOIN manga_web.execution_evidence i ON i.account_id=c.account_id AND i.evidence_id=(owner->>'inputEvidenceId')::uuid
   WHERE c.account_id=a AND c.context_id::text=i.protected_observation->>'contextId' AND c.generation::text=i.protected_observation->'envelope'->>'contextGeneration';
  IF captured IS NULL OR manga_web.windows_native_cost_owner_current(owner,captured) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 END IF;
 answer:=manga_web.windows_stage_cost_activate_core(owner,components);IF answer IS NULL THEN RETURN NULL;END IF;
 IF saved IS NULL THEN INSERT INTO manga_web.windows_stage_cost_owners VALUES(a,e,owner,captured,clock_timestamp());END IF;RETURN answer;
END $$;

CREATE FUNCTION windows_stage_cost_owner(selector jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.windows_native_cost_roots%ROWTYPE;o jsonb;n integer;
BEGIN
 IF NOT manga_web.windows_native_object(selector,ARRAY['executionId','inputEvidenceId','inputFingerprint','basisRef']) OR
  NOT manga_web.windows_native_cost_uuid(selector->>'executionId') OR NOT manga_web.windows_native_cost_uuid(selector->>'inputEvidenceId') OR
  (selector->>'inputFingerprint'~'^[a-f0-9]{64}$') IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_ref(selector->'basisRef') THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=manga_web.current_account() AND execution_id=(selector->>'executionId')::uuid;
 IF NOT FOUND OR r.owner_identity IS DISTINCT FROM selector THEN RETURN NULL;END IF;
 SELECT owner_body INTO o FROM manga_web.windows_stage_cost_owners WHERE account_id=r.account_id AND execution_id=r.execution_id;
 IF NOT FOUND THEN
  SELECT count(*),min(v::text)::jsonb INTO n,o FROM(SELECT DISTINCT protected_scope->'owner' v FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id) s;
  IF n<>1 THEN RETURN NULL;END IF;
 END IF;
 IF o-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR manga_web.windows_native_cost_owner_valid(o) IS DISTINCT FROM true OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id AND protected_scope->'owner' IS DISTINCT FROM o) THEN RETURN NULL;END IF;
 RETURN o;
END $$;

CREATE FUNCTION windows_stage_cost_register_owner(owner jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid;o jsonb;captured jsonb;owner_count integer;capture_count integer;sampled timestamptz;
BEGIN
 o:=manga_web.windows_stage_cost_owner(owner-'claim'-'validationAttemptRef');IF o IS NULL OR o IS DISTINCT FROM owner THEN RETURN false;END IF;e:=(owner->>'executionId')::uuid;
 PERFORM manga_web.windows_native_cost_lock_owner(e);
 SELECT owner_body INTO o FROM manga_web.windows_stage_cost_owners WHERE account_id=a AND execution_id=e;
 IF FOUND THEN RETURN o=owner;END IF;
 SELECT count(DISTINCT protected_scope->'owner'),count(DISTINCT protected_scope->'target'->'protectedOwnerCapture'),min((protected_scope->'target'->'protectedOwnerCapture')::text)::jsonb,min(created_at)
  INTO owner_count,capture_count,captured,sampled FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=e;
 IF owner_count<>1 OR capture_count<>1 OR captured IS NULL OR EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=e AND protected_scope->'owner' IS DISTINCT FROM owner) THEN RETURN false;END IF;
 INSERT INTO manga_web.windows_stage_cost_owners VALUES(a,e,owner,captured,sampled);RETURN true;
END $$;

CREATE FUNCTION windows_stage_cost_row(k text,i text,r jsonb,h text,t timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp SET timezone='UTC' AS $$
 SELECT jsonb_build_object('kind',k,'id',i,'ref',r,'contentDigest',h,'completedAt',t)
$$;

-- Cost close only: retain every original account/context/session/claim/capture
-- check and lock, separating only the active-request predicate. No B1 work
-- entrypoint calls this private helper.
DO $terminal_owner$ DECLARE definition text;needle text:='r.terminal_at IS NULL AND r.state IN(''ACCEPTED'',''ACTIVE'',''WAITING'')';active_needle text:='EXISTS(SELECT 1 FROM manga_web.active_page_requests p WHERE p.account_id=a AND p.request_id=r.request_id AND p.page_lineage_id=r.page_lineage_id)';BEGIN
 SELECT pg_get_functiondef('manga_web.windows_native_cost_owner_current(jsonb,jsonb)'::regprocedure) INTO definition;
 IF position(needle IN definition)=0 OR position(active_needle IN definition)=0 THEN RAISE EXCEPTION 'W4B2 original owner request gate missing';END IF;
 definition:=replace(definition,'FUNCTION manga_web.windows_native_cost_owner_current(','FUNCTION manga_web.windows_stage_cost_terminal_owner(');
 -- finalizeSafe removes current page occupancy. Only this cost-only terminal
 -- helper may use the same original request/page identity after that removal.
 definition:=replace(definition,active_needle,'((r.terminal_at IS NOT NULL AND r.state IN(''STOPPED'',''FAILED'')) OR '||active_needle||')');
 EXECUTE replace(definition,needle,'((r.terminal_at IS NULL AND r.state IN(''ACCEPTED'',''ACTIVE'',''WAITING'')) OR(r.terminal_at IS NOT NULL AND r.state IN(''STOPPED'',''FAILED'')))');
END $terminal_owner$;


-- Only the bounded, closed raw leaf uses this encoder. Original body digests
-- keep the unchanged canonical hash; this never encodes arbitrary JSON.
CREATE FUNCTION windows_stage_cost_leaf(kind text,chunk integer,rows jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE v jsonb;encoded text;parts text[]:='{}';r jsonb;BEGIN
 IF kind IS NULL OR kind!~'^[A-Z_]{1,64}$' OR chunk IS NULL OR chunk NOT BETWEEN 0 AND 16384 OR jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows) NOT BETWEEN 1 AND 256 THEN RETURN NULL;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(rows) LOOP
  IF NOT manga_web.windows_native_object(v,ARRAY['kind','id','ref','contentDigest','completedAt']) OR v->>'kind' IS DISTINCT FROM kind OR jsonb_typeof(v->'id') IS DISTINCT FROM 'string' OR octet_length(v->>'id')>4096 OR jsonb_typeof(v->'contentDigest') IS DISTINCT FROM 'string' OR(v->>'contentDigest'~'^[a-f0-9]{64}$') IS DISTINCT FROM true OR(jsonb_typeof(v->'completedAt')<>'null' AND(jsonb_typeof(v->'completedAt')<>'string' OR octet_length(v->>'completedAt')>64)) THEN RETURN NULL;END IF;
  r:=v->'ref';IF r<>'null'::jsonb AND(NOT manga_web.windows_native_cost_ref(r) OR jsonb_typeof(r->'evidenceId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'evidenceDigest') IS DISTINCT FROM 'string') THEN RETURN NULL;END IF;
  encoded:='{"completedAt":'||(v->'completedAt')::text||',"contentDigest":'||(v->'contentDigest')::text||',"id":'||(v->'id')::text||',"kind":'||(v->'kind')::text||',"ref":'||CASE WHEN r='null'::jsonb THEN 'null' ELSE '{"evidenceDigest":'||(r->'evidenceDigest')::text||',"evidenceId":'||(r->'evidenceId')::text||'}' END||'}';
  parts:=array_append(parts,encoded);
 END LOOP;
 encoded:='{"chunk":'||chunk::text||',"kind":'||to_jsonb(kind)::text||',"rows":['||array_to_string(parts,',')||'],"version":1}';
 IF octet_length(encoded)>1048576 THEN RETURN NULL;END IF;RETURN encoded;
END $$;

-- A single original is authorized by immutable consumer B1 binding or the
-- actual CACHE use/receipt/call/scope join. No current lease or asset check is
-- used for reading history. Missing or ambiguous originals stay visible WAIT.
CREATE FUNCTION windows_stage_cost_original(owner jsonb,job uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid:=(owner->>'executionId')::uuid;v jsonb;items jsonb;cache_used boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_cache_uses cu
  JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id)
  JOIN manga_web.windows_native_cost_scopes sc ON sc.account_id=cc.account_id AND sc.scope_id=cc.scope_id AND sc.execution_id=cc.execution_id
  JOIN manga_web.native_result_candidates nc ON nc.account_id=cu.account_id AND nc.job_id=cu.job_id AND nc.protected_candidate=cu.protected_source->'candidate'
  JOIN manga_web.native_result_receipts nr ON nr.account_id=nc.account_id AND nr.candidate_id=nc.candidate_id AND nr.protected_receipt=cu.protected_source->'receipt'
  JOIN manga_web.native_job_intents ni ON ni.account_id=cu.account_id AND ni.job_id=cu.job_id AND ni.protected_intent=cu.protected_source->'intent'
  WHERE cu.account_id=a AND cc.execution_id=e AND cu.job_id=job AND sc.protected_scope->'owner'=owner AND cu.protected_source->>'origin'='CACHE'
   AND cu.protected_source->'candidate'->>'operationInputDigest'=cc.protected_call->>'operationInputDigest' AND cu.protected_source->'candidate'->>'kernelImplementationDigest'=cc.protected_call->>'kernelDigest') INTO cache_used;
 SELECT jsonb_agg(identity) INTO items FROM(SELECT jsonb_build_object(
  'key',CASE WHEN at.attempt_id IS NULL OR se.record_id IS NULL OR li.link_id IS NULL THEN NULL ELSE jsonb_build_object('binding',at.protected_binding,'expected',jsonb_build_object('recordId',se.record_id,'recordDigest',se.digest,'linkId',li.link_id,'linkDigest',li.digest)) END,
  'scopeRef',CASE WHEN sc.scope_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(sc.scope_id,sc.scope_digest) END,
  'callRef',CASE WHEN ca.call_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(ca.call_id,ca.call_digest) END,'componentId',bi.component_id,
  'sourceOperation',CASE WHEN op.evidence_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(op.evidence_id,op.evidence_digest) END,
  'sourceTermination',CASE WHEN te.evidence_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(te.evidence_id,te.evidence_digest) END,
  'classification',CASE WHEN bi.job_id IS NOT NULL AND ca.execution_id=e AND sc.execution_id=e AND sc.protected_scope->'owner'=owner AND ni.protected_intent=bi.protected_intent AND at.attempt_id IS NOT NULL AND se.record_id IS NOT NULL AND li.link_id IS NOT NULL AND op.evidence_id IS NOT NULL AND te.evidence_id IS NOT NULL THEN 'FRESH'
   WHEN bi.job_id IS NULL AND cache_used AND at.attempt_id IS NOT NULL AND se.record_id IS NOT NULL AND li.link_id IS NOT NULL AND op.evidence_id IS NOT NULL AND te.evidence_id IS NOT NULL THEN 'CACHE' ELSE 'UNCONFIRMED' END) identity
 FROM(SELECT job job_id) j
 LEFT JOIN manga_web.windows_native_cost_bindings bi ON bi.account_id=a AND bi.job_id=j.job_id AND bi.execution_id=e
 LEFT JOIN manga_web.windows_native_cost_calls ca ON ca.account_id=a AND ca.call_id=bi.call_id AND ca.protected_call->>'componentId'=bi.component_id
 LEFT JOIN manga_web.windows_native_cost_scopes sc ON sc.account_id=a AND sc.scope_id=ca.scope_id
 LEFT JOIN manga_web.native_job_intents ni ON ni.account_id=a AND ni.job_id=j.job_id
 LEFT JOIN manga_web.native_controller_attempts at ON at.account_id=a AND at.job_id=j.job_id
 LEFT JOIN manga_web.windows_native_origins origin ON origin.account_id=a AND origin.attempt_id=at.attempt_id
 LEFT JOIN manga_web.windows_native_records se ON se.account_id=a AND se.attempt_id=at.attempt_id AND se.purpose='SEAL'
 LEFT JOIN manga_web.windows_native_links li ON li.account_id=a AND li.attempt_id=at.attempt_id
 -- Count the whole original source job before exact binding/ref filters. A
 -- second OP or TERM with another Windows ref must not disappear in the join.
 LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE kind='WINDOWS_NATIVE_OPERATION') operation_count,count(*) FILTER(WHERE kind='WINDOWS_NATIVE_TERMINATION') termination_count FROM(
  SELECT ev.kind FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id::text=origin.input_snapshot->'value'->>'executionId' AND
   ((ev.kind='WINDOWS_NATIVE_OPERATION' AND ev.protected_observation->'value'->'binding'->>'jobId'=j.job_id::text) OR(ev.kind='WINDOWS_NATIVE_TERMINATION' AND ev.protected_observation->'value'->>'jobId'=j.job_id::text)) LIMIT 3) bounded) original_pair ON true
 LEFT JOIN manga_web.execution_evidence op ON original_pair.operation_count=1 AND original_pair.termination_count=1 AND op.account_id=a AND op.execution_id::text=origin.input_snapshot->'value'->>'executionId' AND op.kind='WINDOWS_NATIVE_OPERATION' AND op.protected_observation->'value'->'binding'=at.protected_binding AND op.protected_observation->'value'->'windowsEvidenceRef'=jsonb_build_object('recordId',se.record_id,'recordDigest',se.digest,'linkId',li.link_id,'linkDigest',li.digest)
 LEFT JOIN manga_web.execution_evidence te ON te.account_id=a AND te.execution_id=op.execution_id AND te.kind='WINDOWS_NATIVE_TERMINATION' AND te.protected_observation->'value'->>'jobId'=j.job_id::text AND te.protected_observation->'value'->'windowsEvidenceRef'=op.protected_observation->'value'->'windowsEvidenceRef'
 LIMIT 2) bounded;
 IF jsonb_array_length(items)<>1 THEN RETURN jsonb_build_object('key',NULL,'scopeRef',NULL,'callRef',NULL,'componentId',NULL,'sourceOperation',NULL,'sourceTermination',NULL,'classification','UNCONFIRMED');END IF;
 RETURN items->0;
END $$;

-- Enumerate the execution footprint before considering owner bindings, profile,
-- slot state, success, GO, or the availability of a complete Windows bundle.
CREATE FUNCTION windows_stage_cost_collect(owner jsonb,"limit" integer,include_originals boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp SET timezone='UTC' AS $$
DECLARE a uuid:=manga_web.current_account();e uuid;o jsonb;r manga_web.windows_native_cost_roots%ROWTYPE;
 jobs uuid[];attempts uuid[];source_executions uuid[];rows jsonb:='[]';originals jsonb:='[]';manifest jsonb;counts jsonb:='[]';leaves jsonb:='[]';
 item record;k text;group_rows jsonb;leaf jsonb;part integer;n integer;body jsonb;identity jsonb;completion jsonb;refs jsonb;
 final_attempt jsonb;final_verified jsonb;final_count integer;completion_valid boolean:=true;leaf_text text;
BEGIN
 IF "limit" IS NULL OR "limit" NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 o:=manga_web.windows_stage_cost_owner(owner-'claim'-'validationAttemptRef');IF o IS NULL OR o IS DISTINCT FROM owner THEN RETURN NULL;END IF;e:=(o->>'executionId')::uuid;
 SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=a AND execution_id=e;
 IF(SELECT count(*) FROM(SELECT 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=e LIMIT 65)s)>64 OR
  (SELECT count(*) FROM(SELECT 1 FROM manga_web.windows_native_cost_calls WHERE account_id=a AND execution_id=e LIMIT 257)s)>256 OR
  (SELECT count(*) FROM(SELECT 1 FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND execution_id=e LIMIT 1025)s)>1024 OR
  (SELECT count(*) FROM(SELECT 1 FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND execution_id=e LIMIT 1025)s)>1024 OR
  (SELECT count(*) FROM(SELECT 1 FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=a AND c.execution_id=e LIMIT 1025)s)>1024 OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_calls WHERE account_id=a AND execution_id=e GROUP BY scope_id HAVING count(*)>64) OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND execution_id=e GROUP BY call_id HAVING count(*)>64) OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND execution_id=e GROUP BY call_id HAVING count(*)>64) THEN RETURN NULL;END IF;
 SELECT array_agg(job_id ORDER BY job_id) INTO jobs FROM(SELECT job_id FROM(
  SELECT job_id FROM manga_web.native_job_intents WHERE account_id=a AND target_kind='EXECUTION' AND target_id=e
  UNION SELECT job_id FROM manga_web.native_capacity_reservations WHERE account_id=a AND(base_execution_id=e OR source_execution_id=e)
  UNION SELECT job_id FROM manga_web.native_capacity_adoptions d JOIN manga_web.native_capacity_reservations r USING(account_id,reservation_id) WHERE d.account_id=a AND d.execution_id=e
  UNION SELECT job_id FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND execution_id=e
  UNION SELECT job_id FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND execution_id=e
  UNION SELECT u.job_id FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=a AND c.execution_id=e
  UNION SELECT i.job_id FROM manga_web.native_job_intents i WHERE i.account_id=a AND i.target_kind='REQUEST_CHECKPOINT' AND EXISTS(
   SELECT 1 FROM manga_web.execution_evidence attempt,LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(attempt.protected_observation->'value'->'targets')='array' THEN attempt.protected_observation->'value'->'targets' ELSE '[]' END) target
   WHERE attempt.account_id=a AND attempt.execution_id=e AND attempt.kind='CHECKPOINT_VALIDATION_ATTEMPT'
    AND attempt.protected_observation->'value'->>'consumerExecutionId'=e::text AND attempt.protected_observation->'value'->>'consumerRequestId'=i.target_id::text
    AND i.semantic_capture_digest=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'phase','CHECKPOINT','currentRequestId',i.target_id,'originExecutionId',target->>'sourceExecutionId','inputFingerprint',target->>'inputFingerprint','outputDigest',target->>'outputDigest')))
 ) footprint ORDER BY job_id LIMIT 65) bounded;
 jobs:=COALESCE(jobs,'{}');IF cardinality(jobs)>64 OR cardinality(jobs)>"limit" THEN RETURN NULL;END IF;
 SELECT COALESCE(array_agg(attempt_id ORDER BY attempt_id),'{}') INTO attempts FROM manga_web.native_controller_attempts WHERE account_id=a AND job_id=ANY(jobs);
 SELECT COALESCE(array_agg(DISTINCT source_execution_id),'{}') INTO source_executions FROM manga_web.native_capacity_reservations WHERE account_id=a AND job_id=ANY(jobs) AND source_execution_id IS NOT NULL;
 source_executions:=array_append(source_executions,e);
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=a AND attempt_id=ANY(attempts) GROUP BY attempt_id HAVING count(*)>64) OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=a AND attempt_id=ANY(attempts) GROUP BY attempt_id HAVING count(*)>4) THEN RETURN NULL;END IF;
 -- Each arm uses immutable metadata/digests; large source bodies are fetched
 -- only through SOURCE or one ORIGINAL at a time, never aggregated here.
 WITH bounded AS MATERIALIZED(SELECT * FROM(
  SELECT 'ENROLLMENT' k,x.execution_id::text id,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest) ref,x.evidence_digest h,NULL::timestamptz t
   FROM manga_web.windows_native_cost_enrollments x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'ROOT',e::text,manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest),manga_web.windows_native_cost_hash(jsonb_build_object('owner',o,'components',r.components,'rootDigest',r.evidence_digest)),NULL
  UNION ALL SELECT 'SCOPE',x.scope_id::text,manga_web.windows_native_cost_reference(x.scope_id,x.scope_digest),x.scope_digest,NULL FROM manga_web.windows_native_cost_scopes x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'SCOPE_END',x.scope_id::text,NULL,manga_web.windows_native_cost_hash(x.protected_end),x.created_at FROM manga_web.windows_native_cost_scope_ends x JOIN manga_web.windows_native_cost_scopes s USING(account_id,scope_id) WHERE x.account_id=a AND s.execution_id=e
  UNION ALL SELECT 'CALL',x.call_id::text,manga_web.windows_native_cost_reference(x.call_id,x.call_digest),x.call_digest,NULL FROM manga_web.windows_native_cost_calls x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'BINDING',x.job_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(jsonb_build_object('intent',x.protected_intent,'capacity',x.protected_capacity,'componentId',x.component_id,'callId',x.call_id)),NULL FROM manga_web.windows_native_cost_bindings x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'IO_START',x.operation_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(jsonb_build_object('request',x.protected_request,'principal',x.principal,'jobId',x.job_id,'context',x.read_context,'digest',x.evidence_digest)),NULL FROM manga_web.windows_native_cost_io_starts x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'IO_END',x.operation_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(x.protected_event),x.created_at FROM manga_web.windows_native_cost_io_ends x JOIN manga_web.windows_native_cost_io_starts s USING(account_id,operation_id) WHERE x.account_id=a AND s.execution_id=e
  UNION ALL SELECT 'RESULT_QUERY',x.request_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(jsonb_build_object('request',x.protected_request,'authority',x.authority,'callId',x.call_id)),NULL FROM manga_web.windows_native_cost_result_queries x WHERE x.account_id=a AND x.execution_id=e
  UNION ALL SELECT 'RESULT_CLAIM',x.request_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('requestId',x.request_id,'claimId',x.claim_id)),x.created_at FROM manga_web.windows_native_cost_result_claims x JOIN manga_web.windows_native_cost_result_queries q USING(account_id,request_id) WHERE x.account_id=a AND q.execution_id=e
  UNION ALL SELECT 'RESULT_ACK',x.request_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(x.response_ref),x.created_at FROM manga_web.windows_native_cost_result_acks x JOIN manga_web.windows_native_cost_result_queries q USING(account_id,request_id) WHERE x.account_id=a AND q.execution_id=e
  UNION ALL SELECT 'CACHE_USE',x.call_id::text||'/'||x.job_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),manga_web.windows_native_cost_hash(x.protected_source),NULL FROM manga_web.windows_native_cost_cache_uses x JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE x.account_id=a AND c.execution_id=e
  UNION ALL SELECT 'INTENT',x.job_id::text,NULL,x.intent_digest,NULL FROM manga_web.native_job_intents x WHERE x.account_id=a AND x.job_id=ANY(jobs)
  UNION ALL SELECT 'RESERVATION',x.reservation_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('reservationId',x.reservation_id,'jobId',x.job_id,'profileId',x.profile_id,'profileDigest',x.profile_digest,'ownerService',x.owner_service,'adoptionId',x.adoption_id,'sourceExecutionId',x.source_execution_id,'sourceInputEvidenceId',x.source_input_evidence_id,'baseExecutionId',x.base_execution_id)),NULL FROM manga_web.native_capacity_reservations x WHERE x.account_id=a AND x.job_id=ANY(jobs)
  UNION ALL SELECT 'ADOPTION',x.adoption_id::text,NULL,manga_web.windows_native_cost_hash(to_jsonb(x)),x.adopted_at FROM manga_web.native_capacity_adoptions x JOIN manga_web.native_capacity_reservations s USING(account_id,reservation_id) WHERE x.account_id=a AND s.job_id=ANY(jobs)
  UNION ALL SELECT 'ATTEMPT',x.attempt_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('binding',x.protected_binding,'capacity',x.protected_capacity,'jobDigest',x.protected_job->>'inputDigest','peerId',x.authenticated_peer_id,'controllerId',x.controller_id,'controllerInstanceId',x.controller_instance_id)),NULL FROM manga_web.native_controller_attempts x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'CONTROLLER_EVENT',x.event_id::text,NULL,manga_web.windows_native_cost_hash(to_jsonb(x)),x.received_at FROM manga_web.native_controller_events x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'GO_GRANT',x.job_id::text,NULL,manga_web.windows_native_cost_hash(to_jsonb(x)),x.granted_at FROM manga_web.native_controller_go_grants x WHERE x.account_id=a AND x.job_id=ANY(jobs)
  UNION ALL SELECT 'GO_CONSUMPTION',x.job_id::text,NULL,manga_web.windows_native_cost_hash(to_jsonb(x)),x.consumed_at FROM manga_web.native_job_go_consumptions x WHERE x.account_id=a AND x.job_id=ANY(jobs)
  UNION ALL SELECT 'OBSERVATION',x.observation_id::text,manga_web.windows_native_cost_reference(x.observation_id,x.observation_digest),x.observation_digest,x.received_at FROM manga_web.native_job_observations x WHERE x.account_id=a AND x.job_id=ANY(jobs)
  UNION ALL SELECT 'ORIGIN',x.attempt_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('originDigest',x.origin_digest,'frameInputDigest',x.frame_input_digest,'input',x.input_snapshot-'value','basis',x.basis_snapshot-'value')),NULL FROM manga_web.windows_native_origins x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'WINDOWS_EVENT',x.event_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('eventId',x.event_id,'sequence',x.sequence,'kind',x.kind,'payloadDigest',x.payload_digest,'sourceDigest',x.source_digest)),NULL FROM manga_web.windows_native_events x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'WINDOWS_RECORD',x.record_id::text,NULL,x.digest,NULL FROM manga_web.windows_native_records x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'WINDOWS_LINK',x.link_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('digest',x.digest,'signature',x.signature)),NULL FROM manga_web.windows_native_links x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'RAW_RESULT',x.raw_result_id::text,NULL,manga_web.windows_native_cost_hash(jsonb_build_object('resultDigest',x.result_digest,'blobRefs',x.blob_refs)),x.created_at FROM manga_web.native_controller_raw_results x WHERE x.account_id=a AND x.attempt_id=ANY(attempts)
  UNION ALL SELECT 'RAW_OBJECT',x.raw_result_id::text||'/'||x.blob_id,NULL,manga_web.windows_native_cost_hash(x.protected_receipt),x.received_at FROM manga_web.native_controller_object_receipts x JOIN manga_web.native_controller_raw_results s USING(account_id,raw_result_id) WHERE x.account_id=a AND s.attempt_id=ANY(attempts)
  UNION ALL SELECT 'EVIDENCE',x.evidence_id::text,manga_web.windows_native_cost_reference(x.evidence_id,x.evidence_digest),x.evidence_digest,x.received_at
   FROM manga_web.execution_evidence x WHERE x.account_id=a AND x.execution_id=ANY(source_executions) AND x.kind NOT IN('WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')
  ) raw_rows ORDER BY raw_rows.k COLLATE "C",raw_rows.id COLLATE "C" LIMIT 16385),
 sized AS MATERIALIZED(SELECT bounded.*,manga_web.windows_stage_cost_row(bounded.k,bounded.id,bounded.ref,bounded.h,bounded.t) v FROM bounded)
 SELECT CASE WHEN count(*)<=16384 AND bool_and(sized.h IS NOT NULL AND sized.h~'^[a-f0-9]{64}$' AND octet_length(sized.id)<=4096) AND sum(octet_length(sized.v::text)+2)<=8388608
  THEN(SELECT jsonb_agg(sized.v ORDER BY sized.k COLLATE "C",sized.id COLLATE "C") FROM sized) ELSE NULL END INTO rows FROM sized;
 IF rows IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) x GROUP BY x->>'kind',x->>'id' HAVING count(*)>1) THEN RETURN NULL;END IF;
 FOR k IN SELECT DISTINCT(value->>'kind') COLLATE "C" AS category FROM jsonb_array_elements(rows) ORDER BY category LOOP
  SELECT jsonb_agg(value ORDER BY value->>'id' COLLATE "C") INTO group_rows FROM jsonb_array_elements(rows) WHERE value->>'kind'=k;
  n:=jsonb_array_length(group_rows);counts:=counts||jsonb_build_array(jsonb_build_object('kind',k,'count',n));
  FOR part IN 0..((n-1)/256) LOOP
   SELECT jsonb_agg(value ORDER BY ord) INTO leaf FROM jsonb_array_elements(group_rows) WITH ORDINALITY v(value,ord) WHERE ord>part*256 AND ord<=(part+1)*256;
   body:=jsonb_build_object('version',1,'kind',k,'chunk',part,'rows',leaf);IF octet_length(body::text)>1048576 THEN RETURN NULL;END IF;
   leaf_text:=manga_web.windows_stage_cost_leaf(k,part,leaf);IF leaf_text IS NULL THEN RETURN NULL;END IF;
   leaves:=leaves||jsonb_build_array(jsonb_build_object('kind',k,'chunk',part,'count',jsonb_array_length(leaf),'digest',encode(sha256(convert_to(leaf_text,'UTF8')),'hex')));
  END LOOP;
 END LOOP;
 manifest:=jsonb_build_object('version',1,'chunkSize',256,'counts',counts,'leaves',leaves);
 IF include_originals THEN
  FOR item IN SELECT job FROM unnest(jobs) job ORDER BY job LOOP
   identity:=manga_web.windows_stage_cost_original(o,item.job);IF identity IS NULL THEN RETURN NULL;END IF;originals:=originals||jsonb_build_array(identity);
  END LOOP;
 END IF;
 SELECT COALESCE(jsonb_agg(manga_web.windows_native_cost_reference(evidence_id,evidence_digest) ORDER BY evidence_id),'[]') INTO refs FROM manga_web.execution_evidence
  WHERE account_id=a AND execution_id=e AND(kind='OUTCOME' OR(kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'purpose'='FINAL_COMMIT') OR
   (kind IN('CHECKPOINT_VALIDATION_VERIFIED','CHECKPOINT_VALIDATION_OPERATION') AND EXISTS(SELECT 1 FROM manga_web.execution_evidence final_attempt WHERE final_attempt.account_id=a AND final_attempt.execution_id=e AND final_attempt.kind='CHECKPOINT_VALIDATION_ATTEMPT' AND final_attempt.protected_observation->'value'->>'purpose'='FINAL_COMMIT' AND
    final_attempt.protected_observation->'value'->>'attemptId'=execution_evidence.protected_observation->'value'->>'attemptId' AND final_attempt.protected_observation->'value'->>'attemptDigest'=execution_evidence.protected_observation->'value'->>'attemptDigest')));
 SELECT count(*),min((protected_observation->'value')::text)::jsonb INTO final_count,final_attempt FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'purpose'='FINAL_COMMIT';
 IF final_count>1 THEN completion_valid:=false;
 ELSIF final_count=1 THEN
  SELECT count(*),min((protected_observation->'value')::text)::jsonb INTO final_count,final_verified FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND kind='CHECKPOINT_VALIDATION_VERIFIED' AND protected_observation->'value'->>'attemptId'=final_attempt->>'attemptId' AND protected_observation->'value'->>'attemptDigest'=final_attempt->>'attemptDigest';
  IF final_count<>1 OR jsonb_typeof(final_attempt->'targets') IS DISTINCT FROM 'array' OR manga_web.windows_stage_cost_refs(final_verified->'facts'->'operations',64) IS DISTINCT FROM true OR final_verified->'facts'->>'attemptId' IS DISTINCT FROM final_attempt->>'attemptId' THEN completion_valid:=false;
  ELSE
   IF jsonb_array_length(final_verified->'facts'->'operations')<>jsonb_array_length(final_attempt->'targets') OR
    (SELECT count(DISTINCT manga_web.windows_native_cost_hash(target)) FROM jsonb_array_elements(final_attempt->'targets') target)<>jsonb_array_length(final_attempt->'targets') OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(final_attempt->'targets') target WHERE(SELECT count(*) FROM manga_web.execution_evidence op WHERE op.account_id=a AND op.execution_id=e AND op.kind='CHECKPOINT_VALIDATION_OPERATION' AND op.protected_observation->'value'->>'attemptId'=final_attempt->>'attemptId' AND op.protected_observation->'value'->>'attemptDigest'=final_attempt->>'attemptDigest' AND op.protected_observation->'value'->>'targetDigest'=manga_web.windows_native_cost_hash(target))<>1) OR
    (SELECT count(*) FROM manga_web.execution_evidence op WHERE op.account_id=a AND op.execution_id=e AND op.kind='CHECKPOINT_VALIDATION_OPERATION' AND op.protected_observation->'value'->>'attemptId'=final_attempt->>'attemptId' AND op.protected_observation->'value'->>'attemptDigest'=final_attempt->>'attemptDigest')<>jsonb_array_length(final_verified->'facts'->'operations') OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(final_verified->'facts'->'operations') er LEFT JOIN manga_web.execution_evidence op ON op.account_id=a AND op.execution_id=e AND op.evidence_id::text=er->>'evidenceId' AND op.evidence_digest=er->>'evidenceDigest' AND op.kind='CHECKPOINT_VALIDATION_OPERATION' AND op.protected_observation->'value'->>'attemptId'=final_attempt->>'attemptId' AND op.protected_observation->'value'->>'attemptDigest'=final_attempt->>'attemptDigest'
     WHERE op.evidence_id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(final_attempt->'targets') target WHERE manga_web.windows_native_cost_hash(target)=op.protected_observation->'value'->>'targetDigest')) THEN completion_valid:=false;END IF;
  END IF;
 END IF;
 IF completion_valid AND EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND kind='OUTCOME') THEN
  completion:=jsonb_build_object('kind',CASE WHEN
   (SELECT count(*) FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND kind='OUTCOME' AND protected_observation->>'outcome'='NOT_STARTED' AND protected_observation->'started'='false'::jsonb)=1 AND
   EXISTS(SELECT 1 FROM manga_web.executions ex JOIN manga_web.processing_requests req USING(account_id,request_id) WHERE ex.account_id=a AND ex.execution_id=e AND ex.dispatch_attempted_at IS NULL AND ex.start_confirmed_at IS NULL AND(ex.state IN('REJECTED','FAILED') OR(ex.state='PREPARED' AND req.state IN('STOPPED','FAILED'))))
   THEN 'TERMINAL_PREPARATION' ELSE 'EXECUTION' END,'refs',refs);
 END IF;
 -- Once sealed, disposition is historical original membership; mutable current
 -- execution/request state must never promote or change it.
 SELECT COALESCE((SELECT seal_body->'value'->'completion' FROM manga_web.windows_stage_cost_seals WHERE account_id=a AND execution_id=e),completion) INTO completion;
 body:=jsonb_build_object('version',1,'mode','CENSUS','owner',o,'root',jsonb_build_object('ref',manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest),'components',r.components,'componentsDigest',r.components_digest),
  'inputRef',jsonb_build_object('evidenceId',o->>'inputEvidenceId','evidenceDigest',o->>'inputFingerprint'),'basisRef',o->'basisRef','rawSetDigest',manga_web.windows_native_cost_hash(manifest),'manifest',manifest,'rows',rows,'originals',originals,'completion',completion);
 IF octet_length(body::text)>8388608 THEN RETURN NULL;END IF;RETURN body;
END $$;

-- Full public/locked-final census. Raw-only collection retains identical rows,
-- kind ordering, counts, leaf bytes and manifest digest, with no original loop.
CREATE FUNCTION windows_stage_cost_census(owner jsonb,"limit" integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT manga_web.windows_stage_cost_collect(owner,"limit",true)
$$;

CREATE FUNCTION windows_stage_cost_lookup(owner jsonb,"limit" integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o jsonb;c jsonb;b jsonb;r jsonb;v manga_web.execution_evidence%ROWTYPE;s manga_web.windows_stage_cost_seals%ROWTYPE;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF owner->'version' IS DISTINCT FROM '1'::jsonb OR "limit" IS NULL OR "limit" NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 IF owner->>'mode' IN('CENSUS','SEALED') THEN
  IF NOT manga_web.windows_native_object(owner,ARRAY['version','mode','owner']) THEN RETURN NULL;END IF;
  o:=manga_web.windows_stage_cost_owner(owner->'owner');
 ELSE
  IF owner->>'mode'='ORIGINAL' THEN IF NOT manga_web.windows_native_object(owner,ARRAY['version','mode','owner','key']) THEN RETURN NULL;END IF;
  ELSIF owner->>'mode'='SOURCE' THEN IF NOT manga_web.windows_native_object(owner,ARRAY['version','mode','owner','ref']) THEN RETURN NULL;END IF;
  ELSE RETURN NULL;END IF;
  o:=manga_web.windows_stage_cost_owner((owner->'owner')-'claim'-'validationAttemptRef');IF o IS DISTINCT FROM owner->'owner' THEN RETURN NULL;END IF;
 END IF;
 IF o IS NULL THEN RETURN NULL;END IF;
 IF owner->>'mode'='CENSUS' THEN RETURN manga_web.windows_stage_cost_census(o,"limit");END IF;
 SELECT * INTO s FROM manga_web.windows_stage_cost_seals WHERE account_id=manga_web.current_account() AND execution_id=(o->>'executionId')::uuid;
 IF owner->>'mode'='SEALED' THEN
  IF s.seal_id IS NULL THEN RETURN NULL;END IF;
  c:=manga_web.windows_stage_cost_census(o,"limit");IF c IS NULL OR s.raw_set_digest IS DISTINCT FROM c->>'rawSetDigest' OR s.lookup_membership->'originals' IS DISTINCT FROM c->'originals' THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('version',1,'mode','SEALED','ref',manga_web.windows_native_cost_reference(s.seal_id,s.seal_digest),'value',s.seal_body->'value','workSet',s.work_set);
 END IF;
 IF owner->>'mode'='SOURCE' THEN
  r:=owner->'ref';IF NOT manga_web.windows_native_cost_ref(r) THEN RETURN NULL;END IF;
  IF s.seal_id IS NOT NULL THEN
   IF s.lookup_membership->>'rawSetDigest' IS DISTINCT FROM s.raw_set_digest OR s.lookup_membership->>'membershipDigest' IS DISTINCT FROM s.membership_digest OR NOT(s.lookup_membership->'sources' @> jsonb_build_array(r)) THEN RETURN NULL;END IF;
  ELSIF r IS DISTINCT FROM jsonb_build_object('evidenceId',o->>'inputEvidenceId','evidenceDigest',o->>'inputFingerprint') AND r IS DISTINCT FROM o->'basisRef' AND NOT EXISTS(
   SELECT 1 FROM manga_web.windows_native_origins origin JOIN manga_web.native_controller_attempts at USING(account_id,attempt_id)
   WHERE origin.account_id=manga_web.current_account() AND((origin.input_snapshot->>'evidenceId'=r->>'evidenceId' AND origin.input_snapshot->>'evidenceDigest'=r->>'evidenceDigest') OR(origin.basis_snapshot->>'evidenceId'=r->>'evidenceId' AND origin.basis_snapshot->>'evidenceDigest'=r->>'evidenceDigest')) AND manga_web.windows_stage_cost_original(o,at.job_id)->>'classification' IN('FRESH','CACHE')) THEN RETURN NULL;END IF;
  SELECT * INTO v FROM manga_web.execution_evidence WHERE account_id=manga_web.current_account() AND evidence_id=(r->>'evidenceId')::uuid AND evidence_digest=r->>'evidenceDigest' AND kind IN('INPUT','OPERATIONAL_COST_BASIS');
  IF NOT FOUND OR octet_length(v.protected_observation::text)>131072 OR manga_web.windows_native_cost_hash(v.protected_observation) IS DISTINCT FROM v.evidence_digest THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('version',1,'mode','SOURCE','ref',r,'kind',v.kind,'value',v.protected_observation);
 END IF;
 IF s.seal_id IS NOT NULL THEN
  IF s.lookup_membership->>'rawSetDigest' IS DISTINCT FROM s.raw_set_digest OR s.lookup_membership->>'membershipDigest' IS DISTINCT FROM s.membership_digest OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.lookup_membership->'originals') j WHERE j->'key'=owner->'key' AND j->>'classification' IN('FRESH','CACHE')) THEN RETURN NULL;END IF;
 ELSE
  IF NOT manga_web.native_controller_binding_valid(owner->'key'->'binding') THEN RETURN NULL;END IF;
 END IF;
 -- The immutable allowlist grants only its original key. Source uniqueness is
 -- still checked in history, without any current lease/session/asset gate.
 c:=manga_web.windows_stage_cost_original(o,(owner->'key'->'binding'->>'jobId')::uuid);
 IF c->'key' IS DISTINCT FROM owner->'key' OR c->>'classification' NOT IN('FRESH','CACHE') THEN RETURN NULL;END IF;
 b:=manga_web.windows_native_evidence_bundle(owner->'key','trio_web_worker');IF b IS NULL OR octet_length(b::text)>1572864 THEN RETURN NULL;END IF;
 r:=CASE WHEN b->'state'->'facts'->'basis'='null'::jsonb THEN NULL ELSE (b->'state'->'facts'->'basis')-'value' END;
 c:=jsonb_build_object('version',1,'mode','ORIGINAL','key',owner->'key','inputRef',(b->'state'->'facts'->'input')-'value','basisRef',r,
  'bundle',jsonb_set(CASE WHEN r IS NULL THEN b ELSE jsonb_set(b,'{state,facts,basis,value}','null') END,'{state,facts,input,value}','null'));
 IF octet_length(c::text)>1576960 THEN RETURN NULL;END IF;RETURN c;
END $$;

CREATE FUNCTION windows_stage_cost_project(owner jsonb,key jsonb,operation jsonb,termination jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid;o jsonb;c jsonb;identity jsonb;b jsonb;derived jsonb;source_op jsonb;source_term jsonb;
 op_ref jsonb;term_ref jsonb;base jsonb;op jsonb;term jsonb;value jsonb;quantity text;ticks numeric;source_event text;projection_kind text;component text;job uuid;
 key_hash text;op_hash text;term_hash text;op_id uuid:=gen_random_uuid();term_id uuid:=gen_random_uuid();sampled timestamptz:=clock_timestamp();saved manga_web.windows_stage_cost_projections%ROWTYPE;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();
 IF key->'version' IS DISTINCT FROM '1'::jsonb OR octet_length(key::text)>32768 THEN RETURN NULL;END IF;
 operation:=NULLIF(operation,'null'::jsonb);termination:=NULLIF(termination,'null'::jsonb);
 o:=manga_web.windows_stage_cost_owner(owner-'claim'-'validationAttemptRef');IF o IS NULL OR o IS DISTINCT FROM owner THEN RETURN NULL;END IF;e:=(o->>'executionId')::uuid;
 PERFORM manga_web.windows_native_cost_lock_owner(e);
 IF NOT manga_web.windows_stage_cost_register_owner(o) THEN RETURN NULL;END IF;
 c:=manga_web.windows_stage_cost_collect(o,64,key->>'kind'='ABSENCE');IF c IS NULL OR c->>'rawSetDigest' IS DISTINCT FROM key->>'rawSetDigest' THEN RETURN NULL;END IF;
 projection_kind:=key->>'kind';component:=key->>'componentId';
 IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_roots root,jsonb_array_elements(root.components) mapping WHERE root.account_id=a AND root.execution_id=e AND mapping->>'componentId'=component) THEN RETURN NULL;END IF;
 IF projection_kind='ABSENCE' THEN
  IF NOT manga_web.windows_native_object(key,ARRAY['version','kind','componentId','rawSetDigest','basisRef']) OR key->'basisRef' IS DISTINCT FROM o->'basisRef' OR operation IS NOT NULL OR termination IS NOT NULL OR
   EXISTS(SELECT 1 FROM jsonb_array_elements(c->'originals') original WHERE original->>'classification'='UNCONFIRMED' OR(original->>'classification'='FRESH' AND original->>'componentId'=component)) THEN RETURN NULL;END IF;
 ELSIF projection_kind='NATIVE' THEN
  IF NOT manga_web.windows_native_object(key,ARRAY['version','kind','originalKey','scopeRef','callRef','componentId','rawSetDigest']) OR operation IS NULL OR termination IS NULL OR
   octet_length(operation::text)>32768 OR octet_length(termination::text)>32768 THEN RETURN NULL;END IF;
  IF NOT manga_web.native_controller_binding_valid(key->'originalKey'->'binding') THEN RETURN NULL;END IF;
  identity:=manga_web.windows_stage_cost_original(o,(key->'originalKey'->'binding'->>'jobId')::uuid);
  IF identity->'key' IS DISTINCT FROM key->'originalKey' OR identity->>'classification' IS DISTINCT FROM 'FRESH' THEN RETURN NULL;END IF;
  IF identity IS NULL OR identity->'scopeRef' IS DISTINCT FROM key->'scopeRef' OR identity->'callRef' IS DISTINCT FROM key->'callRef' OR identity->>'componentId' IS DISTINCT FROM component THEN RETURN NULL;END IF;
  job:=(key->'originalKey'->'binding'->>'jobId')::uuid;
  b:=manga_web.windows_native_evidence_bundle(key->'originalKey','trio_web_worker');IF b IS NULL THEN RETURN NULL;END IF;
  derived:=manga_web.windows_native_evidence_values(b,key->'originalKey');source_op:=derived->'operation'->'value';source_term:=derived->'termination'->'value';
  IF NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence op WHERE op.account_id=a AND op.evidence_id::text=identity->'sourceOperation'->>'evidenceId' AND op.evidence_digest=identity->'sourceOperation'->>'evidenceDigest' AND op.protected_observation=derived->'operation' AND op.evidence_digest=manga_web.windows_native_hash(derived->'operation') AND op.protected_evidence_ref=op.evidence_id::text) OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence te WHERE te.account_id=a AND te.evidence_id::text=identity->'sourceTermination'->>'evidenceId' AND te.evidence_digest=identity->'sourceTermination'->>'evidenceDigest' AND te.protected_observation=derived->'termination' AND te.evidence_digest=manga_web.windows_native_hash(derived->'termination') AND te.protected_evidence_ref=te.evidence_id::text) THEN RETURN NULL;END IF;
  op_ref:=identity->'sourceOperation';term_ref:=identity->'sourceTermination';
  IF source_op->'accounting'='null'::jsonb THEN
   IF source_term->'termination'->>'kind' IS DISTINCT FROM 'NO_CHILD_CREATED' THEN RETURN NULL;END IF;
   quantity:='0';source_event:=source_op->'observations'->'termination'->>'evidenceId';
  ELSE
   IF jsonb_typeof(source_op->'accounting'->'value'->'userTime100ns') IS DISTINCT FROM 'string' OR jsonb_typeof(source_op->'accounting'->'value'->'kernelTime100ns') IS DISTINCT FROM 'string' OR
    (source_op->'accounting'->'value'->>'userTime100ns'~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (source_op->'accounting'->'value'->>'kernelTime100ns'~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true THEN RETURN NULL;END IF;
   IF (source_op->'accounting'->'value'->>'userTime100ns')::numeric>18446744073709551615 OR (source_op->'accounting'->'value'->>'kernelTime100ns')::numeric>18446744073709551615 THEN RETURN NULL;END IF;
   ticks:=(source_op->'accounting'->'value'->>'userTime100ns')::numeric+(source_op->'accounting'->'value'->>'kernelTime100ns')::numeric;
   quantity:=div(ticks,10000000)::text||CASE WHEN mod(ticks,10000000)=0 THEN '' ELSE '.'||rtrim(lpad(mod(ticks,10000000)::text,7,'0'),'0') END;
   source_event:=source_op->'accounting'->'event'->>'eventId';
  END IF;
  IF NOT manga_web.windows_native_cost_uuid(source_event) THEN RETURN NULL;END IF;
  value:=jsonb_build_object('version',1,'owner',o,'scopeRef',key->'scopeRef','callRef',key->'callRef','componentId',component,'source',source_op->'source','jobId',job,
   'sourceOperation',op_ref,'sourceTermination',term_ref,'windowsEvidenceRef',key->'originalKey'->'expected','sourceOperationId',job,'sourceEventId',source_event,'accounting',source_op->'accounting','quantity',quantity,'unit','windows-job-cpu-second-v1');
  SELECT jsonb_build_object('version',1,'accountId',a,'executionId',e,'inputDigest',protected_observation->>'inputDigest','inputFingerprint',o->>'inputFingerprint') INTO base FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(o->>'inputEvidenceId')::uuid;
  op:=base||jsonb_build_object('kind','WINDOWS_NATIVE_COST_ATTRIBUTION','value',value);
  term:=base||jsonb_build_object('kind','WINDOWS_NATIVE_COST_TERMINATION','value',jsonb_build_object('version',1,'owner',o,'scopeRef',key->'scopeRef','callRef',key->'callRef','componentId',component,'source',source_op->'source','jobId',job,'sourceTermination',term_ref,'windowsEvidenceRef',key->'originalKey'->'expected','terminationObservation',source_term->'terminationObservation','termination',source_term->'termination'));
  IF op IS DISTINCT FROM operation OR term IS DISTINCT FROM termination THEN RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 key_hash:=manga_web.windows_native_cost_hash(key);
 SELECT * INTO saved FROM manga_web.windows_stage_cost_projections WHERE account_id=a AND execution_id=e AND key_digest=key_hash;
 IF FOUND THEN
  IF saved.key_body IS DISTINCT FROM key OR(projection_kind='NATIVE' AND(saved.operation_body IS DISTINCT FROM operation OR saved.termination_body IS DISTINCT FROM termination)) THEN RETURN NULL;END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM manga_web.windows_stage_cost_seals WHERE account_id=a AND execution_id=e) THEN RETURN NULL;END IF;
  IF projection_kind='ABSENCE' THEN
   value:=jsonb_build_object('version',1,'componentId',component,'rawSetDigest',key->>'rawSetDigest','basisRef',o->'basisRef','operationId',gen_random_uuid(),'eventId',gen_random_uuid(),'quantity','0','unit','windows-job-cpu-second-v1');
   SELECT jsonb_build_object('version',1,'accountId',a,'executionId',e,'inputDigest',protected_observation->>'inputDigest','inputFingerprint',o->>'inputFingerprint') INTO base FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(o->>'inputEvidenceId')::uuid;
   op:=base||jsonb_build_object('kind','WINDOWS_NATIVE_COST_ABSENCE','value',value);term:=base||jsonb_build_object('kind','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','value',value);
  ELSE
   SELECT * INTO saved FROM manga_web.windows_stage_cost_projections p WHERE p.account_id=a AND p.execution_id=e AND p.kind='NATIVE' AND p.job_id=job ORDER BY p.created_at LIMIT 1;
   IF FOUND THEN
    IF saved.component_id IS DISTINCT FROM component OR saved.operation_body IS DISTINCT FROM op OR saved.termination_body IS DISTINCT FROM term THEN RETURN NULL;END IF;
    op_id:=saved.operation_id;term_id:=saved.termination_id;sampled:=saved.created_at;
   END IF;
  END IF;
  op_hash:=manga_web.windows_native_cost_hash(op);term_hash:=manga_web.windows_native_cost_hash(term);
  INSERT INTO manga_web.windows_stage_cost_projections VALUES(a,e,key_hash,key,projection_kind,component,job,key->>'rawSetDigest',op_id,op_hash,op,term_id,term_hash,term,sampled);
  INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
   SELECT a,id,e,body->>'kind',h,id::text,sampled,body FROM(VALUES(op_id,op,op_hash),(term_id,term,term_hash)) v(id,body,h) ON CONFLICT(account_id,execution_id,kind,evidence_digest) DO NOTHING;
  SELECT * INTO saved FROM manga_web.windows_stage_cost_projections WHERE account_id=a AND execution_id=e AND key_digest=key_hash;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=saved.operation_id AND execution_id=e AND evidence_digest=saved.operation_digest AND protected_observation=saved.operation_body AND protected_evidence_ref=evidence_id::text) OR
  NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=saved.termination_id AND execution_id=e AND evidence_digest=saved.termination_digest AND protected_observation=saved.termination_body AND protected_evidence_ref=evidence_id::text) THEN RETURN NULL;END IF;
 b:=jsonb_build_object('version',1,'kind',projection_kind,'operation',manga_web.windows_native_cost_reference(saved.operation_id,saved.operation_digest),'termination',manga_web.windows_native_cost_reference(saved.termination_id,saved.termination_digest));
 IF projection_kind='ABSENCE' THEN b:=b||jsonb_build_object('value',saved.operation_body->'value');END IF;RETURN b;
END $$;
CREATE FUNCTION windows_stage_cost_refs(v jsonb,maximum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE item jsonb;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(v)>maximum OR(SELECT count(DISTINCT value->>'evidenceId') FROM jsonb_array_elements(v))<>jsonb_array_length(v) THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP IF NOT manga_web.windows_native_cost_ref(item) THEN RETURN false;END IF;END LOOP;RETURN true;
END $$;
CREATE FUNCTION windows_stage_cost_sorted_refs(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'evidenceId' COLLATE "C",value->>'evidenceDigest' COLLATE "C"),'[]') FROM jsonb_array_elements(v)
$$;
CREATE FUNCTION windows_stage_cost_evidence_strings(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(value->>'evidenceId' ORDER BY value->>'evidenceId' COLLATE "C"),'[]') FROM jsonb_array_elements(v)
$$;
CREATE FUNCTION windows_stage_cost_decimal(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}'~'^(0|[1-9][0-9]{0,15})([.][0-9]{1,12})?$',false)
$$;
CREATE FUNCTION windows_stage_cost_amount(basis jsonb,facts jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE snapshot jsonb:=basis->'snapshot';capture jsonb:=basis->'capture';rate jsonb;q jsonb;total numeric;rounded numeric;component_count integer;
BEGIN
 IF NOT manga_web.windows_native_object(facts,ARRAY['provider','quantities','allocation']) OR snapshot->>'state' IS DISTINCT FROM 'MEASURED' OR snapshot->>'rounding' NOT IN('UP','HALF_UP') OR snapshot->'usdScale' IS DISTINCT FROM '12'::jsonb OR jsonb_typeof(snapshot->'evidenceRefs') IS DISTINCT FROM 'array' OR jsonb_array_length(snapshot->'evidenceRefs')=0 THEN RETURN NULL;END IF;
 IF NOT manga_web.windows_native_object(facts->'provider',ARRAY['scope','captureDigest','state','actualUsd','evidenceRefs']) OR NOT manga_web.windows_native_object(facts->'allocation',ARRAY['captureDigest','mode','funding','basisVersion','state','actualUsd','evidenceRefs']) THEN RETURN NULL;END IF;
 IF facts->'provider'->>'scope' IS DISTINCT FROM 'ACTUAL_AI_USD' OR facts->'provider'->>'state' IS DISTINCT FROM 'CONFIRMED' OR facts->'allocation'->>'state' IS DISTINCT FROM 'CONFIRMED' OR
  facts->'provider'->>'captureDigest' IS DISTINCT FROM basis->>'captureDigest' OR facts->'allocation'->>'captureDigest' IS DISTINCT FROM basis->>'captureDigest' OR
  facts->'allocation'->>'mode' IS DISTINCT FROM capture->>'mode' OR facts->'allocation'->>'basisVersion' IS DISTINCT FROM snapshot->>'basisVersion' OR
  facts->'allocation'->>'funding' IS DISTINCT FROM(CASE WHEN capture->>'mode'='FREE' THEN 'FREE_OPERATIONS' ELSE 'PAID_PROCESSING' END) OR
  NOT manga_web.windows_stage_cost_decimal(facts->'provider'->'actualUsd') OR NOT manga_web.windows_stage_cost_decimal(facts->'allocation'->'actualUsd') OR jsonb_typeof(facts->'quantities') IS DISTINCT FROM 'array' OR jsonb_typeof(snapshot->'components') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 component_count:=jsonb_array_length(snapshot->'components');IF component_count>64 OR jsonb_array_length(facts->'quantities')<>component_count OR(SELECT count(DISTINCT value->>'componentId') FROM jsonb_array_elements(facts->'quantities'))<>component_count THEN RETURN NULL;END IF;
 total:=(facts->'provider'->>'actualUsd')::numeric+(facts->'allocation'->>'actualUsd')::numeric;
 FOR rate IN SELECT value FROM jsonb_array_elements(snapshot->'components') LOOP
  SELECT value INTO q FROM jsonb_array_elements(facts->'quantities') WHERE value->>'componentId'=rate->>'componentId';
  IF q IS NULL OR NOT manga_web.windows_native_object(q,ARRAY['componentId','captureDigest','state','quantity','unit','evidenceRefs']) OR q->>'captureDigest' IS DISTINCT FROM basis->>'captureDigest' OR q->>'state' IS DISTINCT FROM 'CONFIRMED' OR q->>'unit' IS DISTINCT FROM rate->>'unit' OR
   NOT manga_web.windows_stage_cost_decimal(q->'quantity') OR NOT manga_web.windows_stage_cost_decimal(rate->'usdPerUnit') OR COALESCE(length(rate->>'rateVersion'),0)=0 OR jsonb_typeof(rate->'evidenceRefs') IS DISTINCT FROM 'array' OR jsonb_array_length(rate->'evidenceRefs')=0 THEN RETURN NULL;END IF;
  total:=total+(q->>'quantity')::numeric*(rate->>'usdPerUnit')::numeric;
 END LOOP;
 rounded:=CASE WHEN snapshot->>'rounding'='UP' THEN ceil(total*1000000000000)*0.000000000001 ELSE round(total,12) END;
 IF rounded>=10000000000000000 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('exactTotalUsd',total::text,'actualUsd',rounded::text);
END $$;

CREATE FUNCTION windows_stage_cost_non_windows(work jsonb,owner jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid:=(owner->>'executionId')::uuid;s jsonb;r jsonb;f jsonb;proof jsonb;proof_kind text;fact_target text;all_refs jsonb:='[]';seen uuid[]:='{}';used uuid[]:='{}';matching integer;terminal_count integer;expected_refs jsonb;reference_group_keys jsonb[]:='{}';reference_group_refs jsonb[]:='{}';reference_group_key jsonb;reference_group_index integer;
BEGIN
 IF NOT manga_web.windows_native_object(work,ARRAY['version','executionId','inputFingerprint','captureDigest','completion','joinedEvidence','terminationEvidence','sources','facts']) OR work->'version' IS DISTINCT FROM '1'::jsonb OR
  work->>'executionId' IS DISTINCT FROM e::text OR work->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR octet_length(work::text)>1048576 OR
  NOT manga_web.windows_stage_cost_refs(work->'joinedEvidence',2046) OR NOT manga_web.windows_stage_cost_refs(work->'terminationEvidence',2046) OR jsonb_typeof(work->'sources') IS DISTINCT FROM 'array' OR
  NOT manga_web.windows_native_object(work->'facts',ARRAY['provider','quantities','allocation']) OR jsonb_typeof(work->'facts'->'quantities') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(work->'facts'->'quantities')>64 THEN RETURN false;END IF;
 IF jsonb_array_length(work->'sources')>2046 OR jsonb_array_length(work->'terminationEvidence')=0 OR jsonb_array_length(work->'joinedEvidence')+jsonb_array_length(work->'terminationEvidence')>2046 OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(work->'joinedEvidence') x,jsonb_array_elements(work->'terminationEvidence') y WHERE x->>'evidenceId'=y->>'evidenceId') THEN RETURN false;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(work->'sources') LOOP
  IF NOT manga_web.windows_native_object(s,ARRAY['sourceOperationId','sourceEventId','target','componentId','evidence']) OR NOT manga_web.windows_native_cost_uuid(s->>'sourceOperationId') OR NOT manga_web.windows_native_cost_uuid(s->>'sourceEventId') OR s->>'target' NOT IN('PROVIDER','QUANTITY','ALLOCATION') OR
   NOT manga_web.windows_stage_cost_refs(s->'evidence',2046) OR jsonb_array_length(s->'evidence')=0 THEN RETURN false;END IF;
  IF (s->>'sourceOperationId')::uuid=ANY(seen) OR(s->>'sourceEventId')::uuid=ANY(seen) OR s->>'sourceOperationId'=s->>'sourceEventId' THEN RETURN false;END IF;seen:=seen||ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid];
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND job_id=ANY(ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid])) OR EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=a AND event_id=ANY(ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid])) THEN RETURN false;END IF;
  IF s->>'target'='QUANTITY' THEN SELECT value INTO f FROM jsonb_array_elements(work->'facts'->'quantities') WHERE value->>'componentId'=s->>'componentId';
  ELSE IF s->'componentId'<>'null'::jsonb THEN RETURN false;END IF;f:=CASE WHEN s->>'target'='PROVIDER' THEN work->'facts'->'provider' ELSE work->'facts'->'allocation' END;END IF;
  IF f IS NULL OR f='null'::jsonb THEN RETURN false;END IF;matching:=0;
  reference_group_key:=jsonb_build_array(s->>'target',s->'componentId');
  reference_group_index:=array_position(reference_group_keys,reference_group_key);
  IF reference_group_index IS NULL THEN
   SELECT COALESCE(jsonb_agg(er.value->>'evidenceId' ORDER BY er.value->>'evidenceId' COLLATE "C"),'[]') INTO expected_refs
    FROM jsonb_array_elements(work->'sources') same_source,LATERAL jsonb_array_elements(same_source->'evidence') er
    WHERE same_source->>'target'=s->>'target' AND same_source->'componentId'=s->'componentId';
   reference_group_keys:=array_append(reference_group_keys,reference_group_key);
   reference_group_refs:=array_append(reference_group_refs,expected_refs);
  ELSE expected_refs:=reference_group_refs[reference_group_index];END IF;
  IF f->'evidenceRefs' IS DISTINCT FROM expected_refs THEN RETURN false;END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(s->'evidence') LOOP
   IF (r->>'evidenceId')::uuid=ANY(used) OR NOT(work->'joinedEvidence' @> jsonb_build_array(r)) THEN RETURN false;END IF;used:=array_append(used,(r->>'evidenceId')::uuid);all_refs:=all_refs||jsonb_build_array(r);
   SELECT protected_observation,kind INTO proof,proof_kind FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND evidence_id=(r->>'evidenceId')::uuid AND evidence_digest=r->>'evidenceDigest' AND protected_evidence_ref=evidence_id::text;
   IF proof IS NULL OR manga_web.windows_native_cost_hash(proof) IS DISTINCT FROM r->>'evidenceDigest' THEN RETURN false;END IF;
   -- An original start/source cannot be borrowed as another operation's extra
   -- reference. Each such row must declare its own operation/event and fact.
   IF proof_kind='CHECKPOINT_VALIDATION_OPERATION' THEN
    -- Original v1 semantic evidence uses semantic.eventId, not a cost fact.
    -- It is auxiliary evidence of this exact declared semantic source; the
    -- separately required cost SOURCE/fact and original end remain mandatory.
    IF NOT manga_web.windows_native_object(proof,ARRAY['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']) OR proof->'version' IS DISTINCT FROM '1'::jsonb OR proof->>'kind' IS DISTINCT FROM proof_kind OR proof->>'accountId' IS DISTINCT FROM a::text OR proof->>'executionId' IS DISTINCT FROM e::text OR proof->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR
     NOT manga_web.windows_native_object(proof->'value',ARRAY['version','operationId','attemptId','attemptDigest','validationVersion','targetDigest','sourceInputFingerprint','outputDigest','semantic','storage','native']) OR proof->'value'->'version' IS DISTINCT FROM '1'::jsonb OR proof->'value'->>'validationVersion' IS DISTINCT FROM 'checkpoint-validation-v1' OR proof->'value'->'native' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(proof->'value'->'storage') IS DISTINCT FROM 'array' OR
     NOT manga_web.windows_native_object(proof->'value'->'semantic',ARRAY['eventId','kind','outcome']) OR proof->'value'->'semantic'->>'kind' IS DISTINCT FROM 'SEMANTIC_VALIDATION' OR proof->'value'->'semantic'->>'outcome' IS DISTINCT FROM 'RETURNED' OR proof->'value'->>'operationId' IS DISTINCT FROM s->>'sourceOperationId' OR proof->'value'->'semantic'->>'eventId' IS DISTINCT FROM s->>'sourceEventId' OR
     s->>'target' IS DISTINCT FROM 'QUANTITY' OR f->>'componentId' IS DISTINCT FROM s->>'componentId' OR f->>'captureDigest' IS DISTINCT FROM work->>'captureDigest' OR NOT EXISTS(
      SELECT 1 FROM manga_web.execution_evidence basis,LATERAL jsonb_array_elements(basis.protected_observation->'value'->'snapshot'->'components') rate WHERE basis.account_id=a AND basis.execution_id=e AND basis.kind='OPERATIONAL_COST_BASIS' AND basis.evidence_id::text=owner->'basisRef'->>'evidenceId' AND basis.evidence_digest=owner->'basisRef'->>'evidenceDigest' AND basis.protected_observation->'value'->>'captureDigest'=f->>'captureDigest' AND rate->>'componentId'=s->>'componentId' AND rate->>'kind'='RENDER' AND rate->>'unit'=f->>'unit') OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'value'->'storage') observed WHERE NOT manga_web.windows_native_object(observed,ARRAY['eventId','kind','assetId','sha256','bytesLength','outcome']) OR observed->>'kind' IS DISTINCT FROM 'OBJECT_READ' OR observed->>'outcome' IS DISTINCT FROM 'RETURNED' OR NOT EXISTS(
      SELECT 1 FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=a AND st.execution_id=e AND st.event_id::text=observed->>'eventId' AND st.protected_request->>'kind'='OBJECT_READ' AND st.protected_request->>'key'=a::text||'/'||(observed->>'assetId') AND en.protected_event->>'state'='RETURNED' AND en.protected_event->'observed'=jsonb_build_object('sha256',observed->>'sha256','bytesLength',observed->>'bytesLength') AND EXISTS(
       SELECT 1 FROM jsonb_array_elements(work->'sources') io_source WHERE io_source->>'sourceOperationId'=st.operation_id::text AND io_source->>'sourceEventId'=st.event_id::text))) THEN RETURN false;END IF;
   ELSIF proof->'value' ?| ARRAY['operationId','eventId','fact'] AND(proof->>'accountId' IS DISTINCT FROM a::text OR proof->>'executionId' IS DISTINCT FROM e::text OR proof->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR proof->'value'->>'operationId' IS DISTINCT FROM s->>'sourceOperationId' OR proof->'value'->>'eventId' IS DISTINCT FROM s->>'sourceEventId' OR proof->'value'->'fact' IS DISTINCT FROM(f-'evidenceRefs')) THEN RETURN false;END IF;
   IF proof->>'accountId'=a::text AND proof->>'executionId'=e::text AND proof->>'inputFingerprint'=owner->>'inputFingerprint' AND proof->'value'->>'operationId'=s->>'sourceOperationId' AND proof->'value'->>'eventId'=s->>'sourceEventId' AND proof->'value'->'fact'=(f-'evidenceRefs') THEN matching:=matching+1;END IF;
  END LOOP;
  IF matching<>1 THEN RETURN false;END IF;
  SELECT count(*) INTO terminal_count FROM jsonb_array_elements(work->'terminationEvidence') tr JOIN manga_web.execution_evidence v ON v.account_id=a AND v.execution_id=e AND v.evidence_id::text=tr.value->>'evidenceId' AND v.evidence_digest=tr.value->>'evidenceDigest',
   LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.protected_observation->'value'->'operations')='array' THEN v.protected_observation->'value'->'operations' ELSE '[]' END) ended
   WHERE ended->>'operationId'=s->>'sourceOperationId' AND ended->>'eventId'=s->>'sourceEventId' AND ended->>'outcome' IN('RETURNED','THREW');
  IF terminal_count<>1 THEN RETURN false;END IF;
 END LOOP;
 -- Source traversal alone cannot establish that a fact has any source. Every
 -- provider, allocation and nonWindows quantity needs its complete exact set.
 FOR fact_target,f IN SELECT 'PROVIDER'::text,work->'facts'->'provider'
  UNION ALL SELECT 'ALLOCATION'::text,work->'facts'->'allocation'
  UNION ALL SELECT 'QUANTITY'::text,value FROM jsonb_array_elements(work->'facts'->'quantities') LOOP
  SELECT COALESCE(jsonb_agg(er.value->>'evidenceId' ORDER BY er.value->>'evidenceId' COLLATE "C"),'[]') INTO expected_refs
   FROM jsonb_array_elements(work->'sources') same_source,LATERAL jsonb_array_elements(same_source->'evidence') er
   WHERE same_source->>'target'=fact_target AND same_source->'componentId'=CASE WHEN fact_target='QUANTITY' THEN f->'componentId' ELSE 'null'::jsonb END;
  IF expected_refs='[]'::jsonb OR f->'evidenceRefs' IS DISTINCT FROM expected_refs THEN RETURN false;END IF;
 END LOOP;
 -- Every original source/start and original nonWindows end belongs to this
 -- complete set. A caller cannot omit a pending or expensive original row.
 IF EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND
   ((ev.protected_observation->'value' ?| ARRAY['operationId','eventId','fact']) AND ev.kind NOT IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION','CHECKPOINT_VALIDATION_OPERATION','WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')) AND
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work->'joinedEvidence') er WHERE er->>'evidenceId'=ev.evidence_id::text AND er->>'evidenceDigest'=ev.evidence_digest)) OR
  EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND jsonb_typeof(ev.protected_observation->'value'->'operations')='array' AND ev.kind NOT IN('CHECKPOINT_VALIDATION_VERIFIED') AND
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work->'terminationEvidence') er WHERE er->>'evidenceId'=ev.evidence_id::text AND er->>'evidenceDigest'=ev.evidence_digest)) THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(work->'terminationEvidence') LOOP
  SELECT protected_observation INTO proof FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND evidence_id=(r->>'evidenceId')::uuid AND evidence_digest=r->>'evidenceDigest' AND protected_evidence_ref=evidence_id::text;
  IF proof IS NULL OR manga_web.windows_native_cost_hash(proof) IS DISTINCT FROM r->>'evidenceDigest' THEN RETURN false;END IF;
  IF proof->'value' ? 'operations' THEN
   IF jsonb_typeof(proof->'value'->'operations') IS DISTINCT FROM 'array' OR jsonb_array_length(proof->'value'->'operations')>2046 OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'value'->'operations') ended WHERE
     NOT manga_web.windows_native_object(ended,ARRAY['operationId','eventId','outcome']) OR ended->>'outcome' NOT IN('RETURNED','THREW') OR
     (SELECT count(*) FROM jsonb_array_elements(work->'sources') src WHERE src->>'sourceOperationId'=ended->>'operationId' AND src->>'sourceEventId'=ended->>'eventId')<>1) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN manga_web.windows_stage_cost_sorted_refs(all_refs)=manga_web.windows_stage_cost_sorted_refs(work->'joinedEvidence');
END $$;

CREATE FUNCTION windows_stage_cost_seal(owner jsonb,candidate jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid;o jsonb;c jsonb;non_windows jsonb;work jsonb;basis jsonb;capture jsonb;
 membership jsonb;lookup_membership jsonb;scope_refs jsonb;attributions jsonb:='[]';absences jsonb:='[]';terminations jsonb:='[]';sources jsonb:='[]';quantities jsonb:='[]';source jsonb;original jsonb;mapping jsonb;q jsonb;refs jsonb;seal_value jsonb;body jsonb;final_work jsonb;
 p manga_web.windows_stage_cost_projections%ROWTYPE;saved manga_web.windows_stage_cost_seals%ROWTYPE;related uuid;event uuid;seal_id uuid:=gen_random_uuid();seal_hash text;sampled timestamptz:=clock_timestamp();ticks numeric;n integer;quantity text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL;END IF;
 IF NOT manga_web.windows_native_object(candidate,ARRAY['version','rawSetDigest','membershipDigest','nonWindowsWorkSet','workSet','completion']) OR candidate->'version' IS DISTINCT FROM '1'::jsonb OR octet_length(candidate::text)>3145728 THEN RETURN NULL;END IF;
 o:=manga_web.windows_stage_cost_owner(owner-'claim'-'validationAttemptRef');IF o IS NULL OR o IS DISTINCT FROM owner THEN RETURN NULL;END IF;e:=(o->>'executionId')::uuid;
 PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
 FOR related IN SELECT DISTINCT execution_id FROM(SELECT e execution_id UNION ALL SELECT source_execution_id FROM manga_web.native_capacity_reservations WHERE account_id=a AND(base_execution_id=e OR source_execution_id=e OR job_id IN(SELECT job_id FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND execution_id=e))) linked WHERE execution_id IS NOT NULL ORDER BY execution_id LOOP
  PERFORM manga_web.windows_native_cost_lock_owner(related);
 END LOOP;
 IF NOT manga_web.windows_stage_cost_register_owner(o) THEN RETURN NULL;END IF;
 -- VOLATILE census obtains fresh READ COMMITTED statement snapshots after locks.
 c:=manga_web.windows_stage_cost_census(o,64);IF c IS NULL OR c->>'rawSetDigest' IS DISTINCT FROM candidate->>'rawSetDigest' THEN RETURN NULL;END IF;
 SELECT * INTO saved FROM manga_web.windows_stage_cost_seals WHERE account_id=a AND execution_id=e;
 IF FOUND THEN
  final_work:=jsonb_set(candidate->'workSet','{terminationEvidence}',manga_web.windows_stage_cost_sorted_refs(candidate->'workSet'->'terminationEvidence'||jsonb_build_array(manga_web.windows_native_cost_reference(saved.seal_id,saved.seal_digest))));
  IF saved.owner_body=o AND saved.raw_set_digest=c->>'rawSetDigest' AND saved.membership_digest=candidate->>'membershipDigest' AND saved.work_set=final_work THEN RETURN jsonb_build_object('version',1,'mode','SEALED','ref',manga_web.windows_native_cost_reference(saved.seal_id,saved.seal_digest),'value',saved.seal_body->'value','workSet',saved.work_set);END IF;RETURN NULL;
 END IF;
 SELECT owner_capture INTO capture FROM manga_web.windows_stage_cost_owners WHERE account_id=a AND execution_id=e;
 IF capture IS NULL THEN RETURN NULL;END IF;
 IF c->'completion'->>'kind'='TERMINAL_PREPARATION' THEN
  IF manga_web.windows_stage_cost_terminal_owner(o,capture) IS DISTINCT FROM true OR
   NOT EXISTS(SELECT 1 FROM manga_web.executions ex JOIN manga_web.processing_requests req USING(account_id,request_id) WHERE ex.account_id=a AND ex.execution_id=e AND ex.dispatch_attempted_at IS NULL AND ex.start_confirmed_at IS NULL AND(ex.state IN('REJECTED','FAILED') OR(ex.state='PREPARED' AND req.state IN('STOPPED','FAILED')))) OR
   (SELECT count(*) FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND kind='OUTCOME' AND protected_observation->>'outcome'='NOT_STARTED' AND protected_observation->'started'='false'::jsonb)<>1 OR
   EXISTS(SELECT 1 FROM jsonb_array_elements(c->'rows') raw WHERE raw->>'kind' IN('GO_GRANT','GO_CONSUMPTION')) THEN RETURN NULL;END IF;
 ELSIF manga_web.windows_native_cost_owner_current(o,capture) IS DISTINCT FROM true THEN
  IF manga_web.windows_stage_cost_terminal_owner(o,capture) IS DISTINCT FROM true OR NOT EXISTS(
   SELECT 1 FROM manga_web.executions ex JOIN manga_web.processing_requests req USING(account_id,request_id)
   JOIN manga_web.execution_evidence outcome ON outcome.account_id=ex.account_id AND outcome.execution_id=ex.execution_id AND outcome.kind='OUTCOME'
   WHERE ex.account_id=a AND ex.execution_id=e AND req.state IN('STOPPED','FAILED') AND req.terminal_at IS NOT NULL
    AND ex.state='FAILED' AND ex.dispatch_attempted_at IS NOT NULL AND ex.finished_confirmed_at IS NOT NULL
    AND outcome.protected_observation=ex.output_envelope AND outcome.protected_observation->>'outcome'='FAILURE'
    AND outcome.protected_evidence_ref=outcome.evidence_id::text
    AND manga_web.windows_native_cost_hash(outcome.protected_observation)=outcome.evidence_digest
    AND(SELECT count(*) FROM manga_web.execution_evidence v WHERE v.account_id=a AND v.execution_id=e AND v.kind='OUTCOME')=1
  ) THEN RETURN NULL;END IF;
 END IF;
 IF c->'completion'='null'::jsonb OR c->'completion' IS DISTINCT FROM candidate->'completion' OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scopes s LEFT JOIN manga_web.windows_native_cost_scope_ends z USING(account_id,scope_id) WHERE s.account_id=a AND s.execution_id=e AND z.scope_id IS NULL) OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts s LEFT JOIN manga_web.windows_native_cost_io_ends z USING(account_id,operation_id) WHERE s.account_id=a AND s.execution_id=e AND z.operation_id IS NULL) OR
  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_queries s LEFT JOIN manga_web.windows_native_cost_result_acks z USING(account_id,request_id) LEFT JOIN manga_web.windows_native_cost_result_claims d USING(account_id,request_id) WHERE s.account_id=a AND s.execution_id=e AND(z.request_id IS NULL OR d.request_id IS NULL)) OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(c->'originals') raw_original WHERE raw_original.value->>'classification'='UNCONFIRMED' OR raw_original.value->'key'='null'::jsonb) THEN RETURN NULL;END IF;
 non_windows:=candidate->'nonWindowsWorkSet';work:=candidate->'workSet';
 IF NOT manga_web.windows_stage_cost_non_windows(non_windows,o) OR NOT manga_web.windows_native_object(work,ARRAY['version','executionId','inputFingerprint','captureDigest','completion','joinedEvidence','terminationEvidence','sources','facts']) OR
  work->>'completion' IS DISTINCT FROM candidate->'completion'->>'kind' OR non_windows->>'completion' IS DISTINCT FROM work->>'completion' THEN RETURN NULL;END IF;
 SELECT protected_observation->'value' INTO basis FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(o->'basisRef'->>'evidenceId')::uuid AND evidence_digest=o->'basisRef'->>'evidenceDigest';
 IF non_windows->>'captureDigest' IS DISTINCT FROM basis->>'captureDigest' OR work->>'captureDigest' IS DISTINCT FROM basis->>'captureDigest' OR work->>'executionId' IS DISTINCT FROM e::text OR work->>'inputFingerprint' IS DISTINCT FROM o->>'inputFingerprint' OR work->'version'<>'1'::jsonb THEN RETURN NULL;END IF;
 SELECT COALESCE(jsonb_agg(value->'ref' ORDER BY value->>'id' COLLATE "C"),'[]') INTO scope_refs FROM jsonb_array_elements(c->'rows') WHERE value->>'kind'='SCOPE';
 FOR original IN SELECT value FROM jsonb_array_elements(c->'originals') WHERE value->>'classification'='FRESH' LOOP
  IF(SELECT count(*) FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest' AND pr.kind='NATIVE' AND pr.job_id::text=original->'key'->'binding'->>'jobId')<>1 THEN RETURN NULL;END IF;
  SELECT * INTO p FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest' AND pr.kind='NATIVE' AND pr.job_id::text=original->'key'->'binding'->>'jobId';
  IF p.key_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.key_body) OR p.key_body IS DISTINCT FROM jsonb_build_object('version',1,'kind','NATIVE','originalKey',original->'key','scopeRef',original->'scopeRef','callRef',original->'callRef','componentId',original->>'componentId','rawSetDigest',c->>'rawSetDigest') OR p.component_id IS DISTINCT FROM original->>'componentId' OR
   p.operation_body->'value'->'owner' IS DISTINCT FROM o OR p.termination_body->'value'->'owner' IS DISTINCT FROM o OR p.operation_body->'value'->'sourceOperation' IS DISTINCT FROM original->'sourceOperation' OR p.operation_body->'value'->'sourceTermination' IS DISTINCT FROM original->'sourceTermination' OR p.termination_body->'value'->'sourceTermination' IS DISTINCT FROM original->'sourceTermination' OR
   p.operation_body->'value'->'scopeRef' IS DISTINCT FROM original->'scopeRef' OR p.termination_body->'value'->'scopeRef' IS DISTINCT FROM original->'scopeRef' OR p.operation_body->'value'->'callRef' IS DISTINCT FROM original->'callRef' OR p.termination_body->'value'->'callRef' IS DISTINCT FROM original->'callRef' OR
   p.operation_body->'value'->>'componentId' IS DISTINCT FROM original->>'componentId' OR p.termination_body->'value'->>'componentId' IS DISTINCT FROM original->>'componentId' OR p.operation_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.operation_body) OR p.termination_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.termination_body) OR p.operation_id=p.termination_id OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.evidence_id=p.operation_id AND ev.evidence_digest=p.operation_digest AND ev.protected_observation=p.operation_body AND ev.protected_evidence_ref=ev.evidence_id::text) OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.evidence_id=p.termination_id AND ev.evidence_digest=p.termination_digest AND ev.protected_observation=p.termination_body AND ev.protected_evidence_ref=ev.evidence_id::text) OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.evidence_id::text=original->'sourceOperation'->>'evidenceId' AND ev.evidence_digest=original->'sourceOperation'->>'evidenceDigest' AND ev.evidence_digest=manga_web.windows_native_hash(ev.protected_observation) AND ev.protected_evidence_ref=ev.evidence_id::text AND ev.protected_observation->'value'->'binding'=original->'key'->'binding' AND ev.protected_observation->'value'->'windowsEvidenceRef'=original->'key'->'expected' AND ev.protected_observation->'value'->'source'=p.operation_body->'value'->'source' AND ev.protected_observation->'value'->'accounting'=p.operation_body->'value'->'accounting') OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.evidence_id::text=original->'sourceTermination'->>'evidenceId' AND ev.evidence_digest=original->'sourceTermination'->>'evidenceDigest' AND ev.evidence_digest=manga_web.windows_native_hash(ev.protected_observation) AND ev.protected_evidence_ref=ev.evidence_id::text AND ev.protected_observation->'value'->'source'=p.termination_body->'value'->'source' AND ev.protected_observation->'value'->'termination'=p.termination_body->'value'->'termination' AND ev.protected_observation->'value'->'terminationObservation'=p.termination_body->'value'->'terminationObservation') THEN RETURN NULL;END IF;
  attributions:=attributions||jsonb_build_array(manga_web.windows_native_cost_reference(p.operation_id,p.operation_digest));terminations:=terminations||jsonb_build_array(manga_web.windows_native_cost_reference(p.termination_id,p.termination_digest));
  sources:=sources||jsonb_build_array(jsonb_build_object('sourceOperationId',p.operation_body->'value'->>'sourceOperationId','sourceEventId',p.operation_body->'value'->>'sourceEventId','target','QUANTITY','componentId',p.component_id,'evidence',jsonb_build_array(manga_web.windows_native_cost_reference(p.operation_id,p.operation_digest))));
 END LOOP;
 FOR mapping IN SELECT DISTINCT jsonb_build_object('componentId',m->>'componentId') FROM manga_web.windows_native_cost_roots r,jsonb_array_elements(r.components)m WHERE r.account_id=a AND r.execution_id=e LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(non_windows->'facts'->'quantities') qf WHERE qf.value->>'componentId'=mapping->>'componentId') THEN RETURN NULL;END IF;
  SELECT count(*),COALESCE(sum((pr.operation_body->'value'->'accounting'->'value'->>'userTime100ns')::numeric+(pr.operation_body->'value'->'accounting'->'value'->>'kernelTime100ns')::numeric),0),COALESCE(jsonb_agg(manga_web.windows_native_cost_reference(pr.operation_id,pr.operation_digest) ORDER BY pr.operation_id),'[]') INTO n,ticks,refs
   FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest' AND pr.kind='NATIVE' AND pr.component_id=mapping->>'componentId';
  IF n=0 THEN
   IF(SELECT count(*) FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest' AND pr.kind='ABSENCE' AND pr.component_id=mapping->>'componentId')<>1 THEN RETURN NULL;END IF;
   SELECT * INTO p FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest' AND pr.kind='ABSENCE' AND pr.component_id=mapping->>'componentId';
   IF NOT FOUND OR p.key_body IS DISTINCT FROM jsonb_build_object('version',1,'kind','ABSENCE','componentId',mapping->>'componentId','rawSetDigest',c->>'rawSetDigest','basisRef',o->'basisRef') OR p.key_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.key_body) OR p.operation_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.operation_body) OR p.termination_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(p.termination_body) OR p.operation_id=p.termination_id OR
    p.operation_body->'value' IS DISTINCT FROM p.termination_body->'value' OR p.operation_body->'value'->>'rawSetDigest' IS DISTINCT FROM c->>'rawSetDigest' OR p.operation_body->'value'->>'componentId' IS DISTINCT FROM mapping->>'componentId' OR p.operation_body->'value'->'basisRef' IS DISTINCT FROM o->'basisRef' OR p.operation_body->'value'->>'quantity' IS DISTINCT FROM '0' OR p.operation_body->'value'->>'unit' IS DISTINCT FROM 'windows-job-cpu-second-v1' OR
    NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.evidence_id=p.operation_id AND ev.evidence_digest=p.operation_digest AND ev.protected_observation=p.operation_body AND ev.protected_evidence_ref=ev.evidence_id::text) OR
    NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.evidence_id=p.termination_id AND ev.evidence_digest=p.termination_digest AND ev.protected_observation=p.termination_body AND ev.protected_evidence_ref=ev.evidence_id::text) THEN RETURN NULL;END IF;
   refs:=jsonb_build_array(manga_web.windows_native_cost_reference(p.operation_id,p.operation_digest));absences:=absences||refs;terminations:=terminations||jsonb_build_array(manga_web.windows_native_cost_reference(p.termination_id,p.termination_digest));
   sources:=sources||jsonb_build_array(jsonb_build_object('sourceOperationId',p.operation_body->'value'->>'operationId','sourceEventId',p.operation_body->'value'->>'eventId','target','QUANTITY','componentId',p.component_id,'evidence',refs));
  END IF;
  quantity:=div(ticks,10000000)::text||CASE WHEN mod(ticks,10000000)=0 THEN '' ELSE '.'||rtrim(lpad(mod(ticks,10000000)::text,7,'0'),'0') END;
  quantities:=quantities||jsonb_build_array(jsonb_build_object('componentId',mapping->>'componentId','captureDigest',basis->>'captureDigest','state','CONFIRMED','quantity',quantity,'unit','windows-job-cpu-second-v1','evidenceRefs',manga_web.windows_stage_cost_evidence_strings(refs)));
 END LOOP;
 IF(SELECT count(*) FROM manga_web.windows_stage_cost_projections pr WHERE pr.account_id=a AND pr.execution_id=e AND pr.raw_set_digest=c->>'rawSetDigest')<>jsonb_array_length(attributions)+jsonb_array_length(absences) THEN RETURN NULL;END IF;
 SELECT jsonb_agg(value ORDER BY value->>'componentId' COLLATE "C") INTO q FROM jsonb_array_elements(non_windows->'facts'->'quantities'||quantities);
 IF work->'facts' IS DISTINCT FROM(non_windows->'facts'||jsonb_build_object('quantities',q)) THEN RETURN NULL;END IF;
 -- 원 I/O와 출처는 정확한 본문·ref를 유지하며 각각 한 번만 펼친다.
 IF EXISTS(
  WITH declared_io_counts AS MATERIALIZED(
   SELECT io_source.value->>'sourceOperationId' AS op_id,
    io_source.value->>'sourceEventId' AS event_id,
    io_evidence.protected_observation->'value'->'io' AS io_body,count(*) AS match_count
   FROM jsonb_array_elements(non_windows->'sources') AS io_source(value)
   CROSS JOIN LATERAL jsonb_array_elements(io_source.value->'evidence') AS io_reference(value)
   JOIN manga_web.execution_evidence AS io_evidence ON io_evidence.account_id=a AND io_evidence.execution_id=e
    AND io_evidence.evidence_id::text=io_reference.value->>'evidenceId'
    AND io_evidence.evidence_digest=io_reference.value->>'evidenceDigest'
   GROUP BY io_source.value->>'sourceOperationId',io_source.value->>'sourceEventId',io_evidence.protected_observation->'value'->'io'
  ),original_io AS MATERIALIZED(
   SELECT io_start.operation_id::text AS op_id,io_start.event_id::text AS event_id,
    io_end.protected_event||jsonb_build_object('ended',manga_web.windows_native_cost_reference(io_end.evidence_id,io_end.evidence_digest)) AS io_body
   FROM manga_web.windows_native_cost_io_starts AS io_start
   JOIN manga_web.windows_native_cost_io_ends AS io_end USING(account_id,operation_id)
   WHERE io_start.account_id=a AND io_start.execution_id=e
  )
  SELECT 1 FROM original_io AS owned_io
  LEFT JOIN declared_io_counts AS declared ON declared.op_id=owned_io.op_id
   AND declared.event_id=owned_io.event_id AND declared.io_body=owned_io.io_body
  WHERE COALESCE(declared.match_count,0)<>1
 ) THEN RETURN NULL;END IF;
 IF manga_web.windows_stage_cost_sorted_refs(work->'joinedEvidence') IS DISTINCT FROM manga_web.windows_stage_cost_sorted_refs(non_windows->'joinedEvidence'||attributions||absences) OR
  manga_web.windows_stage_cost_sorted_refs(work->'terminationEvidence') IS DISTINCT FROM manga_web.windows_stage_cost_sorted_refs(non_windows->'terminationEvidence'||terminations) OR
  NOT manga_web.windows_stage_cost_refs(work->'joinedEvidence',2046) OR NOT manga_web.windows_stage_cost_refs(work->'terminationEvidence',2046) OR jsonb_array_length(work->'joinedEvidence')+jsonb_array_length(work->'terminationEvidence')>2046 OR jsonb_array_length(work->'sources')>2046 THEN RETURN NULL;END IF;
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'sourceOperationId' COLLATE "C",value->>'sourceEventId' COLLATE "C"),'[]') INTO source FROM jsonb_array_elements(work->'sources');
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'sourceOperationId' COLLATE "C",value->>'sourceEventId' COLLATE "C"),'[]') INTO q FROM jsonb_array_elements(non_windows->'sources'||sources);IF source IS DISTINCT FROM q THEN RETURN NULL;END IF;
 IF manga_web.windows_stage_cost_amount(basis,work->'facts') IS NULL THEN RETURN NULL;END IF;
 membership:=jsonb_build_object('version',1,'rawSetDigest',c->>'rawSetDigest','scopeRefs',manga_web.windows_stage_cost_sorted_refs(scope_refs),'attributionRefs',manga_web.windows_stage_cost_sorted_refs(attributions),'absenceRefs',manga_web.windows_stage_cost_sorted_refs(absences),'terminationRefs',manga_web.windows_stage_cost_sorted_refs(terminations),
  'nonWindowsWorkSetDigest',manga_web.windows_native_cost_hash(non_windows),'componentMappingDigest',c->'root'->>'componentsDigest','completion',candidate->'completion');
 IF manga_web.windows_native_cost_hash(membership) IS DISTINCT FROM candidate->>'membershipDigest' THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(work->'sources') LOOP
  IF NOT manga_web.windows_native_cost_uuid(source->>'sourceOperationId') OR NOT manga_web.windows_native_cost_uuid(source->>'sourceEventId') THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM manga_web.windows_stage_cost_allocations WHERE account_id=a AND event_id=ANY(ARRAY[(source->>'sourceOperationId')::uuid,(source->>'sourceEventId')::uuid])) OR EXISTS(
   SELECT 1 FROM manga_web.execution_evidence cl,LATERAL jsonb_array_elements(cl.protected_observation->'value'->'workSet'->'sources') old_source WHERE cl.account_id=a AND cl.execution_id<>e AND cl.kind='OPERATIONAL_COST_CLOSURE' AND
   (old_source->>'sourceOperationId' IN(source->>'sourceOperationId',source->>'sourceEventId') OR old_source->>'sourceEventId' IN(source->>'sourceOperationId',source->>'sourceEventId'))) THEN RETURN NULL;END IF;
 END LOOP;
 seal_value:=membership||jsonb_build_object('executionId',e,'inputFingerprint',o->>'inputFingerprint','basisRef',o->'basisRef','membershipDigest',candidate->>'membershipDigest');
 SELECT jsonb_build_object('version',1,'accountId',a,'executionId',e,'inputDigest',protected_observation->>'inputDigest','inputFingerprint',o->>'inputFingerprint','kind','WINDOWS_STAGE_COST_SEAL','value',seal_value) INTO body FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(o->>'inputEvidenceId')::uuid;
 seal_hash:=manga_web.windows_native_cost_hash(body);final_work:=jsonb_set(work,'{terminationEvidence}',manga_web.windows_stage_cost_sorted_refs(work->'terminationEvidence'||jsonb_build_array(manga_web.windows_native_cost_reference(seal_id,seal_hash))));
 IF octet_length(final_work::text)>1048576 OR octet_length(body::text)>1048576 THEN RETURN NULL;END IF;
 -- Construct the historical read allowlist only from the final DB census.
 -- It is atomically immutable with this seal and is never caller-provided.
 SELECT jsonb_build_object('rawSetDigest',c->>'rawSetDigest','membershipDigest',manga_web.windows_native_cost_hash(membership),'originals',c->'originals','sources',manga_web.windows_stage_cost_sorted_refs(jsonb_agg(DISTINCT ref))) INTO lookup_membership FROM(
  SELECT jsonb_build_object('evidenceId',o->>'inputEvidenceId','evidenceDigest',o->>'inputFingerprint') ref UNION ALL SELECT o->'basisRef'
  UNION ALL SELECT origin.input_snapshot-'value' FROM jsonb_array_elements(c->'originals') j JOIN manga_web.native_controller_attempts at ON at.account_id=a AND at.protected_binding=j->'key'->'binding' JOIN manga_web.windows_native_origins origin USING(account_id,attempt_id)
  UNION ALL SELECT origin.basis_snapshot-'value' FROM jsonb_array_elements(c->'originals') j JOIN manga_web.native_controller_attempts at ON at.account_id=a AND at.protected_binding=j->'key'->'binding' JOIN manga_web.windows_native_origins origin USING(account_id,attempt_id) WHERE origin.basis_snapshot IS NOT NULL AND origin.basis_snapshot<>'null'::jsonb
 ) allowed;
 INSERT INTO manga_web.windows_stage_cost_seals VALUES(a,e,o,c->>'rawSetDigest',candidate->>'membershipDigest',seal_id,seal_hash,body,final_work,manga_web.windows_native_cost_hash(final_work),sampled,lookup_membership);
 FOR source IN SELECT v FROM jsonb_array_elements(work->'sources') v LOOP
  FOREACH event IN ARRAY ARRAY[(source->>'sourceOperationId')::uuid,(source->>'sourceEventId')::uuid] LOOP INSERT INTO manga_web.windows_stage_cost_allocations VALUES(a,event,e,source->>'componentId',source->>'target',(source->>'sourceOperationId')::uuid,(source->>'sourceEventId')::uuid,seal_id);END LOOP;
 END LOOP;
 INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES(a,seal_id,e,'WINDOWS_STAGE_COST_SEAL',seal_hash,seal_id::text,sampled,body);
 RETURN jsonb_build_object('version',1,'mode','SEALED','ref',manga_web.windows_native_cost_reference(seal_id,seal_hash),'value',seal_value,'workSet',final_work);
END $$;

CREATE FUNCTION windows_stage_cost_calculation(p_account uuid,p_execution uuid,p_wrapper jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE s manga_web.windows_stage_cost_seals%ROWTYPE;b manga_web.execution_evidence%ROWTYPE;i manga_web.execution_evidence%ROWTYPE;result jsonb;amount jsonb;part jsonb;rate jsonb;q jsonb;c jsonb;provider_part jsonb;allocation_part jsonb;component_parts jsonb:='[]';expected_breakdown jsonb;
BEGIN
 IF p_account IS DISTINCT FROM manga_web.current_account() OR NOT manga_web.windows_native_object(p_wrapper,ARRAY['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']) OR octet_length(p_wrapper::text)>1048576 THEN RETURN false;END IF;
 SELECT * INTO s FROM manga_web.windows_stage_cost_seals WHERE account_id=p_account AND execution_id=p_execution;IF NOT FOUND THEN RETURN false;END IF;
 c:=manga_web.windows_stage_cost_census(s.owner_body,64);IF c IS NULL OR c->>'rawSetDigest' IS DISTINCT FROM s.raw_set_digest THEN RETURN false;END IF;
 SELECT * INTO b FROM manga_web.execution_evidence WHERE account_id=p_account AND evidence_id=(s.owner_body->'basisRef'->>'evidenceId')::uuid AND evidence_digest=s.owner_body->'basisRef'->>'evidenceDigest';
 SELECT * INTO i FROM manga_web.execution_evidence WHERE account_id=p_account AND evidence_id=(s.owner_body->>'inputEvidenceId')::uuid;
 IF b.evidence_id IS NULL OR i.evidence_id IS NULL OR p_wrapper->'version'<>'1'::jsonb OR p_wrapper->>'accountId' IS DISTINCT FROM p_account::text OR p_wrapper->>'executionId' IS DISTINCT FROM p_execution::text OR
  p_wrapper->>'inputDigest' IS DISTINCT FROM i.protected_observation->>'inputDigest' OR p_wrapper->>'inputFingerprint' IS DISTINCT FROM i.evidence_digest OR p_wrapper->>'kind' IS DISTINCT FROM 'OPERATIONAL_COST_CALCULATION' THEN RETURN false;END IF;
 result:=p_wrapper->'value';IF NOT manga_web.windows_native_object(result,ARRAY['version','scope','state','reasons','capture','captureDigest','snapshot','snapshotDigest','facts','factsDigest','basisVersion','usdScale','rounding','breakdown','exactTotalUsd','actualUsd']) THEN RETURN false;END IF;
 IF result->'version'<>'1'::jsonb OR result->>'scope' IS DISTINCT FROM 'FULL_STAGE_PROCESS' OR result->>'state' IS DISTINCT FROM 'CONFIRMED' OR result->'reasons' IS DISTINCT FROM '[]'::jsonb OR result->'capture' IS DISTINCT FROM b.protected_observation->'value'->'capture' OR
  result->>'captureDigest' IS DISTINCT FROM b.protected_observation->'value'->>'captureDigest' OR result->'snapshot' IS DISTINCT FROM b.protected_observation->'value'->'snapshot' OR result->>'snapshotDigest' IS DISTINCT FROM b.protected_observation->'value'->>'snapshotDigest' OR
  result->'facts' IS DISTINCT FROM s.work_set->'facts' OR result->>'factsDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(s.work_set->'facts') OR result->>'basisVersion' IS DISTINCT FROM result->'snapshot'->>'basisVersion' OR result->>'rounding' IS DISTINCT FROM result->'snapshot'->>'rounding' OR result->'usdScale' IS DISTINCT FROM '12'::jsonb THEN RETURN false;END IF;
 amount:=manga_web.windows_stage_cost_amount(b.protected_observation->'value',result->'facts');
 IF amount IS NULL OR NOT manga_web.windows_stage_cost_decimal(result->'actualUsd') OR jsonb_typeof(result->'exactTotalUsd') IS DISTINCT FROM 'string' OR (result->>'exactTotalUsd'~'^(0|[1-9][0-9]{0,39})([.][0-9]{1,24})?$') IS DISTINCT FROM true THEN RETURN false;END IF;
 IF (result->>'actualUsd')::numeric IS DISTINCT FROM(amount->>'actualUsd')::numeric OR(result->>'exactTotalUsd')::numeric IS DISTINCT FROM(amount->>'exactTotalUsd')::numeric THEN RETURN false;END IF;
 IF result->'actualUsd' IS DISTINCT FROM to_jsonb(((amount->>'actualUsd')::numeric(28,12))::text) OR
  result->'exactTotalUsd' IS DISTINCT FROM to_jsonb(trim_scale((amount->>'exactTotalUsd')::numeric)::text) THEN RETURN false;END IF;
 provider_part:=jsonb_build_object('factDigest',manga_web.windows_native_cost_hash(result->'facts'->'provider'),'evidenceRefs',result->'facts'->'provider'->'evidenceRefs',
  'reportedUsd',result->'facts'->'provider'->'actualUsd','exactUsd',trim_scale((result->'facts'->'provider'->>'actualUsd')::numeric)::text,'confirmed',true);
 allocation_part:=jsonb_build_object('factDigest',manga_web.windows_native_cost_hash(result->'facts'->'allocation'),'evidenceRefs',result->'facts'->'allocation'->'evidenceRefs',
  'reportedUsd',result->'facts'->'allocation'->'actualUsd','exactUsd',trim_scale((result->'facts'->'allocation'->>'actualUsd')::numeric)::text,'confirmed',true,
  'mode',result->'capture'->'mode','funding',result->'facts'->'allocation'->'funding','basisVersion',result->'facts'->'allocation'->'basisVersion');
 IF jsonb_typeof(result->'breakdown'->'components') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'breakdown'->'components')<>jsonb_array_length(result->'snapshot'->'components') THEN RETURN false;END IF;
 FOR rate IN SELECT value FROM jsonb_array_elements(result->'snapshot'->'components') WITH ORDINALITY declared(value,ord) ORDER BY ord LOOP
  SELECT value INTO q FROM jsonb_array_elements(result->'facts'->'quantities') WHERE value->>'componentId'=rate->>'componentId';
  part:=jsonb_build_object('componentId',rate->'componentId','kind',rate->'kind','unit',rate->'unit','rateVersion',rate->'rateVersion','usdPerUnit',rate->'usdPerUnit',
   'rateDigest',manga_web.windows_native_cost_hash(rate),'rateEvidenceRefs',rate->'evidenceRefs','quantity',q->'quantity','quantityDigest',manga_web.windows_native_cost_hash(q),
   'quantityEvidenceRefs',q->'evidenceRefs','exactUsd',trim_scale((rate->>'usdPerUnit')::numeric*(q->>'quantity')::numeric)::text,'confirmed',true);
  component_parts:=component_parts||jsonb_build_array(part);
 END LOOP;
 expected_breakdown:=jsonb_build_object('provider',provider_part,'components',component_parts,'allocation',allocation_part);
 IF result->'breakdown' IS DISTINCT FROM expected_breakdown THEN RETURN false;END IF;RETURN true;
END $$;

CREATE FUNCTION windows_stage_cost_closure(p_account uuid,p_execution uuid,p_wrapper jsonb,p_time timestamptz) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE s manga_web.windows_stage_cost_seals%ROWTYPE;calculation manga_web.execution_evidence%ROWTYPE;v jsonb;
BEGIN
 IF NOT manga_web.windows_native_object(p_wrapper,ARRAY['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']) OR p_wrapper->>'kind' IS DISTINCT FROM 'OPERATIONAL_COST_CLOSURE' OR p_wrapper->>'accountId' IS DISTINCT FROM p_account::text OR p_wrapper->>'executionId' IS DISTINCT FROM p_execution::text OR octet_length(p_wrapper::text)>1048576 THEN RETURN false;END IF;
 SELECT * INTO s FROM manga_web.windows_stage_cost_seals WHERE account_id=p_account AND execution_id=p_execution;IF NOT FOUND THEN RETURN false;END IF;v:=p_wrapper->'value';
 IF NOT manga_web.windows_native_object(v,ARRAY['version','basisEvidenceId','basisEvidenceDigest','workSetDigest','workSet','calculationEvidenceId','calculationEvidenceDigest','factsDigest']) OR NOT manga_web.windows_native_cost_uuid(v->>'calculationEvidenceId') OR
  v->'version'<>'1'::jsonb OR v->>'basisEvidenceId' IS DISTINCT FROM s.owner_body->'basisRef'->>'evidenceId' OR v->>'basisEvidenceDigest' IS DISTINCT FROM s.owner_body->'basisRef'->>'evidenceDigest' OR v->>'workSetDigest' IS DISTINCT FROM s.work_set_digest OR v->'workSet' IS DISTINCT FROM s.work_set OR v->>'factsDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(s.work_set->'facts') THEN RETURN false;END IF;
 SELECT * INTO calculation FROM manga_web.execution_evidence WHERE account_id=p_account AND execution_id=p_execution AND evidence_id=(v->>'calculationEvidenceId')::uuid AND evidence_digest=v->>'calculationEvidenceDigest' AND kind='OPERATIONAL_COST_CALCULATION';
 RETURN calculation.evidence_id IS NOT NULL AND calculation.received_at>=s.created_at AND p_time>=calculation.received_at AND p_wrapper->>'inputFingerprint'=calculation.protected_observation->>'inputFingerprint' AND p_wrapper->>'inputDigest'=calculation.protected_observation->>'inputDigest' AND manga_web.windows_stage_cost_calculation(p_account,p_execution,calculation.protected_observation);
END $$;

CREATE OR REPLACE FUNCTION windows_native_cost_open(execution uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=manga_web.current_account() AND execution_id=execution AND kind='OPERATIONAL_COST_CLOSURE')
 AND NOT EXISTS(SELECT 1 FROM manga_web.windows_stage_cost_seals WHERE account_id=manga_web.current_account() AND execution_id=execution)
$$;

CREATE OR REPLACE FUNCTION windows_native_cost_total_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
 IF NEW.kind IN('WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','WINDOWS_STAGE_COST_SEAL') THEN
  IF NEW.protected_evidence_ref IS DISTINCT FROM NEW.evidence_id::text OR manga_web.windows_native_cost_hash(NEW.protected_observation) IS DISTINCT FROM NEW.evidence_digest OR NOT(
   EXISTS(SELECT 1 FROM manga_web.windows_stage_cost_projections p WHERE p.account_id=NEW.account_id AND p.execution_id=NEW.execution_id AND p.created_at=NEW.received_at AND
    ((p.operation_id=NEW.evidence_id AND p.operation_digest=NEW.evidence_digest AND p.operation_body=NEW.protected_observation) OR(p.termination_id=NEW.evidence_id AND p.termination_digest=NEW.evidence_digest AND p.termination_body=NEW.protected_observation))) OR
   EXISTS(SELECT 1 FROM manga_web.windows_stage_cost_seals s WHERE s.account_id=NEW.account_id AND s.execution_id=NEW.execution_id AND s.seal_id=NEW.evidence_id AND s.seal_digest=NEW.evidence_digest AND s.seal_body=NEW.protected_observation AND s.created_at=NEW.received_at)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_PROTECTED_EVIDENCE_REQUIRED';
  END IF;RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id) THEN
  PERFORM manga_web.windows_native_cost_lock_owner(NEW.execution_id);
  IF NEW.kind IN('WINDOWS_NATIVE_COST_PROJECTION','WINDOWS_NATIVE_COST_SEAL') OR
   (NEW.kind='OPERATIONAL_COST_CALCULATION' AND NEW.protected_observation->'value'->>'state'='CONFIRMED' AND NOT manga_web.windows_stage_cost_calculation(NEW.account_id,NEW.execution_id,NEW.protected_observation)) OR
   (NEW.kind='OPERATIONAL_COST_CLOSURE' AND NOT manga_web.windows_stage_cost_closure(NEW.account_id,NEW.execution_id,NEW.protected_observation,NEW.received_at)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_SEAL_REQUIRED';
  END IF;
  IF NEW.kind IN('OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') AND(NEW.protected_evidence_ref IS DISTINCT FROM NEW.evidence_id::text OR manga_web.windows_native_cost_hash(NEW.protected_observation) IS DISTINCT FROM NEW.evidence_digest) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_RECORD_DIGEST_REQUIRED';END IF;
 END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION windows_native_cost_cost_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE proof manga_web.execution_evidence%ROWTYPE;closure manga_web.execution_evidence%ROWTYPE;
BEGIN
 IF NEW.component='STAGE_TOTAL' AND(NEW.state='CONFIRMED' OR NEW.actual_usd IS NOT NULL) AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id) THEN
  PERFORM manga_web.windows_native_cost_lock_owner(NEW.execution_id);
  -- The original confirmed amount was checked when inserted. Re-observing it
  -- and latching a later conflict cannot create a new amount, date or expense.
  IF TG_OP='UPDATE' AND OLD.state='CONFIRMED' AND
   (to_jsonb(NEW)-'evidence_conflict')=(to_jsonb(OLD)-'evidence_conflict') AND
   (NEW.evidence_conflict OR NOT OLD.evidence_conflict) THEN RETURN NEW;END IF;
  SELECT * INTO proof FROM manga_web.execution_evidence WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id AND kind='OPERATIONAL_COST_CALCULATION' AND 'execution-evidence:'||evidence_id::text||':'||evidence_digest=NEW.usage_ref;
  SELECT * INTO closure FROM manga_web.execution_evidence WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id AND kind='OPERATIONAL_COST_CLOSURE' AND protected_observation->'value'->>'calculationEvidenceId'=proof.evidence_id::text AND protected_observation->'value'->>'calculationEvidenceDigest'=proof.evidence_digest;
  IF proof.evidence_id IS NULL OR closure.evidence_id IS NULL OR NEW.ordinal<>0 OR NEW.state<>'CONFIRMED' OR NEW.confirmed_at IS NULL OR NEW.confirmed_at<closure.received_at OR
   NOT manga_web.windows_stage_cost_calculation(NEW.account_id,NEW.execution_id,proof.protected_observation) OR NOT manga_web.windows_stage_cost_closure(NEW.account_id,NEW.execution_id,closure.protected_observation,closure.received_at) OR
   NEW.actual_usd IS DISTINCT FROM(proof.protected_observation->'value'->>'actualUsd')::numeric OR NEW.rate_version IS DISTINCT FROM proof.protected_observation->'value'->>'basisVersion' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_CONFIRMED_CLOSURE_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND OLD.state='CONFIRMED' AND(NEW.actual_usd IS DISTINCT FROM OLD.actual_usd OR NEW.usage_ref IS DISTINCT FROM OLD.usage_ref OR NEW.rate_version IS DISTINCT FROM OLD.rate_version OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_ORIGINAL_AMOUNT_REQUIRED';END IF;
 END IF;RETURN NEW;
END $$;

DO $acl$ DECLARE r record;BEGIN
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND p.proname LIKE 'windows_stage_cost_%' LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||r.signature||' FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator';
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION windows_stage_cost_project(jsonb,jsonb,jsonb,jsonb),windows_stage_cost_seal(jsonb,jsonb),windows_stage_cost_lookup(jsonb,integer) TO trio_web_worker;
