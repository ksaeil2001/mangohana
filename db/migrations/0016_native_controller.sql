SET LOCAL search_path TO manga_web,pg_catalog;

-- Common validation preserves the existing API/worker caller boundary.
-- Private helpers receive only DB-derived owner service from owning wrappers.
CREATE FUNCTION native_job_go_current_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=p_owner_service; intent manga_web.native_job_intents%ROWTYPE; sampled timestamptz;
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
  RETURN jsonb_build_object('allowed',true,'reason','GO_CURRENT');
END $$;

CREATE FUNCTION native_job_go_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=p_owner_service; intent manga_web.native_job_intents%ROWTYPE; sampled timestamptz;
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

CREATE FUNCTION native_job_observation_owned(p_id uuid,p jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=p_owner_service; t jsonb:=p->'termination'; field text; seal text; intent manga_web.native_job_intents%ROWTYPE; prior manga_web.native_job_observations%ROWTYPE;
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

CREATE FUNCTION native_capacity_current_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=p_owner_service; r manga_web.native_capacity_reservations%ROWTYPE; h manga_web.native_capacity_authority%ROWTYPE; eh manga_web.execution_limit_authority%ROWTYPE; profile manga_web.native_capacity_profiles%ROWTYPE; sampled timestamptz; bound integer; p_reference jsonb:=p_capacity->'reference'; intent jsonb;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO eh FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;SELECT * INTO h FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF eh.last_observed_at IS NOT NULL AND sampled<eh.last_observed_at THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=a AND job_id=p_job;
  IF NOT FOUND OR r.owner_service IS DISTINCT FROM service OR r.state<>'HELD' OR EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs WHERE account_id=a AND reservation_id=r.reservation_id) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_RESERVATION_UNCONFIRMED');END IF;
  IF eh.current_profile_id IS NOT NULL AND eh.state<>'OPEN' THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_AUTHORITY_UNCONFIRMED');END IF;
  IF eh.current_profile_id IS DISTINCT FROM r.execution_profile_id THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');END IF;
  IF NOT manga_web.native_capacity_configuration_valid(p_capacity) OR h.state<>'OPEN' OR h.current_profile_id IS DISTINCT FROM r.profile_id OR p_reference->>'profileId' IS DISTINCT FROM r.profile_id::text OR p_reference->>'profileDigest' IS DISTINCT FROM r.profile_digest OR p_reference->>'profileVersion' IS DISTINCT FROM r.profile_version THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  IF profile.profile_payload IS DISTINCT FROM p_capacity->'profile' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  SELECT protected_intent INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=p_job;
  IF r.source_input_evidence_id IS NOT NULL THEN
    IF p_capacity->'sourceInput'->>'executionId' IS DISTINCT FROM r.source_execution_id::text OR p_capacity->'sourceInput'->>'inputEvidenceId' IS DISTINCT FROM r.source_input_evidence_id::text OR
      p_capacity->'sourceInput'->>'stageInputDigest' IS DISTINCT FROM(SELECT protected_observation->>'inputDigest' FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=r.source_input_evidence_id) OR
      NOT manga_web.native_capacity_source_current(intent,p_capacity->'sourceInput') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  ELSIF p_capacity ? 'sourceInput' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  bound:=profile.max_slots;IF eh.current_profile_id IS NOT NULL THEN SELECT least(bound,max_slots) INTO bound FROM manga_web.execution_limit_profiles WHERE profile_id=eh.current_profile_id;END IF;
  IF(SELECT count(*) FROM manga_web.native_capacity_roots())>bound THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_WAIT');END IF;
  RETURN manga_web.native_job_go_current_owned(p_job,p_parent,p_claim,p_capture,service);
END $$;

CREATE FUNCTION native_capacity_go_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=p_owner_service; r manga_web.native_capacity_reservations%ROWTYPE; h manga_web.native_capacity_authority%ROWTYPE; eh manga_web.execution_limit_authority%ROWTYPE; profile manga_web.native_capacity_profiles%ROWTYPE; sampled timestamptz; bound integer; p_reference jsonb:=p_capacity->'reference'; intent jsonb;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO eh FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;SELECT * INTO h FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF eh.last_observed_at IS NOT NULL AND sampled<eh.last_observed_at THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=a AND job_id=p_job;
  IF NOT FOUND OR r.owner_service IS DISTINCT FROM service OR r.state<>'HELD' OR EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs WHERE account_id=a AND reservation_id=r.reservation_id) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_RESERVATION_UNCONFIRMED');END IF;
  IF eh.current_profile_id IS NOT NULL AND eh.state<>'OPEN' THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_AUTHORITY_UNCONFIRMED');END IF;
  IF eh.current_profile_id IS DISTINCT FROM r.execution_profile_id THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');END IF;
  IF NOT manga_web.native_capacity_configuration_valid(p_capacity) OR h.state<>'OPEN' OR h.current_profile_id IS DISTINCT FROM r.profile_id OR p_reference->>'profileId' IS DISTINCT FROM r.profile_id::text OR p_reference->>'profileDigest' IS DISTINCT FROM r.profile_digest OR p_reference->>'profileVersion' IS DISTINCT FROM r.profile_version THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  IF profile.profile_payload IS DISTINCT FROM p_capacity->'profile' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  SELECT protected_intent INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=p_job;
  IF r.source_input_evidence_id IS NOT NULL THEN
    IF p_capacity->'sourceInput'->>'executionId' IS DISTINCT FROM r.source_execution_id::text OR p_capacity->'sourceInput'->>'inputEvidenceId' IS DISTINCT FROM r.source_input_evidence_id::text OR
      p_capacity->'sourceInput'->>'stageInputDigest' IS DISTINCT FROM(SELECT protected_observation->>'inputDigest' FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=r.source_input_evidence_id) OR
      NOT manga_web.native_capacity_source_current(intent,p_capacity->'sourceInput') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  ELSIF p_capacity ? 'sourceInput' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  bound:=profile.max_slots;IF eh.current_profile_id IS NOT NULL THEN SELECT least(bound,max_slots) INTO bound FROM manga_web.execution_limit_profiles WHERE profile_id=eh.current_profile_id;END IF;
  IF(SELECT count(*) FROM manga_web.native_capacity_roots())>bound THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_WAIT');END IF;
  RETURN manga_web.native_job_go_owned(p_job,p_parent,p_claim,p_capture,service);
END $$;


CREATE OR REPLACE FUNCTION native_capacity_consume_go(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT manga_web.native_capacity_go_owned(p_job,p_parent,p_claim,p_capture,p_capacity,manga_web.native_job_caller())
$$;
CREATE OR REPLACE FUNCTION native_job_append_observation(p_id uuid,p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT manga_web.native_job_observation_owned(p_id,p,manga_web.native_job_caller())
$$;

DO $role$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='trio_web_controller') THEN
    CREATE ROLE trio_web_controller NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $role$;
REVOKE ALL ON SCHEMA manga_web FROM trio_web_controller;
GRANT USAGE ON SCHEMA manga_web TO trio_web_controller;

-- These are immutable physical-attempt facts, not provider/result/release facts.
CREATE TABLE native_controller_attempts(
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  controller_instance_id uuid NOT NULL,
  controller_id uuid NOT NULL,
  owner_service text NOT NULL CHECK(owner_service IN('trio_web_api','trio_web_worker')),
  authenticated_peer_id uuid NOT NULL,
  protected_binding jsonb NOT NULL CHECK(jsonb_typeof(protected_binding)='object' AND octet_length(protected_binding::text)<=4096),
  input_canonical text NOT NULL CHECK(octet_length(input_canonical)<=16777216),
  protected_job jsonb NOT NULL CHECK(jsonb_typeof(protected_job)='object' AND octet_length(protected_job::text)<=16777216),
  protected_capacity jsonb NOT NULL CHECK(jsonb_typeof(protected_capacity)='object' AND octet_length(protected_capacity::text)<=32768),
  source_asset_dependencies jsonb NOT NULL CHECK(jsonb_typeof(source_asset_dependencies)='array'),
  asset_purpose text NOT NULL CHECK(asset_purpose IN('LIVE','UPLOAD_TEMP','EXPORT','LIBRARY')),
  related_context_id uuid,
  access_deadline timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,attempt_id),
  UNIQUE(account_id,reservation_id),
  UNIQUE(account_id,job_id),
  FOREIGN KEY(account_id,reservation_id) REFERENCES native_capacity_reservations(account_id,reservation_id),
  FOREIGN KEY(account_id,job_id) REFERENCES native_job_intents(account_id,job_id)
);
CREATE TABLE native_controller_events(
  event_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  event_id uuid NOT NULL,
  controller_instance_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('READY','UNKNOWN','OBSERVATION','TERMINATION')),
  code text NOT NULL CHECK(code~'^[A-Z][A-Z0-9_]{0,127}$'),
  protected_observation jsonb,
  protected_termination jsonb,
  observation_id uuid,
  observation_digest text CHECK(observation_digest~'^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  UNIQUE(account_id,event_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES native_controller_attempts(account_id,attempt_id),
  FOREIGN KEY(account_id,observation_id) REFERENCES native_job_observations(account_id,observation_id),
  CHECK((observation_id IS NULL)=(observation_digest IS NULL)),
  CHECK((kind IN('OBSERVATION','TERMINATION'))=(protected_observation IS NOT NULL)),
  CHECK((protected_observation IS NULL)=(protected_termination IS NULL))
);
CREATE UNIQUE INDEX native_controller_ready_once ON native_controller_events(account_id,attempt_id) WHERE kind='READY';
CREATE INDEX native_controller_event_facts ON native_controller_events(account_id,attempt_id,event_sequence);
CREATE TABLE native_controller_go_grants(
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  job_id uuid NOT NULL,
  controller_instance_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,attempt_id),
  UNIQUE(account_id,job_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES native_controller_attempts(account_id,attempt_id),
  FOREIGN KEY(account_id,job_id) REFERENCES native_job_go_consumptions(account_id,job_id)
);
CREATE TABLE native_controller_raw_results(
  account_id uuid NOT NULL,
  raw_result_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  controller_instance_id uuid NOT NULL,
  result_digest text NOT NULL CHECK(result_digest~'^[a-f0-9]{64}$'),
  result_canonical text NOT NULL CHECK(octet_length(result_canonical)<=16777216),
  bucket_ref text NOT NULL CHECK(length(bucket_ref) BETWEEN 1 AND 256 AND bucket_ref!~'[[:cntrl:]]'),
  blob_refs jsonb NOT NULL CHECK(jsonb_typeof(blob_refs)='array' AND jsonb_array_length(blob_refs)<=4096),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,raw_result_id),
  UNIQUE(account_id,attempt_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES native_controller_attempts(account_id,attempt_id)
);
CREATE TABLE native_controller_object_receipts(
  account_id uuid NOT NULL,
  raw_result_id uuid NOT NULL,
  blob_id text NOT NULL,
  asset_id uuid NOT NULL,
  protected_receipt jsonb NOT NULL CHECK(jsonb_typeof(protected_receipt)='object' AND octet_length(protected_receipt::text)<=4096),
  received_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,raw_result_id,blob_id),
  UNIQUE(account_id,asset_id),
  FOREIGN KEY(account_id,raw_result_id) REFERENCES native_controller_raw_results(account_id,raw_result_id),
  FOREIGN KEY(account_id,asset_id) REFERENCES assets(account_id,asset_id)
);
DO $tables$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['native_controller_attempts','native_controller_events','native_controller_go_grants','native_controller_raw_results','native_controller_object_receipts'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY controller_account ON manga_web.%I TO trio_web_controller USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',relation);
    EXECUTE format('CREATE TRIGGER immutable_controller_record BEFORE UPDATE OR DELETE ON manga_web.%I FOR EACH ROW EXECUTE FUNCTION manga_web.immutable_native_job_record()',relation);
    EXECUTE format('REVOKE ALL ON manga_web.%I FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller',relation);
  END LOOP;
END $tables$;

CREATE FUNCTION native_controller_caller() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT (current_setting('role',true)='trio_web_controller' AND pg_has_role(session_user,'trio_web_controller','USAGE')) IS TRUE
$$;
CREATE FUNCTION native_controller_binding_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE field text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4096 OR(SELECT count(*) FROM jsonb_object_keys(p))<>7 OR NOT p ?& ARRAY['accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest'] THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['accountId','capacityReservationId','jobId','parentInstanceId'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['inputDigest','profileDigest','kernelDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION native_controller_original(p_binding jsonb,p_controller uuid,p_peer_service text) RETURNS native_controller_attempts LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE;
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p_binding) OR p_binding->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CONTROLLER_ACCESS_DENIED';END IF;
  SELECT * INTO original FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND reservation_id=(p_binding->>'capacityReservationId')::uuid;
  IF NOT FOUND OR original.protected_binding IS DISTINCT FROM p_binding OR original.controller_id IS DISTINCT FROM p_controller OR original.owner_service IS DISTINCT FROM p_peer_service THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CONTROL_BINDING_MISMATCH';END IF;
  RETURN original;
END $$;
CREATE FUNCTION native_controller_snapshot(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT jsonb_build_object('binding',a.protected_binding,'job',a.protected_job,'snapshot',jsonb_build_object(
    'attemptId',a.attempt_id,'controllerInstanceId',a.controller_instance_id,
    'phase',CASE WHEN EXISTS(SELECT 1 FROM manga_web.native_controller_events e WHERE e.account_id=a.account_id AND e.attempt_id=a.attempt_id AND(e.kind='UNKNOWN' OR e.code<>'OK')) THEN 'UNKNOWN'
      WHEN EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants g WHERE g.account_id=a.account_id AND g.attempt_id=a.attempt_id) THEN 'GO_GRANTED'
      WHEN EXISTS(SELECT 1 FROM manga_web.native_controller_events e WHERE e.account_id=a.account_id AND e.attempt_id=a.attempt_id AND e.kind='READY') THEN 'READY' ELSE 'PREPARING' END,
    'rawResult',(SELECT jsonb_build_object('rawResultId',r.raw_result_id,'resultDigest',r.result_digest) FROM manga_web.native_controller_raw_results r WHERE r.account_id=a.account_id AND r.attempt_id=a.attempt_id),
    'termination',(SELECT e.protected_termination FROM manga_web.native_controller_events e WHERE e.account_id=a.account_id AND e.attempt_id=a.attempt_id AND e.kind='TERMINATION' ORDER BY CASE e.protected_termination->>'kind' WHEN 'CGROUP_EMPTY' THEN 3 WHEN 'DIRECT_CHILD_ONLY' THEN 2 WHEN 'NO_CHILD_CREATED' THEN 1 ELSE 0 END DESC,(e.protected_termination->>'operationJoined'='true') DESC,e.event_sequence DESC LIMIT 1),
    'code',COALESCE((SELECT e.code FROM manga_web.native_controller_events e WHERE e.account_id=a.account_id AND e.attempt_id=a.attempt_id AND e.code<>'OK' ORDER BY e.event_sequence LIMIT 1),'OK')))
  FROM manga_web.native_controller_attempts a WHERE a.account_id=p_account AND a.attempt_id=p_attempt
$$;
CREATE FUNCTION native_controller_claim(p_binding jsonb,p_input text,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_peer uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); r manga_web.native_capacity_reservations%ROWTYPE; intent manga_web.native_job_intents%ROWTYPE; profile manga_web.native_capacity_profiles%ROWTYPE; prior manga_web.native_controller_attempts%ROWTYPE; frame jsonb; capacity jsonb; decision jsonb; retention jsonb; dependencies jsonb; sampled timestamptz;
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p_binding) OR a IS NULL OR p_binding->>'accountId' IS DISTINCT FROM a::text OR p_attempt IS NULL OR p_instance IS NULL OR p_controller IS NULL OR p_peer IS NULL OR p_peer_service IS NULL OR p_peer_service NOT IN('trio_web_api','trio_web_worker') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=a AND reservation_id=(p_binding->>'capacityReservationId')::uuid;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(p_binding->>'jobId')::uuid;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  IF r.job_id IS DISTINCT FROM intent.job_id OR r.owner_service IS DISTINCT FROM intent.owner_service OR intent.owner_service IS DISTINCT FROM p_peer_service OR intent.parent_instance_id::text IS DISTINCT FROM p_binding->>'parentInstanceId' OR intent.input_digest IS DISTINCT FROM p_binding->>'inputDigest' OR intent.profile_digest IS DISTINCT FROM p_binding->>'profileDigest' OR profile.native_profile_digest IS DISTINCT FROM intent.profile_digest OR profile.kernel_digest IS DISTINCT FROM p_binding->>'kernelDigest' OR profile.controller_id IS DISTINCT FROM p_controller THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_BINDING_MISMATCH');END IF;
  IF p_input IS NULL OR octet_length(p_input)>16777216 OR encode(sha256(convert_to(p_input,'UTF8')),'hex') IS DISTINCT FROM intent.input_digest THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_BINDING_MISMATCH');END IF;
  frame:=p_input::jsonb;
  IF jsonb_typeof(frame) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(frame))<>7 OR NOT frame ?& ARRAY['version','jobId','task','taskVersion','profileDigest','metadata','blobs'] OR frame->'version' IS DISTINCT FROM '1'::jsonb OR frame->>'jobId' IS DISTINCT FROM intent.job_id::text OR frame->>'task' IS DISTINCT FROM intent.task OR frame->>'taskVersion' IS DISTINCT FROM intent.task_version OR frame->>'profileDigest' IS DISTINCT FROM intent.profile_digest OR jsonb_typeof(frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(frame->'blobs') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_BINDING_MISMATCH');END IF;
  SELECT * INTO prior FROM manga_web.native_controller_attempts WHERE account_id=a AND reservation_id=r.reservation_id;
  IF FOUND THEN
    IF prior.protected_binding IS DISTINCT FROM p_binding OR prior.input_canonical IS DISTINCT FROM p_input THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_BINDING_MISMATCH');END IF;
    RETURN jsonb_build_object('allowed',true,'created',false,'attempt',manga_web.native_controller_snapshot(a,prior.attempt_id));
  END IF;
  capacity:=jsonb_build_object('reference',jsonb_build_object('kind','OWNED_FIXTURE','profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version),'profile',profile.profile_payload);
  IF r.source_input_evidence_id IS NOT NULL THEN capacity:=capacity||jsonb_build_object('sourceInput',jsonb_build_object('executionId',r.source_execution_id,'inputEvidenceId',r.source_input_evidence_id,'stageInputDigest',(SELECT protected_observation->>'inputDigest' FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=r.source_input_evidence_id)));END IF;
  decision:=manga_web.native_capacity_current_owned(intent.job_id,intent.parent_instance_id,intent.protected_intent->'claim',intent.protected_intent->'protectedOwnerCapture',capacity,intent.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  sampled:=clock_timestamp();retention:=manga_web.native_receipt_retention(intent.protected_intent,sampled);dependencies:=manga_web.native_receipt_source_assets(intent.protected_intent,frame,sampled);
  IF retention->>'available' IS DISTINCT FROM 'true' OR dependencies IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_SOURCE_UNCONFIRMED');END IF;
  INSERT INTO manga_web.native_controller_attempts(account_id,attempt_id,reservation_id,job_id,controller_instance_id,controller_id,owner_service,authenticated_peer_id,protected_binding,input_canonical,protected_job,protected_capacity,source_asset_dependencies,asset_purpose,related_context_id,access_deadline,created_at)
    VALUES(a,p_attempt,r.reservation_id,intent.job_id,p_instance,p_controller,intent.owner_service,p_peer,p_binding,p_input,frame||jsonb_build_object('inputDigest',intent.input_digest),capacity,dependencies,retention->>'purpose',(retention->>'contextId')::uuid,(retention->>'accessDeadline')::timestamptz,sampled);
  RETURN jsonb_build_object('allowed',true,'created',true,'attempt',manga_web.native_controller_snapshot(a,p_attempt));
END $$;
CREATE FUNCTION native_controller_load(p_binding jsonb,p_controller uuid,p_peer_service text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE;
BEGIN original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,original.attempt_id));END $$;
CREATE FUNCTION native_controller_ready(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_event uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; intent manga_web.native_job_intents%ROWTYPE; decision jsonb;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  IF original.attempt_id IS DISTINCT FROM p_attempt OR original.controller_instance_id IS DISTINCT FROM p_instance OR EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=original.account_id AND attempt_id=p_attempt AND kind IN('UNKNOWN','TERMINATION')) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED');END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=original.account_id AND attempt_id=p_attempt AND kind='READY') THEN RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));END IF;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=original.account_id AND job_id=original.job_id;
  decision:=manga_web.native_capacity_current_owned(intent.job_id,intent.parent_instance_id,intent.protected_intent->'claim',intent.protected_intent->'protectedOwnerCapture',original.protected_capacity,intent.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  INSERT INTO manga_web.native_controller_events(account_id,attempt_id,event_id,controller_instance_id,kind,code,received_at) VALUES(original.account_id,p_attempt,p_event,p_instance,'READY','OK',clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));
END $$;
CREATE FUNCTION native_controller_grant_go(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; intent manga_web.native_job_intents%ROWTYPE; decision jsonb;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  IF original.attempt_id IS DISTINCT FROM p_attempt OR original.controller_instance_id IS DISTINCT FROM p_instance THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED');END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=original.account_id AND attempt_id=p_attempt) THEN RETURN jsonb_build_object('allowed',true,'created',false,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=original.account_id AND attempt_id=p_attempt AND kind='READY') OR EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=original.account_id AND attempt_id=p_attempt AND(kind IN('UNKNOWN','TERMINATION') OR code<>'OK')) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_GO_UNCONFIRMED');END IF;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=original.account_id AND job_id=original.job_id;
  decision:=manga_web.native_capacity_go_owned(intent.job_id,intent.parent_instance_id,intent.protected_intent->'claim',intent.protected_intent->'protectedOwnerCapture',original.protected_capacity,intent.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  INSERT INTO manga_web.native_controller_go_grants(account_id,attempt_id,job_id,controller_instance_id,granted_at) VALUES(original.account_id,p_attempt,intent.job_id,p_instance,clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'created',true,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));
END $$;
CREATE FUNCTION native_controller_observe(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_event uuid,p_kind text,p_observation jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; prior manga_web.native_controller_events%ROWTYPE; observation jsonb; decision jsonb;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  IF original.attempt_id IS DISTINCT FROM p_attempt OR original.controller_instance_id IS DISTINCT FROM p_instance OR p_event IS NULL OR p_kind IS NULL OR p_kind NOT IN('OBSERVATION','TERMINATION','UNKNOWN') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED');END IF;
  observation:=p_observation||jsonb_build_object('parentInstanceId',original.protected_binding->>'parentInstanceId');
  IF p_observation->>'parentInstanceId' IS DISTINCT FROM original.protected_binding->>'parentInstanceId' OR p_observation->'termination'->>'jobId' IS DISTINCT FROM original.job_id::text OR p_observation->'termination'->>'inputDigest' IS DISTINCT FROM original.protected_binding->>'inputDigest' OR p_observation->'termination'->>'profileDigest' IS DISTINCT FROM original.protected_binding->>'profileDigest' OR(p_kind='TERMINATION' AND observation->>'event' IS DISTINCT FROM 'TERMINATION') OR(p_kind='UNKNOWN' AND observation->>'event' IS DISTINCT FROM 'ERROR') OR(p_kind='OBSERVATION' AND observation->>'event' NOT IN('RESULT','ERROR')) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_OBSERVATION_FENCE_REJECTED');END IF;
  decision:=manga_web.native_job_observation_owned(p_event,observation,original.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  SELECT * INTO prior FROM manga_web.native_controller_events WHERE account_id=original.account_id AND event_id=p_event;
  IF FOUND THEN
    IF prior.attempt_id IS DISTINCT FROM p_attempt OR prior.kind IS DISTINCT FROM p_kind OR prior.protected_observation IS DISTINCT FROM observation THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_OBSERVATION_CONFLICT');END IF;
    RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));
  END IF;
  INSERT INTO manga_web.native_controller_events(account_id,attempt_id,event_id,controller_instance_id,kind,code,protected_observation,protected_termination,observation_id,observation_digest,received_at)
    VALUES(original.account_id,p_attempt,p_event,p_instance,p_kind,observation->>'code',CASE WHEN p_kind='UNKNOWN' THEN NULL ELSE observation END,CASE WHEN p_kind='UNKNOWN' THEN NULL ELSE (observation->'termination')-'isolation' END,p_event,decision->>'observationDigest',clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,p_attempt));
END $$;

CREATE FUNCTION native_controller_allocate_raw(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_raw uuid,p_result text,p_refs jsonb,p_bucket text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; prior manga_web.native_controller_raw_results%ROWTYPE; result_frame jsonb; ref jsonb; descriptor jsonb; seal text;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  IF original.attempt_id IS DISTINCT FROM p_attempt OR original.controller_instance_id IS DISTINCT FROM p_instance OR p_raw IS NULL OR p_result IS NULL OR octet_length(p_result)>16777216 OR p_bucket IS NULL OR length(p_bucket) NOT BETWEEN 1 AND 256 OR p_bucket~'[[:cntrl:]]' OR NOT EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=original.account_id AND attempt_id=p_attempt) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  result_frame:=p_result::jsonb;seal:=encode(sha256(convert_to(p_result,'UTF8')),'hex');
  IF jsonb_typeof(result_frame) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(result_frame))<>8 OR NOT result_frame ?& ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','metadata','blobs'] OR result_frame->'version' IS DISTINCT FROM '1'::jsonb OR result_frame->>'jobId' IS DISTINCT FROM original.job_id::text OR result_frame->>'task' IS DISTINCT FROM original.protected_job->>'task' OR result_frame->>'taskVersion' IS DISTINCT FROM original.protected_job->>'taskVersion' OR result_frame->>'profileDigest' IS DISTINCT FROM original.protected_binding->>'profileDigest' OR result_frame->>'inputDigest' IS DISTINCT FROM original.protected_binding->>'inputDigest' OR jsonb_typeof(result_frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(result_frame->'blobs') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  SELECT * INTO prior FROM manga_web.native_controller_raw_results WHERE account_id=original.account_id AND attempt_id=p_attempt;
  IF FOUND THEN
    IF prior.result_digest IS DISTINCT FROM seal OR prior.result_canonical IS DISTINCT FROM p_result OR prior.bucket_ref IS DISTINCT FROM p_bucket THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
    RETURN jsonb_build_object('allowed',true,'created',false,'allocation',jsonb_build_object('attemptId',p_attempt,'reference',jsonb_build_object('rawResultId',prior.raw_result_id,'resultDigest',prior.result_digest),'result',prior.result_canonical::jsonb),'blobRefs',prior.blob_refs);
  END IF;
  IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs)>4096 OR jsonb_array_length(p_refs)<>jsonb_array_length(result_frame->'blobs') OR(SELECT count(DISTINCT value->>'blobId') FROM jsonb_array_elements(p_refs))<>jsonb_array_length(p_refs) OR(SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(p_refs))<>jsonb_array_length(p_refs) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(ref))<>4 OR NOT ref ?& ARRAY['blobId','assetId','sha256','bytesLength'] OR jsonb_typeof(ref->'blobId') IS DISTINCT FROM 'string' OR ref->>'blobId' !~ '^[A-Za-z0-9._-]{1,100}$' OR jsonb_typeof(ref->'assetId') IS DISTINCT FROM 'string' OR ref->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(ref->'sha256') IS DISTINCT FROM 'string' OR ref->>'sha256' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(ref->'bytesLength') IS DISTINCT FROM 'string' OR ref->>'bytesLength' !~ '^(0|[1-9][0-9]{0,15})$' OR(ref->>'bytesLength')::numeric>9007199254740991 THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
    SELECT value INTO descriptor FROM jsonb_array_elements(result_frame->'blobs') WHERE value->>'id'=ref->>'blobId';
    IF NOT FOUND OR descriptor->>'sha256' IS DISTINCT FROM ref->>'sha256' OR descriptor->>'byteLength' IS DISTINCT FROM ref->>'bytesLength' OR EXISTS(SELECT 1 FROM manga_web.assets WHERE account_id=original.account_id AND asset_id=(ref->>'assetId')::uuid) OR EXISTS(SELECT 1 FROM manga_web.native_controller_raw_results other CROSS JOIN LATERAL jsonb_array_elements(other.blob_refs) existing WHERE other.account_id=original.account_id AND existing->>'assetId'=ref->>'assetId') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  END LOOP;
  INSERT INTO manga_web.native_controller_raw_results(account_id,raw_result_id,attempt_id,controller_instance_id,result_digest,result_canonical,bucket_ref,blob_refs,created_at) VALUES(original.account_id,p_raw,p_attempt,p_instance,seal,p_result,p_bucket,p_refs,clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'created',true,'allocation',jsonb_build_object('attemptId',p_attempt,'reference',jsonb_build_object('rawResultId',p_raw,'resultDigest',seal),'result',result_frame),'blobRefs',p_refs);
END $$;
CREATE FUNCTION native_controller_raw_lookup(p_binding jsonb,p_controller uuid,p_peer_service text,p_bucket text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; raw manga_web.native_controller_raw_results%ROWTYPE; sampled timestamptz:=clock_timestamp(); deadline timestamptz; original_deadline timestamptz;
BEGIN
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  SELECT * INTO raw FROM manga_web.native_controller_raw_results WHERE account_id=original.account_id AND attempt_id=original.attempt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',true,'available',false);END IF;
  IF raw.bucket_ref IS DISTINCT FROM p_bucket THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  deadline:=original.access_deadline;
  IF original.asset_purpose='LIBRARY' THEN
    -- The original Library receipt may confirm its expiry after this attempt
    -- was captured. An immutable NULL capture cannot extend that later fact.
    SELECT l.expires_at INTO original_deadline FROM manga_web.library_store_operations l JOIN manga_web.native_job_intents i ON i.account_id=l.account_id AND i.target_id=l.store_operation_id AND i.target_kind='LIBRARY' WHERE i.account_id=original.account_id AND i.job_id=original.job_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('allowed',true,'available',false);END IF;
    deadline:=least(deadline,original_deadline);
    SELECT least(deadline,min((protected_receipt->>'completedAt')::timestamptz)+interval '30 days') INTO deadline FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=raw.raw_result_id;
  END IF;
  RETURN jsonb_build_object('allowed',true,'available',(deadline IS NULL OR sampled<deadline) AND manga_web.native_receipt_assets_current(original.source_asset_dependencies,sampled) AND NOT EXISTS(SELECT 1 FROM manga_web.native_controller_object_receipts r LEFT JOIN manga_web.assets b ON b.account_id=r.account_id AND b.asset_id=r.asset_id WHERE r.account_id=original.account_id AND r.raw_result_id=raw.raw_result_id AND(b.asset_id IS NULL OR b.bucket_ref IS DISTINCT FROM raw.bucket_ref OR b.object_key IS DISTINCT FROM r.protected_receipt->>'key' OR b.sha256 IS DISTINCT FROM r.protected_receipt->>'sha256' OR b.bytes_length IS DISTINCT FROM(r.protected_receipt->>'bytesLength')::bigint OR b.purpose IS DISTINCT FROM original.asset_purpose OR b.related_context_id IS DISTINCT FROM original.related_context_id OR b.object_created_at IS DISTINCT FROM(r.protected_receipt->>'completedAt')::timestamptz OR b.media_type IS DISTINCT FROM 'application/octet-stream' OR b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND sampled>=b.access_deadline))),
    'allocation',jsonb_build_object('attemptId',original.attempt_id,'reference',jsonb_build_object('rawResultId',raw.raw_result_id,'resultDigest',raw.result_digest),'result',raw.result_canonical::jsonb),'blobRefs',raw.blob_refs);
END $$;
CREATE FUNCTION native_controller_register_raw_object(p_binding jsonb,p_controller uuid,p_peer_service text,p_raw uuid,p_blob text,p_receipt jsonb,p_bucket text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; raw manga_web.native_controller_raw_results%ROWTYPE; ref jsonb; prior manga_web.native_controller_object_receipts%ROWTYPE; completed timestamptz; sampled timestamptz:=clock_timestamp(); deadline timestamptz; first_put timestamptz; original_deadline timestamptz;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  SELECT * INTO raw FROM manga_web.native_controller_raw_results WHERE account_id=original.account_id AND raw_result_id=p_raw AND attempt_id=original.attempt_id;
  IF NOT FOUND OR raw.bucket_ref IS DISTINCT FROM p_bucket THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  SELECT value INTO ref FROM jsonb_array_elements(raw.blob_refs) WHERE value->>'blobId'=p_blob;
  IF NOT FOUND OR NOT manga_web.native_receipt_object_valid(p_receipt) OR p_bucket IS NULL OR length(p_bucket) NOT BETWEEN 1 AND 256 OR p_bucket~'[[:cntrl:]]' OR p_receipt->>'key' IS DISTINCT FROM original.account_id::text||'/'||(ref->>'assetId') OR p_receipt->>'sha256' IS DISTINCT FROM ref->>'sha256' OR p_receipt->>'bytesLength' IS DISTINCT FROM ref->>'bytesLength' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  completed:=(p_receipt->>'completedAt')::timestamptz;
  IF completed>sampled+((p_receipt->>'completedAtPrecisionMilliseconds')::integer*interval '1 millisecond') THEN RETURN jsonb_build_object('allowed',false,'reason','CLOCK_UNCONFIRMED');END IF;
  deadline:=original.access_deadline;
  IF original.asset_purpose='LIBRARY' THEN
    SELECT l.expires_at INTO original_deadline FROM manga_web.library_store_operations l JOIN manga_web.native_job_intents i ON i.account_id=l.account_id AND i.target_id=l.store_operation_id AND i.target_kind='LIBRARY' WHERE i.account_id=original.account_id AND i.job_id=original.job_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
    SELECT least(completed,min((protected_receipt->>'completedAt')::timestamptz)) INTO first_put FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=p_raw;
    deadline:=least(deadline,original_deadline,first_put+interval '30 days');
  END IF;
  SELECT * INTO prior FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=p_raw AND blob_id=p_blob;
  IF FOUND THEN
    IF prior.protected_receipt IS DISTINCT FROM p_receipt OR prior.asset_id IS DISTINCT FROM(ref->>'assetId')::uuid OR NOT EXISTS(SELECT 1 FROM manga_web.assets b WHERE b.account_id=original.account_id AND b.asset_id=prior.asset_id AND b.bucket_ref=p_bucket AND b.object_key=p_receipt->>'key' AND b.sha256=ref->>'sha256' AND b.bytes_length=(ref->>'bytesLength')::bigint AND b.purpose=original.asset_purpose AND b.related_context_id IS NOT DISTINCT FROM original.related_context_id AND b.object_created_at=completed AND b.media_type='application/octet-stream') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
    IF original.asset_purpose='LIBRARY' THEN
      UPDATE manga_web.assets b SET access_deadline=least(b.access_deadline,deadline) WHERE b.account_id=original.account_id AND b.asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=p_raw);
    END IF;
    RETURN jsonb_build_object('allowed',true,'reason','RAW_OBJECT_OBSERVED');
  END IF;
  INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,verified_at,deletion_state,related_context_id,object_created_at,access_deadline)
    VALUES(original.account_id,(ref->>'assetId')::uuid,original.asset_purpose,p_bucket,p_receipt->>'key',ref->>'sha256',(ref->>'bytesLength')::bigint,'application/octet-stream',sampled,'NOT_DUE',original.related_context_id,completed,deadline);
  INSERT INTO manga_web.native_controller_object_receipts(account_id,raw_result_id,blob_id,asset_id,protected_receipt,received_at) VALUES(original.account_id,p_raw,p_blob,(ref->>'assetId')::uuid,p_receipt,sampled);
  IF original.asset_purpose='LIBRARY' THEN
    -- A receipt from an earlier original PUT may arrive later. Shorten only
    -- this raw candidate's registered assets to that same first PUT boundary.
    UPDATE manga_web.assets b SET access_deadline=least(b.access_deadline,deadline) WHERE b.account_id=original.account_id AND b.asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=p_raw);
  END IF;
  RETURN jsonb_build_object('allowed',true,'reason','RAW_OBJECT_OBSERVED');
END $$;

REVOKE ALL ON FUNCTION native_job_go_current_owned(uuid,uuid,jsonb,jsonb,text),native_job_go_owned(uuid,uuid,jsonb,jsonb,text),native_job_observation_owned(uuid,jsonb,text),native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text),native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text),native_controller_caller(),native_controller_binding_valid(jsonb),native_controller_original(jsonb,uuid,text),native_controller_snapshot(uuid,uuid) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
REVOKE ALL ON FUNCTION native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_load(jsonb,uuid,text),native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go(jsonb,uuid,uuid,uuid,text),native_controller_observe(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb),native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text),native_controller_raw_lookup(jsonb,uuid,text,text),native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
GRANT EXECUTE ON FUNCTION native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_load(jsonb,uuid,text),native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go(jsonb,uuid,uuid,uuid,text),native_controller_observe(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb),native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text),native_controller_raw_lookup(jsonb,uuid,text,text),native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text) TO trio_web_controller;
