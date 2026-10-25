SET LOCAL search_path TO manga_web,pg_catalog;

-- Never repair or discard irreversible application facts during an upgrade.
-- Lock before the read-only preflight so no duplicate can enter between it
-- and the new single-application constraint.
LOCK TABLE result_applications IN ACCESS EXCLUSIVE MODE;
DO $preflight$ BEGIN
  IF EXISTS(SELECT 1 FROM result_applications GROUP BY account_id,request_id HAVING count(*)>1) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='CHECKPOINT_RESULT_ORIGIN_MIGRATION_HOLD_DUPLICATE_REQUEST';
  END IF;
END $preflight$;

ALTER TABLE result_applications ADD COLUMN origin_request_id uuid;
ALTER TABLE result_applications ADD COLUMN execution_origin_request_id uuid
  GENERATED ALWAYS AS (coalesce(origin_request_id,request_id)) STORED;
ALTER TABLE result_applications ADD CONSTRAINT result_application_execution_origin_fk
  FOREIGN KEY(account_id,execution_origin_request_id,execution_id) REFERENCES executions(account_id,request_id,execution_id);
ALTER TABLE result_applications ADD CONSTRAINT one_result_application_per_request UNIQUE(account_id,request_id);
-- The generated relation is validated before replacing the original FK.
-- Existing business facts and their NULL-origin meaning remain unchanged.
ALTER TABLE result_applications DROP CONSTRAINT result_applications_account_id_request_id_execution_id_fkey;

CREATE FUNCTION verify_checkpoint_result_origin() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,manga_web,pg_temp AS $guard$
DECLARE request manga_web.processing_requests%ROWTYPE; step record; selected record; checked integer:=0; stage_count integer; final_reused boolean:=false;
BEGIN
  -- Service transactions already lock this account and request. Take the same
  -- locks for direct INSERTs; invoker rights retain the worker's account RLS.
  PERFORM 1 FROM manga_web.accounts WHERE account_id=NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';END IF;
  SELECT * INTO request FROM manga_web.processing_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(request.captured_stage_order) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';
  END IF;
  PERFORM 1 FROM manga_web.executions WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND state IN ('DISPATCHING','RUNNING','UNKNOWN') FOR SHARE;
  IF FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';END IF;
  stage_count:=jsonb_array_length(request.captured_stage_order);
  IF stage_count=0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';END IF;
  FOR step IN SELECT * FROM manga_web.request_steps WHERE account_id=NEW.account_id AND request_id=NEW.request_id ORDER BY ordinal FOR SHARE LOOP
    IF step.ordinal<>checked OR step.logical_step_id IS DISTINCT FROM request.captured_stage_order->>checked THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';
    END IF;
    SELECT c.execution_id,c.verification_state,e.request_id AS execution_request_id,e.logical_step_id AS execution_stage,e.state AS execution_state INTO selected
      FROM manga_web.checkpoints c JOIN manga_web.executions e ON e.account_id=c.account_id AND e.execution_id=c.execution_id
      WHERE c.account_id=NEW.account_id AND(c.checkpoint_id=step.reuse_checkpoint_id OR(step.reuse_checkpoint_id IS NULL AND c.execution_id=step.current_execution_id))
        AND c.stage_contract=e.contract_version AND c.dependency_digest=e.input_digest FOR SHARE OF e;
    IF NOT FOUND OR selected.verification_state<>'VERIFIED' OR selected.execution_state<>'SUCCEEDED' OR selected.execution_stage<>step.logical_step_id OR
      (step.reuse_checkpoint_id IS NULL AND selected.execution_request_id<>NEW.request_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';
    END IF;
    final_reused:=step.reuse_checkpoint_id IS NOT NULL;checked:=checked+1;
  END LOOP;
  IF checked<>stage_count THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';END IF;
  IF NEW.execution_id IS DISTINCT FROM selected.execution_id OR
    coalesce(NEW.origin_request_id,NEW.request_id) IS DISTINCT FROM selected.execution_request_id OR
    (NEW.origin_request_id IS NOT NULL AND(NEW.origin_request_id=NEW.request_id OR NOT final_reused)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CHECKPOINT_RESULT_ORIGIN_INVALID';
  END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION verify_checkpoint_result_origin() FROM PUBLIC;
CREATE TRIGGER verify_checkpoint_result_origin BEFORE INSERT ON result_applications FOR EACH ROW EXECUTE FUNCTION verify_checkpoint_result_origin();
