-- W3-A capacity-only proposal; not applied to a product migration or a database.
-- Parent owns 0020 integration and windows_native_* authority/journal definitions.
-- Keep 0015/0016/0018/0019 files, proof/confirm/release and root accounting intact.
-- Required parent private hook, with no default or fallback implementation:
-- windows_native_capacity_go_ready(uuid,uuid,uuid,text,jsonb) RETURNS boolean
-- Arguments: job, exact attempt, expected original controller instance,
-- DB-derived owner service, exact registered captured capacity.
-- Must check native_controller_caller(), the same original/windows origin row,
-- exact attempt+instance+profile+hostEpoch+key/source tuple, and persisted READY
-- for that same origin/attempt/instance. Missing/unknown/error/terminal READY is
-- false. It must not manufacture READY or consult mutable current keys for history.
-- The 8-argument private GO overload below is called ONLY by
-- windows_native_grant_go, after its authenticated ctx/peer checks.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE FUNCTION native_capacity_windows_profile_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE w jsonb; policy jsonb; pins jsonb; field text; n numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16384 THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>11 OR NOT p ?& ARRAY['kind','version','maxSlots','nativeProfileDigest','kernelDigest','controllerId','keyVersion','environmentDigest','publicKeySpki','evidenceRefs','windows'] OR
    p->'kind' IS DISTINCT FROM '"WINDOWS_JOB_OBJECT"'::jsonb THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['version','keyVersion'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~'^[A-Za-z0-9._-]{1,128}$' THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_typeof(p->'controllerId') IS DISTINCT FROM 'string' OR p->>'controllerId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['nativeProfileDigest','kernelDigest','environmentDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_typeof(p->'maxSlots') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  n:=(p->>'maxSlots')::numeric;IF n<>trunc(n) OR n NOT BETWEEN 1 AND 10000 THEN RETURN false;END IF;
  IF jsonb_typeof(p->'publicKeySpki') IS DISTINCT FROM 'string' OR p->>'publicKeySpki'!~'^[A-Za-z0-9+/]{59}=$' THEN RETURN false;END IF;
  IF octet_length(decode(p->>'publicKeySpki','base64'))<>44 OR encode(substring(decode(p->>'publicKeySpki','base64') FROM 1 FOR 12),'hex')<>'302a300506032b6570032100' OR encode(decode(p->>'publicKeySpki','base64'),'base64')<>p->>'publicKeySpki' THEN RETURN false;END IF;
  IF jsonb_typeof(p->'evidenceRefs') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'evidenceRefs') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'evidenceRefs') value WHERE jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value#>>'{}')!~'^windows-job:[A-Za-z0-9._/-]{1,160}$') OR
    (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'evidenceRefs') value)<>jsonb_array_length(p->'evidenceRefs') THEN RETURN false;END IF;
  w:=p->'windows';IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(w))<>6 OR NOT w ?& ARRAY['hostEpochId','policy','pins','controllerSidDigest','childSidDigest','appContainerSidDigest'] OR jsonb_typeof(w->'hostEpochId') IS DISTINCT FROM 'string' OR w->>'hostEpochId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['controllerSidDigest','childSidDigest','appContainerSidDigest'] LOOP
    IF jsonb_typeof(w->field) IS DISTINCT FROM 'string' OR w->>field!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  END LOOP;
  pins:=w->'pins';IF jsonb_typeof(pins) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(pins))<>6 OR NOT pins ?& ARRAY['executableDigest','bootstrapDigest','helperRuntimeDigest','helperScriptDigest','runtimeFilesDigest','nativeLimitsDigest'] THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['executableDigest','bootstrapDigest','helperRuntimeDigest','helperScriptDigest','runtimeFilesDigest','nativeLimitsDigest'] LOOP
    IF jsonb_typeof(pins->field) IS DISTINCT FROM 'string' OR pins->>field!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  END LOOP;
  policy:=w->'policy';IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(policy))<>8 OR NOT policy ?& ARRAY['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes'] THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['maxProcesses','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs'] LOOP
    IF jsonb_typeof(policy->field) IS DISTINCT FROM 'number' THEN RETURN false;END IF;
    n:=(policy->>field)::numeric;IF n<>trunc(n) OR n<1 OR n>(CASE field WHEN 'maxProcesses' THEN 4294967295 WHEN 'cpuRatePer10000' THEN 10000 ELSE 2147483647 END) THEN RETURN false;END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['jobCommitLimitBytes','processCommitLimitBytes','stdoutMaxBytes','stderrMaxBytes'] LOOP
    IF jsonb_typeof(policy->field) IS DISTINCT FROM 'string' OR policy->>field!~'^[1-9][0-9]{0,19}$' THEN RETURN false;END IF;
    IF (policy->>field)::numeric>18446744073709551615::numeric THEN RETURN false;END IF;
  END LOOP;
  IF (policy->>'processCommitLimitBytes')::numeric>(policy->>'jobCommitLimitBytes')::numeric THEN RETURN false;END IF;
  RETURN true;
END $$;

-- Exactly the single old tagged payload CHECK is replaced; byte/SPKI/column
-- constraints remain. Unexpected prior schema fails migration rather than
-- selecting a looser fallback or silently dropping another constraint.
DO $profile_check$ DECLARE candidates text[];BEGIN
  SELECT array_agg(conname::text) INTO candidates FROM pg_catalog.pg_constraint
    WHERE conrelid='manga_web.native_capacity_profiles'::regclass AND contype='c' AND position('OWNED_FIXTURE' IN pg_catalog.pg_get_constraintdef(oid))>0;
  IF cardinality(candidates) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'NATIVE_CAPACITY_PROFILE_CHECK_UNCONFIRMED';END IF;
  EXECUTE format('ALTER TABLE manga_web.native_capacity_profiles DROP CONSTRAINT %I',candidates[1]);
END $profile_check$;
ALTER TABLE native_capacity_profiles ADD CONSTRAINT native_capacity_tagged_profile_columns CHECK((
  jsonb_typeof(profile_payload)='object' AND profile_payload->>'kind' IN('OWNED_FIXTURE','WINDOWS_JOB_OBJECT') AND
  profile_payload->>'version'=profile_version AND profile_payload->'maxSlots'=to_jsonb(max_slots) AND
  profile_payload->>'nativeProfileDigest'=native_profile_digest AND profile_payload->>'kernelDigest'=kernel_digest AND
  profile_payload->>'controllerId'=controller_id::text AND profile_payload->>'keyVersion'=key_version AND
  profile_payload->>'environmentDigest'=environment_digest AND profile_payload->>'publicKeySpki'=public_key_spki
) IS TRUE);
-- OWNED trigger body below remains literal; only Windows takes the new branch.
-- SECURITY DEFINER is required only to invoke the private pure validator;
-- operator gets no direct helper EXECUTE, and the fixed search_path is retained.
CREATE OR REPLACE FUNCTION native_capacity_profile_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE p jsonb:=NEW.profile_payload; field text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_IMMUTABLE'; END IF;
  IF p->'kind'='"WINDOWS_JOB_OBJECT"'::jsonb THEN
    IF NOT manga_web.native_capacity_windows_profile_valid(p) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_RECORD_INVALID';END IF;
    NEW.profile_digest:=encode(sha256(convert_to(p::text,'UTF8')),'hex');RETURN NEW;
  END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>10 OR NOT p ?& ARRAY['kind','version','maxSlots','nativeProfileDigest','kernelDigest','controllerId','keyVersion','environmentDigest','publicKeySpki','evidenceRefs'] OR
    jsonb_typeof(p->'evidenceRefs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'evidenceRefs') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_RECORD_INVALID'; END IF;
  FOR field IN SELECT jsonb_array_elements_text(p->'evidenceRefs') LOOP
    IF field!~'^owned-fixture:[A-Za-z0-9._/-]{1,160}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_RECORD_INVALID'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'evidenceRefs') v WHERE jsonb_typeof(v)<>'string') OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(p->'evidenceRefs') v)<>jsonb_array_length(p->'evidenceRefs') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_RECORD_INVALID'; END IF;
  FOREACH field IN ARRAY ARRAY['kind','version','nativeProfileDigest','kernelDigest','controllerId','keyVersion','environmentDigest','publicKeySpki'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_RECORD_INVALID'; END IF;
  END LOOP;
  NEW.profile_digest:=encode(sha256(convert_to(p::text,'UTF8')),'hex');RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION native_capacity_reference_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF p->'kind'='"WINDOWS_JOB_OBJECT"'::jsonb THEN
    RETURN (jsonb_typeof(p)='object' AND(SELECT count(*) FROM jsonb_object_keys(p))=4 AND p ?& ARRAY['kind','profileId','profileDigest','profileVersion'] AND
      jsonb_typeof(p->'profileId')='string' AND p->>'profileId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      jsonb_typeof(p->'profileDigest')='string' AND p->>'profileDigest'~'^[a-f0-9]{64}$' AND jsonb_typeof(p->'profileVersion')='string' AND p->>'profileVersion'~'^[A-Za-z0-9._-]{1,128}$') IS TRUE;
  END IF;
  RETURN (jsonb_typeof(p)='object' AND(SELECT count(*) FROM jsonb_object_keys(p))=4 AND p ?& ARRAY['kind','profileId','profileDigest','profileVersion'] AND
    p->>'kind'='OWNED_FIXTURE' AND jsonb_typeof(p->'profileId')='string' AND p->>'profileId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(p->'profileDigest')='string' AND p->>'profileDigest'~'^[a-f0-9]{64}$' AND jsonb_typeof(p->'profileVersion')='string' AND p->>'profileVersion'~'^[A-Za-z0-9._-]{1,128}$') IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION native_capacity_configuration_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>(CASE WHEN p ? 'sourceInput' THEN 3 ELSE 2 END) OR NOT p ?& ARRAY['reference','profile'] OR jsonb_typeof(p->'profile') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF p ? 'sourceInput' AND NOT manga_web.native_capacity_source_valid(p->'sourceInput') THEN RETURN false;END IF;
  IF p->'reference'->'kind' IS DISTINCT FROM p->'profile'->'kind' OR p->'reference'->'profileVersion' IS DISTINCT FROM p->'profile'->'version' THEN RETURN false;END IF;
  IF p->'reference'->'kind'='"WINDOWS_JOB_OBJECT"'::jsonb THEN
    IF NOT manga_web.native_capacity_windows_profile_valid(p->'profile') OR NOT manga_web.native_capacity_source_valid(p->'sourceInput') THEN RETURN false;END IF;
  END IF;
  RETURN manga_web.native_capacity_reference_valid(p->'reference');
END $$;

-- All original account/global locks, ACTIVE/owner/claim/source checks,
-- native_capacity_roots and least(native,execution) maxSlots stay in this body.
CREATE OR REPLACE FUNCTION native_capacity_create_intent(p jsonb,p_receipt boolean,p_capacity jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); h manga_web.native_capacity_authority%ROWTYPE; eh manga_web.execution_limit_authority%ROWTYPE;
  profile manga_web.native_capacity_profiles%ROWTYPE; permit manga_web.execution_capacity_permits%ROWTYPE; source_input manga_web.execution_evidence%ROWTYPE;
  sampled timestamptz; bound integer; decision jsonb; reservation uuid:=gen_random_uuid(); adoption uuid:=gen_random_uuid(); p_reference jsonb:=p_capacity->'reference';
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO eh FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT * INTO h FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF eh.last_observed_at IS NOT NULL AND sampled<eh.last_observed_at THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  IF NOT manga_web.native_capacity_configuration_valid(p_capacity) OR h.state<>'OPEN' OR h.current_profile_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_AUTHORITY_UNCONFIRMED');END IF;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=h.current_profile_id;
  -- Compare the exact validated payload as JSONB, including actual kernel,
  -- controller, key and environment. Its SQL text digest is not a JS RFC8785 hash.
  IF p_reference->>'profileId' IS DISTINCT FROM profile.profile_id::text OR p_reference->>'profileDigest' IS DISTINCT FROM profile.profile_digest OR p_reference->>'profileVersion' IS DISTINCT FROM profile.profile_version OR p->>'profileDigest' IS DISTINCT FROM profile.native_profile_digest OR profile.profile_payload IS DISTINCT FROM p_capacity->'profile' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  IF p_reference->'kind' IS DISTINCT FROM profile.profile_payload->'kind' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  IF profile.profile_payload->'kind'='"WINDOWS_JOB_OBJECT"'::jsonb AND
    (p->>'targetKind' IS NULL OR p->>'targetKind' NOT IN('EXECUTION','REQUEST_CHECKPOINT') OR NOT manga_web.native_capacity_source_valid(p_capacity->'sourceInput')) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  -- The base validator remains the source of truth. Malformed inputs must fail
  -- before any reservation, and before target casts used by the admission code.
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT manga_web.native_job_valid_tuple(p) OR p->>'targetId'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN manga_web.native_capacity_base_intent(p,p_receipt);END IF;
  IF NOT manga_web.native_job_target_current(p,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED');END IF;
  IF p->>'targetKind' IN('EXECUTION','REQUEST_CHECKPOINT') THEN
    IF NOT manga_web.native_capacity_source_current(p,p_capacity->'sourceInput') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
    SELECT * INTO source_input FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(p_capacity->'sourceInput'->>'inputEvidenceId')::uuid;
    IF p->>'targetKind'='EXECUTION' THEN SELECT * INTO permit FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=(p->>'targetId')::uuid AND capacity_released_at IS NULL;END IF;
  ELSIF p_capacity ? 'sourceInput' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');
  END IF;
  IF permit.execution_id IS NOT NULL AND (source_input.evidence_id IS NULL OR permit.input_evidence_id IS DISTINCT FROM source_input.evidence_id) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  IF permit.execution_id IS NOT NULL AND EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r LEFT JOIN manga_web.native_capacity_adoptions d USING(account_id,reservation_id) WHERE r.account_id=a AND r.state='HELD' AND COALESCE(d.execution_id,r.base_execution_id)=permit.execution_id AND NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs f WHERE f.account_id=r.account_id AND f.reservation_id=r.reservation_id)) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_EXECUTION_OCCUPIED');END IF;
  bound:=profile.max_slots;IF eh.current_profile_id IS NOT NULL THEN
    IF eh.state<>'OPEN' THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_AUTHORITY_UNCONFIRMED');END IF;
    SELECT least(bound,max_slots) INTO bound FROM manga_web.execution_limit_profiles WHERE profile_id=eh.current_profile_id;
  END IF;
  IF permit.execution_id IS NULL AND(SELECT count(*) FROM manga_web.native_capacity_roots())>=bound THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_WAIT');END IF;
  decision:=manga_web.native_capacity_base_intent(p,p_receipt);IF (decision->>'allowed')::boolean IS DISTINCT FROM true THEN RETURN decision;END IF;
  INSERT INTO manga_web.native_capacity_reservations(account_id,reservation_id,job_id,adoption_id,owner_service,profile_id,profile_digest,profile_version,execution_profile_id,root_kind,base_execution_id,source_execution_id,source_input_evidence_id,reserved_at,state)
    VALUES(a,reservation,(p->>'jobId')::uuid,adoption,service,profile.profile_id,profile.profile_digest,profile.profile_version,eh.current_profile_id,CASE WHEN permit.execution_id IS NULL THEN 'STANDALONE' ELSE 'EXECUTION' END,permit.execution_id,source_input.execution_id,source_input.evidence_id,sampled,'HELD');
  IF permit.execution_id IS NOT NULL THEN
    INSERT INTO manga_web.native_capacity_adoptions(account_id,adoption_id,reservation_id,execution_id,execution_input_evidence_id,source_input_evidence_id,work_item_id,claim_generation,worker_id,mode,adopted_at)
    VALUES(a,adoption,reservation,permit.execution_id,permit.input_evidence_id,source_input.evidence_id,(p->'claim'->>'workItemId')::uuid,(p->'claim'->>'generation')::bigint,(p->'claim'->>'ownerId')::uuid,'BORROW',sampled);
  END IF;
  RETURN decision||jsonb_build_object('capacityReservationId',reservation);
END $$;

-- PREPARE/current does not require an attempt or READY. GO below does.
CREATE OR REPLACE FUNCTION native_capacity_current_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb ,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
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
  IF profile.profile_payload->'kind'='"WINDOWS_JOB_OBJECT"'::jsonb AND NOT manga_web.native_controller_caller() THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  SELECT protected_intent INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=p_job;
  IF r.source_input_evidence_id IS NOT NULL THEN
    IF p_capacity->'sourceInput'->>'executionId' IS DISTINCT FROM r.source_execution_id::text OR p_capacity->'sourceInput'->>'inputEvidenceId' IS DISTINCT FROM r.source_input_evidence_id::text OR
      p_capacity->'sourceInput'->>'stageInputDigest' IS DISTINCT FROM(SELECT protected_observation->>'inputDigest' FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=r.source_input_evidence_id) OR
      NOT manga_web.native_capacity_source_current(intent,p_capacity->'sourceInput') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  ELSIF p_capacity ? 'sourceInput' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_INPUT_MISMATCH');END IF;
  bound:=profile.max_slots;IF eh.current_profile_id IS NOT NULL THEN SELECT least(bound,max_slots) INTO bound FROM manga_web.execution_limit_profiles WHERE profile_id=eh.current_profile_id;END IF;
  IF(SELECT count(*) FROM manga_web.native_capacity_roots())>bound THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_WAIT');END IF;
  IF profile.profile_payload->>'kind'='WINDOWS_JOB_OBJECT' AND manga_web.windows_native_owner_current(intent->'protectedOwnerCapture') IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  RETURN manga_web.native_job_go_current_owned(p_job,p_parent,p_claim,p_capture,service);
END $$;

CREATE OR REPLACE FUNCTION native_capacity_recovery(p_after text DEFAULT NULL,p_after_id uuid DEFAULT NULL) RETURNS TABLE(state jsonb,created_at_cursor text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); after_at timestamptz;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN;END IF;
  IF(p_after IS NULL) IS DISTINCT FROM(p_after_id IS NULL) OR(p_after IS NOT NULL AND p_after!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_CURSOR_INVALID';END IF;
  after_at:=p_after::timestamptz;
  RETURN QUERY SELECT jsonb_build_object('capacityReservationId',r.reservation_id,'jobId',r.job_id,'parentInstanceId',j.parent_instance_id,
    'reference',jsonb_build_object('kind',profile.profile_payload->>'kind','profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version),
    'rootKind',CASE WHEN COALESCE(d.execution_id,r.base_execution_id) IS NULL THEN 'STANDALONE' ELSE 'EXECUTION' END,'executionId',COALESCE(d.execution_id,r.base_execution_id),'adoptionId',r.adoption_id,
    'go',CASE WHEN g.job_id IS NULL THEN 'UNCONSUMED' ELSE 'CONSUMED' END,'terminationProofId',f.proof_id,'state','HELD','ownerService',r.owner_service,'protectedIntent',j.protected_intent)||
    CASE WHEN r.source_input_evidence_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceInput',jsonb_build_object('executionId',r.source_execution_id,'inputEvidenceId',r.source_input_evidence_id,'stageInputDigest',i.protected_observation->>'inputDigest')) END,
    to_char(r.reserved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM manga_web.native_capacity_reservations r JOIN manga_web.native_job_intents j USING(account_id,job_id) JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id
    LEFT JOIN manga_web.native_capacity_adoptions d USING(account_id,reservation_id) LEFT JOIN manga_web.native_job_go_consumptions g USING(account_id,job_id) LEFT JOIN manga_web.native_capacity_termination_proofs f ON f.account_id=r.account_id AND f.reservation_id=r.reservation_id
    LEFT JOIN manga_web.execution_evidence i ON i.account_id=r.account_id AND i.evidence_id=r.source_input_evidence_id
    WHERE r.account_id=a AND r.owner_service=service AND r.state='HELD' AND(p_after IS NULL OR(r.reserved_at,r.reservation_id)>(after_at,p_after_id)) ORDER BY r.reserved_at,r.reservation_id LIMIT 64;
END $$;

-- Rename the exact final 0016 body once, immediately remove all role access,
-- then recreate both the old private 6-arg name and the public API wrapper.
-- Replacing consume_go explicitly also invalidates any cached old function OID.
ALTER FUNCTION native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text) RENAME TO native_capacity_go_base_v16;
REVOKE ALL ON FUNCTION native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
CREATE FUNCTION native_capacity_go_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb,p_owner_service text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE registered_kind text;
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  SELECT profile.profile_payload->>'kind' INTO registered_kind FROM manga_web.native_capacity_reservations r
    JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id WHERE r.account_id=manga_web.current_account() AND r.job_id=p_job;
  IF registered_kind='WINDOWS_JOB_OBJECT' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_WINDOWS_REQUIRED');END IF;
  RETURN manga_web.native_capacity_go_base_v16(p_job,p_parent,p_claim,p_capture,p_capacity,p_owner_service);
END $$;
CREATE OR REPLACE FUNCTION native_capacity_consume_go(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT manga_web.native_capacity_go_owned(p_job,p_parent,p_claim,p_capture,p_capacity,manga_web.native_job_caller())
$$;

-- Required private overload. Never grant this to controller/API/worker roles.
-- Parent windows_native_grant_go supplies its already authenticated exact
-- attempt/instance and writes its own grant atomically with this consumption.
CREATE FUNCTION native_capacity_go_owned(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb,p_owner_service text,p_attempt uuid,p_instance uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; registered_kind text;
BEGIN
  IF NOT manga_web.native_controller_caller() OR p_attempt IS NULL OR p_instance IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO original FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND job_id=p_job AND attempt_id=p_attempt;
  IF NOT FOUND OR original.controller_instance_id IS DISTINCT FROM p_instance OR original.owner_service IS DISTINCT FROM p_owner_service OR original.protected_capacity IS DISTINCT FROM p_capacity OR
    original.protected_binding->>'parentInstanceId' IS DISTINCT FROM p_parent::text THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED');END IF;
  SELECT profile.profile_payload->>'kind' INTO registered_kind FROM manga_web.native_capacity_reservations r
    JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id WHERE r.account_id=original.account_id AND r.reservation_id=original.reservation_id AND r.job_id=p_job;
  IF registered_kind IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' OR p_capacity->'reference'->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROFILE_MISMATCH');END IF;
  -- Parent hook is mandatory. It reads persisted origin+READY, the exact
  -- original expected instance, and rejects unknown/terminal/error readiness.
  IF manga_web.windows_native_owner_current((SELECT protected_intent->'protectedOwnerCapture' FROM manga_web.native_job_intents WHERE account_id=original.account_id AND job_id=p_job)) IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  IF manga_web.windows_native_capacity_go_ready(p_job,p_attempt,p_instance,p_owner_service,p_capacity) IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_GO_UNCONFIRMED');END IF;
  RETURN manga_web.native_capacity_go_base_v16(p_job,p_parent,p_claim,p_capture,p_capacity,p_owner_service);
END $$;

-- Keep the existing v1 caller/tuple/frame validator behind a private rename.
-- Reject the actual registered Windows tag before any v1 claim, replay, READY
-- or GO. A caller cannot choose OWNED in JSON to reinterpret a Windows row.
ALTER FUNCTION native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid) RENAME TO native_controller_claim_owned_v16;
ALTER FUNCTION native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid) RENAME TO native_controller_ready_owned_v16;
ALTER FUNCTION native_controller_grant_go(jsonb,uuid,uuid,uuid,text) RENAME TO native_controller_grant_go_owned_v16;
REVOKE ALL ON FUNCTION native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
CREATE FUNCTION native_controller_claim(p_binding jsonb,p_input text,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_peer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p_binding) OR p_binding->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id WHERE r.account_id=manga_web.current_account() AND r.reservation_id=(p_binding->>'capacityReservationId')::uuid AND profile.profile_payload->>'kind'='WINDOWS_JOB_OBJECT') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_WINDOWS_REQUIRED');END IF;
  RETURN manga_web.native_controller_claim_owned_v16(p_binding,p_input,p_attempt,p_instance,p_controller,p_peer_service,p_peer);
END $$;
CREATE FUNCTION native_controller_ready(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p_binding) OR p_binding->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id WHERE r.account_id=manga_web.current_account() AND r.reservation_id=(p_binding->>'capacityReservationId')::uuid AND profile.profile_payload->>'kind'='WINDOWS_JOB_OBJECT') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_WINDOWS_REQUIRED');END IF;
  RETURN manga_web.native_controller_ready_owned_v16(p_binding,p_attempt,p_instance,p_controller,p_peer_service,p_event);
END $$;
CREATE FUNCTION native_controller_grant_go(p_binding jsonb,p_attempt uuid,p_instance uuid,p_controller uuid,p_peer_service text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p_binding) OR p_binding->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROLLER_ACCESS_DENIED');END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles profile ON profile.profile_id=r.profile_id WHERE r.account_id=manga_web.current_account() AND r.reservation_id=(p_binding->>'capacityReservationId')::uuid AND profile.profile_payload->>'kind'='WINDOWS_JOB_OBJECT') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_WINDOWS_REQUIRED');END IF;
  RETURN manga_web.native_controller_grant_go_owned_v16(p_binding,p_attempt,p_instance,p_controller,p_peer_service);
END $$;

-- Exact new private signatures for the parent's storage role forbidden lists:
-- native_capacity_windows_profile_valid(jsonb)
-- native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text)
-- native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid)
-- native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid)
-- native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid)
-- native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text)
-- Required parent hook: windows_native_capacity_go_ready(uuid,uuid,uuid,text,jsonb)
REVOKE ALL ON FUNCTION native_capacity_windows_profile_valid(jsonb),native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text),native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text),native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid),native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text),native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
-- Existing private validator/trigger privileges remain private.
REVOKE ALL ON FUNCTION native_capacity_profile_record(),native_capacity_reference_valid(jsonb),native_capacity_configuration_valid(jsonb) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
REVOKE ALL ON FUNCTION native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go(jsonb,uuid,uuid,uuid,text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
GRANT EXECUTE ON FUNCTION native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid),native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid),native_controller_grant_go(jsonb,uuid,uuid,uuid,text) TO trio_web_controller;
-- No PUBLIC or LOGIN grants. No new profile/authority inserts or OPEN action.
-- native_capacity_create_intent/recovery/consume_go retain their existing
-- API/worker grants via CREATE OR REPLACE; confirm_proof/release remain unchanged.
-- The parent must revoke the required readiness hook after defining it, before
-- any runtime access or committing 0020, and add it to role forbidden lists.
-- W3-A: immutable Windows originals. This migration does not release capacity,
-- open an authority, execute a host, or confirm execution cost.
SET LOCAL search_path TO manga_web,pg_catalog;

-- Only Windows' closed ASCII-key, integer/string wire records use this encoder.
-- General execution INPUT and SQL JSONB digests retain their own contracts.
CREATE FUNCTION windows_native_canonical(p jsonb,p_depth integer DEFAULT 0) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE result text; n numeric;
BEGIN
  IF p IS NULL OR p_depth>20 OR octet_length(p::text)>262144 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
  CASE jsonb_typeof(p)
  WHEN 'object' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k !~ '^[ -~]*$') OR (SELECT count(*) FROM jsonb_object_keys(p))>8192 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
    SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||manga_web.windows_native_canonical(value,p_depth+1),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p);
  WHEN 'array' THEN
    IF jsonb_array_length(p)>8192 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
    SELECT '['||COALESCE(string_agg(manga_web.windows_native_canonical(value,p_depth+1),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY a(value,ordinal);
  WHEN 'number' THEN
    IF p::text !~ '^-?(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
    n:=p::text::numeric;IF abs(n)>9007199254740991 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;result:=p::text;
  WHEN 'string','boolean','null' THEN result:=p::text;
  ELSE RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END CASE;
  RETURN result;
END $$;
CREATE FUNCTION windows_native_hash(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT encode(sha256(convert_to(manga_web.windows_native_canonical(p),'UTF8')),'hex')$$;
CREATE FUNCTION windows_native_parse(p text,p_max integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE v jsonb;nodes bigint;
BEGIN
  IF p IS NULL OR octet_length(p)>p_max OR p_max>131072 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LIMIT';END IF;
  v:=p::jsonb;
  WITH RECURSIVE walk(item,depth) AS(SELECT v,0 UNION ALL SELECT child,depth+1 FROM walk CROSS JOIN LATERAL(
    SELECT value AS child FROM jsonb_each(CASE WHEN jsonb_typeof(item)='object' THEN item ELSE '{}'::jsonb END)
    UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item)='array' THEN item ELSE '[]'::jsonb END)
  ) a WHERE depth<=20) SELECT count(*) INTO nodes FROM walk;
  IF nodes>8192 OR manga_web.windows_native_canonical(v) IS DISTINCT FROM p THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
  RETURN v;
END $$;
CREATE FUNCTION windows_native_object(p jsonb,p_keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
SELECT CASE WHEN jsonb_typeof(p)='object' THEN (SELECT count(*) FROM jsonb_object_keys(p))=cardinality(p_keys) AND p ?& p_keys ELSE false END$$;
CREATE FUNCTION windows_native_context(p jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE k text;
BEGIN
  IF NOT manga_web.native_controller_caller() OR NOT manga_web.windows_native_object(p,ARRAY['binding','attemptId','controllerInstanceId','controllerId','ownerService','peerId']) OR NOT manga_web.native_controller_binding_valid(p->'binding') OR p->'binding'->>'accountId' IS DISTINCT FROM manga_web.current_account()::text OR p->>'ownerService' NOT IN('trio_web_api','trio_web_worker') THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['attemptId','controllerInstanceId','controllerId','peerId'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR NOT manga_web.operational_limit_uuid(p->k) THEN RETURN false;END IF;
  END LOOP;RETURN true;
END $$;

CREATE TABLE windows_native_origins(
  account_id uuid NOT NULL,attempt_id uuid NOT NULL,
  origin_canonical text NOT NULL CHECK(octet_length(origin_canonical)<=131072),
  protected_origin jsonb NOT NULL CHECK(jsonb_typeof(protected_origin)='object'),
  origin_digest text NOT NULL CHECK(origin_digest~'^[a-f0-9]{64}$'),
  frame_input_digest text NOT NULL CHECK(frame_input_digest~'^[a-f0-9]{64}$'),
  launch_ref uuid NOT NULL,input_snapshot jsonb NOT NULL,basis_snapshot jsonb,
  PRIMARY KEY(account_id,attempt_id),UNIQUE(account_id,origin_digest),UNIQUE(account_id,launch_ref),
  FOREIGN KEY(account_id,attempt_id) REFERENCES native_controller_attempts(account_id,attempt_id)
);
CREATE TABLE windows_native_events(
  account_id uuid NOT NULL,attempt_id uuid NOT NULL,event_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 64),kind text NOT NULL,
  event_canonical text NOT NULL,source_canonical text NOT NULL,
  protected_event jsonb NOT NULL,protected_source jsonb NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$'),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
  CHECK(octet_length(event_canonical)+octet_length(source_canonical)<=131072),
  PRIMARY KEY(account_id,attempt_id,event_id),UNIQUE(account_id,attempt_id,sequence),UNIQUE(account_id,event_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES windows_native_origins(account_id,attempt_id)
);
CREATE TABLE windows_native_records(
  account_id uuid NOT NULL,attempt_id uuid NOT NULL,record_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN('READY','PARENT_JOIN','SEAL','FINALIZED')),
  canonical text NOT NULL CHECK(octet_length(canonical)<=131072),
  protected_record jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
  PRIMARY KEY(account_id,record_id),UNIQUE(account_id,attempt_id,purpose),
  UNIQUE(account_id,attempt_id,record_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES windows_native_origins(account_id,attempt_id)
);
CREATE TABLE windows_native_links(
  account_id uuid NOT NULL,attempt_id uuid NOT NULL,link_id uuid NOT NULL,
  canonical text NOT NULL CHECK(octet_length(canonical)<=32768),
  protected_link jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
  signature text NOT NULL CHECK(signature~'^[A-Za-z0-9+/]{86}==$'),
  PRIMARY KEY(account_id,link_id),UNIQUE(account_id,attempt_id),
  FOREIGN KEY(account_id,attempt_id) REFERENCES windows_native_origins(account_id,attempt_id)
);
DO $tables$ DECLARE t text;BEGIN
  FOREACH t IN ARRAY ARRAY['windows_native_origins','windows_native_events','windows_native_records','windows_native_links'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY account_scope ON manga_web.%I USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',t);
    EXECUTE format('REVOKE ALL ON manga_web.%I FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator',t);
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE OR TRUNCATE ON manga_web.%I FOR EACH STATEMENT EXECUTE FUNCTION manga_web.immutable_native_job_record()',t);
  END LOOP;
END $tables$;

-- This fence validates original account/attempt/peer/instance provenance only.
-- It intentionally does not re-authorize an old fact against today's lease.
CREATE FUNCTION windows_native_scope(p jsonb) RETURNS windows_native_origins LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;
BEGIN
  IF NOT manga_web.windows_native_context(p) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_ACCESS_DENIED';END IF;
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND attempt_id=(p->>'attemptId')::uuid FOR UPDATE;
  IF NOT FOUND OR a.protected_binding IS DISTINCT FROM p->'binding' OR a.controller_instance_id::text IS DISTINCT FROM p->>'controllerInstanceId' OR a.controller_id::text IS DISTINCT FROM p->>'controllerId' OR a.owner_service IS DISTINCT FROM p->>'ownerService' OR a.authenticated_peer_id::text IS DISTINCT FROM p->>'peerId' OR a.protected_capacity->'reference'->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BINDING_MISMATCH';END IF;
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=a.account_id AND attempt_id=a.attempt_id;
  IF NOT FOUND OR o.protected_origin->'identity'->'binding' IS DISTINCT FROM a.protected_binding OR o.frame_input_digest IS DISTINCT FROM a.protected_job->>'inputDigest' OR manga_web.windows_native_parse(o.origin_canonical,131072) IS DISTINCT FROM o.protected_origin OR o.protected_origin->'authority'->>'attemptId' IS DISTINCT FROM a.attempt_id::text THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_ORIGINAL_UNCONFIRMED';END IF;
  RETURN o;
END $$;
CREATE FUNCTION windows_native_basis(p_account uuid,p_execution uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE rows integer;r manga_web.execution_evidence%ROWTYPE;v jsonb;
BEGIN
  SELECT count(*) INTO rows FROM manga_web.execution_evidence WHERE account_id=p_account AND execution_id=p_execution AND kind='OPERATIONAL_COST_BASIS';
  IF rows=0 THEN RETURN NULL;END IF;IF rows<>1 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BASIS_UNCONFIRMED';END IF;
  SELECT * INTO r FROM manga_web.execution_evidence WHERE account_id=p_account AND execution_id=p_execution AND kind='OPERATIONAL_COST_BASIS';v:=r.protected_observation;
  IF octet_length(v::text)>131072 OR v->>'accountId' IS DISTINCT FROM p_account::text OR v->>'executionId' IS DISTINCT FROM p_execution::text OR v->>'inputDigest' IS DISTINCT FROM p_input->'value'->>'inputDigest' OR v->>'inputFingerprint' IS DISTINCT FROM p_input->>'evidenceDigest' OR v->>'kind' IS DISTINCT FROM 'OPERATIONAL_COST_BASIS' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BASIS_UNCONFIRMED';END IF;
  RETURN jsonb_build_object('evidenceId',r.evidence_id,'evidenceDigest',r.evidence_digest,'value',v);
END $$;
CREATE FUNCTION windows_native_offer(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.native_capacity_reservations%ROWTYPE;i manga_web.native_job_intents%ROWTYPE;profile manga_web.native_capacity_profiles%ROWTYPE;e manga_web.execution_evidence%ROWTYPE;capacity jsonb;source jsonb;input jsonb;basis jsonb;decision jsonb;
BEGIN
  IF NOT manga_web.windows_native_context(p) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=manga_web.current_account() AND reservation_id=(p->'binding'->>'capacityReservationId')::uuid;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=r.account_id AND job_id=r.job_id;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  IF r.job_id::text IS DISTINCT FROM p->'binding'->>'jobId' OR i.parent_instance_id::text IS DISTINCT FROM p->'binding'->>'parentInstanceId' OR i.input_digest IS DISTINCT FROM p->'binding'->>'inputDigest' OR i.profile_digest IS DISTINCT FROM p->'binding'->>'profileDigest' OR i.profile_digest IS DISTINCT FROM profile.native_profile_digest OR profile.kernel_digest IS DISTINCT FROM p->'binding'->>'kernelDigest' OR profile.profile_payload->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' OR profile.controller_id::text IS DISTINCT FROM p->>'controllerId' OR i.owner_service IS DISTINCT FROM p->>'ownerService' OR r.owner_service IS DISTINCT FROM i.owner_service OR r.source_input_evidence_id IS NULL OR i.protected_intent->>'targetKind' NOT IN('EXECUTION','REQUEST_CHECKPOINT') THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_BINDING_MISMATCH');END IF;
  SELECT * INTO e FROM manga_web.execution_evidence WHERE account_id=r.account_id AND execution_id=r.source_execution_id AND evidence_id=r.source_input_evidence_id AND kind='INPUT';
  IF NOT FOUND OR octet_length(e.protected_observation::text)>131072 OR (SELECT count(*) FROM manga_web.execution_evidence WHERE account_id=r.account_id AND execution_id=r.source_execution_id AND kind='INPUT')<>1 THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_INPUT_UNCONFIRMED');END IF;
  source:=jsonb_build_object('executionId',r.source_execution_id,'inputEvidenceId',e.evidence_id,'stageInputDigest',e.protected_observation->>'inputDigest');
  capacity:=jsonb_build_object('reference',jsonb_build_object('kind',profile.profile_payload->>'kind','profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version),'profile',profile.profile_payload,'sourceInput',source);
  decision:=manga_web.native_capacity_current_owned(i.job_id,i.parent_instance_id,i.protected_intent->'claim',i.protected_intent->'protectedOwnerCapture',capacity,i.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  input:=jsonb_build_object('evidenceId',e.evidence_id,'evidenceDigest',e.evidence_digest,'value',e.protected_observation);basis:=manga_web.windows_native_basis(r.account_id,r.source_execution_id,input);
  RETURN jsonb_build_object('allowed',true,'facts',jsonb_build_object('binding',p->'binding','intentDigest',i.intent_digest,'sourceInput',source,'input',input,'basis',basis,'capacity',capacity));
END $$;

CREATE FUNCTION windows_native_capture(p jsonb,p_origin text,p_input text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE result jsonb;facts jsonb;o jsonb;auth jsonb;identity jsonb;profile jsonb;frame jsonb;od text;prior manga_web.windows_native_origins%ROWTYPE;retention jsonb;dependencies jsonb;i manga_web.native_job_intents%ROWTYPE;sampled timestamptz;launch uuid:=gen_random_uuid();cap jsonb;
BEGIN
  IF NOT manga_web.windows_native_context(p) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
  o:=manga_web.windows_native_parse(p_origin,131072);auth:=o->'authority';identity:=o->'identity';
  SELECT * INTO prior FROM manga_web.windows_native_origins WHERE account_id=manga_web.current_account() AND attempt_id=(p->>'attemptId')::uuid;
  IF FOUND THEN
    prior:=manga_web.windows_native_scope(p);
    IF prior.origin_canonical IS DISTINCT FROM p_origin OR p_input IS DISTINCT FROM(SELECT input_canonical FROM manga_web.native_controller_attempts WHERE account_id=prior.account_id AND attempt_id=prior.attempt_id) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_CONFLICT');END IF;
    RETURN jsonb_build_object('allowed',true,'created',false,'capture',jsonb_build_object('origin',prior.protected_origin,'originDigest',prior.origin_digest,'frameInputDigest',prior.frame_input_digest,'launchRef',prior.launch_ref));
  END IF;
  result:=manga_web.windows_native_offer(p);IF result->>'allowed' IS DISTINCT FROM 'true' THEN RETURN result;END IF;facts:=result->'facts';profile:=facts->'capacity'->'profile';
  IF NOT manga_web.windows_native_object(o,ARRAY['identity','authority','pins','policy','limits']) OR NOT manga_web.windows_native_object(identity,ARRAY['binding','intentDigest','sourceInput','inputEvidenceDigest','inputFingerprint','basisRef']) OR identity->'binding' IS DISTINCT FROM p->'binding' OR identity->>'intentDigest' IS DISTINCT FROM facts->>'intentDigest' OR identity->'sourceInput' IS DISTINCT FROM facts->'sourceInput' OR identity->>'inputEvidenceDigest' IS DISTINCT FROM facts->'input'->>'evidenceDigest' OR identity->>'inputFingerprint' IS DISTINCT FROM facts->'input'->>'evidenceDigest' OR identity->'basisRef' IS DISTINCT FROM (CASE WHEN facts->'basis'='null'::jsonb THEN 'null'::jsonb ELSE (facts->'basis')-'value' END) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_INPUT_UNCONFIRMED');END IF;
  IF NOT manga_web.windows_native_object(auth,ARRAY['attemptId','controllerInstanceId','controllerId','keyVersion','environmentDigest','hostEpochId','sessionId','launchId','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest']) OR auth->>'attemptId' IS DISTINCT FROM p->>'attemptId' OR auth->>'controllerInstanceId' IS DISTINCT FROM p->>'controllerInstanceId' OR auth->>'controllerId' IS DISTINCT FROM p->>'controllerId' OR auth->>'keyVersion' IS DISTINCT FROM profile->>'keyVersion' OR auth->>'environmentDigest' IS DISTINCT FROM profile->>'environmentDigest' OR auth->>'hostEpochId' IS DISTINCT FROM profile->'windows'->>'hostEpochId' OR auth->>'policyDigest' IS DISTINCT FROM manga_web.windows_native_hash(o->'policy') OR o->'policy' IS DISTINCT FROM profile->'windows'->'policy' OR o->'pins' IS DISTINCT FROM profile->'windows'->'pins' OR auth->>'controllerSidDigest' IS DISTINCT FROM profile->'windows'->>'controllerSidDigest' OR auth->>'childSidDigest' IS DISTINCT FROM profile->'windows'->>'childSidDigest' OR auth->>'appContainerSidDigest' IS DISTINCT FROM profile->'windows'->>'appContainerSidDigest' OR NOT manga_web.operational_limit_uuid(auth->'sessionId') OR NOT manga_web.operational_limit_uuid(auth->'launchId') OR manga_web.windows_native_hash(o->'limits') IS DISTINCT FROM o->'pins'->>'nativeLimitsDigest' THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_PROFILE_UNCONFIRMED');END IF;
  IF NOT manga_web.windows_native_object(o->'limits',ARRAY['maxMetadataBytes','maxInputBytes','maxOutputBytes','maxItems','childMemoryBytes','maxProcesses','timeoutMs','terminationWaitMs','parentInFlightBytes']) OR EXISTS(SELECT 1 FROM jsonb_each(o->'limits') WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[1-9][0-9]*$' OR value::text::numeric>2147483647) OR (o->'policy'->>'maxProcesses')::numeric>(o->'limits'->>'maxProcesses')::numeric OR (o->'policy'->>'wallTimeoutMs')::numeric>(o->'limits'->>'timeoutMs')::numeric OR (o->'policy'->>'joinTimeoutMs')::numeric>(o->'limits'->>'terminationWaitMs')::numeric THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_LIMIT');END IF;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=manga_web.current_account() AND job_id=(p->'binding'->>'jobId')::uuid;
  IF p_input IS NULL OR octet_length(p_input)>(o->'limits'->>'maxMetadataBytes')::integer OR encode(sha256(convert_to(p_input,'UTF8')),'hex') IS DISTINCT FROM i.input_digest THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_FRAME_UNCONFIRMED');END IF;
  -- NativeJob metadata already has its original raw canonical-byte digest above.
  -- Its valid finite fractional coordinates are not a Windows integer-only record.
  frame:=p_input::jsonb;
  IF NOT manga_web.windows_native_object(frame,ARRAY['version','jobId','task','taskVersion','profileDigest','metadata','blobs']) OR frame->'version' IS DISTINCT FROM '1'::jsonb OR frame->>'jobId' IS DISTINCT FROM i.job_id::text OR frame->>'task' IS DISTINCT FROM i.task OR frame->>'taskVersion' IS DISTINCT FROM i.task_version OR frame->>'profileDigest' IS DISTINCT FROM i.profile_digest OR jsonb_typeof(frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(frame->'blobs') IS DISTINCT FROM 'array' OR jsonb_array_length(frame->'blobs')>(o->'limits'->>'maxItems')::integer THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_FRAME_UNCONFIRMED');END IF;
  sampled:=clock_timestamp();retention:=manga_web.native_receipt_retention(i.protected_intent,sampled);dependencies:=manga_web.native_receipt_source_assets(i.protected_intent,frame,sampled);
  IF retention->>'available' IS DISTINCT FROM 'true' OR dependencies IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_SOURCE_UNCONFIRMED');END IF;
  INSERT INTO manga_web.native_controller_attempts(account_id,attempt_id,reservation_id,job_id,controller_instance_id,controller_id,owner_service,authenticated_peer_id,protected_binding,input_canonical,protected_job,protected_capacity,source_asset_dependencies,asset_purpose,related_context_id,access_deadline,created_at)
  VALUES(manga_web.current_account(),(p->>'attemptId')::uuid,(p->'binding'->>'capacityReservationId')::uuid,i.job_id,(p->>'controllerInstanceId')::uuid,(p->>'controllerId')::uuid,i.owner_service,(p->>'peerId')::uuid,p->'binding',p_input,frame||jsonb_build_object('inputDigest',i.input_digest),facts->'capacity',dependencies,retention->>'purpose',(retention->>'contextId')::uuid,(retention->>'accessDeadline')::timestamptz,sampled);
  od:=manga_web.windows_native_hash(jsonb_build_object('identity',identity,'authority',auth,'pins',o->'pins','policy',o->'policy','nativeLimitsDigest',manga_web.windows_native_hash(o->'limits'),'frameInputDigest',i.input_digest));
  INSERT INTO manga_web.windows_native_origins VALUES(manga_web.current_account(),(p->>'attemptId')::uuid,p_origin,o,od,i.input_digest,launch,facts->'input',nullif(facts->'basis','null'::jsonb));
  cap:=jsonb_build_object('origin',o,'originDigest',od,'frameInputDigest',i.input_digest,'launchRef',launch);
  RETURN jsonb_build_object('allowed',true,'created',true,'capture',cap);
END $$;

CREATE FUNCTION windows_native_go_ref(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r jsonb;g manga_web.native_controller_go_grants%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=p_account AND attempt_id=p_attempt;
  SELECT * INTO g FROM manga_web.native_controller_go_grants WHERE account_id=p_account AND attempt_id=p_attempt;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT to_jsonb(c) INTO r FROM manga_web.native_job_go_consumptions c WHERE c.account_id=p_account AND c.job_id=a.job_id AND c.parent_instance_id=(a.protected_binding->>'parentInstanceId')::uuid;
  IF r IS NULL OR g.job_id IS DISTINCT FROM a.job_id OR g.controller_instance_id IS DISTINCT FROM a.controller_instance_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_GO_UNCONFIRMED';END IF;
  RETURN jsonb_build_object('jobId',a.job_id,'rowDigest',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION windows_native_current(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;
BEGIN o:=manga_web.windows_native_scope(p);RETURN jsonb_build_object('allowed',true,'status',jsonb_build_object('originDigest',o.origin_digest,'state','CONFIRMED','goGrantRef',manga_web.windows_native_go_ref(o.account_id,o.attempt_id)));END $$;

CREATE FUNCTION windows_native_store(p jsonb,p_purpose text,p_id uuid,p_canonical text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;r manga_web.windows_native_records%ROWTYPE;v jsonb;seal text;ref jsonb;counted integer;bad boolean;
BEGIN
  o:=manga_web.windows_native_scope(p);v:=manga_web.windows_native_parse(p_canonical,131072);seal:=manga_web.windows_native_hash(v);
  IF p_id IS NULL OR p_purpose IS NULL OR p_purpose NOT IN('READY','PARENT_JOIN','SEAL','FINALIZED') OR EXISTS(SELECT 1 FROM manga_web.windows_native_links WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND NOT EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose=p_purpose AND canonical=p_canonical)) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RECORD_INVALID';END IF;
  SELECT * INTO r FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose=p_purpose;
  IF FOUND THEN
    IF r.canonical IS DISTINCT FROM p_canonical THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_CONFLICT';END IF;
    RETURN jsonb_build_object('allowed',true,'ref',jsonb_build_object('recordId',r.record_id,'digest',r.digest));
  END IF;
  IF p_purpose='READY' THEN
    IF NOT manga_web.windows_native_object(v,ARRAY['originDigest','attemptId','controllerInstanceId','sessionId','launchId','root']) OR v->>'originDigest' IS DISTINCT FROM o.origin_digest OR v->>'attemptId' IS DISTINCT FROM p->>'attemptId' OR v->>'controllerInstanceId' IS DISTINCT FROM p->>'controllerInstanceId' OR v->>'sessionId' IS DISTINCT FROM o.protected_origin->'authority'->>'sessionId' OR v->>'launchId' IS DISTINCT FROM o.protected_origin->'authority'->>'launchId' OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='PREPARED') OR v->'root' IS DISTINCT FROM (SELECT (protected_event->'payload')-'assignedBy' FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='CREATED_SUSPENDED') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_READY_UNCONFIRMED';END IF;
  ELSIF p_purpose='PARENT_JOIN' THEN
    IF NOT manga_web.windows_native_object(v,ARRAY['joinId','originDigest','digest']) OR v->>'originDigest' IS DISTINCT FROM o.origin_digest OR v->>'joinId' IS DISTINCT FROM p_id::text OR jsonb_typeof(v->'digest') IS DISTINCT FROM 'string' OR v->>'digest' !~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_PARENT_UNCONFIRMED';END IF;
  ELSIF p_purpose='SEAL' THEN
    IF manga_web.windows_native_seal_valid(o.account_id,o.attempt_id,v) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_SEAL_UNCONFIRMED';END IF;
    IF NOT manga_web.windows_native_object(v,ARRAY['version','originDigest','evidence','entries','parentJoinAck']) OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'originDigest' IS DISTINCT FROM o.origin_digest OR octet_length(manga_web.windows_native_canonical(v->'evidence'))>65536 OR NOT manga_web.windows_native_object(v->'evidence',ARRAY['version','kind','identity','authority','pins','policy','lifecycle','final']) OR v->'evidence'->'version' IS DISTINCT FROM '1'::jsonb OR v->'evidence'->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' OR v->'evidence'->'identity' IS DISTINCT FROM o.protected_origin->'identity' OR v->'evidence'->'authority' IS DISTINCT FROM o.protected_origin->'authority' OR v->'evidence'->'pins' IS DISTINCT FROM o.protected_origin->'pins' OR v->'evidence'->'policy'->'requested' IS DISTINCT FROM o.protected_origin->'policy' OR jsonb_typeof(v->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'entries')>64 OR jsonb_typeof(v->'evidence'->'lifecycle'->'events') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_SEAL_UNCONFIRMED';END IF;
    SELECT count(*) INTO counted FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id;
    IF counted<>jsonb_array_length(v->'entries') OR counted<>jsonb_array_length(v->'evidence'->'lifecycle'->'events') OR EXISTS(SELECT 1 FROM manga_web.windows_native_events e WHERE e.account_id=o.account_id AND e.attempt_id=o.attempt_id AND (v->'entries'->(e.sequence-1) IS DISTINCT FROM jsonb_build_object('eventId',e.event_id,'payloadDigest',e.payload_digest,'sourceDigest',e.source_digest) OR v->'evidence'->'lifecycle'->'events'->(e.sequence-1) IS DISTINCT FROM e.protected_event)) OR v->'evidence'->'lifecycle'->'goGrantRef' IS DISTINCT FROM COALESCE(manga_web.windows_native_go_ref(o.account_id,o.attempt_id),'null'::jsonb) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_EVENT_SET_UNCONFIRMED';END IF;
    IF v->'parentJoinAck'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='PARENT_JOIN' AND protected_record=v->'parentJoinAck') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_PARENT_UNCONFIRMED';END IF;
  ELSE
    SELECT jsonb_build_object('recordId',record_id,'digest',digest) INTO ref FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='SEAL';
    IF ref IS NULL OR NOT manga_web.windows_native_object(v,ARRAY['version','originDigest','finalized','brokerJoin']) OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'originDigest' IS DISTINCT FROM o.origin_digest OR NOT manga_web.windows_native_object(v->'finalized',ARRAY['recordId','digest','handles','closeCode']) OR (v->'finalized')-'handles'-'closeCode' IS DISTINCT FROM ref OR v->'finalized'->>'handles' IS DISTINCT FROM 'CLOSED' OR v->'finalized'->'closeCode' IS DISTINCT FROM 'null'::jsonb OR NOT manga_web.windows_native_object(v->'brokerJoin',ARRAY['end','finalized']) OR v->'brokerJoin'->>'end' IS DISTINCT FROM 'EXPECTED' OR v->'brokerJoin'->'finalized' IS DISTINCT FROM v->'finalized' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_FINALIZED_UNCONFIRMED';END IF;
  END IF;
  INSERT INTO manga_web.windows_native_records VALUES(o.account_id,o.attempt_id,p_id,p_purpose,p_canonical,v,seal);
  RETURN jsonb_build_object('allowed',true,'ref',jsonb_build_object('recordId',p_id,'digest',seal));
END $$;
CREATE FUNCTION windows_native_ready(p jsonb,p_canonical text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;i manga_web.native_job_intents%ROWTYPE;decision jsonb;r uuid;
BEGIN
  o:=manga_web.windows_native_scope(p);SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=o.account_id AND attempt_id=o.attempt_id;
  IF EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=o.account_id AND attempt_id=o.attempt_id) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_READY_UNCONFIRMED');END IF;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=o.account_id AND job_id=a.job_id;
  decision:=manga_web.native_capacity_current_owned(i.job_id,i.parent_instance_id,i.protected_intent->'claim',i.protected_intent->'protectedOwnerCapture',a.protected_capacity,i.owner_service);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  decision:=manga_web.windows_native_store(p,'READY',gen_random_uuid(),p_canonical);r:=(decision->'ref'->>'recordId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='READY') THEN
    INSERT INTO manga_web.native_controller_events(account_id,attempt_id,event_id,controller_instance_id,kind,code,received_at) VALUES(o.account_id,o.attempt_id,r,a.controller_instance_id,'READY','OK',clock_timestamp());
  END IF;RETURN jsonb_build_object('allowed',true);
END $$;
CREATE FUNCTION windows_native_grant_go(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;i manga_web.native_job_intents%ROWTYPE;decision jsonb;g jsonb;
BEGIN
  o:=manga_web.windows_native_scope(p);SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=o.account_id AND attempt_id=o.attempt_id;g:=manga_web.windows_native_go_ref(o.account_id,o.attempt_id);
  IF g IS NOT NULL THEN RETURN jsonb_build_object('allowed',true,'created',false,'goGrantRef',g);END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='READY') OR NOT EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='READY') OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='BOOTSTRAP_RESUMED') OR EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose IN('SEAL','FINALIZED')) OR EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind IN('FAILED','CREATE_FAILED','CREATE_NOT_ATTEMPTED')) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_GO_UNCONFIRMED');END IF;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=o.account_id AND job_id=a.job_id;
  decision:=manga_web.native_capacity_go_owned(i.job_id,i.parent_instance_id,i.protected_intent->'claim',i.protected_intent->'protectedOwnerCapture',a.protected_capacity,i.owner_service,o.attempt_id,a.controller_instance_id);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RETURN decision;END IF;
  INSERT INTO manga_web.native_controller_go_grants(account_id,attempt_id,job_id,controller_instance_id,granted_at) VALUES(o.account_id,o.attempt_id,a.job_id,a.controller_instance_id,clock_timestamp());
  RETURN jsonb_build_object('allowed',true,'created',true,'goGrantRef',manga_web.windows_native_go_ref(o.account_id,o.attempt_id));
END $$;

CREATE FUNCTION windows_native_append(p jsonb,p_event text,p_source text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;e jsonb;s jsonb;seal text;sd text;prior manga_web.windows_native_events%ROWTYPE;lastrow manga_web.windows_native_events%ROWTYPE;seq integer;facts jsonb;v_kind text;
BEGIN
  o:=manga_web.windows_native_scope(p);
  IF p_event IS NULL OR p_source IS NULL OR octet_length(p_event)+octet_length(p_source)>131072 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LIMIT';END IF;
  e:=manga_web.windows_native_parse(p_event,131072);s:=manga_web.windows_native_parse(p_source,131072);
  IF NOT manga_web.windows_native_object(e,ARRAY['eventId','sequence','kind','qpcTicks','previousDigest','payload','payloadDigest']) OR NOT manga_web.operational_limit_uuid(e->'eventId') OR jsonb_typeof(e->'sequence') IS DISTINCT FROM 'number' OR e->>'sequence'!~'^[1-9][0-9]?$' OR (e->>'sequence')::integer>64 OR jsonb_typeof(e->'qpcTicks') IS DISTINCT FROM 'string' OR e->>'qpcTicks'!~'^(0|[1-9][0-9]{0,19})$' OR (e->>'qpcTicks')::numeric>18446744073709551615 OR jsonb_typeof(e->'payload') IS DISTINCT FROM 'object' OR NOT manga_web.windows_native_object(s,ARRAY['version','originDigest','eventId','facts']) OR s->'version' IS DISTINCT FROM '1'::jsonb OR s->>'originDigest' IS DISTINCT FROM o.origin_digest OR s->>'eventId' IS DISTINCT FROM e->>'eventId' OR jsonb_typeof(s->'facts') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'facts')>64 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_EVENT_INVALID';END IF;
  seal:=manga_web.windows_native_hash(e-'payloadDigest');sd:=manga_web.windows_native_hash(s);seq:=(e->>'sequence')::integer;v_kind:=e->>'kind';
  IF e->>'payloadDigest' IS DISTINCT FROM seal OR v_kind NOT IN('PRE_CREATE','CREATE_NOT_ATTEMPTED','CREATE_ARMED','CREATE_FAILED','CREATED_SUSPENDED','PREPARED','BOOTSTRAP_RESUMED','GO_AUTHORIZED','GO_WRITE_ARMED','GO_WRITE','ROOT_EXIT','TREE_EMPTY','IO_JOINED','FINAL_ACCOUNTING','FAILED') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_EVENT_INVALID';END IF;
  IF manga_web.windows_native_source_valid(o.account_id,o.attempt_id,e,s) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_SOURCE_UNCONFIRMED';END IF;
  SELECT * INTO prior FROM manga_web.windows_native_events WHERE account_id=o.account_id AND event_id=(e->>'eventId')::uuid;
  IF FOUND THEN
    IF prior.attempt_id IS DISTINCT FROM o.attempt_id OR prior.event_canonical IS DISTINCT FROM p_event OR prior.source_canonical IS DISTINCT FROM p_source THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_CONFLICT';END IF;
    RETURN jsonb_build_object('allowed',true,'ack',jsonb_build_object('eventId',prior.event_id,'payloadDigest',prior.payload_digest,'sourceDigest',prior.source_digest));
  END IF;
  SELECT * INTO lastrow FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id ORDER BY sequence DESC LIMIT 1;
  IF seq<>COALESCE(lastrow.sequence,0)+1 OR e->'previousDigest' IS DISTINCT FROM COALESCE(to_jsonb(lastrow.payload_digest),'null'::jsonb) OR (e->>'qpcTicks')::numeric<COALESCE((lastrow.protected_event->>'qpcTicks')::numeric,0) OR EXISTS(SELECT 1 FROM manga_web.windows_native_events event_row WHERE event_row.account_id=o.account_id AND event_row.attempt_id=o.attempt_id AND event_row.kind=v_kind) OR EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='SEAL') OR (seq=1 AND v_kind<>'PRE_CREATE') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_ORDER';END IF;
  IF v_kind='PRE_CREATE' AND e->'payload' IS DISTINCT FROM jsonb_build_object('bindingDigest',manga_web.windows_native_hash(o.protected_origin->'identity'),'policyDigest',o.protected_origin->'authority'->>'policyDigest','pinsDigest',manga_web.windows_native_hash(o.protected_origin->'pins')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_SOURCE_UNCONFIRMED';END IF;
  IF v_kind='GO_AUTHORIZED' AND e->'payload'->'goGrantRef' IS DISTINCT FROM manga_web.windows_native_go_ref(o.account_id,o.attempt_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_GO_UNCONFIRMED';END IF;
  INSERT INTO manga_web.windows_native_events VALUES(o.account_id,o.attempt_id,(e->>'eventId')::uuid,seq,v_kind,p_event,p_source,e,s,seal,sd);
  RETURN jsonb_build_object('allowed',true,'ack',jsonb_build_object('eventId',e->>'eventId','payloadDigest',seal,'sourceDigest',sd));
END $$;
CREATE FUNCTION windows_native_event(p jsonb,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;e manga_web.windows_native_events%ROWTYPE;v jsonb;
BEGIN o:=manga_web.windows_native_scope(p);SELECT * INTO e FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND event_id=p_id;
  IF FOUND THEN v:=jsonb_build_object('event',e.protected_event,'source',e.protected_source,'sourceDigest',e.source_digest);END IF;RETURN jsonb_build_object('allowed',true,'entry',v);END $$;
CREATE FUNCTION windows_native_scan(p jsonb,p_after integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;e manga_web.windows_native_events%ROWTYPE;v jsonb:='[]'::jsonb;
BEGIN o:=manga_web.windows_native_scope(p);IF p_after IS NULL OR p_after NOT BETWEEN 0 AND 64 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LIMIT';END IF;
  SELECT * INTO e FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND sequence>p_after ORDER BY sequence LIMIT 1;
  IF FOUND THEN v:=jsonb_build_array(jsonb_build_object('event',e.protected_event,'source',e.protected_source,'sourceDigest',e.source_digest));END IF;
  RETURN jsonb_build_object('allowed',true,'entries',v);
END $$;
CREATE FUNCTION windows_native_record(p jsonb,p_purpose text,p_id uuid,p_canonical text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN IF p_purpose IS NULL OR p_purpose='READY' THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_READY_UNCONFIRMED');END IF;RETURN manga_web.windows_native_store(p,p_purpose,p_id,p_canonical);END $$;

CREATE FUNCTION windows_native_facts(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;i manga_web.native_job_intents%ROWTYPE;r manga_web.native_controller_raw_results%ROWTYPE;input jsonb;basis jsonb;observations jsonb;records jsonb;link jsonb;signed_basis jsonb;
BEGIN
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt;
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=p_account AND attempt_id=p_attempt;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=p_account AND job_id=a.job_id;
  SELECT jsonb_build_object('evidenceId',evidence_id,'evidenceDigest',evidence_digest,'value',protected_observation) INTO input FROM manga_web.execution_evidence WHERE account_id=p_account AND execution_id=(o.protected_origin->'identity'->'sourceInput'->>'executionId')::uuid AND evidence_id=(o.protected_origin->'identity'->'sourceInput'->>'inputEvidenceId')::uuid AND kind='INPUT';
  IF o.account_id IS NULL OR input IS DISTINCT FROM o.input_snapshot OR i.intent_digest IS DISTINCT FROM o.protected_origin->'identity'->>'intentDigest' OR NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations n JOIN manga_web.native_capacity_profiles p ON p.profile_id=n.profile_id WHERE n.account_id=p_account AND n.reservation_id=a.reservation_id AND n.job_id=a.job_id AND n.profile_digest=a.protected_capacity->'reference'->>'profileDigest' AND n.profile_version=a.protected_capacity->'reference'->>'profileVersion' AND p.profile_payload=a.protected_capacity->'profile' AND p.profile_payload->>'kind'='WINDOWS_JOB_OBJECT' AND n.source_execution_id::text=o.protected_origin->'identity'->'sourceInput'->>'executionId' AND n.source_input_evidence_id::text=o.protected_origin->'identity'->'sourceInput'->>'inputEvidenceId') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_ORIGINAL_UNCONFIRMED';END IF;
  SELECT protected_link->'basis' INTO signed_basis FROM manga_web.windows_native_links WHERE account_id=p_account AND attempt_id=p_attempt;
  IF FOUND THEN
    IF signed_basis='null'::jsonb THEN basis:=NULL;
    ELSE
      SELECT jsonb_build_object('evidenceId',evidence_id,'evidenceDigest',evidence_digest,'value',protected_observation) INTO basis FROM manga_web.execution_evidence WHERE account_id=p_account AND execution_id=(o.protected_origin->'identity'->'sourceInput'->>'executionId')::uuid AND kind='OPERATIONAL_COST_BASIS' AND evidence_id::text=signed_basis->>'evidenceId' AND evidence_digest=signed_basis->>'evidenceDigest';
      IF basis IS NULL OR basis->'value'->>'accountId' IS DISTINCT FROM p_account::text OR basis->'value'->>'executionId' IS DISTINCT FROM o.protected_origin->'identity'->'sourceInput'->>'executionId' OR basis->'value'->>'inputDigest' IS DISTINCT FROM input->'value'->>'inputDigest' OR basis->'value'->>'inputFingerprint' IS DISTINCT FROM input->>'evidenceDigest' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BASIS_UNCONFIRMED';END IF;
    END IF;
  ELSE basis:=manga_web.windows_native_basis(p_account,(o.protected_origin->'identity'->'sourceInput'->>'executionId')::uuid,input);END IF;
  IF o.basis_snapshot IS NOT NULL AND basis IS DISTINCT FROM o.basis_snapshot THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BASIS_UNCONFIRMED';END IF;
  SELECT * INTO r FROM manga_web.native_controller_raw_results WHERE account_id=p_account AND attempt_id=p_attempt;
  IF FOUND AND (r.result_digest IS DISTINCT FROM encode(sha256(convert_to(r.result_canonical,'UTF8')),'hex') OR r.controller_instance_id IS DISTINCT FROM a.controller_instance_id OR r.result_canonical::jsonb->>'jobId' IS DISTINCT FROM a.job_id::text OR r.result_canonical::jsonb->>'inputDigest' IS DISTINCT FROM o.frame_input_digest) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_RAW_UNCONFIRMED';END IF;
  IF (SELECT count(*) FROM manga_web.native_controller_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind IN('OBSERVATION','TERMINATION'))>2 OR (SELECT count(*) FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt)>4 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LIMIT';END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_controller_events e LEFT JOIN manga_web.native_job_observations n ON n.account_id=e.account_id AND n.observation_id=e.observation_id WHERE e.account_id=p_account AND e.attempt_id=p_attempt AND e.kind IN('OBSERVATION','TERMINATION') AND(n.job_id IS DISTINCT FROM a.job_id OR n.parent_instance_id::text IS DISTINCT FROM a.protected_binding->>'parentInstanceId' OR n.observation_digest IS DISTINCT FROM e.observation_digest OR n.protected_observation IS DISTINCT FROM e.protected_observation OR n.observation_digest IS DISTINCT FROM encode(sha256(convert_to(n.protected_observation::text,'UTF8')),'hex'))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_OBSERVATION_UNCONFIRMED';END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('evidenceId',e.observation_id,'evidenceDigest',e.observation_digest,'value',e.protected_observation) ORDER BY CASE e.kind WHEN 'OBSERVATION' THEN 0 ELSE 1 END),'[]'::jsonb) INTO observations FROM manga_web.native_controller_events e WHERE e.account_id=p_account AND e.attempt_id=p_attempt AND e.kind IN('OBSERVATION','TERMINATION');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('purpose',purpose,'recordId',record_id,'digest',digest,'value',protected_record) ORDER BY purpose),'[]'::jsonb) INTO records FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt;
  SELECT jsonb_build_object('linkId',link_id,'canonical',canonical,'digest',digest,'signature',signature) INTO link FROM manga_web.windows_native_links WHERE account_id=p_account AND attempt_id=p_attempt;
  RETURN jsonb_build_object('capacity',a.protected_capacity,'input',input,'basis',basis,'goGrantRef',manga_web.windows_native_go_ref(p_account,p_attempt),'rawResult',CASE WHEN r.raw_result_id IS NULL THEN NULL ELSE jsonb_build_object('rawResultId',r.raw_result_id,'resultDigest',r.result_digest) END,'observations',observations,'records',records,'link',link,'peer',jsonb_build_object('serviceRole',a.owner_service,'peerId',a.authenticated_peer_id));
END $$;

CREATE FUNCTION windows_native_finish(p jsonb,p_canonical text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;s manga_web.windows_native_records%ROWTYPE;f manga_web.windows_native_records%ROWTYPE;r manga_web.native_controller_raw_results%ROWTYPE;v jsonb;e jsonb;t jsonb;ob jsonb;facts jsonb;seal text;new_id uuid;event_kind text;obs_kind text;
BEGIN
  o:=manga_web.windows_native_scope(p);v:=manga_web.windows_native_parse(p_canonical,131072);SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=o.account_id AND attempt_id=o.attempt_id;
  SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='SEAL';
  SELECT * INTO f FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='FINALIZED';
  facts:=manga_web.windows_native_facts(o.account_id,o.attempt_id);e:=s.protected_record->'evidence';
  IF s.record_id IS NULL OR f.record_id IS NULL OR NOT manga_web.windows_native_object(v,ARRAY['version','originDigest','record','rawResult','finalized']) OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'originDigest' IS DISTINCT FROM o.origin_digest OR v->'record' IS DISTINCT FROM jsonb_build_object('recordId',s.record_id,'digest',s.digest) OR v->'finalized' IS DISTINCT FROM jsonb_build_object('recordId',f.record_id,'digest',f.digest) OR v->'rawResult' IS DISTINCT FROM facts->'rawResult' OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND purpose='PARENT_JOIN' AND protected_record=s.protected_record->'parentJoinAck') OR e->'final'->>'recordSealed' IS DISTINCT FROM 'true' OR e->'final'->>'parentIoJoined' IS DISTINCT FROM 'true' OR e->'final'->>'outcome' NOT IN('NO_CHILD_CREATED','JOB_EMPTY') THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_FINAL_UNCONFIRMED');END IF;
  SELECT * INTO r FROM manga_web.native_controller_raw_results WHERE account_id=o.account_id AND attempt_id=o.attempt_id;
  IF e->'final'->>'outcome'='NO_CHILD_CREATED' THEN
    IF e->'lifecycle'->>'creation' NOT IN('NOT_ATTEMPTED','FAILED') OR e->'lifecycle'->'root' IS DISTINCT FROM 'null'::jsonb OR e->'lifecycle'->>'goWrite' IS DISTINCT FROM 'NOT_ATTEMPTED' OR facts->'goGrantRef' IS DISTINCT FROM 'null'::jsonb OR r.raw_result_id IS NOT NULL OR e->'final'->'accounting' IS DISTINCT FROM 'null'::jsonb OR e->'final'->>'rootSignaled' IS DISTINCT FROM 'false' OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind IN('CREATE_NOT_ATTEMPTED','CREATE_FAILED')) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_NO_CREATE_UNCONFIRMED');END IF;
  ELSE
    IF e->'lifecycle'->>'creation' IS DISTINCT FROM 'CREATED' OR e->'lifecycle'->>'goWrite' IS DISTINCT FROM 'RETURNED' OR facts->'goGrantRef'='null'::jsonb OR r.raw_result_id IS NULL OR e->'final'->>'activeProcesses' IS DISTINCT FROM '0' OR e->'final'->>'rootSignaled' IS DISTINCT FROM 'true' OR e->'final'->>'stdioJoined' IS DISTINCT FROM 'true' OR jsonb_typeof(e->'final'->'accounting') IS DISTINCT FROM 'object' OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind='FINAL_ACCOUNTING') OR (SELECT count(*) FROM manga_web.native_controller_object_receipts WHERE account_id=o.account_id AND raw_result_id=r.raw_result_id)<>jsonb_array_length(r.blob_refs) OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.blob_refs) b LEFT JOIN manga_web.native_controller_object_receipts x ON x.account_id=o.account_id AND x.raw_result_id=r.raw_result_id AND x.blob_id=b->>'blobId' WHERE x.blob_id IS NULL OR x.protected_receipt->>'sha256' IS DISTINCT FROM b->>'sha256' OR x.protected_receipt->>'bytesLength' IS DISTINCT FROM b->>'bytesLength') THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_TREE_UNCONFIRMED');END IF;
  END IF;
  t:=jsonb_build_object('jobId',a.job_id,'inputDigest',o.frame_input_digest,'profileDigest',a.protected_binding->>'profileDigest','goAttempted',e->'lifecycle'->>'goWrite'<>'NOT_ATTEMPTED','startedComputation',r.raw_result_id IS NOT NULL,'directChildClosed',e->'final'->>'outcome'='JOB_EMPTY','subtreeTerminationConfirmed',e->'final'->>'outcome'='JOB_EMPTY','operationJoined',true,'kind',CASE e->'final'->>'outcome' WHEN 'JOB_EMPTY' THEN 'WINDOWS_JOB_EMPTY' ELSE 'NO_CHILD_CREATED' END,'isolation','WINDOWS_JOB_OBJECT');
  FOREACH event_kind IN ARRAY CASE WHEN r.raw_result_id IS NULL THEN ARRAY['TERMINATION'] ELSE ARRAY['RESULT','TERMINATION'] END LOOP
    obs_kind:=CASE event_kind WHEN 'RESULT' THEN 'OBSERVATION' ELSE 'TERMINATION' END;
    ob:=jsonb_build_object('version',2,'parentInstanceId',a.protected_binding->>'parentInstanceId','event',event_kind,'code','OK','resultDigest',CASE event_kind WHEN 'RESULT' THEN r.result_digest ELSE NULL END,'termination',t,'windowsRecordRef',jsonb_build_object('recordId',s.record_id,'recordDigest',s.digest));
    seal:=encode(sha256(convert_to(ob::text,'UTF8')),'hex');
    IF EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind=obs_kind) THEN
      IF NOT EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=o.account_id AND attempt_id=o.attempt_id AND kind=obs_kind AND protected_observation=ob AND observation_digest=seal) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_CONFLICT';END IF;
    ELSE
      new_id:=gen_random_uuid();
      INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES(o.account_id,new_id,a.job_id,(a.protected_binding->>'parentInstanceId')::uuid,event_kind,seal,ob,clock_timestamp());
      INSERT INTO manga_web.native_controller_events(account_id,attempt_id,event_id,controller_instance_id,kind,code,protected_observation,protected_termination,observation_id,observation_digest,received_at) VALUES(o.account_id,o.attempt_id,new_id,a.controller_instance_id,obs_kind,'OK',ob,t-'isolation',new_id,seal,clock_timestamp());
    END IF;
  END LOOP;
  facts:=manga_web.windows_native_facts(o.account_id,o.attempt_id);RETURN jsonb_build_object('allowed',true,'observations',facts->'observations','basis',facts->'basis','goGrantRef',facts->'goGrantRef','rawResult',facts->'rawResult');
END $$;

CREATE FUNCTION windows_native_link_body(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;f jsonb;s manga_web.windows_native_records%ROWTYPE;j manga_web.windows_native_records%ROWTYPE;z manga_web.windows_native_records%ROWTYPE;refs jsonb;
BEGIN
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt;f:=manga_web.windows_native_facts(p_account,p_attempt);
  SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt AND purpose='SEAL';SELECT * INTO j FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt AND purpose='PARENT_JOIN';SELECT * INTO z FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt AND purpose='FINALIZED';
  IF s.record_id IS NULL OR j.record_id IS NULL OR z.record_id IS NULL OR jsonb_array_length(f->'observations')<>(CASE WHEN f->'rawResult'='null'::jsonb THEN 1 ELSE 2 END) OR s.protected_record->'parentJoinAck' IS DISTINCT FROM j.protected_record THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LINK_UNCONFIRMED';END IF;
  SELECT jsonb_agg(value-'value' ORDER BY n) INTO refs FROM jsonb_array_elements(f->'observations') WITH ORDINALITY x(value,n);
  RETURN jsonb_build_object('version',1,'originDigest',o.origin_digest,'identity',o.protected_origin->'identity','basis',CASE WHEN f->'basis'='null'::jsonb THEN 'null'::jsonb ELSE (f->'basis')-'value' END,'goGrantRef',f->'goGrantRef','rawResult',f->'rawResult','record',jsonb_build_object('recordId',s.record_id,'recordDigest',s.digest),'parentJoin',jsonb_build_object('recordId',j.record_id,'digest',j.digest),'finalized',jsonb_build_object('recordId',z.record_id,'digest',z.digest),'observations',refs);
END $$;
CREATE FUNCTION windows_native_link(p jsonb,p_id uuid,p_canonical text,p_signature text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;v jsonb;expected jsonb;r manga_web.windows_native_links%ROWTYPE;
BEGIN
  o:=manga_web.windows_native_scope(p);v:=manga_web.windows_native_parse(p_canonical,32768);expected:=manga_web.windows_native_link_body(o.account_id,o.attempt_id);
  IF p_id IS NULL OR v IS DISTINCT FROM expected OR p_signature IS NULL OR p_signature!~'^[A-Za-z0-9+/]{86}==$' OR replace(encode(decode(p_signature,'base64'),'base64'),E'\n','') IS DISTINCT FROM p_signature OR octet_length(decode(p_signature,'base64'))<>64 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LINK_UNCONFIRMED';END IF;
  SELECT * INTO r FROM manga_web.windows_native_links WHERE account_id=o.account_id AND attempt_id=o.attempt_id;
  IF FOUND THEN
    IF r.canonical IS DISTINCT FROM p_canonical OR r.signature IS DISTINCT FROM p_signature THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_CONFLICT';END IF;
  ELSE
    INSERT INTO manga_web.windows_native_links VALUES(o.account_id,o.attempt_id,p_id,p_canonical,v,encode(sha256(convert_to(p_canonical,'UTF8')),'hex'),p_signature) RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('allowed',true,'reference',jsonb_build_object('recordId',v->'record'->>'recordId','recordDigest',v->'record'->>'recordDigest','linkId',r.link_id,'linkDigest',r.digest));
END $$;

CREATE FUNCTION windows_native_view(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;s manga_web.windows_native_records%ROWTYPE;l manga_web.windows_native_links%ROWTYPE;facts jsonb;ref jsonb;
BEGIN
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt;facts:=manga_web.windows_native_facts(p_account,p_attempt);
  SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=p_account AND attempt_id=p_attempt AND purpose='SEAL';SELECT * INTO l FROM manga_web.windows_native_links WHERE account_id=p_account AND attempt_id=p_attempt;
  IF l.link_id IS NOT NULL THEN
    IF manga_web.windows_native_parse(l.canonical,32768) IS DISTINCT FROM manga_web.windows_native_link_body(p_account,p_attempt) OR encode(sha256(convert_to(l.canonical,'UTF8')),'hex') IS DISTINCT FROM l.digest THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LINK_UNCONFIRMED';END IF;
    ref:=jsonb_build_object('recordId',s.record_id,'recordDigest',s.digest,'linkId',l.link_id,'linkDigest',l.digest);
  END IF;
  RETURN jsonb_build_object('allowed',true,'view',jsonb_build_object('capture',jsonb_build_object('origin',o.protected_origin,'originDigest',o.origin_digest,'frameInputDigest',o.frame_input_digest,'launchRef',o.launch_ref),'record',CASE WHEN s.record_id IS NULL THEN NULL ELSE jsonb_build_object('ref',jsonb_build_object('recordId',s.record_id,'digest',s.digest),'envelope',s.protected_record) END,'windowsEvidenceRef',ref),'facts',facts);
END $$;
CREATE FUNCTION windows_native_read(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;v jsonb;
BEGIN
  IF manga_web.windows_native_object(p,ARRAY['binding','controllerId','expected']) THEN
    IF NOT manga_web.native_controller_caller() OR NOT manga_web.native_controller_binding_valid(p->'binding') OR p->'binding'->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_ACCESS_DENIED';END IF;
    SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND reservation_id=(p->'binding'->>'capacityReservationId')::uuid;
    IF NOT FOUND OR a.protected_binding IS DISTINCT FROM p->'binding' OR a.controller_id::text IS DISTINCT FROM p->>'controllerId' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_BINDING_MISMATCH';END IF;
    o:=manga_web.windows_native_scope(jsonb_build_object('binding',a.protected_binding,'attemptId',a.attempt_id,'controllerInstanceId',a.controller_instance_id,'controllerId',a.controller_id,'ownerService',a.owner_service,'peerId',a.authenticated_peer_id));
  ELSE o:=manga_web.windows_native_scope(p);END IF;
  v:=manga_web.windows_native_view(o.account_id,o.attempt_id);
  IF p ? 'expected' AND p->'expected'<>'null'::jsonb AND p->'expected' IS DISTINCT FROM v->'view'->'windowsEvidenceRef' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_LINK_UNCONFIRMED';END IF;
  RETURN v;
END $$;
CREATE FUNCTION windows_native_lookup(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a manga_web.native_controller_attempts%ROWTYPE;v jsonb;
BEGIN
  IF manga_web.native_job_caller() IS NULL OR NOT manga_web.windows_native_object(p,ARRAY['binding','expected']) OR NOT manga_web.native_controller_binding_valid(p->'binding') OR p->'binding'->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_ACCESS_DENIED';END IF;
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND reservation_id=(p->'binding'->>'capacityReservationId')::uuid;
  IF NOT FOUND OR a.protected_binding IS DISTINCT FROM p->'binding' OR a.owner_service IS DISTINCT FROM manga_web.native_job_caller() THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_BINDING_MISMATCH');END IF;
  v:=manga_web.windows_native_view(a.account_id,a.attempt_id);
  IF p->'expected' IS DISTINCT FROM v->'view'->'windowsEvidenceRef' OR p->'expected'='null'::jsonb THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_LINK_UNCONFIRMED');END IF;
  RETURN v;
END $$;

-- Closed W1/W2 data validation at the owning SQL boundary. These functions
-- validate recorded facts; they are not an attestation of physical Win32 calls.
CREATE FUNCTION windows_native_shape(p jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE item record;token text;result boolean;
BEGIN
  IF s IS NULL OR p IS NULL THEN RETURN false;END IF;
  IF jsonb_typeof(s)='object' THEN
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>(SELECT count(*) FROM jsonb_object_keys(s)) THEN RETURN false;END IF;
    FOR item IN SELECT key,value FROM jsonb_each(s) LOOP IF manga_web.windows_native_shape(p->item.key,item.value) IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;RETURN true;
  ELSIF jsonb_typeof(s)='array' THEN RETURN COALESCE(EXISTS(SELECT 1 FROM jsonb_array_elements(s) x WHERE x=p),false);
  ELSIF jsonb_typeof(s)<>'string' THEN RETURN p IS NOT DISTINCT FROM s;END IF;
  token:=s#>>'{}';
  CASE token
  WHEN 'uuid' THEN result:=jsonb_typeof(p)='string' AND manga_web.operational_limit_uuid(p);
  WHEN 'hex' THEN result:=jsonb_typeof(p)='string' AND (p#>>'{}')~'^[a-f0-9]{64}$';
  WHEN 'code' THEN result:=jsonb_typeof(p)='string' AND (p#>>'{}')~'^[A-Z][A-Z0-9_]{0,127}$';
  WHEN 'bool' THEN result:=jsonb_typeof(p)='boolean';
  WHEN 'uint','positive' THEN
    IF jsonb_typeof(p)<>'number' OR p::text!~'^(0|[1-9][0-9]*)$' THEN RETURN false;END IF;
    result:=p::text::numeric<=4294967295 AND(token='uint' OR p::text::numeric>0);
  WHEN 'u64','u64positive' THEN
    IF jsonb_typeof(p)<>'string' OR (p#>>'{}')!~'^(0|[1-9][0-9]{0,19})$' THEN RETURN false;END IF;
    result:=(p#>>'{}')::numeric<=18446744073709551615 AND(token='u64' OR (p#>>'{}')::numeric>0);
  ELSE result:=false;END CASE;RETURN COALESCE(result,false);
END $$;
CREATE FUNCTION windows_native_seal_valid(p_account uuid,p_attempt uuid,v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;e jsonb:=v->'evidence';l jsonb:=v->'evidence'->'lifecycle';f jsonb:=v->'evidence'->'final';p jsonb:=v->'evidence'->'policy';created jsonb;exited jsonb;acct jsonb;go_event jsonb;creation text;go_write text;k text;r record;readback jsonb;broker jsonb;
BEGIN
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt;
  IF NOT manga_web.windows_native_object(l,ARRAY['creation','root','goGrantRef','goWrite','rootExit','events']) OR NOT manga_web.windows_native_shape(l->'creation','["NOT_ATTEMPTED","FAILED","CREATED","UNCONFIRMED"]') OR NOT manga_web.windows_native_shape(l->'goWrite','["NOT_ATTEMPTED","RETURNED","UNCONFIRMED"]') OR NOT manga_web.windows_native_object(f,ARRAY['outcome','activeProcesses','rootSignaled','stdioJoined','parentIoJoined','recordSealed','accounting','failureCode']) OR NOT manga_web.windows_native_shape(f->'outcome','["NO_CHILD_CREATED","JOB_EMPTY","UNCONFIRMED"]') OR NOT manga_web.windows_native_object(p,ARRAY['requested','osReadback','brokerApplied']) THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['rootSignaled','stdioJoined','parentIoJoined','recordSealed'] LOOP IF NOT manga_web.windows_native_shape(f->k,'"bool"') THEN RETURN false;END IF;END LOOP;
  IF f->'activeProcesses'<>'null'::jsonb AND NOT manga_web.windows_native_shape(f->'activeProcesses','"uint"') OR f->'failureCode'<>'null'::jsonb AND NOT manga_web.windows_native_shape(f->'failureCode','"code"') THEN RETURN false;END IF;
  FOR r IN SELECT * FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt LOOP
    IF manga_web.windows_native_source_valid(p_account,p_attempt,r.protected_event,r.protected_source) IS DISTINCT FROM true THEN RETURN false;END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='IO_JOINED') AND NOT EXISTS(
    SELECT 1 FROM manga_web.windows_native_events x CROSS JOIN LATERAL jsonb_array_elements(x.protected_source->'facts') item
    JOIN manga_web.windows_native_records record ON record.account_id=p_account AND record.attempt_id=p_attempt AND record.purpose='PARENT_JOIN' AND record.protected_record=item->'ack'
    WHERE x.account_id=p_account AND x.attempt_id=p_attempt AND x.kind='IO_JOINED' AND item->>'kind'='PARENT_ACK' AND item->'ack'=v->'parentJoinAck'
  ) THEN RETURN false;END IF;
  SELECT protected_event INTO created FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATED_SUSPENDED';
  SELECT protected_event INTO exited FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='ROOT_EXIT';
  SELECT protected_event INTO acct FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='FINAL_ACCOUNTING';
  SELECT protected_event INTO go_event FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='GO_WRITE';
  creation:=CASE WHEN created IS NOT NULL THEN 'CREATED' WHEN EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATE_FAILED') THEN 'FAILED' WHEN EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATE_NOT_ATTEMPTED') THEN 'NOT_ATTEMPTED' ELSE 'UNCONFIRMED' END;
  go_write:=CASE WHEN go_event IS NOT NULL THEN go_event->'payload'->>'result' WHEN EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='GO_WRITE_ARMED') THEN 'UNCONFIRMED' ELSE 'NOT_ATTEMPTED' END;
  IF l->>'creation' IS DISTINCT FROM creation OR l->>'goWrite' IS DISTINCT FROM go_write OR l->'root' IS DISTINCT FROM COALESCE((created->'payload')-'assignedBy','null'::jsonb) OR l->'rootExit' IS DISTINCT FROM (CASE WHEN exited IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('exitCode',exited->'payload'->'exitCode','observedQpcTicks',exited->>'qpcTicks') END) OR f->'rootSignaled' IS DISTINCT FROM to_jsonb(exited IS NOT NULL) OR f->'stdioJoined' IS DISTINCT FROM to_jsonb(EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='IO_JOINED')) THEN RETURN false;END IF;
  IF (SELECT count(*) FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind IN('CREATED_SUSPENDED','CREATE_NOT_ATTEMPTED','CREATE_FAILED'))>1 OR EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATE_NOT_ATTEMPTED') AND EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATE_ARMED') THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='PREPARED') THEN
    readback:=(p->'requested')-'wallTimeoutMs'-'joinTimeoutMs'-'stdoutMaxBytes'-'stderrMaxBytes'||jsonb_build_object('killOnJobClose',true,'breakawayAllowed',false);
    broker:=(p->'requested')-'maxProcesses'-'jobCommitLimitBytes'-'processCommitLimitBytes'-'cpuRatePer10000';
    IF p->'osReadback' IS DISTINCT FROM readback OR p->'brokerApplied' IS DISTINCT FROM broker THEN RETURN false;END IF;
  ELSIF p->'osReadback' IS DISTINCT FROM 'null'::jsonb OR p->'brokerApplied' IS DISTINCT FROM 'null'::jsonb THEN RETURN false;END IF;
  IF acct IS NOT NULL THEN
    IF f->'accounting' IS DISTINCT FROM acct->'payload'->'accounting' OR NOT manga_web.windows_native_accounting_valid(f->'accounting') OR f->'accounting'->>'startQpcTicks' IS DISTINCT FROM created->>'qpcTicks' OR f->'accounting'->>'endQpcTicks' IS DISTINCT FROM acct->>'qpcTicks' THEN RETURN false;END IF;
  ELSIF f->'accounting' IS DISTINCT FROM 'null'::jsonb THEN RETURN false;END IF;
  IF f->>'outcome'='NO_CHILD_CREATED' THEN RETURN creation IN('NOT_ATTEMPTED','FAILED') AND f->'activeProcesses'='null'::jsonb AND f->'accounting'='null'::jsonb AND f->'rootSignaled'='false'::jsonb AND f->'stdioJoined'='false'::jsonb AND f->'parentIoJoined'='true'::jsonb AND f->'recordSealed'='true'::jsonb AND f->'failureCode'<>'null'::jsonb AND l->'goGrantRef'='null'::jsonb AND go_write='NOT_ATTEMPTED';
  ELSIF f->>'outcome'='JOB_EMPTY' THEN RETURN creation='CREATED' AND exited IS NOT NULL AND acct IS NOT NULL AND f->'activeProcesses'='0'::jsonb AND f->'rootSignaled'='true'::jsonb AND f->'stdioJoined'='true'::jsonb AND f->'parentIoJoined'='true'::jsonb AND f->'recordSealed'='true'::jsonb AND EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='TREE_EMPTY');
  ELSE RETURN f->'failureCode'<>'null'::jsonb;END IF;
END $$;
CREATE FUNCTION windows_native_win_value(p_api text,v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE s jsonb;b jsonb:='{"TotalUserTime":"u64","TotalKernelTime":"u64","ThisPeriodTotalUserTime":"u64","ThisPeriodTotalKernelTime":"u64","TotalPageFaultCount":"uint","TotalProcesses":"uint","ActiveProcesses":"uint","TotalTerminatedProcesses":"uint"}';
io jsonb:='{"ReadOperationCount":"u64","WriteOperationCount":"u64","OtherOperationCount":"u64","ReadTransferCount":"u64","WriteTransferCount":"u64","OtherTransferCount":"u64"}';
lim jsonb:='{"PerProcessUserTimeLimit":"u64","PerJobUserTimeLimit":"u64","LimitFlags":"uint","MinimumWorkingSetSize":"u64","MaximumWorkingSetSize":"u64","ActiveProcessLimit":"uint","Affinity":"u64","PriorityClass":"uint","SchedulingClass":"uint"}';
BEGIN
  CASE p_api
  WHEN 'CreateJobObjectW','OpenProcessToken' THEN s:='{"objectRef":"uuid"}';
  WHEN 'CreateProcessAsUserW' THEN s:='{"processRef":"uuid","threadRef":"uuid","pid":"positive"}';
  WHEN 'GetProcessTimes' THEN s:='{"processRef":"uuid","creationFileTime100ns":"u64","userTime100ns":"u64","kernelTime100ns":"u64"}';
  WHEN 'IsProcessInJob' THEN s:='{"isMember":"bool"}';
  WHEN 'ResumeThread' THEN s:='{"previousSuspendCount":"uint"}';
  WHEN 'WaitForSingleObject' THEN s:='{"waitResult":["SIGNALED","TIMEOUT","FAILED"]}';
  WHEN 'GetExitCodeProcess' THEN s:='{"exitCode":"uint"}';
  WHEN 'QueryPerformanceCounter' THEN s:='{"ticks":"u64"}';
  WHEN 'QueryPerformanceFrequency' THEN s:='{"frequency":"u64positive"}';
  WHEN 'GetNativeSystemInfo' THEN s:='{"processorArchitecture":"uint"}';
  WHEN 'IsWow64Process2' THEN s:='{"processMachine":"uint","nativeMachine":"uint"}';
  WHEN 'ProcessIdToSessionId' THEN s:='{"sessionId":"uint"}';
  WHEN 'SetInformationJobObject','TerminateJobObject','CloseHandle' THEN s:='{"returned":"bool"}';
  WHEN 'GetTokenInformation' THEN
    CASE v->>'informationClass'
    WHEN 'TOKEN_USER','TOKEN_APPCONTAINER_SID','TOKEN_INTEGRITY_LEVEL' THEN s:=jsonb_build_object('informationClass',jsonb_build_array(v->>'informationClass'),'values','{"sidDigest":"hex"}'::jsonb);
    WHEN 'TOKEN_IS_APPCONTAINER' THEN s:='{"informationClass":["TOKEN_IS_APPCONTAINER"],"values":{"isAppContainer":"bool"}}';
    WHEN 'TOKEN_SESSION_ID' THEN s:='{"informationClass":["TOKEN_SESSION_ID"],"values":{"sessionId":"uint"}}';ELSE RETURN false;END CASE;
  WHEN 'QueryInformationJobObject' THEN
    CASE v->>'informationClass'
    WHEN 'EXTENDED_LIMITS' THEN s:=jsonb_build_object('informationClass',jsonb_build_array('EXTENDED_LIMITS'),'values',jsonb_build_object('BasicLimitInformation',lim,'IoInfo',io,'ProcessMemoryLimit','u64','JobMemoryLimit','u64','PeakProcessMemoryUsed','u64','PeakJobMemoryUsed','u64'));
    WHEN 'CPU_RATE' THEN s:='{"informationClass":["CPU_RATE"],"values":{"ControlFlags":"uint","CpuRate":"uint"}}';
    WHEN 'BASIC_ACCOUNTING' THEN s:=jsonb_build_object('informationClass',jsonb_build_array('BASIC_ACCOUNTING'),'values',b);
    WHEN 'BASIC_AND_IO' THEN s:=jsonb_build_object('informationClass',jsonb_build_array('BASIC_AND_IO'),'values',jsonb_build_object('BasicInfo',b,'IoInfo',io));
    ELSE RETURN false;END CASE;
  ELSE RETURN false;END CASE;RETURN manga_web.windows_native_shape(v,s);
END $$;
CREATE FUNCTION windows_native_fact_valid(f jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.windows_native_shape(f->'qpcTicks','"u64"') THEN RETURN false;END IF;
  CASE f->>'kind'
  WHEN 'WIN32' THEN
    IF NOT manga_web.windows_native_object(f,ARRAY['kind','callId','api','qpcTicks','status','win32Error','value']) OR NOT manga_web.windows_native_shape(f->'callId','"uuid"') OR jsonb_typeof(f->'api') IS DISTINCT FROM 'string' OR f->>'api' NOT IN('GetNativeSystemInfo','IsWow64Process2','ProcessIdToSessionId','CreateJobObjectW','SetInformationJobObject','QueryInformationJobObject','CreateProcessAsUserW','IsProcessInJob','GetProcessTimes','OpenProcessToken','GetTokenInformation','ResumeThread','WaitForSingleObject','GetExitCodeProcess','TerminateJobObject','CloseHandle','QueryPerformanceCounter','QueryPerformanceFrequency') OR NOT manga_web.windows_native_shape(f->'status','["RETURNED","FAILED","UNCONFIRMED"]') THEN RETURN false;END IF;
    IF f->>'status'='RETURNED' THEN RETURN f->'win32Error'='null'::jsonb AND manga_web.windows_native_win_value(f->>'api',f->'value');
    ELSIF f->>'status'='UNCONFIRMED' THEN RETURN f->'win32Error'='null'::jsonb AND f->'value'='null'::jsonb;
    ELSIF f->>'status'='FAILED' THEN RETURN manga_web.windows_native_shape(f->'win32Error','"positive"') AND(f->'value'='null'::jsonb OR manga_web.windows_native_win_value(f->>'api',f->'value'));END IF;RETURN false;
  WHEN 'IO' THEN
    IF NOT manga_web.windows_native_object(f,ARRAY['kind','callId','lane','operation','qpcTicks','status','bytesLength','sha256']) OR NOT manga_web.windows_native_shape(f->'callId','"uuid"') OR NOT manga_web.windows_native_shape(f->'lane','["IN","OUT","ERR"]') OR NOT manga_web.windows_native_shape(f->'operation','["READ","WRITE","CLOSE"]') OR NOT manga_web.windows_native_shape(f->'status','["RETURNED","FAILED","UNCONFIRMED"]') THEN RETURN false;END IF;
    IF f->'bytesLength'='null'::jsonb THEN RETURN f->'sha256'='null'::jsonb AND f->>'status'<>'RETURNED';END IF;
    RETURN f->>'status'<>'UNCONFIRMED' AND manga_web.windows_native_shape(f->'bytesLength','"u64"') AND manga_web.windows_native_shape(f->'sha256','"hex"');
  WHEN 'PARENT_ACK' THEN RETURN manga_web.windows_native_shape(f,'{"kind":["PARENT_ACK"],"qpcTicks":"u64","ack":{"joinId":"uuid","originDigest":"hex","digest":"hex"}}');
  WHEN 'ORIGINAL_GO' THEN RETURN manga_web.windows_native_shape(f,'{"kind":["ORIGINAL_GO"],"qpcTicks":"u64","goGrantRef":{"jobId":"uuid","rowDigest":"hex"}}');
  ELSE RETURN false;END CASE;
END $$;
CREATE FUNCTION windows_native_accounting_valid(a jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
SELECT manga_web.windows_native_shape(a,'{"userTime100ns":"u64","kernelTime100ns":"u64","peakJobMemoryBytes":"u64","peakProcessMemoryBytes":"u64","readOperations":"u64","writeOperations":"u64","otherOperations":"u64","readBytes":"u64","writeBytes":"u64","otherBytes":"u64","totalProcesses":"u64positive","startQpcTicks":"u64","endQpcTicks":"u64","qpcFrequency":"u64positive","snapshotScope":["FRESH_JOB_LIFETIME"],"memoryAccounting":["WIN32_JOB_MEMORY_NOT_RSS"]}')$$;

CREATE FUNCTION windows_native_source_valid(p_account uuid,p_attempt uuid,e jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.windows_native_origins%ROWTYPE;pred text;event_kind text:=e->>'kind';v jsonb:=e->'payload';schema jsonb;f jsonb;x jsonb;y jsonb;z jsonb;created jsonb;prepared jsonb;armed jsonb;previous_fact jsonb;policy jsonb;root jsonb;readback jsonb;broker jsonb;tokens jsonb;actual jsonb;acct jsonb;cf bigint;lf bigint;calls integer;times integer;
BEGIN
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt;policy:=o.protected_origin->'policy';
  CASE event_kind
  WHEN 'PRE_CREATE' THEN schema:='{"bindingDigest":"hex","policyDigest":"hex","pinsDigest":"hex"}';
  WHEN 'CREATE_NOT_ATTEMPTED' THEN schema:='{"code":"code"}';pred:='PRE_CREATE';
  WHEN 'CREATE_ARMED' THEN schema:='{"callId":"uuid"}';pred:='PRE_CREATE';
  WHEN 'CREATE_FAILED' THEN schema:='{"win32Error":"positive","creationConfirmedAbsent":true}';pred:='CREATE_ARMED';
  WHEN 'CREATED_SUSPENDED' THEN schema:='{"pid":"positive","creationFileTime100ns":"u64","assignedBy":["PROC_THREAD_ATTRIBUTE_JOB_LIST"]}';pred:='CREATE_ARMED';
  WHEN 'PREPARED' THEN schema:='{"membershipConfirmed":true,"tokenDigest":"hex","osReadbackDigest":"hex","brokerAppliedDigest":"hex"}';pred:='CREATED_SUSPENDED';
  WHEN 'BOOTSTRAP_RESUMED' THEN schema:='{"resumeReturned":true}';pred:='PREPARED';
  WHEN 'GO_AUTHORIZED' THEN schema:='{"goGrantRef":{"jobId":"uuid","rowDigest":"hex"}}';pred:='BOOTSTRAP_RESUMED';
  WHEN 'GO_WRITE_ARMED' THEN schema:='{"bytesLength":["6"]}';pred:='GO_AUTHORIZED';
  WHEN 'GO_WRITE' THEN schema:='{"result":["RETURNED","UNCONFIRMED"],"bytesLength":["6"]}';pred:='GO_WRITE_ARMED';
  WHEN 'ROOT_EXIT' THEN schema:='{"exitCode":"uint"}';pred:='CREATED_SUSPENDED';
  WHEN 'TREE_EMPTY' THEN schema:='{"activeProcesses":0,"totalProcesses":"u64positive"}';pred:='ROOT_EXIT';
  WHEN 'IO_JOINED' THEN schema:='{"stdinClosed":true,"stdoutEof":true,"stderrEof":true,"parentIoJoined":true}';pred:='TREE_EMPTY';
  WHEN 'FINAL_ACCOUNTING' THEN IF NOT manga_web.windows_native_object(v,ARRAY['accounting']) OR NOT manga_web.windows_native_accounting_valid(v->'accounting') THEN RETURN false;END IF;schema:=NULL;pred:='IO_JOINED';
  WHEN 'FAILED' THEN schema:='{"code":"code","phase":["CREATE","PREPARE","GO","DRAIN"]}';pred:='PRE_CREATE';ELSE RETURN false;END CASE;
  IF schema IS NOT NULL AND manga_web.windows_native_shape(v,schema) IS DISTINCT FROM true THEN RETURN false;END IF;
  IF pred IS NOT NULL AND NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events r WHERE r.account_id=p_account AND r.attempt_id=p_attempt AND r.kind=pred AND r.sequence<(e->>'sequence')::integer) THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'facts') value WHERE value ? 'callId' GROUP BY value->>'callId' HAVING count(DISTINCT value)>1) THEN RETURN false;END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(s->'facts') LOOP
    IF manga_web.windows_native_fact_valid(f) IS DISTINCT FROM true OR((f->>'qpcTicks')::numeric>(e->>'qpcTicks')::numeric AND NOT(event_kind='CREATED_SUSPENDED' AND f->>'kind'='WIN32' AND f->>'api'='GetProcessTimes' AND f->>'status'='RETURNED')) THEN RETURN false;END IF;
    IF f ? 'callId' AND EXISTS(SELECT 1 FROM manga_web.windows_native_events r CROSS JOIN LATERAL jsonb_array_elements(r.protected_source->'facts') old WHERE r.account_id=p_account AND r.attempt_id=p_attempt AND r.sequence<(e->>'sequence')::integer AND old->>'callId'=f->>'callId' AND old IS DISTINCT FROM f) THEN RETURN false;END IF;
  END LOOP;
  SELECT protected_event INTO created FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATED_SUSPENDED';
  SELECT protected_event INTO prepared FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='PREPARED';
  SELECT protected_event INTO armed FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='CREATE_ARMED';
  IF created IS NOT NULL AND (created->>'sequence')::integer<(e->>'sequence')::integer THEN
    SELECT value INTO previous_fact FROM manga_web.windows_native_events r CROSS JOIN LATERAL jsonb_array_elements(r.protected_source->'facts') WHERE r.account_id=p_account AND r.attempt_id=p_attempt AND r.kind='CREATED_SUSPENDED' AND value->>'api'='GetProcessTimes';
    IF (e->>'qpcTicks')::numeric<(previous_fact->>'qpcTicks')::numeric THEN RETURN false;END IF;
  END IF;
  CASE event_kind
  WHEN 'CREATED_SUSPENDED','CREATE_FAILED' THEN
    SELECT count(*),jsonb_agg(value)->0 INTO calls,x FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='WIN32' AND value->>'api'='CreateProcessAsUserW' AND value->>'status'=CASE event_kind WHEN 'CREATE_FAILED' THEN 'FAILED' ELSE 'RETURNED' END;
    IF calls<>1 OR x->>'callId' IS DISTINCT FROM armed->'payload'->>'callId' THEN RETURN false;END IF;
    IF event_kind='CREATE_FAILED' THEN RETURN x->'win32Error'=v->'win32Error';END IF;
    SELECT count(*),jsonb_agg(value)->0 INTO times,y FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='WIN32' AND value->>'api'='GetProcessTimes' AND value->>'status'='RETURNED';
    RETURN jsonb_array_length(s->'facts')=2 AND times=1 AND x->>'callId'<>y->>'callId' AND x->>'qpcTicks'=e->>'qpcTicks' AND(y->>'qpcTicks')::numeric>=(x->>'qpcTicks')::numeric AND x->'value'->'pid'=v->'pid' AND y->'value'->'processRef'=x->'value'->'processRef' AND y->'value'->'creationFileTime100ns'=v->'creationFileTime100ns';
  WHEN 'PREPARED' THEN
    SELECT count(*),jsonb_agg(value)->0 INTO calls,x FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='GetProcessTimes' AND value->>'status'='RETURNED';
    IF calls<>1 OR x->'value'->'creationFileTime100ns' IS DISTINCT FROM created->'payload'->'creationFileTime100ns' OR x->'value'->'processRef' IS DISTINCT FROM previous_fact->'value'->'processRef' OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'facts') value WHERE(value->>'qpcTicks')::numeric<(previous_fact->>'qpcTicks')::numeric) OR EXISTS(SELECT 1 FROM manga_web.windows_native_events r CROSS JOIN LATERAL jsonb_array_elements(r.protected_source->'facts') value WHERE r.account_id=p_account AND r.attempt_id=p_attempt AND r.sequence<(e->>'sequence')::integer AND value->>'callId'=x->>'callId') THEN RETURN false;END IF;
    SELECT count(*) INTO calls FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='IsProcessInJob' AND value->>'status'='RETURNED' AND value->'value'->'isMember'='true'::jsonb;IF calls<>1 THEN RETURN false;END IF;
    SELECT jsonb_agg(value->'value' ORDER BY array_position(ARRAY['TOKEN_USER','TOKEN_APPCONTAINER_SID','TOKEN_IS_APPCONTAINER','TOKEN_INTEGRITY_LEVEL','TOKEN_SESSION_ID'],value->'value'->>'informationClass')) INTO tokens FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='GetTokenInformation' AND value->>'status'='RETURNED';
    IF jsonb_array_length(tokens) IS DISTINCT FROM 5 OR(SELECT count(DISTINCT value->>'informationClass') FROM jsonb_array_elements(tokens))<>5 OR tokens->0->'values'->>'sidDigest' IS DISTINCT FROM o.protected_origin->'authority'->>'childSidDigest' OR tokens->1->'values'->>'sidDigest' IS DISTINCT FROM o.protected_origin->'authority'->>'appContainerSidDigest' OR tokens->2->'values'->'isAppContainer' IS DISTINCT FROM 'true'::jsonb OR manga_web.windows_native_hash(tokens) IS DISTINCT FROM v->>'tokenDigest' THEN RETURN false;END IF;
    SELECT count(*),jsonb_agg(value->'value'->'values')->0 INTO calls,x FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryInformationJobObject' AND value->>'status'='RETURNED' AND value->'value'->>'informationClass'='EXTENDED_LIMITS';IF calls<>1 THEN RETURN false;END IF;
    SELECT count(*),jsonb_agg(value->'value'->'values')->0 INTO calls,y FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryInformationJobObject' AND value->>'status'='RETURNED' AND value->'value'->>'informationClass'='CPU_RATE';IF calls<>1 THEN RETURN false;END IF;
    lf:=(x->'BasicLimitInformation'->>'LimitFlags')::bigint;cf:=(y->>'ControlFlags')::bigint;
    IF (lf&776)<>776 OR(cf&5)<>5 OR(lf&8192)=0 OR(lf&6144)<>0 THEN RETURN false;END IF;
    readback:=jsonb_build_object('maxProcesses',x->'BasicLimitInformation'->'ActiveProcessLimit','jobCommitLimitBytes',x->>'JobMemoryLimit','processCommitLimitBytes',x->>'ProcessMemoryLimit','cpuRatePer10000',y->'CpuRate','killOnJobClose',true,'breakawayAllowed',false);
    broker:=policy-'maxProcesses'-'jobCommitLimitBytes'-'processCommitLimitBytes'-'cpuRatePer10000';
    RETURN readback-'killOnJobClose'-'breakawayAllowed'=policy-'wallTimeoutMs'-'joinTimeoutMs'-'stdoutMaxBytes'-'stderrMaxBytes' AND manga_web.windows_native_hash(readback)=v->>'osReadbackDigest' AND manga_web.windows_native_hash(broker)=v->>'brokerAppliedDigest';
  WHEN 'BOOTSTRAP_RESUMED' THEN
    SELECT count(*),jsonb_agg(value)->0 INTO calls,x FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='ResumeThread' AND value->>'status'='RETURNED' AND value->'value'->'previousSuspendCount'='1'::jsonb;
    SELECT count(*),jsonb_agg(value)->0 INTO times,y FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='IO' AND value->>'lane'='OUT' AND value->>'operation'='READ' AND value->>'status'='RETURNED' AND value->>'bytesLength'='8' AND value->>'sha256'=encode(sha256(convert_to(E'WAIT_V1\n','UTF8')),'hex');
    RETURN calls=1 AND times=1 AND(x->>'qpcTicks')::numeric>=(prepared->>'qpcTicks')::numeric AND(y->>'qpcTicks')::numeric>=(x->>'qpcTicks')::numeric AND y->>'qpcTicks'=e->>'qpcTicks';
  WHEN 'GO_AUTHORIZED' THEN RETURN v->'goGrantRef'=manga_web.windows_native_go_ref(p_account,p_attempt) AND(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value=jsonb_build_object('kind','ORIGINAL_GO','qpcTicks',e->>'qpcTicks','goGrantRef',v->'goGrantRef'))=1;
  WHEN 'GO_WRITE' THEN RETURN(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='IO' AND value->>'lane'='IN' AND value->>'operation'='WRITE' AND value->>'status'=v->>'result' AND value->>'qpcTicks'=e->>'qpcTicks' AND(v->>'result'='UNCONFIRMED' OR value->>'bytesLength'='6' AND value->>'sha256'=encode(sha256(convert_to(E'GO_V1\n','UTF8')),'hex')))=1;
  WHEN 'ROOT_EXIT' THEN RETURN(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='WaitForSingleObject' AND value->>'status'='RETURNED' AND value->'value'->>'waitResult'='SIGNALED')=1 AND(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='GetExitCodeProcess' AND value->>'status'='RETURNED' AND value->'value'->'exitCode'=v->'exitCode')=1;
  WHEN 'TREE_EMPTY' THEN RETURN(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryInformationJobObject' AND value->>'status'='RETURNED' AND value->'value'->>'informationClass'='BASIC_ACCOUNTING' AND value->'value'->'values'->'ActiveProcesses'='0'::jsonb AND value->'value'->'values'->>'TotalProcesses'=v->>'totalProcesses')=1;
  WHEN 'IO_JOINED' THEN
    FOREACH pred IN ARRAY ARRAY['IN','OUT','ERR'] LOOP IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='IO' AND value->>'lane'=pred AND value->>'operation'=CASE pred WHEN 'IN' THEN 'CLOSE' ELSE 'READ' END AND value->>'status'='RETURNED' AND value->>'bytesLength'='0' AND value->>'sha256'=encode(sha256(''::bytea),'hex')) THEN RETURN false;END IF;END LOOP;
    RETURN(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'kind'='PARENT_ACK' AND value->'ack'->>'originDigest'=o.origin_digest)=1;
  WHEN 'FINAL_ACCOUNTING' THEN
    acct:=v->'accounting';SELECT count(*),jsonb_agg(value->'value'->'values')->0 INTO calls,x FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryInformationJobObject' AND value->>'status'='RETURNED' AND value->'value'->>'informationClass'='BASIC_AND_IO';IF calls<>1 THEN RETURN false;END IF;
    SELECT count(*),jsonb_agg(value->'value'->'values')->0 INTO calls,y FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryInformationJobObject' AND value->>'status'='RETURNED' AND value->'value'->>'informationClass'='EXTENDED_LIMITS';IF calls<>1 THEN RETURN false;END IF;
    SELECT count(*),jsonb_agg(value->'value')->0 INTO calls,z FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryPerformanceFrequency' AND value->>'status'='RETURNED';IF calls<>1 THEN RETURN false;END IF;
    actual:=jsonb_build_object('userTime100ns',x->'BasicInfo'->>'TotalUserTime','kernelTime100ns',x->'BasicInfo'->>'TotalKernelTime','peakJobMemoryBytes',y->>'PeakJobMemoryUsed','peakProcessMemoryBytes',y->>'PeakProcessMemoryUsed','readOperations',x->'IoInfo'->>'ReadOperationCount','writeOperations',x->'IoInfo'->>'WriteOperationCount','otherOperations',x->'IoInfo'->>'OtherOperationCount','readBytes',x->'IoInfo'->>'ReadTransferCount','writeBytes',x->'IoInfo'->>'WriteTransferCount','otherBytes',x->'IoInfo'->>'OtherTransferCount','totalProcesses',x->'BasicInfo'->>'TotalProcesses','startQpcTicks',created->>'qpcTicks','endQpcTicks',e->>'qpcTicks','qpcFrequency',z->>'frequency','snapshotScope','FRESH_JOB_LIFETIME','memoryAccounting','WIN32_JOB_MEMORY_NOT_RSS');
    RETURN x->'BasicInfo'->'ActiveProcesses'='0'::jsonb AND acct=actual AND(SELECT count(*) FROM jsonb_array_elements(s->'facts') WHERE value->>'api'='QueryPerformanceCounter' AND value->>'status'='RETURNED' AND value->'value'->'ticks'=e->'qpcTicks')=1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'facts') WHERE(value->>'qpcTicks')::numeric<(SELECT(protected_event->>'qpcTicks')::numeric FROM manga_web.windows_native_events WHERE account_id=p_account AND attempt_id=p_attempt AND kind='IO_JOINED'));
  ELSE RETURN true;END CASE;
END $$;

-- Windows' approved PREPARE/GO/publication boundary is stricter than v1's
-- immutable background context reference. Historical reads never call this.
CREATE FUNCTION windows_native_owner_current(p_capture jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();c manga_web.workspace_contexts%ROWTYPE;sampled timestamptz:=clock_timestamp();
BEGIN
  IF a IS NULL OR NOT manga_web.windows_native_object(p_capture,ARRAY['contextId','contextGeneration','ownerSessionId','ownerTabId','ownerRevision','workspaceRevision']) OR NOT manga_web.operational_limit_uuid(p_capture->'contextId') OR NOT manga_web.operational_limit_uuid(p_capture->'ownerSessionId') OR NOT manga_web.operational_limit_uuid(p_capture->'ownerTabId') THEN RETURN false;END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO c FROM manga_web.workspace_contexts WHERE account_id=a AND context_id=(p_capture->>'contextId')::uuid FOR UPDATE;
  IF NOT FOUND OR c.workspace_revision::text IS DISTINCT FROM p_capture->>'workspaceRevision' THEN RETURN false;END IF;
  PERFORM 1 FROM manga_web.app_sessions WHERE account_id=a AND session_id=c.owner_session_id FOR SHARE;
  PERFORM 1 FROM manga_web.login_bindings WHERE account_id=a AND binding_id=(SELECT binding_id FROM manga_web.app_sessions WHERE account_id=a AND session_id=c.owner_session_id) FOR SHARE;
  RETURN manga_web.native_job_capture_current(c.context_id,p_capture,sampled) IS TRUE;
END $$;

-- Private Window GO hook: the caller already checked the authenticated ctx.
CREATE FUNCTION windows_native_capacity_go_ready(p_job uuid,p_attempt uuid,p_instance uuid,p_owner text,p_capacity jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
SELECT manga_web.native_controller_caller() AND EXISTS(
 SELECT 1 FROM manga_web.native_controller_attempts a JOIN manga_web.windows_native_origins o USING(account_id,attempt_id)
 JOIN manga_web.windows_native_records r USING(account_id,attempt_id)
 JOIN manga_web.native_controller_events e USING(account_id,attempt_id)
 WHERE a.account_id=manga_web.current_account() AND a.job_id=p_job AND a.attempt_id=p_attempt AND a.controller_instance_id=p_instance AND a.owner_service=p_owner AND a.protected_capacity=p_capacity
 AND a.controller_id::text=o.protected_origin->'authority'->>'controllerId' AND a.controller_instance_id::text=o.protected_origin->'authority'->>'controllerInstanceId'
 AND p_capacity->'profile'->'windows'->>'hostEpochId'=o.protected_origin->'authority'->>'hostEpochId' AND p_capacity->'profile'->>'keyVersion'=o.protected_origin->'authority'->>'keyVersion'
 AND r.purpose='READY' AND e.kind='READY' AND e.code='OK' AND e.controller_instance_id=p_instance AND r.protected_record->>'originDigest'=o.origin_digest
) AND NOT EXISTS(SELECT 1 FROM manga_web.native_controller_events WHERE account_id=manga_web.current_account() AND attempt_id=p_attempt AND(kind IN('UNKNOWN','TERMINATION') OR code<>'OK'))
$$;
CREATE FUNCTION windows_native_reference(p_job uuid,p_ref jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a manga_web.native_controller_attempts%ROWTYPE;l manga_web.windows_native_links%ROWTYPE;s manga_web.windows_native_records%ROWTYPE;
BEGIN
  IF NOT manga_web.windows_native_object(p_ref,ARRAY['recordId','recordDigest','linkId','linkDigest']) OR NOT manga_web.operational_limit_uuid(p_ref->'recordId') OR NOT manga_web.operational_limit_uuid(p_ref->'linkId') THEN RETURN false;END IF;
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND job_id=p_job AND protected_capacity->'reference'->>'kind'='WINDOWS_JOB_OBJECT';IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO l FROM manga_web.windows_native_links WHERE account_id=a.account_id AND attempt_id=a.attempt_id AND link_id=(p_ref->>'linkId')::uuid;
  SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=a.account_id AND attempt_id=a.attempt_id AND record_id=(p_ref->>'recordId')::uuid AND purpose='SEAL';
  RETURN l.link_id IS NOT NULL AND s.record_id IS NOT NULL AND l.digest=p_ref->>'linkDigest' AND s.digest=p_ref->>'recordDigest'
    AND l.digest=encode(sha256(convert_to(l.canonical,'UTF8')),'hex') AND s.digest=encode(sha256(convert_to(s.canonical,'UTF8')),'hex')
    AND l.protected_link=manga_web.windows_native_link_body(a.account_id,a.attempt_id) AND l.protected_link->'record'=jsonb_build_object('recordId',s.record_id,'recordDigest',s.digest);
END $$;

-- Only finish derives Window observations from the complete persisted set.
-- API/worker and the old controller observer cannot manufacture v2 or downgrade.
ALTER FUNCTION native_job_observation_owned(uuid,jsonb,text) RENAME TO native_job_observation_owned_v16;
CREATE FUNCTION native_job_observation_owned(p_id uuid,p jsonb,p_owner_service text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF p->'version'='2'::jsonb OR EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles pr ON pr.profile_id=r.profile_id WHERE r.account_id=manga_web.current_account() AND r.job_id::text=p->'termination'->>'jobId' AND pr.profile_payload->>'kind'='WINDOWS_JOB_OBJECT') THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_FINAL_UNCONFIRMED');END IF;
  RETURN manga_web.native_job_observation_owned_v16(p_id,p,p_owner_service);
END $$;
CREATE OR REPLACE FUNCTION native_job_append_observation(p_id uuid,p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT manga_web.native_job_observation_owned(p_id,p,manga_web.native_job_caller())$$;

ALTER FUNCTION native_controller_snapshot(uuid,uuid) RENAME TO native_controller_snapshot_v16;
CREATE FUNCTION native_controller_snapshot(p_account uuid,p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE result jsonb;v jsonb;
BEGIN
  result:=manga_web.native_controller_snapshot_v16(p_account,p_attempt);
  IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_origins WHERE account_id=p_account AND attempt_id=p_attempt) THEN RETURN result;END IF;
  v:=manga_web.windows_native_view(p_account,p_attempt);
  RETURN result||jsonb_build_object('snapshot',(result->'snapshot')||jsonb_build_object('version',2,'isolation','WINDOWS_JOB_OBJECT','windowsEvidenceRef',v->'view'->'windowsEvidenceRef'));
END $$;
ALTER FUNCTION native_job_unresolved(text) RENAME TO native_job_unresolved_v13;
CREATE FUNCTION native_job_unresolved(p_key text) RETURNS TABLE(state jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r record;v jsonb;binding jsonb;a manga_web.native_controller_attempts%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM manga_web.native_job_unresolved_v13(p_key) LOOP
    SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=manga_web.current_account() AND job_id::text=r.state->>'jobId' AND protected_capacity->'reference'->>'kind'='WINDOWS_JOB_OBJECT';
    IF FOUND AND EXISTS(SELECT 1 FROM manga_web.windows_native_links WHERE account_id=a.account_id AND attempt_id=a.attempt_id) THEN
      v:=manga_web.windows_native_view(a.account_id,a.attempt_id);r.state:=r.state||jsonb_build_object('windowsEvidenceRef',v->'view'->'windowsEvidenceRef','termination',CASE WHEN r.state->>'termination'='NO_CHILD_CANDIDATE' THEN 'NO_CHILD_CANDIDATE' ELSE 'UNTRUSTED_WINDOWS_CANDIDATE' END,'cost','UNCONFIRMED','application','UNCONFIRMED','unresolved',true);
    END IF;state:=r.state;RETURN NEXT;
  END LOOP;
END $$;

-- A legacy load may read a tagged snapshot, but no legacy write/GO uses it.
CREATE OR REPLACE FUNCTION native_controller_load(p_binding jsonb,p_controller uuid,p_peer_service text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE;
BEGIN original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);RETURN jsonb_build_object('allowed',true,'attempt',manga_web.native_controller_snapshot(original.account_id,original.attempt_id));END $$;

-- W3-A/W3-B/C receipt v2 proposal. TEMP ONLY; no database or product mutation.
-- Source: exact final 0014 native_receipt_* bodies (0015..0019 do not replace
-- prepare/verify/lookup/register_asset). Parent integrates after its tables and
-- private windows_native_reference(uuid,jsonb) RETURNS boolean exist.
-- Target lookup schema stays the original closed 11-key version=1 selector.
-- Candidate outer version=2 has 14 keys; verified receipt version=2 has 6 keys.
-- Native input/result frame versions and semantic verificationVersion stay v1.
-- Raw allocation asset IDs and candidate output asset IDs have separate roles.
-- Compare the full original raw blobRefs against raw receipts/assets and compare
-- blob ID/order/hash/length to the candidate; do not equate those asset IDs.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE FUNCTION native_receipt_windows_job(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations r
    JOIN manga_web.native_capacity_profiles p ON p.profile_id=r.profile_id
    WHERE r.account_id=manga_web.current_account() AND r.job_id=p_job AND p.profile_payload->>'kind'='WINDOWS_JOB_OBJECT')
$$;

-- Immutable history integrity only. Publication/current/retention remain the
-- original checks in each owning receipt function copied below.
CREATE FUNCTION native_receipt_windows_raw_valid(p_job uuid,p_ref jsonb,p_input text,p_result text,p_blobs jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); attempt manga_web.native_controller_attempts%ROWTYPE; raw_row manga_web.native_controller_raw_results%ROWTYPE; link_row manga_web.windows_native_links%ROWTYPE;
  frame jsonb; ref jsonb; candidate_ref jsonb; expected jsonb; object_receipt manga_web.native_controller_object_receipts%ROWTYPE; asset manga_web.assets%ROWTYPE; position integer:=0;
BEGIN
  IF account IS NULL OR manga_web.windows_native_reference(p_job,p_ref) IS DISTINCT FROM true OR NOT manga_web.native_receipt_windows_job(p_job) OR p_input IS NULL OR p_result IS NULL OR jsonb_typeof(p_blobs) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p_blobs)>4096 THEN RETURN false;END IF;
  SELECT * INTO attempt FROM manga_web.native_controller_attempts WHERE account_id=account AND job_id=p_job;
  IF NOT FOUND OR attempt.input_canonical IS DISTINCT FROM p_input OR attempt.protected_capacity->'reference'->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' THEN RETURN false;END IF;
  SELECT * INTO raw_row FROM manga_web.native_controller_raw_results WHERE account_id=account AND attempt_id=attempt.attempt_id;
  IF NOT FOUND OR raw_row.controller_instance_id IS DISTINCT FROM attempt.controller_instance_id OR raw_row.result_canonical IS DISTINCT FROM p_result OR raw_row.result_digest IS DISTINCT FROM encode(sha256(convert_to(p_result,'UTF8')),'hex') THEN RETURN false;END IF;
  SELECT * INTO link_row FROM manga_web.windows_native_links WHERE account_id=account AND attempt_id=attempt.attempt_id AND link_id::text=p_ref->>'linkId' AND digest=p_ref->>'linkDigest';
  IF NOT FOUND OR link_row.protected_link->'rawResult' IS DISTINCT FROM jsonb_build_object('rawResultId',raw_row.raw_result_id,'resultDigest',raw_row.result_digest) OR
    link_row.protected_link->'record' IS DISTINCT FROM jsonb_build_object('recordId',p_ref->>'recordId','recordDigest',p_ref->>'recordDigest') THEN RETURN false;END IF;
  frame:=raw_row.result_canonical::jsonb;
  IF jsonb_typeof(frame) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(frame))<>8 OR NOT frame ?& ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','metadata','blobs'] OR frame->'version' IS DISTINCT FROM '1'::jsonb OR frame->>'jobId' IS DISTINCT FROM p_job::text OR frame->>'task' IS DISTINCT FROM attempt.protected_job->>'task' OR frame->>'taskVersion' IS DISTINCT FROM attempt.protected_job->>'taskVersion' OR frame->>'profileDigest' IS DISTINCT FROM attempt.protected_binding->>'profileDigest' OR frame->>'inputDigest' IS DISTINCT FROM attempt.protected_binding->>'inputDigest' OR jsonb_typeof(frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(frame->'blobs') IS DISTINCT FROM 'array' OR jsonb_typeof(raw_row.blob_refs) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(raw_row.blob_refs)>4096 OR jsonb_array_length(raw_row.blob_refs)<>jsonb_array_length(frame->'blobs') OR jsonb_array_length(raw_row.blob_refs)<>jsonb_array_length(p_blobs) OR
    (SELECT count(*) FROM manga_web.native_controller_object_receipts WHERE account_id=account AND raw_result_id=raw_row.raw_result_id)<>jsonb_array_length(raw_row.blob_refs) THEN RETURN false;END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(raw_row.blob_refs) LOOP
    expected:=frame->'blobs'->position;candidate_ref:=p_blobs->position;
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR jsonb_typeof(candidate_ref) IS DISTINCT FROM 'object' OR jsonb_typeof(expected) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(ref))<>4 OR NOT ref ?& ARRAY['blobId','assetId','sha256','bytesLength'] OR
      (SELECT count(*) FROM jsonb_object_keys(candidate_ref))<>4 OR NOT candidate_ref ?& ARRAY['blobId','assetId','sha256','bytesLength'] OR
      (SELECT count(*) FROM jsonb_object_keys(expected))<>3 OR NOT expected ?& ARRAY['id','byteLength','sha256'] THEN RETURN false;END IF;
    IF jsonb_typeof(ref->'blobId') IS DISTINCT FROM 'string' OR ref->>'blobId'!~'^[A-Za-z0-9._-]{1,100}$' OR ref->>'blobId' IS DISTINCT FROM expected->>'id' OR candidate_ref->'blobId' IS DISTINCT FROM ref->'blobId' OR
      jsonb_typeof(ref->'assetId') IS DISTINCT FROM 'string' OR ref->>'assetId'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
      jsonb_typeof(candidate_ref->'assetId') IS DISTINCT FROM 'string' OR candidate_ref->>'assetId'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
      jsonb_typeof(ref->'sha256') IS DISTINCT FROM 'string' OR ref->>'sha256'!~'^[a-f0-9]{64}$' OR ref->'sha256' IS DISTINCT FROM expected->'sha256' OR candidate_ref->'sha256' IS DISTINCT FROM ref->'sha256' OR
      jsonb_typeof(ref->'bytesLength') IS DISTINCT FROM 'string' OR ref->>'bytesLength'!~'^(0|[1-9][0-9]{0,15})$' OR candidate_ref->'bytesLength' IS DISTINCT FROM ref->'bytesLength' OR jsonb_typeof(expected->'byteLength') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
    IF (ref->>'bytesLength')::numeric>9007199254740991 OR (ref->>'bytesLength')::numeric IS DISTINCT FROM (expected->>'byteLength')::numeric THEN RETURN false;END IF;
    SELECT * INTO object_receipt FROM manga_web.native_controller_object_receipts WHERE account_id=account AND raw_result_id=raw_row.raw_result_id AND blob_id=ref->>'blobId';
    IF NOT FOUND OR object_receipt.asset_id::text IS DISTINCT FROM ref->>'assetId' OR NOT manga_web.native_receipt_object_valid(object_receipt.protected_receipt) OR object_receipt.protected_receipt->>'key' IS DISTINCT FROM account::text||'/'||(ref->>'assetId') OR object_receipt.protected_receipt->'sha256' IS DISTINCT FROM ref->'sha256' OR object_receipt.protected_receipt->'bytesLength' IS DISTINCT FROM ref->'bytesLength' THEN RETURN false;END IF;
    SELECT * INTO asset FROM manga_web.assets WHERE account_id=account AND asset_id=(ref->>'assetId')::uuid;
    IF NOT FOUND OR asset.bucket_ref IS DISTINCT FROM raw_row.bucket_ref OR asset.object_key IS DISTINCT FROM object_receipt.protected_receipt->>'key' OR asset.sha256 IS DISTINCT FROM ref->>'sha256' OR asset.bytes_length::text IS DISTINCT FROM ref->>'bytesLength' OR asset.media_type IS DISTINCT FROM 'application/octet-stream' OR asset.purpose IS DISTINCT FROM attempt.asset_purpose OR asset.related_context_id IS DISTINCT FROM attempt.related_context_id OR asset.object_created_at IS DISTINCT FROM (object_receipt.protected_receipt->>'completedAt')::timestamptz THEN RETURN false;END IF;
    position:=position+1;
  END LOOP;
  RETURN (SELECT count(DISTINCT value->>'blobId') FROM jsonb_array_elements(raw_row.blob_refs))=position AND
    (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(raw_row.blob_refs))=position AND
    (SELECT count(DISTINCT value->>'blobId') FROM jsonb_array_elements(p_blobs))=position AND
    (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(p_blobs))=position;
END $$;

CREATE FUNCTION native_receipt_windows_candidate_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); original manga_web.native_job_intents%ROWTYPE; attempt manga_web.native_controller_attempts%ROWTYPE; linked jsonb; field text;
BEGIN
  IF account IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16777216 THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>14 OR NOT p ?& ARRAY['version','candidateId','jobId','parentInstanceId','operationInputDigest','kernelImplementationDigest','verificationVersion','resultObservationId','resultObservationDigest','resultDigest','inputCanonical','resultCanonical','blobs','windowsEvidenceRef'] OR p->'version' IS DISTINCT FROM '2'::jsonb OR p->>'verificationVersion' IS DISTINCT FROM 'native-facade-verification-v1' THEN RETURN false;END IF;
  FOREACH field IN ARRAY ARRAY['candidateId','jobId','parentInstanceId','resultObservationId'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['operationInputDigest','kernelImplementationDigest','resultObservationDigest','resultDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_typeof(p->'inputCanonical') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'resultCanonical') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'blobs') IS DISTINCT FROM 'array' OR
    manga_web.windows_native_reference((p->>'jobId')::uuid,p->'windowsEvidenceRef') IS DISTINCT FROM true OR
    NOT manga_web.native_receipt_windows_raw_valid((p->>'jobId')::uuid,p->'windowsEvidenceRef',p->>'inputCanonical',p->>'resultCanonical',p->'blobs') THEN RETURN false;END IF;
  SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=account AND job_id=(p->>'jobId')::uuid;
  IF NOT FOUND OR original.parent_instance_id::text IS DISTINCT FROM p->>'parentInstanceId' OR original.operation_input_digest IS DISTINCT FROM p->>'operationInputDigest' OR encode(sha256(convert_to(p->>'resultCanonical','UTF8')),'hex') IS DISTINCT FROM p->>'resultDigest' THEN RETURN false;END IF;
  SELECT * INTO attempt FROM manga_web.native_controller_attempts WHERE account_id=account AND job_id=original.job_id;
  IF NOT FOUND OR attempt.protected_binding->>'kernelDigest' IS DISTINCT FROM p->>'kernelImplementationDigest' THEN RETURN false;END IF;
  SELECT protected_link->'observations' INTO linked FROM manga_web.windows_native_links WHERE account_id=account AND attempt_id=attempt.attempt_id AND link_id::text=p->'windowsEvidenceRef'->>'linkId' AND digest=p->'windowsEvidenceRef'->>'linkDigest';
  IF NOT FOUND OR jsonb_typeof(linked) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=account AND o.job_id=original.job_id AND o.parent_instance_id=original.parent_instance_id AND o.observation_id=(p->>'resultObservationId')::uuid AND o.event='RESULT' AND o.observation_digest=p->>'resultObservationDigest' AND o.protected_observation->'version'='2'::jsonb AND o.protected_observation->>'resultDigest'=p->>'resultDigest' AND o.protected_observation->>'code'='OK' AND o.protected_observation->'windowsRecordRef'=jsonb_build_object('recordId',p->'windowsEvidenceRef'->>'recordId','recordDigest',p->'windowsEvidenceRef'->>'recordDigest') AND linked @> jsonb_build_array(jsonb_build_object('evidenceId',o.observation_id,'evidenceDigest',o.observation_digest))) THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=account AND o.job_id=original.job_id AND o.parent_instance_id=original.parent_instance_id AND o.event='TERMINATION' AND o.protected_observation->'version'='2'::jsonb AND o.protected_observation->>'code'='OK' AND o.protected_observation->'windowsRecordRef'=jsonb_build_object('recordId',p->'windowsEvidenceRef'->>'recordId','recordDigest',p->'windowsEvidenceRef'->>'recordDigest') AND o.protected_observation->'termination'->>'kind'='WINDOWS_JOB_EMPTY' AND o.protected_observation->'termination'->>'isolation'='WINDOWS_JOB_OBJECT' AND o.protected_observation->'termination'->>'operationJoined'='true' AND o.protected_observation->'termination'->>'directChildClosed'='true' AND o.protected_observation->'termination'->>'subtreeTerminationConfirmed'='true' AND linked @> jsonb_build_array(jsonb_build_object('evidenceId',o.observation_id,'evidenceDigest',o.observation_digest))) THEN RETURN false;END IF;
  RETURN true;
END $$;

CREATE FUNCTION native_receipt_windows_receipt_valid(p jsonb,p_candidate jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE entry jsonb; ref jsonb; position integer:=0; account uuid:=manga_web.current_account();
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>1048576 THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>6 OR NOT p ?& ARRAY['version','candidateId','kernelImplementationDigest','verificationVersion','blobs','windowsEvidenceRef'] OR p->'version' IS DISTINCT FROM '2'::jsonb OR p_candidate->'version' IS DISTINCT FROM '2'::jsonb OR p->'candidateId' IS DISTINCT FROM p_candidate->'candidateId' OR p->'kernelImplementationDigest' IS DISTINCT FROM p_candidate->'kernelImplementationDigest' OR p->'verificationVersion' IS DISTINCT FROM p_candidate->'verificationVersion' OR p->'windowsEvidenceRef' IS DISTINCT FROM p_candidate->'windowsEvidenceRef' OR jsonb_typeof(p->'blobs') IS DISTINCT FROM 'array' OR jsonb_typeof(p_candidate->'blobs') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'blobs')<>jsonb_array_length(p_candidate->'blobs') THEN RETURN false;END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p->'blobs') LOOP
    ref:=p_candidate->'blobs'->position;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry))<>2 OR NOT entry ?& ARRAY['blobId','receipt'] OR entry->'blobId' IS DISTINCT FROM ref->'blobId' OR NOT manga_web.native_receipt_object_valid(entry->'receipt') OR entry->'receipt'->>'key' IS DISTINCT FROM account::text||'/'||(ref->>'assetId') OR entry->'receipt'->'sha256' IS DISTINCT FROM ref->'sha256' OR entry->'receipt'->'bytesLength' IS DISTINCT FROM ref->'bytesLength' THEN RETURN false;END IF;
    IF NOT EXISTS(SELECT 1 FROM manga_web.assets b WHERE b.account_id=account AND b.asset_id=(ref->>'assetId')::uuid AND b.object_created_at=(entry->'receipt'->>'completedAt')::timestamptz AND b.object_key=entry->'receipt'->>'key' AND b.sha256=ref->>'sha256' AND b.bytes_length::text=ref->>'bytesLength') THEN RETURN false;END IF;
    position:=position+1;
  END LOOP;
  RETURN true;
END $$;
-- Preserve the original v1 function OIDs/bodies behind private renamed entries.
-- Revoke inherited ACLs immediately; dispatch is the only new public path.
ALTER FUNCTION native_receipt_prepare(jsonb,jsonb) RENAME TO native_receipt_prepare_v1_14;
ALTER FUNCTION native_receipt_verify(uuid,jsonb,jsonb) RENAME TO native_receipt_verify_v1_14;
ALTER FUNCTION native_receipt_lookup(jsonb) RENAME TO native_receipt_lookup_v1_14;
ALTER FUNCTION native_receipt_register_asset(uuid,text,jsonb,text,jsonb) RENAME TO native_receipt_register_asset_v1_14;
REVOKE ALL ON FUNCTION native_receipt_prepare_v1_14(jsonb,jsonb),native_receipt_verify_v1_14(uuid,jsonb,jsonb),native_receipt_lookup_v1_14(jsonb),native_receipt_register_asset_v1_14(uuid,text,jsonb,text,jsonb) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
-- 0014 prepare body, only outer14/version2/ref binding added.
CREATE FUNCTION native_receipt_prepare_windows_v2(p jsonb,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); original manga_web.native_job_intents%ROWTYPE; observation manga_web.native_job_observations%ROWTYPE; prior manga_web.native_result_candidates%ROWTYPE; result_frame jsonb; input_frame jsonb; retention jsonb; sources jsonb; field text; entry jsonb; position integer:=0; expected jsonb; sampled timestamptz; seal text;
BEGIN
  IF manga_web.windows_native_owner_current(p_target->'protectedOwnerCapture') IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p_target) OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16777216 OR(SELECT count(*) FROM jsonb_object_keys(p))<>14 OR NOT p ?& ARRAY['version','candidateId','jobId','parentInstanceId','operationInputDigest','kernelImplementationDigest','verificationVersion','resultObservationId','resultObservationDigest','resultDigest','inputCanonical','resultCanonical','blobs','windowsEvidenceRef'] OR p->'version' IS DISTINCT FROM '2'::jsonb OR p->>'verificationVersion' IS DISTINCT FROM 'native-facade-verification-v1' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  FOREACH field IN ARRAY ARRAY['candidateId','jobId','parentInstanceId','resultObservationId'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['operationInputDigest','kernelImplementationDigest','resultObservationDigest','resultDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  END LOOP;
  IF jsonb_typeof(p->'inputCanonical') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'resultCanonical') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'blobs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'blobs')>4096 OR encode(sha256(convert_to(p->>'resultCanonical','UTF8')),'hex') IS DISTINCT FROM p->>'resultDigest' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  input_frame:=(p->>'inputCanonical')::jsonb;
  result_frame:=(p->>'resultCanonical')::jsonb;
  SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(p->>'jobId')::uuid;
  IF NOT FOUND OR original.owner_service IS DISTINCT FROM service OR original.parent_instance_id IS DISTINCT FROM (p->>'parentInstanceId')::uuid OR original.operation_input_digest IS DISTINCT FROM p->>'operationInputDigest' OR p_target->>'operationInputDigest' IS DISTINCT FROM original.operation_input_digest OR p_target->>'kernelImplementationDigest' IS DISTINCT FROM p->>'kernelImplementationDigest' OR p_target->>'task' IS DISTINCT FROM original.task OR p_target->>'taskVersion' IS DISTINCT FROM original.task_version OR p_target->>'profileDigest' IS DISTINCT FROM original.profile_digest THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
  IF encode(sha256(convert_to(p->>'inputCanonical','UTF8')),'hex') IS DISTINCT FROM original.input_digest OR jsonb_typeof(input_frame) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(input_frame))<>7 OR NOT input_frame ?& ARRAY['version','jobId','task','taskVersion','profileDigest','metadata','blobs'] OR input_frame->'version' IS DISTINCT FROM '1'::jsonb OR input_frame->>'jobId' IS DISTINCT FROM original.job_id::text OR input_frame->>'task' IS DISTINCT FROM original.task OR input_frame->>'taskVersion' IS DISTINCT FROM original.task_version OR input_frame->>'profileDigest' IS DISTINCT FROM original.profile_digest OR jsonb_typeof(input_frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(input_frame->'blobs') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_RESULT_CONFLICT'); END IF;
  SELECT * INTO observation FROM manga_web.native_job_observations WHERE account_id=a AND observation_id=(p->>'resultObservationId')::uuid AND job_id=original.job_id AND parent_instance_id=original.parent_instance_id AND event='RESULT';
  IF NOT FOUND OR observation.observation_digest IS DISTINCT FROM p->>'resultObservationDigest' OR observation.protected_observation->>'resultDigest' IS DISTINCT FROM p->>'resultDigest' OR observation.protected_observation->>'code' IS DISTINCT FROM 'OK' OR
    jsonb_typeof(result_frame) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(result_frame))<>8 OR NOT result_frame ?& ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','metadata','blobs'] OR result_frame->'version' IS DISTINCT FROM '1'::jsonb OR result_frame->>'jobId' IS DISTINCT FROM original.job_id::text OR result_frame->>'task' IS DISTINCT FROM original.task OR result_frame->>'taskVersion' IS DISTINCT FROM original.task_version OR result_frame->>'profileDigest' IS DISTINCT FROM original.profile_digest OR result_frame->>'inputDigest' IS DISTINCT FROM original.input_digest OR jsonb_typeof(result_frame->'metadata') IS DISTINCT FROM 'object' OR jsonb_typeof(result_frame->'blobs') IS DISTINCT FROM 'array' OR jsonb_array_length(result_frame->'blobs')<>jsonb_array_length(p->'blobs') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_RESULT_CONFLICT'); END IF;
  IF NOT manga_web.native_receipt_windows_candidate_valid(p) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_WINDOWS_UNCONFIRMED');END IF;
  IF NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='TERMINATION' AND o.protected_observation->>'code'='OK' AND o.protected_observation->'termination'->>'operationJoined'='true' AND o.protected_observation->'termination'->>'directChildClosed'='true') OR EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='ERROR') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_UNCONFIRMED'); END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p->'blobs') LOOP
    expected:=result_frame->'blobs'->position;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(entry))<>4 OR NOT entry ?& ARRAY['blobId','assetId','sha256','bytesLength'] OR jsonb_typeof(expected) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(expected))<>3 OR NOT expected ?& ARRAY['id','byteLength','sha256'] OR jsonb_typeof(expected->'id') IS DISTINCT FROM 'string' OR expected->>'id' !~ '^[A-Za-z0-9._-]{1,100}$' OR jsonb_typeof(entry->'blobId') IS DISTINCT FROM 'string' OR entry->>'blobId' IS DISTINCT FROM expected->>'id' OR jsonb_typeof(entry->'assetId') IS DISTINCT FROM 'string' OR entry->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(entry->'sha256') IS DISTINCT FROM 'string' OR entry->>'sha256' !~ '^[a-f0-9]{64}$' OR entry->>'sha256' IS DISTINCT FROM expected->>'sha256' OR jsonb_typeof(entry->'bytesLength') IS DISTINCT FROM 'string' OR entry->>'bytesLength' !~ '^(0|[1-9][0-9]{0,15})$' OR(entry->>'bytesLength')::numeric>9007199254740991 OR jsonb_typeof(expected->'byteLength') IS DISTINCT FROM 'number' OR(entry->>'bytesLength')::numeric IS DISTINCT FROM (expected->>'byteLength')::numeric THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
    position:=position+1;
  END LOOP;
  IF(SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(p->'blobs'))<>position OR(SELECT count(DISTINCT value->>'blobId') FROM jsonb_array_elements(p->'blobs'))<>position THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(p_target,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  retention:=manga_web.native_receipt_retention(original.protected_intent,sampled);
  IF retention->>'available' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_RETENTION_EXPIRED'); END IF;
  sources:=manga_web.native_receipt_source_assets(original.protected_intent,input_frame,sampled);
  IF sources IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_SOURCE_UNCONFIRMED'); END IF;
  seal:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO prior FROM manga_web.native_result_candidates WHERE account_id=a AND operation_input_digest=original.operation_input_digest ORDER BY created_at,candidate_id LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('allowed',prior.candidate_digest=seal,'reason',CASE WHEN prior.candidate_digest=seal THEN 'CANDIDATE_EXISTS' ELSE 'NATIVE_RECEIPT_CANDIDATE_CONFLICT' END,'candidate',prior.protected_candidate); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'blobs') b JOIN manga_web.assets s ON s.account_id=a AND s.asset_id=(b->>'assetId')::uuid) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_CANDIDATE_CONFLICT'); END IF;
  INSERT INTO manga_web.native_result_candidates(account_id,candidate_id,job_id,parent_instance_id,operation_input_digest,kernel_implementation_digest,verification_version,result_observation_id,protected_candidate,source_asset_dependencies,candidate_digest,asset_purpose,related_context_id,access_deadline,created_at) VALUES(a,(p->>'candidateId')::uuid,original.job_id,original.parent_instance_id,original.operation_input_digest,p->>'kernelImplementationDigest',p->>'verificationVersion',observation.observation_id,p,sources,seal,retention->>'purpose',(retention->>'contextId')::uuid,(retention->>'accessDeadline')::timestamptz,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','PREPARED','candidate',p);
END $$;

-- 0014 verify body, only outer6/version2/exact candidate ref added.
CREATE FUNCTION native_receipt_verify_windows_v2(p_candidate uuid,p jsonb,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; original manga_web.native_job_intents%ROWTYPE; prior manga_web.native_result_receipts%ROWTYPE; entry jsonb; ref jsonb; position integer:=0; asset manga_web.assets%ROWTYPE; seal text; sampled timestamptz;
BEGIN
  IF manga_web.windows_native_owner_current(p_target->'protectedOwnerCapture') IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=a AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p_target) OR p_target->>'operationInputDigest' IS DISTINCT FROM candidate.operation_input_digest OR p_target->>'kernelImplementationDigest' IS DISTINCT FROM candidate.kernel_implementation_digest OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>1048576 OR(SELECT count(*) FROM jsonb_object_keys(p))<>6 OR NOT p ?& ARRAY['version','candidateId','kernelImplementationDigest','verificationVersion','blobs','windowsEvidenceRef'] OR p->'version' IS DISTINCT FROM '2'::jsonb OR p->>'candidateId' IS DISTINCT FROM p_candidate::text OR p->>'kernelImplementationDigest' IS DISTINCT FROM candidate.kernel_implementation_digest OR p->>'verificationVersion' IS DISTINCT FROM candidate.verification_version OR jsonb_typeof(p->'blobs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'blobs')<>jsonb_array_length(candidate.protected_candidate->'blobs') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  IF NOT manga_web.native_receipt_windows_candidate_valid(candidate.protected_candidate) OR candidate.candidate_digest IS DISTINCT FROM encode(sha256(convert_to(candidate.protected_candidate::text,'UTF8')),'hex') OR NOT manga_web.native_receipt_windows_receipt_valid(p,candidate.protected_candidate) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_WINDOWS_UNCONFIRMED');END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(p_target,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=a AND job_id=candidate.job_id;
  IF original.task IS DISTINCT FROM p_target->>'task' OR original.task_version IS DISTINCT FROM p_target->>'taskVersion' OR original.profile_digest IS DISTINCT FROM p_target->>'profileDigest' OR(manga_web.native_receipt_retention(original.protected_intent,sampled)->>'available') IS DISTINCT FROM 'true' OR NOT manga_web.native_receipt_assets_current(candidate.source_asset_dependencies,sampled) OR(candidate.access_deadline IS NOT NULL AND sampled>=candidate.access_deadline) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_RETENTION_EXPIRED'); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='ERROR') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_UNCONFIRMED'); END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p->'blobs') LOOP
    ref:=candidate.protected_candidate->'blobs'->position;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(entry))<>2 OR NOT entry ?& ARRAY['blobId','receipt'] OR entry->>'blobId' IS DISTINCT FROM ref->>'blobId' OR NOT manga_web.native_receipt_object_valid(entry->'receipt') OR entry->'receipt'->>'key' IS DISTINCT FROM a::text||'/'||(ref->>'assetId') OR entry->'receipt'->>'sha256' IS DISTINCT FROM ref->>'sha256' OR entry->'receipt'->>'bytesLength' IS DISTINCT FROM ref->>'bytesLength' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
    SELECT * INTO asset FROM manga_web.assets WHERE account_id=a AND asset_id=(ref->>'assetId')::uuid;
    IF NOT FOUND OR asset.object_key IS DISTINCT FROM entry->'receipt'->>'key' OR asset.sha256 IS DISTINCT FROM ref->>'sha256' OR asset.bytes_length::text IS DISTINCT FROM ref->>'bytesLength' OR asset.purpose IS DISTINCT FROM candidate.asset_purpose OR asset.related_context_id IS DISTINCT FROM candidate.related_context_id OR asset.media_type IS DISTINCT FROM 'application/octet-stream' OR asset.object_created_at IS DISTINCT FROM (entry->'receipt'->>'completedAt')::timestamptz OR asset.deletion_state='CONFIRMED' OR(asset.access_deadline IS NOT NULL AND sampled>=asset.access_deadline) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_OBJECT_CONFLICT'); END IF;
    position:=position+1;
  END LOOP;
  seal:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO prior FROM manga_web.native_result_receipts WHERE account_id=a AND candidate_id=p_candidate;
  IF FOUND THEN RETURN jsonb_build_object('allowed',prior.receipt_digest=seal,'reason',CASE WHEN prior.receipt_digest=seal THEN 'RECEIPT_EXISTS' ELSE 'NATIVE_RECEIPT_OBJECT_CONFLICT' END); END IF;
  INSERT INTO manga_web.native_result_receipts(account_id,candidate_id,protected_receipt,receipt_digest,verified_at) VALUES(a,p_candidate,p,seal,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','VERIFIED');
END $$;

-- 0014 lookup body retains target current, original retention, source asset
-- currentness, access deadlines, output asset checks and ERROR rejection.
CREATE FUNCTION native_receipt_lookup_windows_v2(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; original manga_web.native_job_intents%ROWTYPE; proof manga_web.native_result_receipts%ROWTYPE; sampled timestamptz; origin_termination jsonb;
BEGIN
  IF manga_web.windows_native_owner_current(p->'protectedOwnerCapture') IS DISTINCT FROM true THEN RETURN jsonb_build_object('state','CONFLICT','reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('state','CONFLICT','reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','CONFLICT','reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(p,service,sampled) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest' ORDER BY created_at,candidate_id LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest' ORDER BY created_at,job_id LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','MISS'); END IF;
    SELECT o.protected_observation->'termination' INTO origin_termination FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id ORDER BY o.received_at DESC,o.observation_id DESC LIMIT 1;
    RETURN jsonb_build_object('state','PENDING_OR_UNCONFIRMED','reason','NATIVE_RECEIPT_UNCONFIRMED','intent',original.protected_intent,'termination',origin_termination);
  END IF;
  IF NOT manga_web.native_receipt_windows_candidate_valid(candidate.protected_candidate) OR candidate.candidate_digest IS DISTINCT FROM encode(sha256(convert_to(candidate.protected_candidate::text,'UTF8')),'hex') THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_WINDOWS_UNCONFIRMED');END IF;
  SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=a AND job_id=candidate.job_id;
  SELECT o.protected_observation->'termination' INTO origin_termination FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='TERMINATION' ORDER BY o.received_at DESC,o.observation_id DESC LIMIT 1;
  IF candidate.kernel_implementation_digest IS DISTINCT FROM p->>'kernelImplementationDigest' OR candidate.verification_version<>'native-facade-verification-v1' OR original.task IS DISTINCT FROM p->>'task' OR original.task_version IS DISTINCT FROM p->>'taskVersion' OR original.profile_digest IS DISTINCT FROM p->>'profileDigest' THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_VERSION_CONFLICT','intent',original.protected_intent,'termination',origin_termination); END IF;
  IF (manga_web.native_receipt_retention(original.protected_intent,sampled)->>'available') IS DISTINCT FROM 'true' OR NOT manga_web.native_receipt_assets_current(candidate.source_asset_dependencies,sampled) OR(candidate.access_deadline IS NOT NULL AND sampled>=candidate.access_deadline) OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate.protected_candidate->'blobs') ref JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND sampled>=b.access_deadline)) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_RETENTION_EXPIRED','intent',original.protected_intent,'termination',origin_termination); END IF;
  SELECT * INTO proof FROM manga_web.native_result_receipts WHERE account_id=a AND candidate_id=candidate.candidate_id;
  IF proof.candidate_id IS NOT NULL AND (NOT manga_web.native_receipt_windows_receipt_valid(proof.protected_receipt,candidate.protected_candidate) OR proof.receipt_digest IS DISTINCT FROM encode(sha256(convert_to(proof.protected_receipt::text,'UTF8')),'hex')) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_WINDOWS_UNCONFIRMED','intent',original.protected_intent,'termination',origin_termination);END IF;
  IF proof.candidate_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(candidate.protected_candidate->'blobs') ref LEFT JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.asset_id IS NULL OR b.sha256 IS DISTINCT FROM ref->>'sha256' OR b.bytes_length::text IS DISTINCT FROM ref->>'bytesLength' OR b.object_key IS DISTINCT FROM a::text||'/'||(ref->>'assetId') OR b.purpose IS DISTINCT FROM candidate.asset_purpose OR b.related_context_id IS DISTINCT FROM candidate.related_context_id OR b.media_type IS DISTINCT FROM 'application/octet-stream') THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_OBJECT_CONFLICT','intent',original.protected_intent,'termination',origin_termination); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='ERROR') THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_UNCONFIRMED','intent',original.protected_intent,'termination',origin_termination); END IF;
  RETURN jsonb_build_object('state',CASE WHEN proof.candidate_id IS NULL THEN 'PENDING_OR_UNCONFIRMED' ELSE 'VERIFIED' END,'reason',CASE WHEN proof.candidate_id IS NULL THEN 'NATIVE_RECEIPT_UNCONFIRMED' ELSE 'VERIFIED' END,'candidate',candidate.protected_candidate,'receipt',proof.protected_receipt,'intent',original.protected_intent,'termination',origin_termination);
END $$;

-- 0014 register body remains, including its worker-only null-target Library
-- reconciliation, exact ObjectReceipt, original asset provenance and deadlines.
CREATE FUNCTION native_receipt_register_asset_windows_v2(p_candidate uuid,p_blob text,p_receipt jsonb,p_bucket text,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; prior manga_web.assets%ROWTYPE; ref jsonb; completed timestamptz; deadline timestamptz; original_deadline timestamptz; sampled timestamptz;
BEGIN
  IF p_target IS NOT NULL AND manga_web.windows_native_owner_current(p_target->'protectedOwnerCapture') IS DISTINCT FROM true THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_OWNER_UNCONFIRMED');END IF;
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=a AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
  IF NOT manga_web.native_receipt_windows_candidate_valid(candidate.protected_candidate) OR candidate.candidate_digest IS DISTINCT FROM encode(sha256(convert_to(candidate.protected_candidate::text,'UTF8')),'hex') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_WINDOWS_UNCONFIRMED');END IF;
  sampled:=clock_timestamp();
  IF p_target IS NULL THEN
    IF service<>'trio_web_worker' OR candidate.asset_purpose<>'LIBRARY' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
  ELSIF NOT manga_web.native_receipt_lookup_valid(p_target) OR p_target->>'operationInputDigest' IS DISTINCT FROM candidate.operation_input_digest OR p_target->>'kernelImplementationDigest' IS DISTINCT FROM candidate.kernel_implementation_digest OR NOT manga_web.native_job_target_current(p_target,service,sampled) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_TARGET_FENCE_REJECTED'); END IF;
  IF NOT manga_web.native_receipt_object_valid(p_receipt) OR p_bucket IS NULL OR length(p_bucket) NOT BETWEEN 1 AND 256 OR p_bucket~'[[:cntrl:]]' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
  SELECT value INTO ref FROM jsonb_array_elements(candidate.protected_candidate->'blobs') WHERE value->>'blobId'=p_blob;
  IF NOT FOUND OR p_receipt->>'key' IS DISTINCT FROM a::text||'/'||(ref->>'assetId') OR p_receipt->>'sha256' IS DISTINCT FROM ref->>'sha256' OR p_receipt->>'bytesLength' IS DISTINCT FROM ref->>'bytesLength' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_OBJECT_CONFLICT'); END IF;
  completed:=(p_receipt->>'completedAt')::timestamptz;deadline:=candidate.access_deadline;
  IF completed>sampled OR completed+((p_receipt->>'completedAtPrecisionMilliseconds')::integer*interval '1 millisecond')<=candidate.created_at THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_OBJECT_CONFLICT'); END IF;
  IF candidate.asset_purpose='LIBRARY' THEN
    deadline:=LEAST(deadline,completed+interval '30 days');
    SELECT l.expires_at INTO original_deadline FROM manga_web.library_store_operations l JOIN manga_web.native_job_intents i ON i.account_id=l.account_id AND i.target_id=l.store_operation_id AND i.target_kind='LIBRARY' WHERE i.account_id=a AND i.job_id=candidate.job_id;
    deadline:=LEAST(deadline,original_deadline);
  END IF;
  SELECT * INTO prior FROM manga_web.assets WHERE account_id=a AND asset_id=(ref->>'assetId')::uuid;
  IF FOUND THEN
    IF prior.purpose IS DISTINCT FROM candidate.asset_purpose OR prior.bucket_ref IS DISTINCT FROM p_bucket OR prior.object_key IS DISTINCT FROM p_receipt->>'key' OR prior.sha256 IS DISTINCT FROM ref->>'sha256' OR prior.bytes_length::text IS DISTINCT FROM ref->>'bytesLength' OR prior.media_type IS DISTINCT FROM 'application/octet-stream' OR prior.related_context_id IS DISTINCT FROM candidate.related_context_id OR prior.object_created_at IS DISTINCT FROM completed OR prior.access_deadline IS DISTINCT FROM deadline THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_OBJECT_CONFLICT'); END IF;
    RETURN jsonb_build_object('allowed',true,'reason','ASSET_EXISTS');
  END IF;
  INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,verified_at,deletion_state,related_context_id,object_created_at,access_deadline) VALUES(a,(ref->>'assetId')::uuid,candidate.asset_purpose,p_bucket,p_receipt->>'key',ref->>'sha256',(ref->>'bytesLength')::bigint,'application/octet-stream',sampled,'NOT_DUE',candidate.related_context_id,completed,deadline);
  RETURN jsonb_build_object('allowed',true,'reason','REGISTERED');
END $$;

-- Public dispatch validates the persisted job/candidate kind; no caller JSON
-- field can reinterpret a Windows original as v1 or an OWNED original as v2.
CREATE FUNCTION native_receipt_prepare(p jsonb,p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); windows boolean;
BEGIN
  IF account IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=account AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16777216 OR jsonb_typeof(p->'jobId') IS DISTINCT FROM 'string' OR p->>'jobId'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID';END IF;
  windows:=manga_web.native_receipt_windows_job((p->>'jobId')::uuid);
  IF p->'version'='1'::jsonb THEN
    IF windows THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_VERSION_CONFLICT');END IF;
    RETURN manga_web.native_receipt_prepare_v1_14(p,p_target);
  ELSIF p->'version'='2'::jsonb THEN
    IF NOT windows THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_VERSION_CONFLICT');END IF;
    RETURN manga_web.native_receipt_prepare_windows_v2(p,p_target);
  END IF;
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID';
END $$;

CREATE FUNCTION native_receipt_verify(p_candidate uuid,p jsonb,p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; windows boolean;
BEGIN
  IF account IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=account AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=account AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED');END IF;
  windows:=manga_web.native_receipt_windows_job(candidate.job_id);
  IF candidate.protected_candidate->'version'='1'::jsonb AND NOT (candidate.protected_candidate ? 'windowsEvidenceRef') AND p->'version'='1'::jsonb AND NOT windows THEN RETURN manga_web.native_receipt_verify_v1_14(p_candidate,p,p_target);
  ELSIF candidate.protected_candidate->'version'='2'::jsonb AND p->'version'='2'::jsonb AND windows THEN RETURN manga_web.native_receipt_verify_windows_v2(p_candidate,p,p_target);
  END IF;
  RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_VERSION_CONFLICT');
END $$;

CREATE FUNCTION native_receipt_lookup(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; original manga_web.native_job_intents%ROWTYPE; sampled timestamptz; windows boolean;
BEGIN
  IF account IS NULL OR service IS NULL THEN RETURN jsonb_build_object('state','CONFLICT','reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=account AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','CONFLICT','reason','ACCOUNT_ACCESS_DENIED');END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID';END IF;
  sampled:=clock_timestamp();
  IF NOT manga_web.native_job_target_current(p,service,sampled) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_TARGET_FENCE_REJECTED');END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=account AND operation_input_digest=p->>'operationInputDigest' ORDER BY created_at,candidate_id LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=account AND operation_input_digest=p->>'operationInputDigest' ORDER BY created_at,job_id LIMIT 1;
    IF original.job_id IS NOT NULL AND manga_web.native_receipt_windows_job(original.job_id) THEN RETURN manga_web.native_receipt_lookup_windows_v2(p);END IF;
    RETURN manga_web.native_receipt_lookup_v1_14(p);
  END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_result_receipts r WHERE r.account_id=account AND r.candidate_id=candidate.candidate_id AND candidate.protected_candidate->'version'='1'::jsonb AND (r.protected_receipt->'version' IS DISTINCT FROM '1'::jsonb OR r.protected_receipt ? 'windowsEvidenceRef')) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_VERSION_CONFLICT');END IF;
  windows:=manga_web.native_receipt_windows_job(candidate.job_id);
  IF candidate.protected_candidate->'version'='1'::jsonb AND NOT (candidate.protected_candidate ? 'windowsEvidenceRef') AND NOT windows THEN RETURN manga_web.native_receipt_lookup_v1_14(p);
  ELSIF candidate.protected_candidate->'version'='2'::jsonb AND windows THEN RETURN manga_web.native_receipt_lookup_windows_v2(p);
  END IF;
  RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_VERSION_CONFLICT');
END $$;

CREATE FUNCTION native_receipt_register_asset(p_candidate uuid,p_blob text,p_receipt jsonb,p_bucket text,p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE account uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; windows boolean;
BEGIN
  IF account IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  -- Keep 0014's non-ACTIVE history registration boundary. The copied body
  -- separately enforces current target or its precise Library-only NULL case.
  PERFORM 1 FROM manga_web.accounts WHERE account_id=account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=account AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED');END IF;
  windows:=manga_web.native_receipt_windows_job(candidate.job_id);
  IF candidate.protected_candidate->'version'='1'::jsonb AND NOT (candidate.protected_candidate ? 'windowsEvidenceRef') AND NOT windows THEN RETURN manga_web.native_receipt_register_asset_v1_14(p_candidate,p_blob,p_receipt,p_bucket,p_target);
  ELSIF candidate.protected_candidate->'version'='2'::jsonb AND windows THEN RETURN manga_web.native_receipt_register_asset_windows_v2(p_candidate,p_blob,p_receipt,p_bucket,p_target);
  END IF;
  RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_VERSION_CONFLICT');
END $$;

-- Complete private ACL list. Parent adds these exact signatures to both the
-- API/worker internal-function deny inventory and controller forbidden checks.
REVOKE ALL ON FUNCTION
  native_receipt_windows_job(uuid),
  native_receipt_windows_raw_valid(uuid,jsonb,text,text,jsonb),
  native_receipt_windows_candidate_valid(jsonb),
  native_receipt_windows_receipt_valid(jsonb,jsonb),
  native_receipt_prepare_v1_14(jsonb,jsonb),
  native_receipt_verify_v1_14(uuid,jsonb,jsonb),
  native_receipt_lookup_v1_14(jsonb),
  native_receipt_register_asset_v1_14(uuid,text,jsonb,text,jsonb),
  native_receipt_prepare_windows_v2(jsonb,jsonb),
  native_receipt_verify_windows_v2(uuid,jsonb,jsonb),
  native_receipt_lookup_windows_v2(jsonb),
  native_receipt_register_asset_windows_v2(uuid,text,jsonb,text,jsonb),
  windows_native_reference(uuid,jsonb)
FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
REVOKE ALL ON FUNCTION native_receipt_prepare(jsonb,jsonb),native_receipt_verify(uuid,jsonb,jsonb),native_receipt_lookup(jsonb),native_receipt_register_asset(uuid,text,jsonb,text,jsonb) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller;
GRANT EXECUTE ON FUNCTION native_receipt_prepare(jsonb,jsonb),native_receipt_verify(uuid,jsonb,jsonb),native_receipt_lookup(jsonb),native_receipt_register_asset(uuid,text,jsonb,text,jsonb) TO trio_web_api,trio_web_worker;
-- No cost/proof/confirm/release/observation/snapshot/unresolved or role membership
-- mutations. Parent owns required reference helper and all 0020 integration.
-- No new private helper or renamed old body is callable by service LOGINs.
REVOKE ALL ON FUNCTION manga_web.windows_native_offer(jsonb),manga_web.windows_native_capture(jsonb,text,text),manga_web.windows_native_current(jsonb),manga_web.windows_native_ready(jsonb,text),manga_web.windows_native_grant_go(jsonb),manga_web.windows_native_append(jsonb,text,text),manga_web.windows_native_event(jsonb,uuid),manga_web.windows_native_scan(jsonb,integer),manga_web.windows_native_record(jsonb,text,uuid,text),manga_web.windows_native_finish(jsonb,text),manga_web.windows_native_link(jsonb,uuid,text,text),manga_web.windows_native_read(jsonb),manga_web.windows_native_canonical(jsonb,integer),manga_web.windows_native_hash(jsonb),manga_web.windows_native_parse(text,integer),manga_web.windows_native_object(jsonb,text[]),manga_web.windows_native_context(jsonb),manga_web.windows_native_scope(jsonb),manga_web.windows_native_basis(uuid,uuid,jsonb),manga_web.windows_native_go_ref(uuid,uuid),manga_web.windows_native_store(jsonb,text,uuid,text),manga_web.windows_native_facts(uuid,uuid),manga_web.windows_native_link_body(uuid,uuid),manga_web.windows_native_view(uuid,uuid),manga_web.windows_native_capacity_go_ready(uuid,uuid,uuid,text,jsonb),manga_web.windows_native_reference(uuid,jsonb),manga_web.native_capacity_windows_profile_valid(jsonb),manga_web.native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text),manga_web.native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid),manga_web.native_controller_claim_owned_v16(jsonb,text,uuid,uuid,uuid,text,uuid),manga_web.native_controller_ready_owned_v16(jsonb,uuid,uuid,uuid,text,uuid),manga_web.native_controller_grant_go_owned_v16(jsonb,uuid,uuid,uuid,text),manga_web.native_job_observation_owned_v16(uuid,jsonb,text),manga_web.native_controller_snapshot_v16(uuid,uuid),manga_web.native_job_unresolved_v13(text),manga_web.native_receipt_windows_job(uuid),manga_web.native_receipt_windows_raw_valid(uuid,jsonb,text,text,jsonb),manga_web.native_receipt_windows_candidate_valid(jsonb),manga_web.native_receipt_windows_receipt_valid(jsonb,jsonb),manga_web.native_receipt_prepare_v1_14(jsonb,jsonb),manga_web.native_receipt_verify_v1_14(uuid,jsonb,jsonb),manga_web.native_receipt_lookup_v1_14(jsonb),manga_web.native_receipt_register_asset_v1_14(uuid,text,jsonb,text,jsonb),manga_web.native_receipt_prepare_windows_v2(jsonb,jsonb),manga_web.native_receipt_verify_windows_v2(uuid,jsonb,jsonb),manga_web.native_receipt_lookup_windows_v2(jsonb),manga_web.native_receipt_register_asset_windows_v2(uuid,text,jsonb,text,jsonb),manga_web.windows_native_reference(uuid,jsonb),manga_web.windows_native_shape(jsonb,jsonb),manga_web.windows_native_win_value(text,jsonb),manga_web.windows_native_fact_valid(jsonb),manga_web.windows_native_accounting_valid(jsonb),manga_web.windows_native_source_valid(uuid,uuid,jsonb,jsonb),manga_web.windows_native_seal_valid(uuid,uuid,jsonb),manga_web.windows_native_owner_current(jsonb),manga_web.windows_native_lookup(jsonb),manga_web.native_controller_snapshot(uuid,uuid),manga_web.native_job_observation_owned(uuid,jsonb,text),manga_web.native_job_unresolved(text) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator;
GRANT EXECUTE ON FUNCTION manga_web.windows_native_offer(jsonb),manga_web.windows_native_capture(jsonb,text,text),manga_web.windows_native_current(jsonb),manga_web.windows_native_ready(jsonb,text),manga_web.windows_native_grant_go(jsonb),manga_web.windows_native_append(jsonb,text,text),manga_web.windows_native_event(jsonb,uuid),manga_web.windows_native_scan(jsonb,integer),manga_web.windows_native_record(jsonb,text,uuid,text),manga_web.windows_native_finish(jsonb,text),manga_web.windows_native_link(jsonb,uuid,text,text),manga_web.windows_native_read(jsonb) TO trio_web_controller;
GRANT EXECUTE ON FUNCTION manga_web.windows_native_lookup(jsonb),manga_web.native_job_unresolved(text) TO trio_web_api,trio_web_worker;
