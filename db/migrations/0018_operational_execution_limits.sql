SET LOCAL search_path TO manga_web,pg_catalog;

-- Operational evidence is an operator-reviewed copy, not proof that the
-- measured run actually occurred. No production measurement or policy is
-- installed by this migration.
CREATE TABLE operational_limit_evidence (
  evidence_id uuid PRIMARY KEY,
  raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes) BETWEEN 1 AND 65536),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_by text NOT NULL CHECK(length(reviewed_by) BETWEEN 1 AND 128),
  reviewed_at timestamptz NOT NULL CHECK(isfinite(reviewed_at))
);

CREATE FUNCTION operational_limit_object(value jsonb,keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(value)='object' THEN
    value ?& keys AND (SELECT count(*) FROM jsonb_object_keys(value))=cardinality(keys)
    ELSE false END
$$;
CREATE FUNCTION operational_limit_decimal(value jsonb,positive boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR
    (value#>>'{}') !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$' THEN RETURN false; END IF;
  RETURN CASE WHEN positive THEN (value#>>'{}')::numeric>0 ELSE (value#>>'{}')::numeric>=0 END;
END $$;
CREATE FUNCTION operational_limit_uuid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT COALESCE(jsonb_typeof(value)='string' AND
    (value#>>'{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
$$;
CREATE FUNCTION operational_limit_refs(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE ref jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
  FOR ref IN SELECT v FROM jsonb_array_elements(value) a(v) LOOP
    IF NOT manga_web.operational_limit_uuid(ref) THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT v) FROM jsonb_array_elements(value) a(v))=jsonb_array_length(value);
END $$;
CREATE FUNCTION operational_limit_timestamp(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE stamp timestamptz;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
  stamp:=(value#>>'{}')::timestamptz;
  RETURN isfinite(stamp) AND to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=(value#>>'{}');
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
CREATE FUNCTION operational_limit_identity(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE field text;
BEGIN
  IF NOT manga_web.operational_limit_object(value,ARRAY['profileVersion','mediaProfileDigest','environmentDigest','pipelineDigest']) THEN RETURN false; END IF;
  IF jsonb_typeof(value->'profileVersion') IS DISTINCT FROM 'string' OR value->>'profileVersion' !~ '^[A-Za-z0-9._-]{1,128}$' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['mediaProfileDigest','environmentDigest','pipelineDigest'] LOOP
    IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' OR value->>field !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION operational_limit_window(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.operational_limit_object(value,ARRAY['kind','policyId','startAt','endAt']) OR
    value->>'kind' IS DISTINCT FROM 'OPERATOR_EXPLICIT_WINDOW_V1' OR
    jsonb_typeof(value->'policyId') IS DISTINCT FROM 'string' OR value->>'policyId' !~ '^[A-Za-z0-9._-]{1,128}$' OR
    NOT manga_web.operational_limit_timestamp(value->'startAt') OR NOT manga_web.operational_limit_timestamp(value->'endAt') THEN RETURN false; END IF;
  RETURN (value->>'startAt')::timestamptz<(value->>'endAt')::timestamptz;
END $$;

CREATE FUNCTION operational_limit_measurement(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE run jsonb; cost jsonb; policy jsonb; full_process jsonb; field text;
  seen text[]:=ARRAY[]::text[]; executions text[]:=ARRAY[]::text[]; all_cost_refs jsonb:='[]'; stage_sum numeric:=0; cost_sum numeric; cost_refs jsonb;
BEGIN
  IF NOT manga_web.operational_limit_object(value,ARRAY['kind','identity','runs','fullProcess','policy']) OR
    value->>'kind' IS DISTINCT FROM 'EXECUTION_LIMIT_MEASUREMENT_V1' OR
    NOT manga_web.operational_limit_identity(value->'identity') OR
    jsonb_typeof(value->'runs') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'runs')<>4 THEN RETURN false; END IF;
  policy:=value->'policy';full_process:=value->'fullProcess';
  IF NOT manga_web.operational_limit_object(policy,ARRAY['maxSlots','requestLimitUsd','dailyLimitUsd','window']) OR
    jsonb_typeof(policy->'maxSlots') IS DISTINCT FROM 'number' OR
    (policy->>'maxSlots')::numeric NOT BETWEEN 1 AND 10000 OR trunc((policy->>'maxSlots')::numeric)<>(policy->>'maxSlots')::numeric OR
    NOT manga_web.operational_limit_decimal(policy->'requestLimitUsd',true) OR
    NOT manga_web.operational_limit_decimal(policy->'dailyLimitUsd',true) OR NOT manga_web.operational_limit_window(policy->'window') OR
    NOT manga_web.operational_limit_object(full_process,ARRAY['boundUsd','retryAllowanceUsd','sharedAllowanceUsd','evidenceIds']) OR
    NOT manga_web.operational_limit_decimal(full_process->'boundUsd',true) OR
    NOT manga_web.operational_limit_decimal(full_process->'retryAllowanceUsd',false) OR
    NOT manga_web.operational_limit_decimal(full_process->'sharedAllowanceUsd',false) OR
    NOT manga_web.operational_limit_refs(full_process->'evidenceIds') THEN RETURN false; END IF;
  FOR run IN SELECT v FROM jsonb_array_elements(value->'runs') a(v) LOOP
    IF NOT manga_web.operational_limit_object(run,ARRAY['stage','accountId','requestId','executionId','inputDigest','startEvidenceId','endEvidenceId','startedAt','endedAt','elapsedMilliseconds','peakMemoryBytes','costs','actualUsd','boundUsd']) OR
      run->>'stage' IS NULL OR run->>'stage' NOT IN ('OCR','TRANSLATE','CLEANUP','TYPESET') OR run->>'stage'=ANY(seen) OR
      jsonb_typeof(run->'inputDigest') IS DISTINCT FROM 'string' OR run->>'inputDigest' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
    seen:=array_append(seen,run->>'stage');
    IF run->>'executionId'=ANY(executions) OR run->'startEvidenceId'=run->'endEvidenceId' THEN RETURN false; END IF;
    executions:=array_append(executions,run->>'executionId');
    FOREACH field IN ARRAY ARRAY['accountId','requestId','executionId','startEvidenceId','endEvidenceId'] LOOP
      IF NOT manga_web.operational_limit_uuid(run->field) THEN RETURN false; END IF;
    END LOOP;
    IF NOT manga_web.operational_limit_timestamp(run->'startedAt') OR NOT manga_web.operational_limit_timestamp(run->'endedAt') OR
      (run->>'endedAt')::timestamptz<=(run->>'startedAt')::timestamptz OR
      jsonb_typeof(run->'elapsedMilliseconds') IS DISTINCT FROM 'number' OR jsonb_typeof(run->'peakMemoryBytes') IS DISTINCT FROM 'number' OR
      (run->>'elapsedMilliseconds')::numeric NOT BETWEEN 1 AND 9007199254740991 OR
      trunc((run->>'elapsedMilliseconds')::numeric)<>(run->>'elapsedMilliseconds')::numeric OR
      (run->>'elapsedMilliseconds')::numeric<>extract(epoch FROM ((run->>'endedAt')::timestamptz-(run->>'startedAt')::timestamptz))*1000 OR
      (run->>'peakMemoryBytes')::numeric NOT BETWEEN 1 AND 9007199254740991 OR
      trunc((run->>'peakMemoryBytes')::numeric)<>(run->>'peakMemoryBytes')::numeric OR
      NOT manga_web.operational_limit_decimal(run->'actualUsd',false) OR NOT manga_web.operational_limit_decimal(run->'boundUsd',true) OR
      jsonb_typeof(run->'costs') IS DISTINCT FROM 'array' OR jsonb_array_length(run->'costs') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
    cost_sum:=0;cost_refs:='[]';
    FOR cost IN SELECT v FROM jsonb_array_elements(run->'costs') a(v) LOOP
      IF NOT manga_web.operational_limit_object(cost,ARRAY['component','unit','quantity','actualUsd','basisVersion','evidenceId']) OR
        jsonb_typeof(cost->'component') IS DISTINCT FROM 'string' OR cost->>'component' !~ '^[A-Za-z0-9._-]{1,128}$' OR
        cost->>'unit' IS NULL OR cost->>'unit' NOT IN ('TOKEN','MILLISECOND','BYTE','CALL') OR
        NOT manga_web.operational_limit_decimal(cost->'quantity',true) OR NOT manga_web.operational_limit_decimal(cost->'actualUsd',false) OR
        jsonb_typeof(cost->'basisVersion') IS DISTINCT FROM 'string' OR cost->>'basisVersion' !~ '^[A-Za-z0-9._-]{1,128}$' OR
        NOT manga_web.operational_limit_uuid(cost->'evidenceId') THEN RETURN false; END IF;
      IF all_cost_refs @> jsonb_build_array(cost->'evidenceId') THEN RETURN false; END IF;
      all_cost_refs:=all_cost_refs||jsonb_build_array(cost->'evidenceId');
      cost_sum:=cost_sum+(cost->>'actualUsd')::numeric;cost_refs:=cost_refs||jsonb_build_array(cost->'evidenceId');
    END LOOP;
    IF NOT manga_web.operational_limit_refs(cost_refs) OR cost_sum<>(run->>'actualUsd')::numeric OR cost_sum>(run->>'boundUsd')::numeric THEN RETURN false; END IF;
    stage_sum:=stage_sum+(run->>'boundUsd')::numeric;
  END LOOP;
  RETURN stage_sum+(full_process->>'retryAllowanceUsd')::numeric+(full_process->>'sharedAllowanceUsd')::numeric=(full_process->>'boundUsd')::numeric AND
    (full_process->>'boundUsd')::numeric<=(policy->>'requestLimitUsd')::numeric AND (full_process->>'boundUsd')::numeric<=(policy->>'dailyLimitUsd')::numeric;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;

CREATE FUNCTION validate_operational_limit_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE raw_text text;
BEGIN
  IF NEW.raw_bytes IS NULL OR octet_length(NEW.raw_bytes) NOT BETWEEN 1 AND 65536 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='OPERATIONAL_LIMIT_EVIDENCE_INVALID';
  END IF;
  raw_text:=convert_from(NEW.raw_bytes,'UTF8');
  -- Check the original text before jsonb discards duplicate object keys.
  -- PG18 WITH UNIQUE KEYS also checks nested objects.
  IF NOT (raw_text IS JSON OBJECT WITH UNIQUE KEYS) OR NOT manga_web.operational_limit_measurement(raw_text::jsonb) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='OPERATIONAL_LIMIT_EVIDENCE_INVALID';
  END IF;
  NEW.sha256:=encode(sha256(NEW.raw_bytes),'hex');
  NEW.reviewed_by:=session_user;NEW.reviewed_at:=clock_timestamp();
  RETURN NEW;
EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='OPERATIONAL_LIMIT_EVIDENCE_INVALID';
END $$;
CREATE TRIGGER validate_operational_limit_evidence BEFORE INSERT ON operational_limit_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_operational_limit_evidence();
CREATE TRIGGER immutable_operational_limit_evidence BEFORE UPDATE OR DELETE ON operational_limit_evidence
  FOR EACH ROW EXECUTE FUNCTION immutable_execution_limit_record();
REVOKE ALL ON operational_limit_evidence FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT SELECT,INSERT ON operational_limit_evidence TO trio_web_operator;

CREATE FUNCTION operational_execution_limit_valid(p manga_web.execution_limit_profiles) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE payload jsonb:=p.profile_payload; evidence manga_web.operational_limit_evidence%ROWTYPE;
  raw_text text; measurement jsonb; run jsonb; stage jsonb; cost_refs jsonb;
BEGIN
  IF NOT manga_web.operational_limit_object(payload,ARRAY['kind','version','maxSlots','requestLimitUsd','dailyLimitUsd','fullBoundUsd','stages','fullBoundEvidenceRefs','window','identity','evidence']) OR
    payload->>'kind' IS DISTINCT FROM 'MEASURED_EXECUTION_LIMITS_V1' OR
    NOT manga_web.operational_limit_identity(payload->'identity') OR payload->'version' IS DISTINCT FROM payload->'identity'->'profileVersion' OR
    NOT manga_web.operational_limit_object(payload->'evidence',ARRAY['id','sha256']) OR
    NOT manga_web.operational_limit_uuid(payload->'evidence'->'id') OR
    jsonb_typeof(payload->'evidence'->'sha256') IS DISTINCT FROM 'string' OR payload->'evidence'->>'sha256' !~ '^[a-f0-9]{64}$' OR
    NOT manga_web.operational_limit_window(payload->'window') OR
    NOT manga_web.operational_limit_object(payload->'stages',ARRAY['OCR','TRANSLATE','CLEANUP','TYPESET']) THEN RETURN false; END IF;
  SELECT * INTO evidence FROM manga_web.operational_limit_evidence WHERE evidence_id=(payload->'evidence'->>'id')::uuid;
  IF NOT FOUND OR evidence.sha256 IS DISTINCT FROM payload->'evidence'->>'sha256' OR
    evidence.sha256 IS DISTINCT FROM encode(sha256(evidence.raw_bytes),'hex') OR
    octet_length(evidence.raw_bytes) NOT BETWEEN 1 AND 65536 OR evidence.reviewed_by IS NULL OR evidence.reviewed_at IS NULL THEN RETURN false; END IF;
  raw_text:=convert_from(evidence.raw_bytes,'UTF8');
  IF NOT (raw_text IS JSON OBJECT WITH UNIQUE KEYS) THEN RETURN false; END IF;
  measurement:=raw_text::jsonb;
  IF NOT manga_web.operational_limit_measurement(measurement) OR measurement->'identity' IS DISTINCT FROM payload->'identity' OR
    jsonb_build_object('maxSlots',payload->'maxSlots','requestLimitUsd',payload->'requestLimitUsd','dailyLimitUsd',payload->'dailyLimitUsd','window',payload->'window') IS DISTINCT FROM measurement->'policy' OR
    payload->'fullBoundUsd' IS DISTINCT FROM measurement->'fullProcess'->'boundUsd' OR payload->'fullBoundEvidenceRefs' IS DISTINCT FROM measurement->'fullProcess'->'evidenceIds' THEN RETURN false; END IF;
  FOR run IN SELECT v FROM jsonb_array_elements(measurement->'runs') a(v) LOOP
    stage:=payload->'stages'->(run->>'stage');
    SELECT jsonb_agg(v->'evidenceId' ORDER BY position) INTO cost_refs FROM jsonb_array_elements(run->'costs') WITH ORDINALITY a(v,position);
    IF NOT manga_web.operational_limit_object(stage,ARRAY['boundUsd','component','evidenceRefs']) OR
      stage->>'component' IS DISTINCT FROM 'STAGE_TOTAL' OR stage->'boundUsd' IS DISTINCT FROM run->'boundUsd' OR stage->'evidenceRefs' IS DISTINCT FROM cost_refs THEN RETURN false; END IF;
  END LOOP;
  RETURN (payload->>'version'=p.profile_version AND
    (payload->>'maxSlots')::numeric=p.max_slots AND
    (payload->>'requestLimitUsd')::numeric=p.request_limit_usd AND (payload->>'dailyLimitUsd')::numeric=p.daily_limit_usd AND
    (payload->>'fullBoundUsd')::numeric=p.full_bound_usd AND payload->'stages'=p.stage_bounds AND payload->'fullBoundEvidenceRefs'=p.full_bound_evidence_refs AND
    p.budget_period='OPERATOR_EXPLICIT_WINDOW_V1' AND p.window_start IS NOT NULL AND p.window_end IS NOT NULL AND
    isfinite(p.window_start) AND isfinite(p.window_end) AND p.window_start<p.window_end AND
    (payload->'window'->>'startAt')::timestamptz=p.window_start AND (payload->'window'->>'endAt')::timestamptz=p.window_end AND
    p.profile_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex')) IS TRUE;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;

-- Preserve each old CHECK expression verbatim in the OWNED branch, including
-- SQL CHECK's null acceptance for its nullable budget_period scalar check.
-- The new branch requires matching extracted columns and an explicit window.
DO $constraints$
DECLARE c record; operational text:=$branch$
  profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1' AND
  profile_payload->>'version'=profile_version AND
  (profile_payload->>'maxSlots')::numeric=max_slots AND
  (profile_payload->>'requestLimitUsd')::numeric=request_limit_usd AND
  (profile_payload->>'dailyLimitUsd')::numeric=daily_limit_usd AND
  (profile_payload->>'fullBoundUsd')::numeric=full_bound_usd AND
  profile_payload->'stages'=stage_bounds AND profile_payload->'fullBoundEvidenceRefs'=full_bound_evidence_refs AND
  budget_period='OPERATOR_EXPLICIT_WINDOW_V1' AND
  profile_payload->'window'->>'kind'=budget_period AND
  window_start IS NOT NULL AND window_end IS NOT NULL AND isfinite(window_start) AND isfinite(window_end) AND window_start<window_end AND
  (profile_payload->'window'->>'startAt')::timestamptz=window_start AND (profile_payload->'window'->>'endAt')::timestamptz=window_end
$branch$;
BEGIN
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
    WHERE conrelid='manga_web.execution_limit_profiles'::regclass AND contype='c' AND
      (pg_get_expr(conbin,conrelid) LIKE '%OWNED_FIXTURE%' OR pg_get_expr(conbin,conrelid) LIKE '%OWNED_EXPLICIT_WINDOW%') LOOP
    EXECUTE format('ALTER TABLE manga_web.execution_limit_profiles DROP CONSTRAINT %I',c.conname);
    EXECUTE format('ALTER TABLE manga_web.execution_limit_profiles ADD CONSTRAINT %I CHECK (((profile_payload->>''kind''=''OWNED_FIXTURE'' AND (%s) IS NOT FALSE) OR (%s)) IS TRUE)',c.conname,c.expression,operational);
  END LOOP;
END $constraints$;
-- No change to the legacy validator function body or its evidence grammar.
DROP TRIGGER validate_execution_limit_profiles ON execution_limit_profiles;
CREATE TRIGGER validate_execution_limit_profiles BEFORE INSERT ON execution_limit_profiles
  FOR EACH ROW WHEN (NEW.profile_payload->>'kind'='OWNED_FIXTURE') EXECUTE FUNCTION validate_execution_limit_profile();
CREATE FUNCTION validate_operational_execution_limit_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  NEW.profile_digest:=encode(sha256(convert_to(NEW.profile_payload::text,'UTF8')),'hex');
  IF NOT manga_web.operational_execution_limit_valid(NEW) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='OPERATIONAL_LIMIT_PROFILE_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_operational_execution_limit_profiles BEFORE INSERT ON execution_limit_profiles
  FOR EACH ROW WHEN (NEW.profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1') EXECUTE FUNCTION validate_operational_execution_limit_profile();

CREATE FUNCTION read_operational_execution_limit(expected_identity jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE h manga_web.execution_limit_authority%ROWTYPE; p manga_web.execution_limit_profiles%ROWTYPE;
  evidence manga_web.operational_limit_evidence%ROWTYPE; sampled timestamptz:=clock_timestamp();
BEGIN
  IF NOT manga_web.operational_limit_identity(expected_identity) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIMIT_PROFILE_UNCONFIRMED'; END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton;
  IF NOT FOUND OR h.state<>'OPEN' OR h.current_profile_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIMIT_AUTHORITY_UNCONFIRMED'; END IF;
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='GLOBAL_CLOCK_UNCONFIRMED'; END IF;
  SELECT * INTO p FROM manga_web.execution_limit_profiles WHERE profile_id=h.current_profile_id;
  IF NOT FOUND OR NOT manga_web.operational_execution_limit_valid(p) OR
    p.profile_payload->'identity' IS DISTINCT FROM expected_identity OR p.profile_version IS DISTINCT FROM expected_identity->>'profileVersion' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIMIT_PROFILE_UNCONFIRMED';
  END IF;
  IF sampled<p.window_start OR sampled>=p.window_end THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIMIT_PERIOD_UNCONFIRMED'; END IF;
  SELECT * INTO evidence FROM manga_web.operational_limit_evidence WHERE evidence_id=(p.profile_payload->'evidence'->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIMIT_PROFILE_UNCONFIRMED'; END IF;
  RETURN jsonb_build_object(
    'reference',jsonb_build_object('kind','MEASURED_EXECUTION_LIMITS_V1','profileId',p.profile_id,'profileDigest',p.profile_digest,'profileVersion',p.profile_version),
    'profile',p.profile_payload,'profileCanonical',p.profile_payload::text,
    'evidence',jsonb_build_object('id',evidence.evidence_id,'sha256',evidence.sha256,
      'bytesBase64',replace(encode(evidence.raw_bytes,'base64'),E'\n',''),'reviewedBy',evidence.reviewed_by,'reviewedAt',evidence.reviewed_at));
END $$;

-- Preserve original account/global lock order, HELD budget and evidence logic.
CREATE OR REPLACE FUNCTION capture_execution_limits(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); r manga_web.processing_requests%ROWTYPE; b manga_web.execution_request_bounds%ROWTYPE;
  h manga_web.execution_limit_authority%ROWTYPE; p manga_web.execution_limit_profiles%ROWTYPE; sampled timestamptz; ref jsonb;
BEGIN
  IF a IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  SELECT * INTO r FROM manga_web.processing_requests WHERE account_id=a AND request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  ref:=r.captured_input->'executionLimit';
  SELECT * INTO b FROM manga_web.execution_request_bounds WHERE account_id=a AND request_id=p_request;
  IF FOUND AND ref->>'kind' IS DISTINCT FROM 'MEASURED_EXECUTION_LIMITS_V1' THEN RETURN jsonb_build_object('allowed',true,'reason','CAPTURED','stageBounds',b.stage_bounds); END IF;
  IF ref IS NULL OR ref->>'kind' IS NULL OR ref->>'kind' NOT IN ('OWNED_FIXTURE','MEASURED_EXECUTION_LIMITS_V1') OR
    ref->>'profileId' IS NULL OR ref->>'profileId' !~ '^[0-9a-fA-F-]{36}$' OR
    (b.request_id IS NULL AND EXISTS(SELECT 1 FROM manga_web.execution_evidence v JOIN manga_web.executions e USING(account_id,execution_id) WHERE e.account_id=a AND e.request_id=p_request AND v.kind='INPUT')) THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING');
  END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN
    UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE 'GLOBAL_CLOCK_UNCONFIRMED' END,revision=revision+1 WHERE singleton;
    RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');
  END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  IF h.state<>'OPEN' OR h.current_profile_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_AUTHORITY_UNCONFIRMED'); END IF;
  SELECT * INTO p FROM manga_web.execution_limit_profiles WHERE profile_id=h.current_profile_id;
  IF ref->>'kind' IS DISTINCT FROM p.profile_payload->>'kind' OR ref->>'profileId'<>p.profile_id::text OR ref->>'profileDigest' IS DISTINCT FROM p.profile_digest OR ref->>'profileVersion' IS DISTINCT FROM p.profile_version OR r.captured_input->>'parameterProfileVersion' IS DISTINCT FROM p.profile_version THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');
  END IF;
  IF p.profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1' AND
    (NOT manga_web.operational_execution_limit_valid(p) OR NOT manga_web.operational_limit_object(ref,ARRAY['kind','profileId','profileDigest','profileVersion'])) THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_UNCONFIRMED');
  END IF;
  IF (p.profile_payload->>'kind'='OWNED_FIXTURE' AND (p.budget_period IS DISTINCT FROM 'OWNED_EXPLICIT_WINDOW' OR p.window_start IS NULL OR p.window_end IS NULL OR
    NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_end IS DISTINCT FROM p.window_start+interval '24 hours' OR
    p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end)) OR
    (p.profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1' AND (p.budget_period IS DISTINCT FROM 'OPERATOR_EXPLICIT_WINDOW_V1' OR p.window_start IS NULL OR p.window_end IS NULL OR NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end)) THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PERIOD_UNCONFIRMED'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.captured_stage_order) s(stage) WHERE NOT p.stage_bounds ? s.stage) THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  IF b.request_id IS NOT NULL THEN
    IF b.profile_id<>p.profile_id OR b.profile_digest<>p.profile_digest OR b.profile_version<>p.profile_version OR
      b.full_bound_usd<>p.full_bound_usd OR b.stage_bounds<>p.stage_bounds OR b.full_bound_evidence_refs<>p.full_bound_evidence_refs THEN
      RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');
    END IF;
    RETURN jsonb_build_object('allowed',true,'reason','CAPTURED','stageBounds',b.stage_bounds);
  END IF;
  INSERT INTO manga_web.execution_request_bounds(account_id,request_id,profile_id,profile_digest,profile_version,full_bound_usd,stage_bounds,full_bound_evidence_refs,captured_at)
    VALUES(a,p_request,p.profile_id,p.profile_digest,p.profile_version,p.full_bound_usd,p.stage_bounds,p.full_bound_evidence_refs,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','CAPTURED','stageBounds',p.stage_bounds);
END $$;

-- 0015 owns the public wrapper and its native root/adoption/termination checks.
-- Replace only the private v12 body, preserving that wrapper and all its ACLs.
CREATE OR REPLACE FUNCTION native_capacity_base_reserve_execution_v12(p_execution uuid,p_work uuid,p_generation bigint,p_worker uuid,p_reference jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); r manga_web.processing_requests%ROWTYPE; e manga_web.executions%ROWTYPE;
  b manga_web.execution_request_bounds%ROWTYPE; h manga_web.execution_limit_authority%ROWTYPE; p manga_web.execution_limit_profiles%ROWTYPE;
  budget manga_web.execution_budget_reservations%ROWTYPE; input manga_web.execution_evidence%ROWTYPE;
  sampled timestamptz; stage_bound numeric; held numeric; spent numeric; allocated numeric; request_spent numeric; count_input integer;
BEGIN
  IF a IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO e FROM manga_web.executions WHERE account_id=a AND execution_id=p_execution FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  SELECT * INTO r FROM manga_web.processing_requests WHERE account_id=a AND request_id=e.request_id FOR UPDATE;
  SELECT * INTO b FROM manga_web.execution_request_bounds WHERE account_id=a AND request_id=e.request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN
    UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE 'GLOBAL_CLOCK_UNCONFIRMED' END,revision=revision+1 WHERE singleton;
    RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');
  END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  IF h.state<>'OPEN' OR h.current_profile_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_AUTHORITY_UNCONFIRMED'); END IF;
  SELECT * INTO p FROM manga_web.execution_limit_profiles WHERE profile_id=h.current_profile_id;
  IF p_reference IS DISTINCT FROM r.captured_input->'executionLimit' OR p_reference->>'kind' IS DISTINCT FROM p.profile_payload->>'kind' OR p_reference->>'kind' NOT IN ('OWNED_FIXTURE','MEASURED_EXECUTION_LIMITS_V1') OR
    p_reference->>'profileId' IS DISTINCT FROM p.profile_id::text OR p_reference->>'profileDigest' IS DISTINCT FROM p.profile_digest OR p_reference->>'profileVersion' IS DISTINCT FROM p.profile_version OR
    b.profile_id<>p.profile_id OR b.profile_digest<>p.profile_digest OR b.profile_version<>p.profile_version OR
    b.full_bound_usd<>p.full_bound_usd OR b.stage_bounds<>p.stage_bounds OR b.full_bound_evidence_refs<>p.full_bound_evidence_refs THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');
  END IF;
  IF p.profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1' AND
    (NOT manga_web.operational_execution_limit_valid(p) OR
      r.captured_input->>'parameterProfileVersion' IS DISTINCT FROM p.profile_version OR
      NOT manga_web.operational_limit_object(p_reference,ARRAY['kind','profileId','profileDigest','profileVersion'])) THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_UNCONFIRMED');
  END IF;
  IF (p.profile_payload->>'kind'='OWNED_FIXTURE' AND (p.budget_period IS DISTINCT FROM 'OWNED_EXPLICIT_WINDOW' OR p.window_start IS NULL OR p.window_end IS NULL OR
    NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_end IS DISTINCT FROM p.window_start+interval '24 hours' OR
    p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end)) OR
    (p.profile_payload->>'kind'='MEASURED_EXECUTION_LIMITS_V1' AND (p.budget_period IS DISTINCT FROM 'OPERATOR_EXPLICIT_WINDOW_V1' OR p.window_start IS NULL OR p.window_end IS NULL OR NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end)) THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PERIOD_UNCONFIRMED'); END IF;
  SELECT count(*) INTO count_input FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND kind='INPUT';
  SELECT * INTO input FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND kind='INPUT';
  stage_bound:=(b.stage_bounds->e.logical_step_id->>'boundUsd')::numeric;
  IF count_input<>1 OR stage_bound IS NULL OR input.protected_observation->>'executionId' IS DISTINCT FROM e.execution_id::text OR
    input.protected_observation->>'requestId' IS DISTINCT FROM r.request_id::text OR input.protected_observation->>'accountId' IS DISTINCT FROM a::text OR
    input.protected_observation->>'stage' IS DISTINCT FROM e.logical_step_id OR input.protected_observation->>'inputDigest' IS DISTINCT FROM e.input_digest OR
    input.protected_observation->'envelope'->>'costBoundUsd' IS NULL OR
    (input.protected_observation->'envelope'->>'costBoundUsd')::numeric IS DISTINCT FROM stage_bound OR
    input.protected_observation->'envelope'->>'parameterProfileVersion' IS DISTINCT FROM b.profile_version OR
    input.protected_observation->'envelope'->>'executionId' IS DISTINCT FROM e.execution_id::text THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_INPUT_MISMATCH');
  END IF;
  IF e.state<>'PREPARED' OR e.dispatch_attempted_at IS NOT NULL OR e.claim_generation<>p_generation OR
    r.state IN ('COMPLETED','STOPPED','FAILED') OR
    NOT EXISTS(SELECT 1 FROM manga_web.request_steps s WHERE s.account_id=a AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id AND s.current_execution_id=p_execution) OR
    NOT EXISTS(SELECT 1 FROM manga_web.work_items w WHERE w.account_id=a AND w.work_item_id=p_work AND w.kind='DISPATCH' AND w.target_ref->>'requestId'=e.request_id::text AND w.state='CLAIMED' AND w.claim_generation=p_generation AND w.claim_owner=p_worker::text AND w.lease_until>sampled) THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_CLAIM_EXPIRED');
  END IF;
  IF EXISTS(SELECT 1 FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=p_execution) THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_ALREADY_RESERVED'); END IF;
  IF (SELECT count(*) FROM manga_web.execution_capacity_permits WHERE capacity_released_at IS NULL)>=p.max_slots THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_CAPACITY_WAIT'); END IF;
  SELECT * INTO budget FROM manga_web.execution_budget_reservations WHERE account_id=a AND request_id=e.request_id FOR UPDATE;
  SELECT COALESCE(sum(actual_usd),0) INTO request_spent FROM manga_web.execution_limit_expenses WHERE account_id=a AND request_id=e.request_id;
  IF budget.account_id IS NULL THEN
    SELECT COALESCE(sum(remaining_usd),0) INTO held FROM manga_web.execution_budget_reservations WHERE state='HELD';
    SELECT COALESCE(sum(actual_usd),0) INTO spent FROM manga_web.execution_limit_expenses WHERE cost_confirmed_at>=p.window_start AND cost_confirmed_at<p.window_end;
    IF b.full_bound_usd>p.request_limit_usd OR spent+held+b.full_bound_usd>p.daily_limit_usd THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BUDGET_WAIT'); END IF;
    INSERT INTO manga_web.execution_budget_reservations(account_id,request_id,initial_bound_usd,remaining_usd,state,reserved_at) VALUES(a,e.request_id,b.full_bound_usd,b.full_bound_usd,'HELD',sampled) RETURNING * INTO budget;
  ELSIF budget.state<>'HELD' THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BUDGET_WAIT');
  END IF;
  SELECT COALESCE(sum(stage_bound_usd),0) INTO allocated FROM manga_web.execution_capacity_permits WHERE account_id=a AND request_id=e.request_id AND budget_resolved_at IS NULL;
  IF allocated+stage_bound>budget.remaining_usd OR request_spent+budget.remaining_usd>p.request_limit_usd OR request_spent+stage_bound>b.full_bound_usd THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_REQUEST_BUDGET_WAIT'); END IF;
  INSERT INTO manga_web.execution_capacity_permits(account_id,execution_id,request_id,stage_bound_usd,expected_component,input_evidence_id,reserved_at)
    VALUES(a,p_execution,e.request_id,stage_bound,b.stage_bounds->e.logical_step_id->>'component',input.evidence_id,sampled);
  UPDATE manga_web.executions SET state='DISPATCHING',dispatch_attempted_at=sampled,revision=revision+1 WHERE account_id=a AND execution_id=p_execution;
  RETURN jsonb_build_object('allowed',true,'reason','RESERVED');
END $$;

REVOKE ALL ON FUNCTION operational_limit_object(jsonb,text[]),operational_limit_decimal(jsonb,boolean),operational_limit_uuid(jsonb),operational_limit_refs(jsonb),operational_limit_timestamp(jsonb),operational_limit_identity(jsonb),operational_limit_window(jsonb),operational_limit_measurement(jsonb),operational_execution_limit_valid(manga_web.execution_limit_profiles),validate_operational_limit_evidence(),validate_operational_execution_limit_profile() FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION operational_limit_object(jsonb,text[]),operational_limit_decimal(jsonb,boolean),operational_limit_uuid(jsonb),operational_limit_refs(jsonb),operational_limit_timestamp(jsonb),operational_limit_identity(jsonb),operational_limit_window(jsonb),operational_limit_measurement(jsonb),operational_execution_limit_valid(manga_web.execution_limit_profiles),validate_operational_limit_evidence(),validate_operational_execution_limit_profile() TO trio_web_operator;
REVOKE ALL ON FUNCTION read_operational_execution_limit(jsonb) FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION read_operational_execution_limit(jsonb) TO trio_web_api,trio_web_worker;

-- Restore the existing v12 HALTED record inside the v15 native wrapper's
-- backward-clock branch; all native admission logic and ACLs are preserved.
CREATE OR REPLACE FUNCTION reserve_execution_limits(p_execution uuid,p_work uuid,p_generation bigint,p_worker uuid,p_reference jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); h manga_web.execution_limit_authority%ROWTYPE; nh manga_web.native_capacity_authority%ROWTYPE;
  profile manga_web.execution_limit_profiles%ROWTYPE; execution_row manga_web.executions%ROWTYPE; input_row manga_web.execution_evidence%ROWTYPE;
  sampled timestamptz; bound integer; promotion_ids uuid[]:=ARRAY[]::uuid[]; candidate record; decision jsonb;
BEGIN
  IF a IS NULL OR manga_web.native_job_caller() IS DISTINCT FROM 'trio_web_worker' THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT * INTO nh FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE 'GLOBAL_CLOCK_UNCONFIRMED' END,revision=revision+1 WHERE singleton;RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  -- When no owned capacity profile was installed, existing execution-only
  -- validation and failure reasons remain owned by the original implementation.
  IF NOT manga_web.native_capacity_required() THEN RETURN manga_web.native_capacity_base_reserve_execution_v12(p_execution,p_work,p_generation,p_worker,p_reference);END IF;
  IF nh.state<>'OPEN' OR nh.current_profile_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_AUTHORITY_UNCONFIRMED');END IF;
  IF h.state<>'OPEN' OR h.current_profile_id IS NULL THEN RETURN manga_web.native_capacity_base_reserve_execution_v12(p_execution,p_work,p_generation,p_worker,p_reference);END IF;
  SELECT * INTO profile FROM manga_web.execution_limit_profiles WHERE profile_id=h.current_profile_id;
  SELECT least(profile.max_slots,max_slots) INTO bound FROM manga_web.native_capacity_profiles WHERE profile_id=nh.current_profile_id;
  SELECT * INTO execution_row FROM manga_web.executions WHERE account_id=a AND execution_id=p_execution;
  SELECT * INTO input_row FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND kind='INPUT';
  IF NOT EXISTS(SELECT 1 FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=p_execution) AND execution_row.execution_id IS NOT NULL AND
    (SELECT count(*) FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND kind='INPUT')=1 THEN
    FOR candidate IN SELECT r.*,j.protected_intent,j.target_kind,j.target_id,f.proof_id FROM manga_web.native_capacity_reservations r JOIN manga_web.native_job_intents j USING(account_id,job_id)
      LEFT JOIN manga_web.native_capacity_termination_proofs f ON f.account_id=r.account_id AND f.reservation_id=r.reservation_id
      WHERE r.account_id=a AND r.state='HELD' AND r.root_kind='STANDALONE' AND NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_adoptions d WHERE d.account_id=r.account_id AND d.reservation_id=r.reservation_id) AND
        j.owner_service='trio_web_worker' AND ((j.target_kind='EXECUTION' AND j.target_id=p_execution) OR(j.target_kind='REQUEST_CHECKPOINT' AND j.target_id=execution_row.request_id)) AND
        j.protected_intent->'claim'=jsonb_build_object('generation',p_generation::text,'ownerId',p_worker::text,'workItemId',p_work::text)
    LOOP
      IF candidate.proof_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_TERMINATION_UNCONFIRMED');END IF;
      IF candidate.source_input_evidence_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
      IF candidate.target_kind='EXECUTION' THEN
        IF candidate.source_execution_id IS DISTINCT FROM p_execution OR candidate.source_input_evidence_id IS DISTINCT FROM input_row.evidence_id THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
      ELSIF NOT manga_web.native_capacity_source_current(candidate.protected_intent,jsonb_build_object('executionId',candidate.source_execution_id::text,'inputEvidenceId',candidate.source_input_evidence_id::text,'stageInputDigest',(SELECT protected_observation->>'inputDigest' FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=candidate.source_input_evidence_id))) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
      IF input_row.protected_observation->>'executionId' IS DISTINCT FROM execution_row.execution_id::text OR input_row.protected_observation->>'requestId' IS DISTINCT FROM execution_row.request_id::text OR input_row.protected_observation->>'inputDigest' IS DISTINCT FROM execution_row.input_digest THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
      promotion_ids:=array_append(promotion_ids,candidate.reservation_id);
    END LOOP;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=p_execution) AND(SELECT count(*) FROM manga_web.native_capacity_roots())-cardinality(promotion_ids)>=bound THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_CAPACITY_WAIT');END IF;
  decision:=manga_web.native_capacity_base_reserve_execution_v12(p_execution,p_work,p_generation,p_worker,p_reference);
  IF (decision->>'allowed')::boolean IS DISTINCT FROM true THEN RETURN decision;END IF;
  INSERT INTO manga_web.native_capacity_adoptions(account_id,adoption_id,reservation_id,execution_id,execution_input_evidence_id,source_input_evidence_id,work_item_id,claim_generation,worker_id,mode,adopted_at)
    SELECT a,r.adoption_id,r.reservation_id,p_execution,input_row.evidence_id,r.source_input_evidence_id,p_work,p_generation,p_worker,'PROMOTE',clock_timestamp() FROM manga_web.native_capacity_reservations r WHERE r.account_id=a AND r.reservation_id=ANY(promotion_ids);
  RETURN decision;
END $$;
