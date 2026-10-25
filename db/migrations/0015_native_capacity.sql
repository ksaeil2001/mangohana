SET LOCAL search_path TO manga_web,pg_catalog;

-- OWNED fixture authority only. Physical production evidence and the daily
-- accounting period are deliberately not manufactured by this migration.
CREATE TABLE native_capacity_profiles(
  profile_id uuid PRIMARY KEY,
  profile_payload jsonb NOT NULL CHECK(octet_length(profile_payload::text)<=16384),
  profile_digest text NOT NULL CHECK(profile_digest~'^[a-f0-9]{64}$'),
  profile_version text NOT NULL CHECK(profile_version~'^[A-Za-z0-9._-]{1,128}$'),
  max_slots integer NOT NULL CHECK(max_slots BETWEEN 1 AND 10000),
  native_profile_digest text NOT NULL CHECK(native_profile_digest~'^[a-f0-9]{64}$'),
  kernel_digest text NOT NULL CHECK(kernel_digest~'^[a-f0-9]{64}$'),
  controller_id uuid NOT NULL,
  key_version text NOT NULL CHECK(key_version~'^[A-Za-z0-9._-]{1,128}$'),
  environment_digest text NOT NULL CHECK(environment_digest~'^[a-f0-9]{64}$'),
  public_key_spki text NOT NULL CHECK(public_key_spki~'^[A-Za-z0-9+/]{59}=$'),
  UNIQUE(profile_id,profile_digest,profile_version),
  CHECK((jsonb_typeof(profile_payload)='object' AND profile_payload->>'kind'='OWNED_FIXTURE' AND
    profile_payload->>'version'=profile_version AND profile_payload->'maxSlots'=to_jsonb(max_slots) AND
    profile_payload->>'nativeProfileDigest'=native_profile_digest AND profile_payload->>'kernelDigest'=kernel_digest AND
    profile_payload->>'controllerId'=controller_id::text AND profile_payload->>'keyVersion'=key_version AND
    profile_payload->>'environmentDigest'=environment_digest AND profile_payload->>'publicKeySpki'=public_key_spki) IS TRUE),
  CHECK((octet_length(decode(public_key_spki,'base64'))=44 AND encode(substring(decode(public_key_spki,'base64') FROM 1 FOR 12),'hex')='302a300506032b6570032100' AND encode(decode(public_key_spki,'base64'),'base64')=public_key_spki) IS TRUE)
);
CREATE TABLE native_capacity_authority(
  singleton boolean PRIMARY KEY CHECK(singleton),
  current_profile_id uuid REFERENCES native_capacity_profiles(profile_id),
  state text NOT NULL CHECK(state IN('UNMEASURED','OPEN','HALTED')),
  revision bigint NOT NULL CHECK(revision>=0),
  CHECK((state='UNMEASURED' AND current_profile_id IS NULL) OR(state IN('OPEN','HALTED') AND current_profile_id IS NOT NULL))
);
INSERT INTO native_capacity_authority VALUES(true,NULL,'UNMEASURED',0);
CREATE TABLE native_capacity_reservations(
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  reservation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  adoption_id uuid NOT NULL UNIQUE,
  owner_service text NOT NULL CHECK(owner_service IN('trio_web_api','trio_web_worker')),
  profile_id uuid NOT NULL,
  profile_digest text NOT NULL,
  profile_version text NOT NULL,
  execution_profile_id uuid REFERENCES execution_limit_profiles(profile_id),
  root_kind text NOT NULL CHECK(root_kind IN('STANDALONE','EXECUTION')),
  base_execution_id uuid,
  source_execution_id uuid,
  source_input_evidence_id uuid,
  reserved_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN('HELD','RELEASED')),
  released_at timestamptz,
  release_proof_id uuid,
  PRIMARY KEY(account_id,reservation_id),
  UNIQUE(account_id,job_id),
  UNIQUE(account_id,adoption_id),
  FOREIGN KEY(account_id,job_id) REFERENCES native_job_intents(account_id,job_id),
  FOREIGN KEY(profile_id,profile_digest,profile_version) REFERENCES native_capacity_profiles(profile_id,profile_digest,profile_version),
  FOREIGN KEY(account_id,base_execution_id) REFERENCES execution_capacity_permits(account_id,execution_id),
  FOREIGN KEY(account_id,source_execution_id) REFERENCES executions(account_id,execution_id),
  FOREIGN KEY(account_id,source_input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  CHECK((root_kind='EXECUTION')=(base_execution_id IS NOT NULL)),
  CHECK((source_execution_id IS NULL)=(source_input_evidence_id IS NULL)),
  CHECK((state='HELD' AND released_at IS NULL AND release_proof_id IS NULL) OR(state='RELEASED' AND released_at IS NOT NULL AND release_proof_id IS NOT NULL))
);
CREATE TABLE native_capacity_adoptions(
  account_id uuid NOT NULL,
  adoption_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  execution_input_evidence_id uuid NOT NULL,
  source_input_evidence_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  claim_generation bigint NOT NULL CHECK(claim_generation>=0),
  worker_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN('BORROW','PROMOTE')),
  adopted_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,adoption_id),
  UNIQUE(account_id,reservation_id),
  FOREIGN KEY(account_id,reservation_id) REFERENCES native_capacity_reservations(account_id,reservation_id),
  FOREIGN KEY(account_id,adoption_id) REFERENCES native_capacity_reservations(account_id,adoption_id),
  FOREIGN KEY(account_id,execution_id) REFERENCES execution_capacity_permits(account_id,execution_id),
  FOREIGN KEY(account_id,execution_input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  FOREIGN KEY(account_id,source_input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  FOREIGN KEY(account_id,work_item_id) REFERENCES work_items(account_id,work_item_id)
);
CREATE TABLE native_capacity_termination_proofs(
  account_id uuid NOT NULL,
  proof_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  proof_canonical text NOT NULL CHECK(octet_length(proof_canonical)<=8192),
  proof_signature text NOT NULL CHECK(proof_signature~'^[A-Za-z0-9+/]{86}==$'),
  proof_digest text NOT NULL CHECK(proof_digest~'^[a-f0-9]{64}$'),
  observation_id uuid NOT NULL,
  observation_digest text NOT NULL CHECK(observation_digest~'^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,proof_id),
  UNIQUE(account_id,reservation_id),
  UNIQUE(proof_digest),
  FOREIGN KEY(account_id,reservation_id) REFERENCES native_capacity_reservations(account_id,reservation_id),
  FOREIGN KEY(account_id,observation_id) REFERENCES native_job_observations(account_id,observation_id)
);
ALTER TABLE native_capacity_reservations ADD FOREIGN KEY(account_id,release_proof_id) REFERENCES native_capacity_termination_proofs(account_id,proof_id);

CREATE FUNCTION native_capacity_profile_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE p jsonb:=NEW.profile_payload; field text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_IMMUTABLE'; END IF;
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
CREATE TRIGGER native_capacity_profile_record BEFORE INSERT OR UPDATE OR DELETE ON native_capacity_profiles FOR EACH ROW EXECUTE FUNCTION native_capacity_profile_record();
CREATE FUNCTION native_capacity_immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_IMMUTABLE';END $$;
CREATE TRIGGER native_capacity_adoption_immutable BEFORE UPDATE OR DELETE ON native_capacity_adoptions FOR EACH ROW EXECUTE FUNCTION native_capacity_immutable_record();
CREATE TRIGGER native_capacity_proof_immutable BEFORE UPDATE OR DELETE ON native_capacity_termination_proofs FOR EACH ROW EXECUTE FUNCTION native_capacity_immutable_record();
CREATE FUNCTION native_capacity_reservation_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','released_at','release_proof_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','released_at','release_proof_id']) OR OLD.state<>'HELD' OR NEW.state<>'RELEASED' OR
    NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs p WHERE p.account_id=OLD.account_id AND p.reservation_id=OLD.reservation_id AND p.proof_id=NEW.release_proof_id AND p.confirmed_at<=NEW.released_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_IMMUTABLE';
  END IF;RETURN NEW;
END $$;
CREATE TRIGGER native_capacity_reservation_record BEFORE UPDATE OR DELETE ON native_capacity_reservations FOR EACH ROW EXECUTE FUNCTION native_capacity_reservation_record();
DO $rls$ DECLARE relation text;BEGIN
  FOREACH relation IN ARRAY ARRAY['native_capacity_profiles','native_capacity_authority','native_capacity_reservations','native_capacity_adoptions','native_capacity_termination_proofs'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',relation);
    IF relation IN('native_capacity_profiles','native_capacity_authority') THEN EXECUTE format('CREATE POLICY operator_scope ON manga_web.%I TO trio_web_operator USING(true) WITH CHECK(true)',relation);
    ELSE EXECUTE format('CREATE POLICY account_scope ON manga_web.%I TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',relation);END IF;
  END LOOP;
END $rls$;
REVOKE ALL ON native_capacity_profiles,native_capacity_authority,native_capacity_reservations,native_capacity_adoptions,native_capacity_termination_proofs FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator;
GRANT SELECT,INSERT ON native_capacity_profiles TO trio_web_operator;
GRANT SELECT,UPDATE ON native_capacity_authority TO trio_web_operator;
GRANT SELECT ON native_capacity_reservations,native_capacity_adoptions TO trio_web_api,trio_web_worker;

-- The authoritative root set is shared by both admission paths. Provider facts
-- retain their original release fields; a still-held native adoption keeps its
-- execution root occupied even when those provider fields become terminal.
CREATE FUNCTION native_capacity_roots() RETURNS TABLE(root_id text) LANGUAGE sql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT 'execution:'||account_id::text||':'||execution_id::text FROM manga_web.execution_capacity_permits WHERE capacity_released_at IS NULL
 UNION
 SELECT CASE WHEN COALESCE(a.execution_id,r.base_execution_id) IS NOT NULL THEN 'execution:'||r.account_id::text||':'||COALESCE(a.execution_id,r.base_execution_id)::text ELSE 'native:'||r.account_id::text||':'||r.reservation_id::text END FROM manga_web.native_capacity_reservations r LEFT JOIN manga_web.native_capacity_adoptions a USING(account_id,reservation_id) WHERE r.state='HELD'
$$;
CREATE FUNCTION native_capacity_required() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM manga_web.native_capacity_profiles) OR EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations)
$$;
CREATE FUNCTION native_capacity_reference_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  RETURN (jsonb_typeof(p)='object' AND(SELECT count(*) FROM jsonb_object_keys(p))=4 AND p ?& ARRAY['kind','profileId','profileDigest','profileVersion'] AND
    p->>'kind'='OWNED_FIXTURE' AND jsonb_typeof(p->'profileId')='string' AND p->>'profileId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(p->'profileDigest')='string' AND p->>'profileDigest'~'^[a-f0-9]{64}$' AND jsonb_typeof(p->'profileVersion')='string' AND p->>'profileVersion'~'^[A-Za-z0-9._-]{1,128}$') IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION native_capacity_configuration_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>(CASE WHEN p ? 'sourceInput' THEN 3 ELSE 2 END) OR NOT p ?& ARRAY['reference','profile'] OR jsonb_typeof(p->'profile') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF p ? 'sourceInput' AND NOT manga_web.native_capacity_source_valid(p->'sourceInput') THEN RETURN false;END IF;
  RETURN manga_web.native_capacity_reference_valid(p->'reference');
END $$;
-- Private original StageInput identity. This is distinct from a native frame's
-- inputDigest and from SQL's JSONB text hash. Existing parent storedInput still
-- verifies the original canonical INPUT evidence and envelope before this call.
CREATE FUNCTION native_capacity_source_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  RETURN (jsonb_typeof(p)='object' AND(SELECT count(*) FROM jsonb_object_keys(p))=3 AND p ?& ARRAY['executionId','inputEvidenceId','stageInputDigest'] AND
    jsonb_typeof(p->'executionId')='string' AND p->>'executionId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(p->'inputEvidenceId')='string' AND p->>'inputEvidenceId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(p->'stageInputDigest')='string' AND p->>'stageInputDigest'~'^[a-f0-9]{64}$') IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION native_capacity_source_current(p_intent jsonb,p_source jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); source_execution uuid;
BEGIN
  IF a IS NULL OR NOT manga_web.native_capacity_source_valid(p_source) OR p_intent->>'targetKind' NOT IN('EXECUTION','REQUEST_CHECKPOINT') THEN RETURN false;END IF;
  source_execution:=(p_source->>'executionId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM manga_web.executions e JOIN manga_web.execution_evidence i USING(account_id,execution_id) WHERE e.account_id=a AND e.execution_id=source_execution AND
    i.evidence_id=(p_source->>'inputEvidenceId')::uuid AND i.kind='INPUT' AND e.input_digest=p_source->>'stageInputDigest' AND
    i.protected_observation->>'accountId'=a::text AND i.protected_observation->>'executionId'=e.execution_id::text AND i.protected_observation->>'requestId'=e.request_id::text AND
    i.protected_observation->>'inputDigest'=e.input_digest AND i.protected_observation->>'stage'=e.logical_step_id AND
    i.protected_observation->'envelope'->>'executionId'=e.execution_id::text AND i.protected_observation->'envelope'->>'requestId'=e.request_id::text AND i.protected_observation->'envelope'->>'inputDigest'=e.input_digest AND
    (SELECT count(*) FROM manga_web.execution_evidence x WHERE x.account_id=e.account_id AND x.execution_id=e.execution_id AND x.kind='INPUT')=1) THEN RETURN false;END IF;
  IF p_intent->>'targetKind'='EXECUTION' THEN RETURN p_intent->>'targetId'=source_execution::text;END IF;
  -- Reuse has exactly the same priority as ExecutionService.validateCheckpoints.
  -- A selected checkpoint from an earlier request is valid; unrelated INPUT is not.
  RETURN EXISTS(SELECT 1 FROM manga_web.request_steps s JOIN manga_web.checkpoints c ON c.account_id=s.account_id AND
    (c.checkpoint_id=s.reuse_checkpoint_id OR(s.reuse_checkpoint_id IS NULL AND c.execution_id=s.current_execution_id))
    WHERE s.account_id=a AND s.request_id::text=p_intent->>'targetId' AND c.execution_id=source_execution);
END $$;
ALTER FUNCTION native_job_create_intent(jsonb) RENAME TO native_capacity_base_create_intent_v13;
ALTER FUNCTION native_job_consume_go(uuid,uuid,jsonb,jsonb) RENAME TO native_capacity_base_consume_go_v13;
ALTER FUNCTION reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb) RENAME TO native_capacity_base_reserve_execution_v12;
REVOKE ALL ON FUNCTION native_capacity_base_create_intent_v13(jsonb),native_capacity_base_consume_go_v13(uuid,uuid,jsonb,jsonb),native_capacity_base_reserve_execution_v12(uuid,uuid,bigint,uuid,jsonb) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator;

-- Both public admissions take the same account/global locks before reading the
-- root set. A physically joined standalone can be promoted without first
-- releasing or rewriting its original reservation. The adoption aliases that
-- original root to the execution created in this exact transaction.
CREATE FUNCTION reserve_execution_limits(p_execution uuid,p_work uuid,p_generation bigint,p_worker uuid,p_reference jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); h manga_web.execution_limit_authority%ROWTYPE; nh manga_web.native_capacity_authority%ROWTYPE;
  profile manga_web.execution_limit_profiles%ROWTYPE; execution_row manga_web.executions%ROWTYPE; input_row manga_web.execution_evidence%ROWTYPE;
  sampled timestamptz; bound integer; promotion_ids uuid[]:=ARRAY[]::uuid[]; candidate record; decision jsonb;
BEGIN
  IF a IS NULL OR manga_web.native_job_caller() IS DISTINCT FROM 'trio_web_worker' THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED');END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT * INTO nh FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
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

CREATE FUNCTION native_capacity_operator_caller() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT current_setting('role',true)='trio_web_operator' AND pg_has_role(session_user,'trio_web_operator','USAGE')
$$;
CREATE FUNCTION native_capacity_operator_profile(p_account uuid,p_reservation uuid) RETURNS TABLE(profile jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  RETURN QUERY SELECT p.profile_payload FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles p ON p.profile_id=r.profile_id WHERE r.account_id=p_account AND r.reservation_id=p_reservation;
END $$;
-- Only the separate trusted operator may call this function. That process
-- validates the Ed25519 signature over these exact canonical bytes first. SQL
-- independently compares every original binding; no service boolean is trusted.
CREATE FUNCTION native_capacity_confirm_proof(p_canonical text,p_signature text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE p jsonb; a uuid; r manga_web.native_capacity_reservations%ROWTYPE; profile manga_web.native_capacity_profiles%ROWTYPE;
  intent manga_web.native_job_intents%ROWTYPE; observation manga_web.native_job_observations%ROWTYPE; previous manga_web.native_capacity_termination_proofs%ROWTYPE;
  t jsonb; field text; seal text; new_id uuid:=gen_random_uuid(); sampled timestamptz; observed timestamptz;
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  IF p_canonical IS NULL OR octet_length(p_canonical)>8192 OR p_signature IS NULL OR p_signature!~'^[A-Za-z0-9+/]{86}==$' OR octet_length(decode(p_signature,'base64'))<>64 OR replace(encode(decode(p_signature,'base64'),'base64'),E'\n','')<>p_signature THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  p:=p_canonical::jsonb;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(p))<>20 OR NOT p ?& ARRAY['version','kind','accountId','capacityReservationId','adoptionId','jobId','inputDigest','nativeProfileDigest','parentInstanceId','controllerId','keyVersion','environmentDigest','terminationObservationId','terminationObservationDigest','goAttempted','startedComputation','operationJoined','directChildClosed','subtreeTerminationConfirmed','terminationKind'] OR p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'kind' IS DISTINCT FROM 'OWNED_FIXTURE' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  FOREACH field IN ARRAY ARRAY['accountId','capacityReservationId','adoptionId','jobId','parentInstanceId','controllerId','terminationObservationId'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['inputDigest','nativeProfileDigest','environmentDigest','terminationObservationDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field!~'^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  END LOOP;
  a:=(p->>'accountId')::uuid;PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  SELECT last_observed_at INTO observed FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();IF observed IS NOT NULL AND sampled<observed THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=a AND reservation_id=(p->>'capacityReservationId')::uuid;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  SELECT * INTO profile FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  SELECT * INTO intent FROM manga_web.native_job_intents WHERE account_id=a AND job_id=r.job_id;
  SELECT * INTO observation FROM manga_web.native_job_observations WHERE account_id=a AND observation_id=(p->>'terminationObservationId')::uuid;
  t:=observation.protected_observation->'termination';
  IF r.job_id::text IS DISTINCT FROM p->>'jobId' OR r.adoption_id::text IS DISTINCT FROM p->>'adoptionId' OR intent.input_digest IS DISTINCT FROM p->>'inputDigest' OR intent.profile_digest IS DISTINCT FROM p->>'nativeProfileDigest' OR intent.parent_instance_id::text IS DISTINCT FROM p->>'parentInstanceId' OR
    profile.controller_id::text IS DISTINCT FROM p->>'controllerId' OR profile.key_version IS DISTINCT FROM p->>'keyVersion' OR profile.environment_digest IS DISTINCT FROM p->>'environmentDigest' OR profile.profile_payload->>'kind' IS DISTINCT FROM 'OWNED_FIXTURE' OR
    observation.job_id IS DISTINCT FROM r.job_id OR observation.event IS DISTINCT FROM 'TERMINATION' OR observation.observation_digest IS DISTINCT FROM p->>'terminationObservationDigest' OR
    t->>'isolation' IS DISTINCT FROM 'OWNED_FIXTURE' OR t->'goAttempted' IS DISTINCT FROM p->'goAttempted' OR t->'startedComputation' IS DISTINCT FROM p->'startedComputation' OR t->'operationJoined' IS DISTINCT FROM p->'operationJoined' OR t->'directChildClosed' IS DISTINCT FROM p->'directChildClosed' OR t->'subtreeTerminationConfirmed' IS DISTINCT FROM p->'subtreeTerminationConfirmed' OR t->>'kind' IS DISTINCT FROM p->>'terminationKind' OR
    p->'operationJoined' IS DISTINCT FROM 'true'::jsonb OR p->'subtreeTerminationConfirmed' IS DISTINCT FROM 'false'::jsonb THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  IF p->>'terminationKind'='NO_CHILD_CREATED' THEN
    IF p->'goAttempted' IS DISTINCT FROM 'false'::jsonb OR p->'startedComputation' IS DISTINCT FROM 'false'::jsonb OR p->'directChildClosed' IS DISTINCT FROM 'false'::jsonb OR EXISTS(SELECT 1 FROM manga_web.native_job_go_consumptions WHERE account_id=a AND job_id=r.job_id) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_GO_CONTRADICTION');END IF;
  ELSIF p->>'terminationKind'='DIRECT_CHILD_ONLY' THEN
    IF p->'directChildClosed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p->'goAttempted') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'startedComputation') IS DISTINCT FROM 'boolean' OR(p->'startedComputation'='true'::jsonb AND p->'goAttempted'<>'true'::jsonb) OR(p->'goAttempted'<>'true'::jsonb AND EXISTS(SELECT 1 FROM manga_web.native_job_go_consumptions WHERE account_id=a AND job_id=r.job_id)) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_GO_CONTRADICTION');END IF;
  ELSE RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  seal:=encode(sha256(convert_to(p_canonical,'UTF8')),'hex');SELECT * INTO previous FROM manga_web.native_capacity_termination_proofs WHERE account_id=a AND reservation_id=r.reservation_id;
  IF FOUND THEN RETURN jsonb_build_object('allowed',previous.proof_digest=seal AND previous.proof_canonical=p_canonical AND previous.proof_signature=p_signature,'reason',CASE WHEN previous.proof_digest=seal AND previous.proof_canonical=p_canonical AND previous.proof_signature=p_signature THEN 'PROOF_REPLAY' ELSE 'NATIVE_CAPACITY_PROOF_CONFLICT' END,'capacityReservationId',r.reservation_id,'proofId',previous.proof_id);END IF;
  INSERT INTO manga_web.native_capacity_termination_proofs(account_id,proof_id,reservation_id,proof_canonical,proof_signature,proof_digest,observation_id,observation_digest,confirmed_at) VALUES(a,new_id,r.reservation_id,p_canonical,p_signature,seal,observation.observation_id,observation.observation_digest,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','PROOF_CONFIRMED','capacityReservationId',r.reservation_id,'proofId',new_id);
END $$;
CREATE FUNCTION native_capacity_release(p_account uuid,p_reservation uuid,p_proof uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.native_capacity_reservations%ROWTYPE; sampled timestamptz; observed timestamptz;
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=p_account FOR UPDATE;SELECT last_observed_at INTO observed FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=p_account AND reservation_id=p_reservation;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs WHERE account_id=p_account AND reservation_id=p_reservation AND proof_id=p_proof) THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED');END IF;
  IF r.state='RELEASED' THEN RETURN jsonb_build_object('allowed',r.release_proof_id=p_proof,'reason',CASE WHEN r.release_proof_id=p_proof THEN 'RELEASE_REPLAY' ELSE 'NATIVE_CAPACITY_PROOF_CONFLICT' END,'capacityReservationId',r.reservation_id);END IF;
  sampled:=clock_timestamp();IF observed IS NOT NULL AND sampled<observed THEN RETURN jsonb_build_object('allowed',false,'reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  UPDATE manga_web.native_capacity_reservations SET state='RELEASED',released_at=sampled,release_proof_id=p_proof WHERE account_id=p_account AND reservation_id=p_reservation;
  RETURN jsonb_build_object('allowed',true,'reason','NATIVE_CAPACITY_RELEASED','capacityReservationId',r.reservation_id);
END $$;

CREATE FUNCTION native_capacity_recovery(p_after text DEFAULT NULL,p_after_id uuid DEFAULT NULL) RETURNS TABLE(state jsonb,created_at_cursor text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); after_at timestamptz;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN;END IF;
  IF(p_after IS NULL) IS DISTINCT FROM(p_after_id IS NULL) OR(p_after IS NOT NULL AND p_after!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_CURSOR_INVALID';END IF;
  after_at:=p_after::timestamptz;
  RETURN QUERY SELECT jsonb_build_object('capacityReservationId',r.reservation_id,'jobId',r.job_id,'parentInstanceId',j.parent_instance_id,
    'reference',jsonb_build_object('kind','OWNED_FIXTURE','profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version),
    'rootKind',CASE WHEN COALESCE(d.execution_id,r.base_execution_id) IS NULL THEN 'STANDALONE' ELSE 'EXECUTION' END,'executionId',COALESCE(d.execution_id,r.base_execution_id),'adoptionId',r.adoption_id,
    'go',CASE WHEN g.job_id IS NULL THEN 'UNCONSUMED' ELSE 'CONSUMED' END,'terminationProofId',f.proof_id,'state','HELD','ownerService',r.owner_service,'protectedIntent',j.protected_intent)||
    CASE WHEN r.source_input_evidence_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceInput',jsonb_build_object('executionId',r.source_execution_id,'inputEvidenceId',r.source_input_evidence_id,'stageInputDigest',i.protected_observation->>'inputDigest')) END,
    to_char(r.reserved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM manga_web.native_capacity_reservations r JOIN manga_web.native_job_intents j USING(account_id,job_id)
    LEFT JOIN manga_web.native_capacity_adoptions d USING(account_id,reservation_id) LEFT JOIN manga_web.native_job_go_consumptions g USING(account_id,job_id) LEFT JOIN manga_web.native_capacity_termination_proofs f ON f.account_id=r.account_id AND f.reservation_id=r.reservation_id
    LEFT JOIN manga_web.execution_evidence i ON i.account_id=r.account_id AND i.evidence_id=r.source_input_evidence_id
    WHERE r.account_id=a AND r.owner_service=service AND r.state='HELD' AND(p_after IS NULL OR(r.reserved_at,r.reservation_id)>(after_at,p_after_id)) ORDER BY r.reserved_at,r.reservation_id LIMIT 64;
END $$;

CREATE FUNCTION native_capacity_base_intent(p jsonb,p_receipt boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();
BEGIN
  IF p_receipt AND jsonb_typeof(p)='object' AND jsonb_typeof(p->'jobId')='string' AND p->>'jobId'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND NOT EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(p->>'jobId')::uuid) AND
    (EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest') OR EXISTS(SELECT 1 FROM manga_web.native_result_candidates WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest')) THEN
    RETURN jsonb_build_object('allowed',false,'reason','NATIVE_JOB_UNRESOLVED');END IF;
  RETURN manga_web.native_capacity_base_create_intent_v13(p);
END $$;
CREATE FUNCTION native_job_create_intent(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;PERFORM 1 FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  IF manga_web.native_capacity_required() THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_REFERENCE_REQUIRED');END IF;
  RETURN manga_web.native_capacity_base_intent(p,false);
END $$;
CREATE OR REPLACE FUNCTION native_receipt_create_intent(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;PERFORM 1 FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  IF manga_web.native_capacity_required() THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_REFERENCE_REQUIRED');END IF;
  RETURN manga_web.native_capacity_base_intent(p,true);
END $$;
CREATE FUNCTION native_job_consume_go(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;PERFORM 1 FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  IF manga_web.native_capacity_required() THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_REFERENCE_REQUIRED');END IF;
  RETURN manga_web.native_capacity_base_consume_go_v13(p_job,p_parent,p_claim,p_capture);
END $$;

CREATE FUNCTION native_capacity_create_intent(p jsonb,p_receipt boolean,p_capacity jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
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
CREATE FUNCTION native_capacity_consume_go(p_job uuid,p_parent uuid,p_claim jsonb,p_capture jsonb,p_capacity jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); r manga_web.native_capacity_reservations%ROWTYPE; h manga_web.native_capacity_authority%ROWTYPE; eh manga_web.execution_limit_authority%ROWTYPE; profile manga_web.native_capacity_profiles%ROWTYPE; sampled timestamptz; bound integer; p_reference jsonb:=p_capacity->'reference'; intent jsonb;
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
  RETURN manga_web.native_capacity_base_consume_go_v13(p_job,p_parent,p_claim,p_capture);
END $$;

REVOKE ALL ON FUNCTION native_capacity_profile_record(),native_capacity_immutable_record(),native_capacity_reservation_record(),native_capacity_roots(),native_capacity_required(),native_capacity_reference_valid(jsonb),native_capacity_configuration_valid(jsonb),native_capacity_source_valid(jsonb),native_capacity_source_current(jsonb,jsonb),native_capacity_base_intent(jsonb,boolean),native_capacity_operator_caller() FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator;
REVOKE ALL ON FUNCTION native_job_create_intent(jsonb),native_receipt_create_intent(jsonb),native_job_consume_go(uuid,uuid,jsonb,jsonb),reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb),native_capacity_create_intent(jsonb,boolean,jsonb),native_capacity_consume_go(uuid,uuid,jsonb,jsonb,jsonb),native_capacity_recovery(text,uuid),native_capacity_operator_profile(uuid,uuid),native_capacity_confirm_proof(text,text),native_capacity_release(uuid,uuid,uuid) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator;
GRANT EXECUTE ON FUNCTION native_job_create_intent(jsonb),native_receipt_create_intent(jsonb),native_job_consume_go(uuid,uuid,jsonb,jsonb),native_capacity_create_intent(jsonb,boolean,jsonb),native_capacity_consume_go(uuid,uuid,jsonb,jsonb,jsonb),native_capacity_recovery(text,uuid) TO trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb) TO trio_web_worker;
GRANT EXECUTE ON FUNCTION native_capacity_operator_profile(uuid,uuid),native_capacity_confirm_proof(text,text),native_capacity_release(uuid,uuid,uuid) TO trio_web_operator;
