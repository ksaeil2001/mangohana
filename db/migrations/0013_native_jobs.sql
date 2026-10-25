SET LOCAL search_path TO manga_web,pg_catalog;

-- Parent-owned metadata only. No bytes, paths, credentials or native input
-- metadata are persisted here. Child processes have no database authority.
CREATE TABLE native_job_intents(
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  job_id uuid NOT NULL,
  owner_service text NOT NULL CHECK(owner_service IN ('trio_web_api','trio_web_worker')),
  parent_instance_id uuid NOT NULL,
  task text NOT NULL CHECK(task IN ('DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE')),
  task_version text NOT NULL CHECK(task_version='native-pure-v1'),
  profile_digest text NOT NULL CHECK(profile_digest~'^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK(input_digest~'^[a-f0-9]{64}$'),
  operation_input_digest text NOT NULL CHECK(operation_input_digest~'^[a-f0-9]{64}$'),
  target_kind text NOT NULL CHECK(target_kind IN ('UPLOAD','RESTORE','RASTER','EXPORT','LIBRARY','EXECUTION','REQUEST_CHECKPOINT')),
  target_id uuid NOT NULL,
  semantic_capture_digest text NOT NULL CHECK(semantic_capture_digest~'^[a-f0-9]{64}$'),
  logical_operation_key text NOT NULL CHECK(logical_operation_key~'^[a-f0-9]{64}$'),
  protected_intent jsonb NOT NULL CHECK(jsonb_typeof(protected_intent)='object' AND octet_length(protected_intent::text)<=8192),
  intent_digest text NOT NULL CHECK(intent_digest~'^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,job_id),
  UNIQUE(account_id,job_id,parent_instance_id),
  -- No release authority exists in this stage. Changing a claim generation,
  -- parent instance or job UUID cannot bypass the original unresolved intent.
  UNIQUE(account_id,logical_operation_key)
);
CREATE TABLE native_job_go_consumptions(
  account_id uuid NOT NULL,
  job_id uuid NOT NULL,
  parent_instance_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,job_id),
  FOREIGN KEY(account_id,job_id,parent_instance_id) REFERENCES native_job_intents(account_id,job_id,parent_instance_id)
);
CREATE TABLE native_job_observations(
  account_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  parent_instance_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('ERROR','RESULT','TERMINATION')),
  observation_digest text NOT NULL CHECK(observation_digest~'^[a-f0-9]{64}$'),
  protected_observation jsonb NOT NULL CHECK(jsonb_typeof(protected_observation)='object' AND octet_length(protected_observation::text)<=4096),
  received_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,observation_id),
  FOREIGN KEY(account_id,job_id,parent_instance_id) REFERENCES native_job_intents(account_id,job_id,parent_instance_id)
);
CREATE INDEX native_job_observations_by_job ON native_job_observations(account_id,job_id,received_at,observation_id);
CREATE FUNCTION immutable_native_job_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_native_job_intents BEFORE UPDATE OR DELETE ON native_job_intents FOR EACH ROW EXECUTE FUNCTION immutable_native_job_record();
CREATE TRIGGER immutable_native_job_go_consumptions BEFORE UPDATE OR DELETE ON native_job_go_consumptions FOR EACH ROW EXECUTE FUNCTION immutable_native_job_record();
CREATE TRIGGER immutable_native_job_observations BEFORE UPDATE OR DELETE ON native_job_observations FOR EACH ROW EXECUTE FUNCTION immutable_native_job_record();
DO $rls$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['native_job_intents','native_job_go_consumptions','native_job_observations'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY account_scope ON manga_web.%I TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',relation);
  END LOOP;
END $rls$;
REVOKE ALL ON native_job_intents,native_job_go_consumptions,native_job_observations FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT SELECT ON native_job_intents,native_job_go_consumptions,native_job_observations TO trio_web_api,trio_web_worker;

CREATE FUNCTION native_job_caller() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE service text:=current_setting('role',true);
BEGIN
  IF service NOT IN ('trio_web_api','trio_web_worker') OR service IS NULL OR NOT pg_has_role(session_user,service,'USAGE') THEN RETURN NULL; END IF;
  RETURN service;
END $$;
CREATE FUNCTION native_job_logical_key(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT encode(sha256(convert_to(array_to_string(ARRAY['native-logical-operation-v1',p->>'targetKind',lower(p->>'targetId'),p->>'semanticCaptureDigest',p->>'task',p->>'taskVersion',p->>'profileDigest',p->>'operationInputDigest'],E'\n'),'UTF8')),'hex')
$$;
CREATE FUNCTION native_job_valid_tuple(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE capture jsonb:=p->'protectedOwnerCapture'; claim jsonb:=p->'claim'; field text;
BEGIN
  IF jsonb_typeof(capture) IS DISTINCT FROM 'object' OR jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(capture))<>6 OR NOT capture ?& ARRAY['contextId','contextGeneration','ownerSessionId','ownerTabId','ownerRevision','workspaceRevision'] OR
     (SELECT count(*) FROM jsonb_object_keys(claim))<>3 OR NOT claim ?& ARRAY['generation','ownerId','workItemId'] THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['contextId','ownerSessionId','ownerTabId'] LOOP
    IF capture->field<>'null'::jsonb AND (jsonb_typeof(capture->field) IS DISTINCT FROM 'string' OR capture->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['contextGeneration','ownerRevision','workspaceRevision'] LOOP
    IF capture->field<>'null'::jsonb THEN
      IF jsonb_typeof(capture->field) IS DISTINCT FROM 'string' OR capture->>field !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN false; END IF;
      IF (capture->>field)::numeric>9223372036854775807 THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF (capture->'contextId'='null'::jsonb) IS DISTINCT FROM (capture->'contextGeneration'='null'::jsonb) THEN RETURN false; END IF;
  IF jsonb_typeof(claim->'generation') IS DISTINCT FROM 'string' OR claim->>'generation' !~ '^(0|[1-9][0-9]{0,18})$' OR jsonb_typeof(claim->'ownerId') IS DISTINCT FROM 'string' OR
     claim->>'ownerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  IF (claim->>'generation')::numeric>9223372036854775807 THEN RETURN false; END IF;
  IF claim->'workItemId'<>'null'::jsonb AND (jsonb_typeof(claim->'workItemId') IS DISTINCT FROM 'string' OR claim->>'workItemId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  RETURN true;
END $$;

-- Check actual account ownership and the owning table's current lease/revision.
-- The original parent additionally owns its semantic owner/capture/INPUT fence;
-- a caller's digest or membership flag is not a replacement for that check.
-- Current owner authority is used only where the owning upload/export service
-- requires it. workspaceRevision remains the source capture's revision.
CREATE FUNCTION native_job_capture_current(p_context uuid,p_capture jsonb,p_now timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM manga_web.workspace_contexts c JOIN manga_web.accounts a USING(account_id)
    JOIN manga_web.app_sessions s ON s.account_id=c.account_id AND s.session_id=c.owner_session_id
    JOIN manga_web.login_bindings b ON b.account_id=s.account_id AND b.binding_id=s.binding_id
    WHERE c.account_id=manga_web.current_account() AND c.context_id=p_context AND c.context_id::text IS NOT DISTINCT FROM lower(p_capture->>'contextId') AND c.generation::text IS NOT DISTINCT FROM p_capture->>'contextGeneration'
      AND c.lifecycle<>'CLOSED' AND c.owner_session_id::text IS NOT DISTINCT FROM lower(p_capture->>'ownerSessionId') AND c.owner_tab_id IS NOT NULL AND c.owner_tab_id::text IS NOT DISTINCT FROM lower(p_capture->>'ownerTabId')
      AND c.owner_revision::text IS NOT DISTINCT FROM p_capture->>'ownerRevision'
      AND a.access_state='ACTIVE' AND s.revoked_at IS NULL AND s.absolute_expires_at>p_now AND s.auth_generation=a.auth_generation AND b.state='ACTIVE')
$$;
-- Immutable result/background work remains usable after its source context is
-- closed or its current owner/workspace changes. Only its actual context and
-- original generation are referenced here; claim and semantic fences are separate.
CREATE FUNCTION native_job_context_reference(p_context uuid,p_capture jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM manga_web.workspace_contexts c WHERE c.account_id=manga_web.current_account() AND c.context_id=p_context AND c.context_id::text IS NOT DISTINCT FROM lower(p_capture->>'contextId') AND c.generation::text IS NOT DISTINCT FROM p_capture->>'contextGeneration')
$$;
CREATE FUNCTION native_job_target_current(p jsonb,p_service text,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); target uuid:=(p->>'targetId')::uuid; kind text:=p->>'targetKind'; native_generation bigint:=(p->'claim'->>'generation')::bigint;
  native_claim_owner uuid:=(p->'claim'->>'ownerId')::uuid; work uuid:=(p->'claim'->>'workItemId')::uuid; capture jsonb:=p->'protectedOwnerCapture';
BEGIN
  IF a IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN RETURN false; END IF;
  IF p_service='trio_web_api' AND kind NOT IN ('UPLOAD','RESTORE','RASTER','EXPORT','LIBRARY') OR
     p_service='trio_web_worker' AND kind NOT IN ('EXECUTION','REQUEST_CHECKPOINT','RASTER','LIBRARY') OR p_service NOT IN ('trio_web_api','trio_web_worker') THEN RETURN false; END IF;
  IF kind IN ('UPLOAD','RESTORE') THEN
    RETURN work IS NULL AND EXISTS(SELECT 1 FROM manga_web.uploads u WHERE u.account_id=a AND u.upload_id=target AND u.preview_revision=native_generation AND u.state<>'COMMITTED' AND u.expires_at>p_now AND
      u.purpose IN ('PAGE_IMAGES','PROJECT_IMPORT') AND (kind<>'RESTORE' OR u.purpose='PROJECT_IMPORT') AND u.owner_session_id IS NOT NULL AND u.owner_tab_id IS NOT NULL AND
      u.owner_session_id::text IS NOT DISTINCT FROM lower(capture->>'ownerSessionId') AND u.owner_tab_id::text IS NOT DISTINCT FROM lower(capture->>'ownerTabId') AND
      u.context_id::text IS NOT DISTINCT FROM lower(capture->>'contextId') AND u.context_generation::text IS NOT DISTINCT FROM capture->>'contextGeneration' AND u.owner_revision::text IS NOT DISTINCT FROM capture->>'ownerRevision' AND u.captured_workspace_revision::text IS NOT DISTINCT FROM capture->>'workspaceRevision' AND
      ((u.context_id IS NOT NULL AND manga_web.native_job_capture_current(u.context_id,capture,p_now)) OR
       (u.context_id IS NULL AND EXISTS(SELECT 1 FROM manga_web.app_sessions s JOIN manga_web.accounts x USING(account_id) JOIN manga_web.login_bindings b USING(account_id,binding_id) WHERE s.account_id=a AND s.session_id=u.owner_session_id AND s.revoked_at IS NULL AND s.absolute_expires_at>p_now AND s.auth_generation=x.auth_generation AND b.state='ACTIVE'))));
  ELSIF kind='RASTER' THEN
    RETURN work IS NULL AND EXISTS(SELECT 1 FROM manga_web.results r JOIN manga_web.result_render_claims c USING(account_id,result_id) WHERE r.account_id=a AND r.result_id=target AND c.generation=native_generation AND c.owner_id=native_claim_owner AND c.lease_until>p_now AND manga_web.native_job_context_reference(r.context_id,capture));
  ELSIF kind='EXPORT' THEN
    RETURN work IS NULL AND EXISTS(SELECT 1 FROM manga_web.exports e JOIN manga_web.export_builds b USING(account_id,export_id) JOIN manga_web.workspace_contexts c ON c.account_id=e.account_id AND c.context_id=e.context_id
      WHERE e.account_id=a AND e.export_id=target AND e.retry_deadline>p_now AND b.generation=native_generation AND b.owner_id=native_claim_owner AND c.lifecycle<>'CLOSED' AND c.generation=e.context_generation AND
      e.context_id::text IS NOT DISTINCT FROM lower(capture->>'contextId') AND e.context_generation::text IS NOT DISTINCT FROM capture->>'contextGeneration' AND
      b.claim_authorization->>'sessionId' IS NOT NULL AND lower(b.claim_authorization->>'sessionId') IS NOT DISTINCT FROM lower(capture->>'ownerSessionId') AND b.claim_authorization->>'tabId' IS NOT NULL AND lower(b.claim_authorization->>'tabId') IS NOT DISTINCT FROM lower(capture->>'ownerTabId') AND
      b.claim_authorization->>'ownerRevision' IS NOT NULL AND b.claim_authorization->>'ownerRevision' IS NOT DISTINCT FROM capture->>'ownerRevision' AND b.claim_authorization->>'contextGeneration' IS NOT DISTINCT FROM capture->>'contextGeneration' AND
      e.snapshot_revision::text IS NOT DISTINCT FROM capture->>'workspaceRevision' AND
      ((b.state='BUILDING' AND b.lease_until>p_now AND manga_web.native_job_capture_current(e.context_id,capture,p_now) AND EXISTS(SELECT 1 FROM manga_web.app_sessions s JOIN manga_web.accounts x USING(account_id) WHERE s.account_id=a AND s.session_id::text=lower(b.claim_authorization->>'sessionId') AND s.binding_id::text=lower(b.claim_authorization->>'bindingId') AND x.auth_generation::text=b.claim_authorization->>'authGeneration')) OR
       (b.state='COMPLETE' AND b.completed_at IS NOT NULL AND e.state='AVAILABLE' AND e.kind='PROJECT_FILE' AND e.output_asset_id IS NOT NULL AND p->>'task' IN ('ZIP_READ','DECODE_IMAGE') AND e.snapshot_revision::text IS NOT DISTINCT FROM capture->>'workspaceRevision')));
  ELSIF kind='EXECUTION' THEN
    RETURN work IS NOT NULL AND EXISTS(SELECT 1 FROM manga_web.executions e JOIN manga_web.processing_requests r USING(account_id,request_id) JOIN manga_web.work_items w ON w.account_id=e.account_id
      WHERE e.account_id=a AND e.execution_id=target AND w.work_item_id=work AND
      ((w.kind='DISPATCH' AND w.target_ref->>'requestId'=e.request_id::text AND e.claim_generation=native_generation) OR (w.kind='RECONCILE' AND w.target_ref->>'executionId'=e.execution_id::text)) AND
      w.state='CLAIMED' AND w.claim_generation=native_generation AND w.claim_owner=native_claim_owner::text AND w.lease_until>p_now AND r.context_generation::text IS NOT DISTINCT FROM capture->>'contextGeneration' AND manga_web.native_job_context_reference(r.context_id,capture));
  ELSIF kind='REQUEST_CHECKPOINT' THEN
    RETURN work IS NOT NULL AND EXISTS(SELECT 1 FROM manga_web.processing_requests r JOIN manga_web.work_items w ON w.account_id=r.account_id WHERE r.account_id=a AND r.request_id=target AND w.work_item_id=work AND
      ((w.kind IN ('DISPATCH','APPLY') AND w.target_ref->>'requestId'=r.request_id::text) OR
       (w.kind='RECONCILE' AND EXISTS(SELECT 1 FROM manga_web.executions e WHERE e.account_id=r.account_id AND e.request_id=r.request_id AND e.execution_id::text=w.target_ref->>'executionId'))) AND
      w.state='CLAIMED' AND w.claim_generation=native_generation AND w.claim_owner=native_claim_owner::text AND w.lease_until>p_now AND r.context_generation::text IS NOT DISTINCT FROM capture->>'contextGeneration' AND manga_web.native_job_context_reference(r.context_id,capture));
  ELSIF kind='LIBRARY' THEN
    IF p_service='trio_web_api' THEN RETURN work IS NULL AND EXISTS(SELECT 1 FROM manga_web.library_store_operations l WHERE l.account_id=a AND l.store_operation_id=target AND l.revision=native_generation AND manga_web.native_job_context_reference(l.source_context_id,capture)); END IF;
    RETURN work IS NOT NULL AND EXISTS(SELECT 1 FROM manga_web.library_store_operations l JOIN manga_web.work_items w ON w.account_id=l.account_id WHERE l.account_id=a AND l.store_operation_id=target AND w.work_item_id=work AND w.kind='STORE' AND
      ((w.target_ref->>'storeOperationId'=l.store_operation_id::text AND (w.target_ref->>'resultId' IS NULL OR w.target_ref->>'resultId'=l.result_id::text)) OR (NOT w.target_ref ? 'storeOperationId' AND w.target_ref->>'resultId'=l.result_id::text)) AND
      (w.target_ref->>'retryGroupId' IS NULL OR w.target_ref->>'retryGroupId'=l.retry_group_id::text) AND w.state='CLAIMED' AND w.claim_generation=native_generation AND w.claim_owner=native_claim_owner::text AND w.lease_until>p_now AND manga_web.native_job_context_reference(l.source_context_id,capture));
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION native_job_create_intent(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); field text; sampled timestamptz; prior manga_web.native_job_intents%ROWTYPE; key text; seal text;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  -- New native invocation requires ACTIVE. Raw outcomes/cost and late
  -- observations remain separate facts after account restriction.
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>14 OR NOT p ?& ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','operationInputDigest','parentInstanceId','targetKind','targetId','semanticCaptureDigest','logicalOperationKey','protectedOwnerCapture','claim'] OR
     p->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'task') IS DISTINCT FROM 'string' OR p->>'task' NOT IN ('DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE') OR
     p->>'taskVersion' IS DISTINCT FROM 'native-pure-v1' OR jsonb_typeof(p->'targetKind') IS DISTINCT FROM 'string' OR p->>'targetKind' NOT IN ('UPLOAD','RESTORE','RASTER','EXPORT','LIBRARY','EXECUTION','REQUEST_CHECKPOINT') OR NOT manga_web.native_job_valid_tuple(p) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID';
  END IF;
  FOREACH field IN ARRAY ARRAY['jobId','parentInstanceId','targetId'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['profileDigest','inputDigest','operationInputDigest','semanticCaptureDigest','logicalOperationKey'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  END LOOP;
  key:=manga_web.native_job_logical_key(p);seal:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  IF p->>'logicalOperationKey' IS DISTINCT FROM key THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_LOGICAL_KEY_INVALID'; END IF;
  SELECT * INTO prior FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(p->>'jobId')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('allowed',false,'reason',CASE WHEN prior.intent_digest=seal THEN 'NATIVE_INTENT_EXISTS' ELSE 'NATIVE_INTENT_CONFLICT' END); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND logical_operation_key=key) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_JOB_UNRESOLVED'); END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(p,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  INSERT INTO manga_web.native_job_intents(account_id,job_id,owner_service,parent_instance_id,task,task_version,profile_digest,input_digest,operation_input_digest,target_kind,target_id,semantic_capture_digest,logical_operation_key,protected_intent,intent_digest,created_at)
    VALUES(a,(p->>'jobId')::uuid,service,(p->>'parentInstanceId')::uuid,p->>'task',p->>'taskVersion',p->>'profileDigest',p->>'inputDigest',p->>'operationInputDigest',p->>'targetKind',(p->>'targetId')::uuid,p->>'semanticCaptureDigest',key,p,seal,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','CREATED','intentDigest',seal);
END $$;

-- This INSERT is the single CAS grant. A repeated identical call must refuse GO,
-- even if the first transaction's response was lost, the parent restarted, the
-- worker lease expired, or a later observer reports that computation did not start.
CREATE FUNCTION native_job_consume_go(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); intent manga_web.native_job_intents%ROWTYPE; sampled timestamptz;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=p_job;
  IF NOT FOUND OR intent.owner_service IS DISTINCT FROM service OR intent.parent_instance_id IS DISTINCT FROM p_parent OR intent.protected_intent->'claim' IS DISTINCT FROM p_claim OR intent.protected_intent->'protectedOwnerCapture' IS DISTINCT FROM p_capture THEN
    RETURN jsonb_build_object('allowed',false,'reason','NATIVE_INTENT_FENCE_REJECTED');
  END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_go_consumptions WHERE account_id=a AND job_id=p_job) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_GO_ALREADY_CONSUMED'); END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(intent.protected_intent,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  INSERT INTO manga_web.native_job_go_consumptions(account_id,job_id,parent_instance_id,consumed_at) VALUES(a,p_job,p_parent,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','GO_CONSUMED');
END $$;

CREATE FUNCTION native_job_append_observation(p_id uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); t jsonb:=p->'termination'; field text; seal text; intent manga_web.native_job_intents%ROWTYPE; prior manga_web.native_job_observations%ROWTYPE;
BEGIN
  IF a IS NULL OR service IS NULL OR p_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(t) IS DISTINCT FROM 'object' OR octet_length(p::text)>4096 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>6 OR NOT p ?& ARRAY['version','parentInstanceId','event','code','resultDigest','termination'] OR
    (SELECT count(*) FROM jsonb_object_keys(t))<>10 OR NOT t ?& ARRAY['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind','isolation'] OR
    p->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'event') IS DISTINCT FROM 'string' OR p->>'event' NOT IN ('ERROR','RESULT','TERMINATION') OR
    jsonb_typeof(p->'code') IS DISTINCT FROM 'string' OR p->>'code' !~ '^[A-Z][A-Z0-9_]{0,127}$' OR
    jsonb_typeof(t->'kind') IS DISTINCT FROM 'string' OR t->>'kind' NOT IN ('NO_CHILD_CREATED','DIRECT_CHILD_ONLY','CGROUP_EMPTY','UNCONFIRMED') OR
    jsonb_typeof(t->'isolation') IS DISTINCT FROM 'string' OR t->>'isolation' NOT IN ('OWNED_FIXTURE','LINUX_CGROUP_V2') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  IF jsonb_typeof(p->'parentInstanceId') IS DISTINCT FROM 'string' OR p->>'parentInstanceId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
     jsonb_typeof(t->'jobId') IS DISTINCT FROM 'string' OR t->>'jobId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  FOREACH field IN ARRAY ARRAY['inputDigest','profileDigest'] LOOP
    IF jsonb_typeof(t->field) IS DISTINCT FROM 'string' OR t->>field !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'] LOOP
    IF jsonb_typeof(t->field) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  END LOOP;
  IF (p->>'event'='RESULT') IS DISTINCT FROM (p->'resultDigest'<>'null'::jsonb) OR
    (p->'resultDigest'<>'null'::jsonb AND (jsonb_typeof(p->'resultDigest') IS DISTINCT FROM 'string' OR p->>'resultDigest' !~ '^[a-f0-9]{64}$')) OR
    (t->>'startedComputation'='true' AND t->>'goAttempted'<>'true') OR
    (t->>'subtreeTerminationConfirmed'='true' AND (t->>'directChildClosed'<>'true' OR t->>'operationJoined'<>'true' OR t->>'isolation'<>'LINUX_CGROUP_V2')) OR
    (t->>'kind'='NO_CHILD_CREATED' AND (t->>'operationJoined'<>'true' OR t->>'goAttempted'<>'false' OR t->>'startedComputation'<>'false' OR t->>'directChildClosed'<>'false' OR t->>'subtreeTerminationConfirmed'<>'false')) OR
    (t->>'kind'='DIRECT_CHILD_ONLY' AND (t->>'operationJoined'<>'true' OR t->>'directChildClosed'<>'true' OR t->>'subtreeTerminationConfirmed'<>'false' OR t->>'isolation'<>'OWNED_FIXTURE')) OR
    (t->>'kind'='CGROUP_EMPTY' AND (t->>'operationJoined'<>'true' OR t->>'directChildClosed'<>'true' OR t->>'subtreeTerminationConfirmed'<>'true' OR t->>'isolation'<>'LINUX_CGROUP_V2')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_JOB_RECORD_INVALID'; END IF;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(t->>'jobId')::uuid;
  IF NOT FOUND OR intent.owner_service IS DISTINCT FROM service OR intent.parent_instance_id IS DISTINCT FROM (p->>'parentInstanceId')::uuid OR intent.input_digest IS DISTINCT FROM t->>'inputDigest' OR intent.profile_digest IS DISTINCT FROM t->>'profileDigest' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_OBSERVATION_FENCE_REJECTED'); END IF;
  seal:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO prior FROM manga_web.native_job_observations WHERE account_id=a AND observation_id=p_id;
  IF FOUND THEN RETURN jsonb_build_object('allowed',prior.observation_digest=seal,'reason',CASE WHEN prior.observation_digest=seal THEN 'OBSERVATION_EXISTS' ELSE 'NATIVE_OBSERVATION_CONFLICT' END,'observationDigest',prior.observation_digest); END IF;
  INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES(a,p_id,intent.job_id,intent.parent_instance_id,p->>'event',seal,p,clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'reason','OBSERVED','observationDigest',seal);
END $$;

-- Facts stay separate. Even an explicit NO_CHILD candidate, reported success,
-- or claimed CGROUP_EMPTY does not release this logical operation. Production
-- controller trust and termination authority are deliberately not installed.
CREATE FUNCTION native_job_unresolved(p_key text) RETURNS TABLE(state jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT jsonb_build_object('jobId',i.job_id,'parentInstanceId',i.parent_instance_id,'logicalOperationKey',i.logical_operation_key,
    'go',CASE WHEN g.job_id IS NULL THEN 'UNCONSUMED' ELSE 'CONSUMED' END,
    'result',CASE WHEN EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='RESULT') THEN 'OBSERVED' ELSE 'UNOBSERVED' END,
    'termination',CASE WHEN g.job_id IS NULL AND NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND (o.protected_observation->'termination'->>'goAttempted'='true' OR o.protected_observation->'termination'->>'startedComputation'='true' OR o.protected_observation->'termination'->>'directChildClosed'='true')) AND EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.protected_observation->'termination'->>'kind'='NO_CHILD_CREATED' AND o.protected_observation->'termination'->>'goAttempted'='false' AND o.protected_observation->'termination'->>'operationJoined'='true') THEN 'NO_CHILD_CANDIDATE'
      WHEN EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.protected_observation->'termination'->>'kind'='CGROUP_EMPTY' AND o.protected_observation->'termination'->>'isolation'='LINUX_CGROUP_V2') THEN 'UNTRUSTED_CGROUP_CANDIDATE' ELSE 'UNCONFIRMED' END,
    'cost','UNCONFIRMED','application','UNCONFIRMED','unresolved',true,
    'firstError',(SELECT jsonb_build_object('observationId',o.observation_id,'digest',o.observation_digest,'snapshot',o.protected_observation,'receivedAt',o.received_at) FROM manga_web.native_job_observations o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.event='ERROR' ORDER BY o.received_at,o.observation_id LIMIT 1))
  FROM manga_web.native_job_intents i LEFT JOIN manga_web.native_job_go_consumptions g USING(account_id,job_id)
  WHERE i.account_id=manga_web.current_account() AND i.logical_operation_key=p_key AND manga_web.native_job_caller() IS NOT NULL
$$;
REVOKE ALL ON FUNCTION immutable_native_job_record(),native_job_caller(),native_job_logical_key(jsonb),native_job_valid_tuple(jsonb),native_job_capture_current(uuid,jsonb,timestamptz),native_job_context_reference(uuid,jsonb),native_job_target_current(jsonb,text,timestamptz),native_job_create_intent(jsonb),native_job_consume_go(uuid,uuid,jsonb,jsonb),native_job_append_observation(uuid,jsonb),native_job_unresolved(text) FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION native_job_create_intent(jsonb),native_job_consume_go(uuid,uuid,jsonb,jsonb),native_job_append_observation(uuid,jsonb),native_job_unresolved(text) TO trio_web_api,trio_web_worker;
