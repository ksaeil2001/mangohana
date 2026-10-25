SET LOCAL search_path TO manga_web,pg_catalog;

-- Only immutable, explicitly owned fixture profiles can be installed at this
-- stage. No measured production values or daily-period choice are fabricated.
CREATE TABLE execution_limit_profiles (
  profile_id uuid PRIMARY KEY,
  profile_payload jsonb NOT NULL CHECK (octet_length(profile_payload::text)<=32768),
  profile_digest text NOT NULL CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
  profile_version text NOT NULL CHECK (profile_version ~ '^[A-Za-z0-9._-]{1,128}$'),
  max_slots integer NOT NULL CHECK (max_slots BETWEEN 1 AND 10000),
  request_limit_usd numeric(28,12) NOT NULL CHECK (request_limit_usd>0 AND request_limit_usd<'Infinity'::numeric),
  daily_limit_usd numeric(28,12) NOT NULL CHECK (daily_limit_usd>0 AND daily_limit_usd<'Infinity'::numeric),
  full_bound_usd numeric(28,12) NOT NULL CHECK (full_bound_usd>0 AND full_bound_usd<=request_limit_usd AND full_bound_usd<=daily_limit_usd),
  stage_bounds jsonb NOT NULL CHECK (jsonb_typeof(stage_bounds)='object'),
  full_bound_evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(full_bound_evidence_refs)='array' AND jsonb_array_length(full_bound_evidence_refs)>0),
  budget_period text CHECK (budget_period='OWNED_EXPLICIT_WINDOW'),
  window_start timestamptz,
  window_end timestamptz,
  UNIQUE(profile_id,profile_digest,profile_version),
  CHECK (((budget_period IS NULL AND window_start IS NULL AND window_end IS NULL) OR
    (budget_period='OWNED_EXPLICIT_WINDOW' AND window_start IS NOT NULL AND window_end IS NOT NULL AND
      isfinite(window_start) AND isfinite(window_end) AND window_end=window_start+interval '24 hours')) IS TRUE),
  CHECK ((profile_payload->>'kind'='OWNED_FIXTURE' AND profile_payload->>'version'=profile_version AND
    (profile_payload->>'maxSlots')::integer=max_slots AND (profile_payload->>'requestLimitUsd')::numeric=request_limit_usd AND
    (profile_payload->>'dailyLimitUsd')::numeric=daily_limit_usd AND (profile_payload->>'fullBoundUsd')::numeric=full_bound_usd AND
    profile_payload->'stages'=stage_bounds AND profile_payload->'fullBoundEvidenceRefs'=full_bound_evidence_refs) IS TRUE),
  CHECK (((budget_period IS NULL AND profile_payload->'window'='null'::jsonb) OR
    (budget_period='OWNED_EXPLICIT_WINDOW' AND profile_payload->'window'->>'kind'=budget_period AND
      (profile_payload->'window'->>'startAt')::timestamptz=window_start AND (profile_payload->'window'->>'endAt')::timestamptz=window_end)) IS TRUE)
);
CREATE TABLE execution_limit_authority (
  singleton boolean PRIMARY KEY CHECK(singleton),
  current_profile_id uuid REFERENCES execution_limit_profiles(profile_id),
  state text NOT NULL CHECK(state IN ('UNMEASURED','OPEN','HALTED')),
  last_observed_at timestamptz,
  halt_reason text,
  revision bigint NOT NULL CHECK(revision>=0),
  CHECK ((state='UNMEASURED' AND current_profile_id IS NULL) OR (state IN ('OPEN','HALTED') AND current_profile_id IS NOT NULL)),
  CHECK ((state='HALTED' AND halt_reason IS NOT NULL) OR (state<>'HALTED' AND halt_reason IS NULL))
);
INSERT INTO execution_limit_authority(singleton,current_profile_id,state,revision) VALUES(true,NULL,'UNMEASURED',0);

CREATE TABLE execution_request_bounds (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_digest text NOT NULL,
  profile_version text NOT NULL,
  full_bound_usd numeric(28,12) NOT NULL CHECK(full_bound_usd>0 AND full_bound_usd<'Infinity'::numeric),
  stage_bounds jsonb NOT NULL,
  full_bound_evidence_refs jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,request_id),
  FOREIGN KEY(account_id,request_id) REFERENCES processing_requests(account_id,request_id),
  FOREIGN KEY(profile_id,profile_digest,profile_version) REFERENCES execution_limit_profiles(profile_id,profile_digest,profile_version)
);
CREATE TABLE execution_budget_reservations (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  initial_bound_usd numeric(28,12) NOT NULL CHECK(initial_bound_usd>0 AND initial_bound_usd<'Infinity'::numeric),
  remaining_usd numeric(28,12) NOT NULL CHECK(remaining_usd>=0 AND remaining_usd<'Infinity'::numeric AND remaining_usd<=initial_bound_usd),
  state text NOT NULL CHECK(state IN ('HELD','RELEASED')),
  reserved_at timestamptz NOT NULL,
  released_at timestamptz,
  release_evidence_ref text,
  PRIMARY KEY(account_id,request_id),
  FOREIGN KEY(account_id,request_id) REFERENCES execution_request_bounds(account_id,request_id),
  CHECK ((state='HELD' AND released_at IS NULL AND release_evidence_ref IS NULL) OR
    (state='RELEASED' AND remaining_usd=0 AND released_at IS NOT NULL AND release_evidence_ref IS NOT NULL))
);
CREATE TABLE execution_capacity_permits (
  account_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  request_id uuid NOT NULL,
  stage_bound_usd numeric(28,12) NOT NULL CHECK(stage_bound_usd>0 AND stage_bound_usd<'Infinity'::numeric),
  expected_component text NOT NULL CHECK(expected_component IN ('STAGE_TOTAL','LOCAL_SYNTHETIC')),
  input_evidence_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  capacity_released_at timestamptz,
  capacity_evidence_id uuid,
  budget_resolved_at timestamptz,
  budget_evidence_id uuid,
  PRIMARY KEY(account_id,execution_id),
  FOREIGN KEY(account_id,request_id) REFERENCES execution_budget_reservations(account_id,request_id),
  FOREIGN KEY(account_id,request_id,execution_id) REFERENCES executions(account_id,request_id,execution_id),
  FOREIGN KEY(account_id,input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  FOREIGN KEY(account_id,capacity_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  FOREIGN KEY(account_id,budget_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  CHECK ((capacity_released_at IS NULL)=(capacity_evidence_id IS NULL)),
  CHECK ((budget_resolved_at IS NULL)=(budget_evidence_id IS NULL))
);
CREATE TABLE execution_limit_expenses (
  account_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  request_id uuid NOT NULL,
  component text NOT NULL,
  ordinal integer NOT NULL,
  evidence_id uuid NOT NULL,
  evidence_digest text NOT NULL,
  actual_usd numeric(28,12) NOT NULL CHECK(actual_usd>=0 AND actual_usd<'Infinity'::numeric),
  cost_confirmed_at timestamptz NOT NULL,
  evidence_received_at timestamptz NOT NULL,
  attributed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,cost_item_id),
  UNIQUE(account_id,execution_id,component,ordinal),
  UNIQUE(account_id,execution_id,evidence_id),
  FOREIGN KEY(account_id,cost_item_id) REFERENCES cost_items(account_id,cost_item_id),
  FOREIGN KEY(account_id,execution_id) REFERENCES execution_capacity_permits(account_id,execution_id),
  FOREIGN KEY(account_id,request_id) REFERENCES execution_request_bounds(account_id,request_id),
  FOREIGN KEY(account_id,evidence_id) REFERENCES execution_evidence(account_id,evidence_id)
);

CREATE FUNCTION immutable_execution_limit_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_RECORD_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_execution_limit_profiles BEFORE UPDATE OR DELETE ON execution_limit_profiles FOR EACH ROW EXECUTE FUNCTION immutable_execution_limit_record();
CREATE TRIGGER immutable_execution_request_bounds BEFORE UPDATE OR DELETE ON execution_request_bounds FOR EACH ROW EXECUTE FUNCTION immutable_execution_limit_record();
CREATE TRIGGER immutable_execution_limit_expenses BEFORE UPDATE OR DELETE ON execution_limit_expenses FOR EACH ROW EXECUTE FUNCTION immutable_execution_limit_record();

-- Validate the operator-owned fixture shape in SQL as well as in the fixture
-- builder. Caller flags and supplied digests never define the authority.
CREATE FUNCTION validate_execution_limit_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE stage record; total numeric:=0; ref jsonb;
BEGIN
  IF NEW.profile_payload IS NULL OR jsonb_typeof(NEW.profile_payload)<>'object' OR
    (SELECT count(*) FROM jsonb_object_keys(NEW.profile_payload))<>9 OR
    NOT NEW.profile_payload ?& ARRAY['kind','version','maxSlots','requestLimitUsd','dailyLimitUsd','fullBoundUsd','stages','fullBoundEvidenceRefs','window'] OR
    NEW.profile_payload->>'kind' IS DISTINCT FROM 'OWNED_FIXTURE' OR
    jsonb_typeof(NEW.profile_payload->'version') IS DISTINCT FROM 'string' OR
    jsonb_typeof(NEW.profile_payload->'maxSlots') IS DISTINCT FROM 'number' OR
    jsonb_typeof(NEW.profile_payload->'requestLimitUsd') IS DISTINCT FROM 'string' OR
    jsonb_typeof(NEW.profile_payload->'dailyLimitUsd') IS DISTINCT FROM 'string' OR
    jsonb_typeof(NEW.profile_payload->'fullBoundUsd') IS DISTINCT FROM 'string' OR
    NEW.profile_payload->>'requestLimitUsd' !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$' OR
    NEW.profile_payload->>'dailyLimitUsd' !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$' OR
    NEW.profile_payload->>'fullBoundUsd' !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$' OR
    (SELECT count(*) FROM jsonb_object_keys(NEW.stage_bounds)) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID';
  END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(NEW.full_bound_evidence_refs) LOOP
    IF jsonb_typeof(ref)<>'string' OR (ref#>>'{}') !~ '^owned-fixture:[A-Za-z0-9._/-]{1,160}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
  END LOOP;
  IF jsonb_array_length(NEW.full_bound_evidence_refs)>32 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.full_bound_evidence_refs))<>jsonb_array_length(NEW.full_bound_evidence_refs) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
  FOR stage IN SELECT key,value FROM jsonb_each(NEW.stage_bounds) LOOP
    IF stage.key !~ '^[A-Z][A-Z0-9_]{0,63}$' OR jsonb_typeof(stage.value)<>'object' OR
      (SELECT count(*) FROM jsonb_object_keys(stage.value))<>3 OR NOT stage.value ?& ARRAY['boundUsd','component','evidenceRefs'] OR
      jsonb_typeof(stage.value->'boundUsd') IS DISTINCT FROM 'string' OR jsonb_typeof(stage.value->'component') IS DISTINCT FROM 'string' OR
      stage.value->>'boundUsd' !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$' OR (stage.value->>'boundUsd')::numeric<=0 OR
      stage.value->>'component' NOT IN ('STAGE_TOTAL','LOCAL_SYNTHETIC') OR jsonb_typeof(stage.value->'evidenceRefs')<>'array' OR
      jsonb_array_length(stage.value->'evidenceRefs') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
    FOR ref IN SELECT value FROM jsonb_array_elements(stage.value->'evidenceRefs') LOOP
      IF jsonb_typeof(ref)<>'string' OR (ref#>>'{}') !~ '^owned-fixture:[A-Za-z0-9._/-]{1,160}$' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(stage.value->'evidenceRefs'))<>jsonb_array_length(stage.value->'evidenceRefs') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
    total:=total+(stage.value->>'boundUsd')::numeric;
  END LOOP;
  IF total>NEW.full_bound_usd THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID'; END IF;
  IF NEW.budget_period IS NOT NULL AND (jsonb_typeof(NEW.profile_payload->'window') IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(NEW.profile_payload->'window'))<>3 OR
    NOT NEW.profile_payload->'window' ?& ARRAY['kind','startAt','endAt'] OR
    NEW.profile_payload->'window'->>'kind' IS DISTINCT FROM 'OWNED_EXPLICIT_WINDOW' OR
    NEW.profile_payload->'window'->>'startAt' IS NULL OR NEW.profile_payload->'window'->>'endAt' IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_PROFILE_INVALID';
  END IF;
  -- convert_to is STABLE in PG18, so the digest is established in this owning
  -- BEFORE INSERT trigger, not an invalid generated-column expression.
  NEW.profile_digest:=encode(sha256(convert_to(NEW.profile_payload::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER validate_execution_limit_profiles BEFORE INSERT ON execution_limit_profiles FOR EACH ROW EXECUTE FUNCTION validate_execution_limit_profile();

-- Ordering is enforced by the INSERT itself, rather than comparing an earlier
-- account-clock sample with the later global-clock sample in the same txn.
CREATE FUNCTION verify_execution_limit_input() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.processing_requests%ROWTYPE; e manga_web.executions%ROWTYPE; b manga_web.execution_request_bounds%ROWTYPE;
BEGIN
  IF NEW.kind<>'INPUT' THEN RETURN NEW; END IF;
  SELECT * INTO e FROM manga_web.executions WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id;
  SELECT * INTO r FROM manga_web.processing_requests WHERE account_id=e.account_id AND request_id=e.request_id;
  IF r.captured_input->'executionLimit' IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO b FROM manga_web.execution_request_bounds WHERE account_id=e.account_id AND request_id=e.request_id;
  IF NOT FOUND OR NEW.protected_observation->'envelope'->>'costBoundUsd' IS NULL OR
    (NEW.protected_observation->'envelope'->>'costBoundUsd')::numeric IS DISTINCT FROM (b.stage_bounds->e.logical_step_id->>'boundUsd')::numeric OR
    NEW.protected_observation->'envelope'->>'parameterProfileVersion' IS DISTINCT FROM b.profile_version THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EXECUTION_LIMIT_INPUT_UNCAPTURED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verify_execution_limit_input BEFORE INSERT ON execution_evidence FOR EACH ROW EXECUTE FUNCTION verify_execution_limit_input();

DO $rls$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['execution_request_bounds','execution_budget_reservations','execution_capacity_permits','execution_limit_expenses'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY account_scope ON manga_web.%I TO trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',relation);
  END LOOP;
END $rls$;
REVOKE ALL ON execution_limit_profiles,execution_limit_authority,execution_request_bounds,execution_budget_reservations,execution_capacity_permits,execution_limit_expenses FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT SELECT,INSERT ON execution_limit_profiles TO trio_web_operator;
GRANT SELECT,UPDATE ON execution_limit_authority TO trio_web_operator;
GRANT SELECT ON execution_request_bounds,execution_budget_reservations,execution_capacity_permits,execution_limit_expenses TO trio_web_worker;

CREATE FUNCTION capture_execution_limits(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); r manga_web.processing_requests%ROWTYPE; b manga_web.execution_request_bounds%ROWTYPE;
  h manga_web.execution_limit_authority%ROWTYPE; p manga_web.execution_limit_profiles%ROWTYPE; sampled timestamptz; ref jsonb;
BEGIN
  IF a IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  SELECT * INTO r FROM manga_web.processing_requests WHERE account_id=a AND request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  ref:=r.captured_input->'executionLimit';
  SELECT * INTO b FROM manga_web.execution_request_bounds WHERE account_id=a AND request_id=p_request;
  IF FOUND THEN RETURN jsonb_build_object('allowed',true,'reason','CAPTURED','stageBounds',b.stage_bounds); END IF;
  IF ref IS NULL OR ref->>'kind' IS DISTINCT FROM 'OWNED_FIXTURE' OR
    ref->>'profileId' IS NULL OR ref->>'profileId' !~ '^[0-9a-fA-F-]{36}$' OR
    EXISTS(SELECT 1 FROM manga_web.execution_evidence v JOIN manga_web.executions e USING(account_id,execution_id) WHERE e.account_id=a AND e.request_id=p_request AND v.kind='INPUT') THEN
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
  IF ref->>'profileId'<>p.profile_id::text OR ref->>'profileDigest' IS DISTINCT FROM p.profile_digest OR ref->>'profileVersion' IS DISTINCT FROM p.profile_version OR r.captured_input->>'parameterProfileVersion' IS DISTINCT FROM p.profile_version THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');
  END IF;
  IF p.budget_period IS DISTINCT FROM 'OWNED_EXPLICIT_WINDOW' OR p.window_start IS NULL OR p.window_end IS NULL OR
    NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_end IS DISTINCT FROM p.window_start+interval '24 hours' OR
    p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PERIOD_UNCONFIRMED'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.captured_stage_order) s(stage) WHERE NOT p.stage_bounds ? s.stage) THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_BOUND_MISSING'); END IF;
  INSERT INTO manga_web.execution_request_bounds(account_id,request_id,profile_id,profile_digest,profile_version,full_bound_usd,stage_bounds,full_bound_evidence_refs,captured_at)
    VALUES(a,p_request,p.profile_id,p.profile_digest,p.profile_version,p.full_bound_usd,p.stage_bounds,p.full_bound_evidence_refs,sampled);
  RETURN jsonb_build_object('allowed',true,'reason','CAPTURED','stageBounds',p.stage_bounds);
END $$;

-- Account mutex always precedes the global mutex. Cross-account work below is
-- an aggregate read; no other account locks, provider calls or external I/O.
CREATE FUNCTION reserve_execution_limits(p_execution uuid,p_work uuid,p_generation bigint,p_worker uuid,p_reference jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
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
  IF p_reference IS DISTINCT FROM r.captured_input->'executionLimit' OR p_reference->>'kind' IS DISTINCT FROM 'OWNED_FIXTURE' OR
    p_reference->>'profileId' IS DISTINCT FROM p.profile_id::text OR p_reference->>'profileDigest' IS DISTINCT FROM p.profile_digest OR p_reference->>'profileVersion' IS DISTINCT FROM p.profile_version OR
    b.profile_id<>p.profile_id OR b.profile_digest<>p.profile_digest OR b.profile_version<>p.profile_version OR
    b.full_bound_usd<>p.full_bound_usd OR b.stage_bounds<>p.stage_bounds OR b.full_bound_evidence_refs<>p.full_bound_evidence_refs THEN
    RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PROFILE_MISMATCH');
  END IF;
  IF p.budget_period IS DISTINCT FROM 'OWNED_EXPLICIT_WINDOW' OR p.window_start IS NULL OR p.window_end IS NULL OR
    NOT isfinite(p.window_start) OR NOT isfinite(p.window_end) OR p.window_end IS DISTINCT FROM p.window_start+interval '24 hours' OR
    p.window_start>=p.window_end OR sampled<p.window_start OR sampled>=p.window_end THEN RETURN jsonb_build_object('allowed',false,'reason','LIMIT_PERIOD_UNCONFIRMED'); END IF;
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

CREATE FUNCTION release_request_execution_budget(p_request uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); r manga_web.processing_requests%ROWTYPE; h manga_web.execution_limit_authority%ROWTYPE; sampled timestamptz;
BEGIN
  IF a IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  SELECT * INTO r FROM manga_web.processing_requests WHERE account_id=a AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.state NOT IN ('COMPLETED','STOPPED','FAILED') OR r.terminal_at IS NULL OR r.terminal_evidence_ref IS NULL OR
    NOT EXISTS(SELECT 1 FROM manga_web.execution_budget_reservations WHERE account_id=a AND request_id=p_request AND state='HELD') THEN RETURN; END IF;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN
    UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE 'GLOBAL_CLOCK_UNCONFIRMED' END,revision=revision+1 WHERE singleton;
    RETURN;
  END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  IF EXISTS(SELECT 1 FROM manga_web.execution_capacity_permits WHERE account_id=a AND request_id=p_request AND budget_resolved_at IS NULL) OR
    EXISTS(SELECT 1 FROM manga_web.cost_items c JOIN manga_web.executions e USING(account_id,execution_id) WHERE e.account_id=a AND e.request_id=p_request AND c.evidence_conflict) THEN RETURN; END IF;
  UPDATE manga_web.execution_budget_reservations SET state='RELEASED',remaining_usd=0,released_at=r.terminal_at,release_evidence_ref=r.terminal_evidence_ref WHERE account_id=a AND request_id=p_request AND state='HELD';
END $$;

CREATE FUNCTION reconcile_execution_limits(p_execution uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); permit manga_web.execution_capacity_permits%ROWTYPE; e manga_web.executions%ROWTYPE;
  h manga_web.execution_limit_authority%ROWTYPE; cost manga_web.cost_items%ROWTYPE; proof manga_web.execution_evidence%ROWTYPE;
  old_expense manga_web.execution_limit_expenses%ROWTYPE; terminal_proof manga_web.execution_evidence%ROWTYPE;
  sampled timestamptz; conflict boolean:=false; complete_cost boolean:=false; expense_total numeric:=0; remaining numeric; reason text;
BEGIN
  IF a IS NULL THEN RETURN jsonb_build_object('reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  SELECT * INTO permit FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=p_execution FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason','NO_PERMIT'); END IF;
  SELECT * INTO e FROM manga_web.executions WHERE account_id=a AND execution_id=p_execution FOR UPDATE;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  sampled:=clock_timestamp();
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN reason:='GLOBAL_CLOCK_UNCONFIRMED';
  ELSE UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton; END IF;
  -- Preserve the original cost amount and both original dates, including stale
  -- OUTCOME evidence. A lease, a restart and a new window are not release proof.
  FOR cost IN SELECT * FROM manga_web.cost_items WHERE account_id=a AND execution_id=p_execution LOOP
    IF cost.evidence_conflict THEN conflict:=true; END IF;
    IF cost.state<>'CONFIRMED' OR cost.actual_usd IS NULL OR cost.confirmed_at IS NULL THEN CONTINUE; END IF;
    SELECT * INTO proof FROM manga_web.execution_evidence v WHERE v.account_id=a AND v.execution_id=p_execution AND v.kind IN ('OUTCOME','STALE_OUTCOME') AND
      v.protected_observation->>'evidenceId'=cost.usage_ref AND v.protected_observation->>'usageConfirmed'='true' AND
      v.protected_observation->>'costUsd' IS NOT NULL AND (v.protected_observation->>'costUsd')::numeric=cost.actual_usd ORDER BY v.received_at,v.evidence_id LIMIT 1;
    IF NOT FOUND THEN conflict:=true; CONTINUE; END IF;
    SELECT * INTO old_expense FROM manga_web.execution_limit_expenses WHERE account_id=a AND cost_item_id=cost.cost_item_id;
    IF FOUND THEN
      IF old_expense.actual_usd<>cost.actual_usd OR old_expense.evidence_id<>proof.evidence_id OR old_expense.evidence_digest<>proof.evidence_digest OR old_expense.cost_confirmed_at<>cost.confirmed_at OR old_expense.evidence_received_at<>proof.received_at THEN conflict:=true; END IF;
    ELSE
      INSERT INTO manga_web.execution_limit_expenses(account_id,cost_item_id,execution_id,request_id,component,ordinal,evidence_id,evidence_digest,actual_usd,cost_confirmed_at,evidence_received_at,attributed_at)
        VALUES(a,cost.cost_item_id,p_execution,e.request_id,cost.component,cost.ordinal,proof.evidence_id,proof.evidence_digest,cost.actual_usd,cost.confirmed_at,proof.received_at,sampled) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN conflict:=true; END IF;
    END IF;
    IF cost.component=permit.expected_component AND cost.ordinal=0 AND NOT cost.evidence_conflict THEN complete_cost:=true; END IF;
  END LOOP;
  SELECT COALESCE(sum(actual_usd),0) INTO expense_total FROM manga_web.execution_limit_expenses WHERE account_id=a AND execution_id=p_execution;
  IF expense_total>permit.stage_bound_usd THEN reason:='LIMIT_ACTUAL_OVER_BOUND'; END IF;
  IF EXISTS(SELECT 1 FROM manga_web.cost_items WHERE account_id=a AND execution_id=p_execution AND (component<>permit.expected_component OR ordinal<>0)) THEN conflict:=true; END IF;
  SELECT * INTO terminal_proof FROM manga_web.execution_evidence v WHERE v.account_id=a AND v.execution_id=p_execution AND v.kind IN ('OUTCOME','STALE_OUTCOME') AND
    ((v.protected_observation->>'outcome' IN ('SUCCESS','FAILURE') AND v.protected_observation->>'started'='true') OR
     (v.protected_observation->>'outcome'='NOT_STARTED' AND v.protected_observation->>'started'='false')) ORDER BY v.received_at,v.evidence_id LIMIT 1;
  IF FOUND THEN
    IF terminal_proof.protected_observation->>'outcome'='NOT_STARTED' AND (e.start_confirmed_at IS NOT NULL OR expense_total<>0 OR EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND protected_observation->>'started'='true')) THEN conflict:=true;
    ELSIF permit.capacity_released_at IS NULL THEN
      UPDATE manga_web.execution_capacity_permits SET capacity_released_at=terminal_proof.received_at,capacity_evidence_id=terminal_proof.evidence_id WHERE account_id=a AND execution_id=p_execution;
    END IF;
  END IF;
  IF conflict THEN reason:=COALESCE(reason,'LIMIT_EVIDENCE_CONFLICT'); END IF;
  IF permit.budget_resolved_at IS NULL AND NOT conflict AND (complete_cost OR terminal_proof.protected_observation->>'outcome'='NOT_STARTED') THEN
    SELECT remaining_usd INTO remaining FROM manga_web.execution_budget_reservations WHERE account_id=a AND request_id=e.request_id FOR UPDATE;
    IF expense_total>remaining THEN reason:=COALESCE(reason,'LIMIT_ACTUAL_OVER_BOUND');
    ELSE
      -- A stage allocation lives inside the whole-request HELD remainder. Only
      -- actual expense is converted; the stage is never added to global held.
      UPDATE manga_web.execution_budget_reservations SET remaining_usd=remaining_usd-expense_total WHERE account_id=a AND request_id=e.request_id AND state='HELD';
      UPDATE manga_web.execution_capacity_permits SET budget_resolved_at=sampled,budget_evidence_id=CASE WHEN complete_cost THEN (SELECT evidence_id FROM manga_web.execution_limit_expenses WHERE account_id=a AND execution_id=p_execution AND component=permit.expected_component AND ordinal=0) ELSE terminal_proof.evidence_id END WHERE account_id=a AND execution_id=p_execution;
    END IF;
  END IF;
  IF reason IS NOT NULL THEN UPDATE manga_web.execution_limit_authority SET state=CASE WHEN current_profile_id IS NULL THEN state ELSE 'HALTED' END,halt_reason=CASE WHEN current_profile_id IS NULL THEN NULL ELSE COALESCE(halt_reason,reason) END,revision=revision+1 WHERE singleton; END IF;
  PERFORM manga_web.release_request_execution_budget(e.request_id);
  RETURN jsonb_build_object('reason',COALESCE(reason,'RECONCILED'));
END $$;

REVOKE ALL ON FUNCTION immutable_execution_limit_record(),validate_execution_limit_profile(),verify_execution_limit_input(),capture_execution_limits(uuid),reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb),reconcile_execution_limits(uuid),release_request_execution_budget(uuid) FROM PUBLIC,trio_web_api;
GRANT EXECUTE ON FUNCTION capture_execution_limits(uuid),reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb),reconcile_execution_limits(uuid),release_request_execution_budget(uuid) TO trio_web_worker;
