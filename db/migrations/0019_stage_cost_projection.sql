-- 전체 처리 비용의 원 INPUT/BASIS/calculation/closure를 한도 expense에 연결한다.
-- 기존 일반 경로의 한도·충돌·ACL을 유지하고, 전체 비용의 예약 해제는 원 비용·종료 봉인을 기다린다.
-- 계산·JS canonical workSet/facts digest 재현은 기존 TS journal/reader가 검증한다.
-- 새 closure proof의 SQL 상한은 1 MiB이며, 증거 거부 시에도 원 actual은 보존한다.
SET search_path TO manga_web,pg_catalog;

CREATE OR REPLACE FUNCTION reconcile_execution_limits(p_execution uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); permit manga_web.execution_capacity_permits%ROWTYPE; e manga_web.executions%ROWTYPE;
  h manga_web.execution_limit_authority%ROWTYPE; cost manga_web.cost_items%ROWTYPE; proof manga_web.execution_evidence%ROWTYPE;
  old_expense manga_web.execution_limit_expenses%ROWTYPE; terminal_proof manga_web.execution_evidence%ROWTYPE;
  closure_proof manga_web.execution_evidence%ROWTYPE; operational_basis boolean:=false;
  sampled timestamptz; conflict boolean:=false; complete_cost boolean:=false; expense_total numeric:=0; remaining numeric; reason text;
BEGIN
  IF a IS NULL THEN RETURN jsonb_build_object('reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  SELECT * INTO permit FROM manga_web.execution_capacity_permits WHERE account_id=a AND execution_id=p_execution FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason','NO_PERMIT'); END IF;
  SELECT * INTO e FROM manga_web.executions WHERE account_id=a AND execution_id=p_execution FOR UPDATE;
  SELECT * INTO h FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND kind='OPERATIONAL_COST_BASIS') INTO operational_basis;
  sampled:=clock_timestamp();
  IF h.last_observed_at IS NOT NULL AND sampled<h.last_observed_at THEN reason:='GLOBAL_CLOCK_UNCONFIRMED';
  ELSE UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton; END IF;
  -- Preserve the original cost amount and both original dates, including stale
  -- OUTCOME evidence. A lease, a restart and a new window are not release proof.
  FOR cost IN SELECT * FROM manga_web.cost_items WHERE account_id=a AND execution_id=p_execution LOOP
    IF cost.evidence_conflict THEN conflict:=true; END IF;
    IF cost.state<>'CONFIRMED' OR cost.actual_usd IS NULL OR cost.confirmed_at IS NULL THEN CONTINUE; END IF;

    SELECT * INTO proof FROM manga_web.execution_evidence v
    WHERE v.account_id=a AND v.execution_id=p_execution AND (
      (NOT operational_basis AND v.kind IN ('OUTCOME','STALE_OUTCOME') AND
       v.protected_observation->>'evidenceId'=cost.usage_ref AND
       v.protected_observation->>'usageConfirmed'='true' AND
       v.protected_observation->>'costUsd' IS NOT NULL AND
       (v.protected_observation->>'costUsd')::numeric=cost.actual_usd)
      OR
      (v.kind='OPERATIONAL_COST_CALCULATION' AND cost.component='STAGE_TOTAL' AND cost.ordinal=0 AND
       cost.usage_ref='execution-evidence:'||v.evidence_id::text||':'||v.evidence_digest AND
       v.protected_evidence_ref=v.evidence_id::text AND
       v.protected_observation->>'version'='1' AND
       v.protected_observation->>'accountId'=a::text AND
       v.protected_observation->>'executionId'=p_execution::text AND
       v.protected_observation->>'inputDigest'=e.input_digest AND
       v.protected_observation->>'kind'='OPERATIONAL_COST_CALCULATION' AND
       v.protected_observation->'value'->>'scope'='FULL_STAGE_PROCESS' AND
       v.protected_observation->'value'->>'state'='CONFIRMED' AND
       CASE WHEN jsonb_typeof(v.protected_observation->'value'->'actualUsd')='string' AND v.protected_observation->'value'->>'actualUsd' ~ '^(0|[1-9][0-9]{0,15})([.][0-9]{1,12})?$' THEN (v.protected_observation->'value'->>'actualUsd')::numeric ELSE NULL END=cost.actual_usd AND
       v.protected_observation->'value'->>'basisVersion'=cost.rate_version AND
       EXISTS(
         SELECT 1 FROM manga_web.execution_evidence i
         JOIN manga_web.execution_evidence b ON b.account_id=i.account_id AND b.execution_id=i.execution_id AND b.kind='OPERATIONAL_COST_BASIS'
         JOIN manga_web.execution_evidence c ON c.account_id=i.account_id AND c.execution_id=i.execution_id AND c.kind='OPERATIONAL_COST_CLOSURE'
         WHERE i.account_id=a AND i.execution_id=p_execution AND i.kind='INPUT' AND
           i.protected_evidence_ref=i.evidence_id::text AND b.protected_evidence_ref=b.evidence_id::text AND c.protected_evidence_ref=c.evidence_id::text AND
           i.evidence_digest=v.protected_observation->>'inputFingerprint' AND
           i.protected_observation->>'executionId'=p_execution::text AND i.protected_observation->>'accountId'=a::text AND i.protected_observation->>'inputDigest'=e.input_digest AND
           b.protected_observation->>'version'='1' AND b.protected_observation->>'accountId'=a::text AND b.protected_observation->>'executionId'=p_execution::text AND
           b.protected_observation->>'inputDigest'=e.input_digest AND b.protected_observation->>'inputFingerprint'=i.evidence_digest AND b.protected_observation->>'kind'='OPERATIONAL_COST_BASIS' AND
           b.protected_observation->'value'->>'captureDigest'=v.protected_observation->'value'->>'captureDigest' AND
           b.protected_observation->'value'->'snapshot'=v.protected_observation->'value'->'snapshot' AND
           b.protected_observation->'value'->>'snapshotDigest'=v.protected_observation->'value'->>'snapshotDigest' AND
           c.protected_observation->>'version'='1' AND c.protected_observation->>'accountId'=a::text AND c.protected_observation->>'executionId'=p_execution::text AND
           c.protected_observation->>'inputDigest'=e.input_digest AND c.protected_observation->>'inputFingerprint'=i.evidence_digest AND c.protected_observation->>'kind'='OPERATIONAL_COST_CLOSURE' AND
           c.protected_observation->'value'->>'basisEvidenceId'=b.evidence_id::text AND c.protected_observation->'value'->>'basisEvidenceDigest'=b.evidence_digest AND
           c.protected_observation->'value'->>'calculationEvidenceId'=v.evidence_id::text AND c.protected_observation->'value'->>'calculationEvidenceDigest'=v.evidence_digest AND
           c.protected_observation->'value'->>'factsDigest'=v.protected_observation->'value'->>'factsDigest' AND
           c.protected_observation->'value'->'workSet'->'facts'=v.protected_observation->'value'->'facts' AND
           c.protected_observation->'value'->'workSet'->>'executionId'=p_execution::text AND
           c.protected_observation->'value'->'workSet'->>'inputFingerprint'=i.evidence_digest AND
           c.protected_observation->'value'->'workSet'->>'captureDigest'=b.protected_observation->'value'->>'captureDigest' AND
           CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'terminationEvidence')='array' THEN jsonb_array_length(c.protected_observation->'value'->'workSet'->'terminationEvidence') ELSE 0 END>0 AND
           CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'joinedEvidence')='array' THEN jsonb_array_length(c.protected_observation->'value'->'workSet'->'joinedEvidence') ELSE 0 END>0 AND

           octet_length(c.protected_observation::text)<=1048576 AND
           c.protected_observation->'value'->>'workSetDigest' ~ '^[a-f0-9]{64}$' AND
           c.protected_observation->'value'->>'factsDigest' ~ '^[a-f0-9]{64}$' AND
           b.protected_observation->'value'->'capture'=v.protected_observation->'value'->'capture' AND
           c.protected_observation->'value'->'workSet'->'version'='1'::jsonb AND
           NOT EXISTS(
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'joinedEvidence')='array'
                 THEN c.protected_observation->'value'->'workSet'->'joinedEvidence' ELSE '[]'::jsonb END ||
               CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'terminationEvidence')='array'
                 THEN c.protected_observation->'value'->'workSet'->'terminationEvidence' ELSE '[]'::jsonb END
             ) ref
             LEFT JOIN manga_web.execution_evidence raw
               ON raw.account_id=a AND raw.execution_id=p_execution AND
                 raw.evidence_id=CASE WHEN ref->>'evidenceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (ref->>'evidenceId')::uuid ELSE NULL END
             WHERE jsonb_typeof(ref) IS DISTINCT FROM 'object' OR
               (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(ref)='object' THEN ref ELSE '{}'::jsonb END))<>2 OR
               NOT (ref ?& ARRAY['evidenceId','evidenceDigest']) OR
               jsonb_typeof(ref->'evidenceId') IS DISTINCT FROM 'string' OR jsonb_typeof(ref->'evidenceDigest') IS DISTINCT FROM 'string' OR
               raw.evidence_id IS NULL OR raw.evidence_digest IS DISTINCT FROM ref->>'evidenceDigest' OR
               raw.protected_evidence_ref IS DISTINCT FROM raw.evidence_id::text OR
               raw.kind IN ('INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') OR
               raw.evidence_id IN (v.evidence_id,c.evidence_id,b.evidence_id,i.evidence_id) OR raw.received_at>c.received_at
           ) AND
           NOT EXISTS(
             SELECT ref->>'evidenceId' FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'joinedEvidence')='array'
                 THEN c.protected_observation->'value'->'workSet'->'joinedEvidence' ELSE '[]'::jsonb END ||
               CASE WHEN jsonb_typeof(c.protected_observation->'value'->'workSet'->'terminationEvidence')='array'
                 THEN c.protected_observation->'value'->'workSet'->'terminationEvidence' ELSE '[]'::jsonb END
             ) ref GROUP BY ref->>'evidenceId' HAVING count(*)>1
           ) AND
           i.received_at<=b.received_at AND b.received_at<=v.received_at AND v.received_at<=c.received_at AND c.received_at<=cost.confirmed_at AND
           (SELECT count(*) FROM manga_web.execution_evidence z WHERE z.account_id=a AND z.execution_id=p_execution AND z.kind='INPUT')=1 AND
           (SELECT count(*) FROM manga_web.execution_evidence z WHERE z.account_id=a AND z.execution_id=p_execution AND z.kind='OPERATIONAL_COST_BASIS')=1 AND
           (SELECT count(*) FROM manga_web.execution_evidence z WHERE z.account_id=a AND z.execution_id=p_execution AND z.kind='OPERATIONAL_COST_CLOSURE')=1
       ))
    ) ORDER BY v.received_at,v.evidence_id LIMIT 1;
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
  -- An opt-in whole-stage BASIS prevents a model-only NOT_STARTED from
  -- resolving the whole budget or releasing capacity before original work ends.
  IF operational_basis AND complete_cost AND NOT conflict THEN
    SELECT c.* INTO closure_proof FROM manga_web.execution_evidence c
    JOIN manga_web.execution_limit_expenses x ON x.account_id=c.account_id AND x.execution_id=c.execution_id AND
      c.protected_observation->'value'->>'calculationEvidenceId'=x.evidence_id::text AND
      c.protected_observation->'value'->>'calculationEvidenceDigest'=x.evidence_digest
    WHERE c.account_id=a AND c.execution_id=p_execution AND c.kind='OPERATIONAL_COST_CLOSURE' AND
      x.component=permit.expected_component AND x.ordinal=0;
    IF NOT FOUND THEN conflict:=true;complete_cost:=false; END IF;
  END IF;
  SELECT * INTO terminal_proof FROM manga_web.execution_evidence v WHERE v.account_id=a AND v.execution_id=p_execution AND v.kind IN ('OUTCOME','STALE_OUTCOME') AND
    ((v.protected_observation->>'outcome' IN ('SUCCESS','FAILURE') AND v.protected_observation->>'started'='true') OR
     (v.protected_observation->>'outcome'='NOT_STARTED' AND v.protected_observation->>'started'='false')) ORDER BY v.received_at,v.evidence_id LIMIT 1;
  IF FOUND THEN
    IF terminal_proof.protected_observation->>'outcome'='NOT_STARTED' AND (e.start_confirmed_at IS NOT NULL OR (NOT operational_basis AND expense_total<>0) OR EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=p_execution AND protected_observation->>'started'='true')) THEN conflict:=true;
    ELSIF permit.capacity_released_at IS NULL AND (NOT operational_basis OR (complete_cost AND closure_proof.evidence_id IS NOT NULL)) THEN
      UPDATE manga_web.execution_capacity_permits SET capacity_released_at=CASE WHEN operational_basis THEN closure_proof.received_at ELSE terminal_proof.received_at END,capacity_evidence_id=CASE WHEN operational_basis THEN closure_proof.evidence_id ELSE terminal_proof.evidence_id END WHERE account_id=a AND execution_id=p_execution;
    END IF;
  END IF;
  IF conflict THEN reason:=COALESCE(reason,'LIMIT_EVIDENCE_CONFLICT'); END IF;
  IF permit.budget_resolved_at IS NULL AND NOT conflict AND (complete_cost OR (NOT operational_basis AND terminal_proof.protected_observation->>'outcome'='NOT_STARTED')) THEN
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
