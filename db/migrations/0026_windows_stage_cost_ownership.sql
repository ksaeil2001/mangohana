
-- 10.186: 비용 소유와 원 입력을 구분한다. 실행이나 권한을 새로 허용하지 않는다.
-- 기존 함수의 최종 변경은 private collect 하나다. 전환은 쓰기 중단된 격리 DB에서 수행한다.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE TABLE windows_stage_cost_ownership_transitions(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,seal_id uuid NOT NULL,seal_digest text NOT NULL,
 old_rule text NOT NULL CHECK(old_rule='windows-stage-cost-0025'),
 old_raw_set_digest text,old_originals_digest text,new_raw_set_digest text,new_originals_digest text,
 disposition text NOT NULL CHECK(disposition IN('LEGACY_EXACT','LEGACY_HOLD')),
 reason text NOT NULL CHECK(reason IN('EXACT','OLD_UNCONFIRMED','OLD_RAW_CHANGED','OLD_ORIGINALS_CHANGED','KNOWN_CONFLICT','NEW_RULE_CHANGED')),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,execution_id),UNIQUE(account_id,seal_id),
 FOREIGN KEY(account_id,execution_id) REFERENCES windows_stage_cost_seals(account_id,execution_id),
 CHECK(seal_digest~'^[a-f0-9]{64}$'),
 CHECK(old_raw_set_digest IS NULL OR old_raw_set_digest~'^[a-f0-9]{64}$'),
 CHECK(old_originals_digest IS NULL OR old_originals_digest~'^[a-f0-9]{64}$'),
 CHECK(new_raw_set_digest IS NULL OR new_raw_set_digest~'^[a-f0-9]{64}$'),
 CHECK(new_originals_digest IS NULL OR new_originals_digest~'^[a-f0-9]{64}$'),
 CHECK((disposition='LEGACY_EXACT')=(reason='EXACT'))
);
REVOKE ALL ON TABLE windows_stage_cost_ownership_transitions FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator;
ALTER TABLE windows_stage_cost_ownership_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE windows_stage_cost_ownership_transitions FORCE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE OR TRUNCATE ON windows_stage_cost_ownership_transitions FOR EACH STATEMENT EXECUTE FUNCTION manga_web.immutable_native_job_record();

-- 원자료 본문 대신 구 관측 scalar만 거래 안에 보존한다.
CREATE TEMP TABLE windows_stage_cost_transition_stage ON COMMIT DROP AS
 SELECT s.account_id,s.execution_id,s.seal_id,s.seal_digest,
  NULL::text old_raw_set_digest,NULL::text old_originals_digest,false old_exact,false known_conflict,NULL::text old_reason
 FROM manga_web.windows_stage_cost_seals s;
ALTER TABLE pg_temp.windows_stage_cost_transition_stage ADD PRIMARY KEY(account_id,execution_id);

DO $old_observation$
DECLARE v_initial_context text:=current_setting('trio.account_id',true);v_account uuid;v_execution uuid;v_seal record;v_observed jsonb;v_reason text;v_conflict boolean;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=(SELECT proowner FROM pg_proc WHERE oid='manga_web.windows_stage_cost_collect(jsonb,integer,boolean)'::regprocedure) AND(rolsuper OR rolbypassrls)) OR
  NOT has_table_privilege(current_user,'manga_web.windows_stage_cost_seals','SELECT') OR
  NOT has_table_privilege((SELECT proowner FROM pg_proc WHERE oid='manga_web.windows_stage_cost_collect(jsonb,integer,boolean)'::regprocedure),'manga_web.windows_stage_cost_ownership_transitions','SELECT')
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_ACCESS_DENIED';END IF;
 FOR v_account IN SELECT account_id FROM pg_temp.windows_stage_cost_transition_stage GROUP BY account_id ORDER BY account_id LOOP
  PERFORM 1 FROM manga_web.accounts WHERE account_id=v_account FOR UPDATE;
  FOR v_execution IN SELECT execution_id FROM(
   SELECT execution_id FROM pg_temp.windows_stage_cost_transition_stage WHERE account_id=v_account
   UNION SELECT nr.source_execution_id FROM manga_web.native_capacity_reservations nr WHERE nr.account_id=v_account AND nr.source_execution_id IS NOT NULL AND(
    nr.base_execution_id IN(SELECT execution_id FROM pg_temp.windows_stage_cost_transition_stage WHERE account_id=v_account)
    OR nr.source_execution_id IN(SELECT execution_id FROM pg_temp.windows_stage_cost_transition_stage WHERE account_id=v_account))
  ) related ORDER BY execution_id LOOP
   PERFORM set_config('trio.account_id',v_account::text,true);
   PERFORM manga_web.windows_native_cost_lock_owner(v_execution);
   PERFORM set_config('trio.account_id',COALESCE(v_initial_context,''),true);
  END LOOP;
 END LOOP;
 IF EXISTS((SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_seals EXCEPT SELECT account_id,execution_id,seal_id,seal_digest FROM pg_temp.windows_stage_cost_transition_stage)
  UNION ALL(SELECT account_id,execution_id,seal_id,seal_digest FROM pg_temp.windows_stage_cost_transition_stage EXCEPT SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_seals))
 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_QUIESCENCE_UNCONFIRMED';END IF;
 FOR v_seal IN SELECT s.* FROM manga_web.windows_stage_cost_seals s ORDER BY s.account_id,s.execution_id LOOP
  PERFORM set_config('trio.account_id',v_seal.account_id::text,true);
  v_observed:=manga_web.windows_stage_cost_collect(v_seal.owner_body,64,true);
  SELECT EXISTS(SELECT 1 FROM manga_web.cost_items ci WHERE ci.account_id=v_seal.account_id AND ci.execution_id=v_seal.execution_id AND ci.evidence_conflict) INTO v_conflict;
  v_reason:=CASE WHEN v_conflict THEN 'KNOWN_CONFLICT' WHEN v_observed IS NULL THEN 'OLD_UNCONFIRMED'
   WHEN v_observed->>'rawSetDigest' IS DISTINCT FROM v_seal.raw_set_digest THEN 'OLD_RAW_CHANGED'
   WHEN v_observed->'originals' IS DISTINCT FROM v_seal.lookup_membership->'originals' THEN 'OLD_ORIGINALS_CHANGED' ELSE 'EXACT' END;
  UPDATE pg_temp.windows_stage_cost_transition_stage SET old_raw_set_digest=v_observed->>'rawSetDigest',
   old_originals_digest=CASE WHEN v_observed IS NULL THEN NULL ELSE manga_web.windows_native_cost_hash(v_observed->'originals') END,
   old_exact=v_reason='EXACT',known_conflict=v_conflict,old_reason=v_reason WHERE account_id=v_seal.account_id AND execution_id=v_seal.execution_id AND seal_id=v_seal.seal_id AND seal_digest=v_seal.seal_digest;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_SEAL_CHANGED';END IF;
  PERFORM set_config('trio.account_id',COALESCE(v_initial_context,''),true);
 END LOOP;
 PERFORM set_config('trio.account_id',COALESCE(v_initial_context,''),true);
END $old_observation$;

-- 새 수집으로 전환 판정만 평가하는 거래 내부 단계다.
CREATE OR REPLACE FUNCTION manga_web.windows_stage_cost_collect(owner jsonb,"limit" integer,include_originals boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp SET timezone='UTC' AS $$
DECLARE a uuid:=manga_web.current_account();e uuid;o jsonb;r manga_web.windows_native_cost_roots%ROWTYPE;
 jobs uuid[];attempts uuid[];source_executions uuid[];rows jsonb:='[]';originals jsonb:='[]';manifest jsonb;counts jsonb:='[]';leaves jsonb:='[]';
 item record;k text;group_rows jsonb;leaf jsonb;part integer;n integer;body jsonb;identity jsonb;completion jsonb;refs jsonb;

 v_source_jobs uuid[];v_source_only uuid[];v_non_source_jobs uuid[];v_foreign_jobs uuid[]:='{}';v_foreign_evidence uuid[]:='{}';v_source_evidence uuid[];
 v_job uuid;v_link record;v_foreign_owner jsonb;v_identity jsonb;v_bundle jsonb;v_expected jsonb;v_pair_count integer;v_op_count integer;v_term_count integer;v_bridge record;
 v_transition manga_web.windows_stage_cost_ownership_transitions%ROWTYPE;v_saved_seal manga_web.windows_stage_cost_seals%ROWTYPE;
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

 -- 소속이 아니라 실제 관측 근거로 후보를 발견한다. foreign 제외는 source 가지에만 적용한다.
 SELECT COALESCE(array_agg(job_id ORDER BY job_id),'{}') INTO v_non_source_jobs FROM(SELECT job_id FROM(
  SELECT job_id FROM manga_web.native_job_intents WHERE account_id=a AND target_kind='EXECUTION' AND target_id=e
  UNION SELECT job_id FROM manga_web.native_capacity_reservations WHERE account_id=a AND base_execution_id=e
  UNION SELECT job_id FROM manga_web.native_capacity_adoptions d JOIN manga_web.native_capacity_reservations r USING(account_id,reservation_id) WHERE d.account_id=a AND d.execution_id=e
  UNION SELECT job_id FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND execution_id=e
  UNION SELECT job_id FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND execution_id=e
  UNION SELECT u.job_id FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=a AND c.execution_id=e
  UNION SELECT i.job_id FROM manga_web.native_job_intents i WHERE i.account_id=a AND i.target_kind='REQUEST_CHECKPOINT' AND EXISTS(
   SELECT 1 FROM manga_web.execution_evidence attempt,LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(attempt.protected_observation->'value'->'targets')='array' THEN attempt.protected_observation->'value'->'targets' ELSE '[]' END) target
   WHERE attempt.account_id=a AND attempt.execution_id=e AND attempt.kind='CHECKPOINT_VALIDATION_ATTEMPT'
    AND attempt.protected_observation->'value'->>'consumerExecutionId'=e::text AND attempt.protected_observation->'value'->>'consumerRequestId'=i.target_id::text
    AND i.semantic_capture_digest=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'phase','CHECKPOINT','currentRequestId',i.target_id,'originExecutionId',target->>'sourceExecutionId','inputFingerprint',target->>'inputFingerprint','outputDigest',target->>'outputDigest')))
 ) non_source ORDER BY job_id LIMIT 65) bounded_non_source;
 IF cardinality(v_non_source_jobs)>64 OR cardinality(v_non_source_jobs)>"limit" THEN RETURN NULL;END IF;
 -- 해석 불가 local bridge를 정상 foreign으로 제외해서는 안 된다.
 IF EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') AND
  manga_web.windows_native_cost_uuid(CASE WHEN ev.kind='WINDOWS_NATIVE_OPERATION' THEN ev.protected_observation->'value'->'binding'->>'jobId' ELSE ev.protected_observation->'value'->>'jobId' END) IS DISTINCT FROM true) THEN RETURN NULL;END IF;
 -- 탐색 UUID도 원 raw-row 예산의 N+1로 제한한다. 선택 작업의 64 상한은 아래에서 별도로 적용한다.
 SELECT COALESCE(array_agg(job_id ORDER BY job_id),'{}') INTO v_source_jobs FROM(SELECT job_id FROM(
  SELECT job_id FROM manga_web.native_capacity_reservations WHERE account_id=a AND source_execution_id=e
  UNION SELECT(CASE WHEN ev.kind='WINDOWS_NATIVE_OPERATION' THEN ev.protected_observation->'value'->'binding'->>'jobId' ELSE ev.protected_observation->'value'->>'jobId' END)::uuid
   FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND ev.kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')
 ) source_candidates ORDER BY job_id LIMIT 16385) bounded_source;
 IF cardinality(v_source_jobs)>16384 THEN RETURN NULL;END IF;
 FOREACH v_job IN ARRAY v_source_jobs LOOP
  SELECT bi.*,cc.execution_id AS call_execution_id,cc.scope_id,cc.call_digest,cc.protected_call,
   sc.execution_id AS scope_execution_id,sc.scope_digest,sc.protected_scope,rr.owner_identity,rr.components,rr.components_digest,
   ni.protected_intent AS actual_intent,ni.intent_digest,ni.owner_service AS intent_owner,ni.target_kind,ni.target_id,ni.semantic_capture_digest,ni.parent_instance_id,ni.profile_digest AS actual_profile_digest,ni.input_digest,ni.operation_input_digest,ni.task,ni.task_version,ni.logical_operation_key,
   nr.source_execution_id,nr.source_input_evidence_id,nr.reservation_id,nr.owner_service AS reservation_owner,nr.root_kind,nr.base_execution_id,nr.profile_id,nr.profile_digest AS reserved_profile_digest,nr.profile_version,
   pf.profile_payload,pf.native_profile_digest,pf.kernel_digest,
   si.evidence_id AS source_evidence_id,si.protected_observation AS source_input
   INTO v_link FROM manga_web.windows_native_cost_bindings bi
   LEFT JOIN manga_web.windows_native_cost_calls cc ON cc.account_id=bi.account_id AND cc.call_id=bi.call_id
   LEFT JOIN manga_web.windows_native_cost_scopes sc ON sc.account_id=cc.account_id AND sc.scope_id=cc.scope_id
   LEFT JOIN manga_web.windows_native_cost_roots rr ON rr.account_id=bi.account_id AND rr.execution_id=bi.execution_id
   LEFT JOIN manga_web.native_job_intents ni ON ni.account_id=bi.account_id AND ni.job_id=bi.job_id
   LEFT JOIN manga_web.native_capacity_reservations nr ON nr.account_id=bi.account_id AND nr.job_id=bi.job_id
   LEFT JOIN manga_web.native_capacity_profiles pf ON pf.profile_id=nr.profile_id
   LEFT JOIN manga_web.execution_evidence si ON si.account_id=nr.account_id AND si.execution_id=nr.source_execution_id AND si.evidence_id=nr.source_input_evidence_id AND si.kind='INPUT'
   WHERE bi.account_id=a AND bi.job_id=v_job;
  -- binding이 없거나 자기 소속이면 기존 UNCONFIRMED/FRESH 판정 경로에 남긴다.
  IF NOT FOUND OR v_link.execution_id=e THEN CONTINUE;END IF;
  v_foreign_owner:=manga_web.windows_stage_cost_owner(v_link.owner_identity);
  IF v_link.reservation_owner IS DISTINCT FROM v_link.intent_owner OR v_link.intent_owner IS DISTINCT FROM 'trio_web_worker' OR
   EXISTS(SELECT 1 FROM manga_web.native_controller_attempts at WHERE at.account_id=a AND at.job_id=v_job AND at.owner_service IS DISTINCT FROM v_link.intent_owner)
  THEN RETURN NULL;END IF;
  IF v_foreign_owner IS NULL OR v_link.call_execution_id IS DISTINCT FROM v_link.execution_id OR v_link.scope_execution_id IS DISTINCT FROM v_link.execution_id OR
   (v_link.protected_scope->'owner')-'claim'-'validationAttemptRef' IS DISTINCT FROM v_link.owner_identity OR
   v_link.scope_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(v_link.protected_scope-'scopeDigest') OR
   manga_web.windows_native_cost_scope_history_valid(v_link.protected_scope) IS DISTINCT FROM true OR
   NOT manga_web.windows_native_object(v_link.protected_call,ARRAY['version','callId','callDigest','scopeId','scopeDigest','task','taskVersion','profileDigest','kernelDigest','operationInputDigest','componentId']) OR
   v_link.protected_call->>'callId' IS DISTINCT FROM v_link.call_id::text OR v_link.protected_call->>'scopeId' IS DISTINCT FROM v_link.scope_id::text OR
   v_link.protected_call->>'scopeDigest' IS DISTINCT FROM v_link.scope_digest OR v_link.protected_call->>'callDigest' IS DISTINCT FROM v_link.call_digest OR
   v_link.call_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(v_link.protected_call-'callDigest') OR
   jsonb_typeof(v_link.components) IS DISTINCT FROM 'array' OR octet_length(v_link.components::text)>16384 OR v_link.components_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(v_link.components) OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_link.components)='array' THEN v_link.components ELSE '[]' END) component WHERE component->>'task'=v_link.protected_call->>'task' AND component->>'componentId'=v_link.component_id) OR
   v_link.evidence_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(jsonb_build_object('call',v_link.protected_call,'intent',v_link.protected_intent,'capacity',v_link.protected_capacity,'componentId',v_link.component_id)) OR
   manga_web.native_job_valid_tuple(v_link.protected_intent) IS DISTINCT FROM true OR v_link.actual_intent IS DISTINCT FROM v_link.protected_intent OR
   v_link.intent_digest IS DISTINCT FROM encode(sha256(convert_to(v_link.actual_intent::text,'UTF8')),'hex') OR
   v_link.actual_intent->>'jobId' IS DISTINCT FROM v_job::text OR v_link.actual_intent->>'parentInstanceId' IS DISTINCT FROM v_link.parent_instance_id::text OR
   v_link.actual_intent->>'targetKind' IS DISTINCT FROM v_link.target_kind OR v_link.actual_intent->>'targetId' IS DISTINCT FROM v_link.target_id::text OR
   v_link.actual_intent->>'semanticCaptureDigest' IS DISTINCT FROM v_link.semantic_capture_digest OR
   v_link.actual_intent->>'logicalOperationKey' IS DISTINCT FROM v_link.logical_operation_key OR
   v_link.actual_intent->>'inputDigest' IS DISTINCT FROM v_link.input_digest OR v_link.actual_intent->>'operationInputDigest' IS DISTINCT FROM v_link.operation_input_digest OR
   v_link.actual_intent->>'task' IS DISTINCT FROM v_link.task OR v_link.actual_intent->>'taskVersion' IS DISTINCT FROM v_link.task_version OR
   v_link.actual_intent->>'profileDigest' IS DISTINCT FROM v_link.actual_profile_digest OR
   v_link.protected_intent->>'task' IS DISTINCT FROM v_link.protected_call->>'task' OR v_link.protected_intent->>'taskVersion' IS DISTINCT FROM v_link.protected_call->>'taskVersion' OR
   v_link.protected_intent->>'profileDigest' IS DISTINCT FROM v_link.protected_call->>'profileDigest' OR v_link.protected_intent->>'operationInputDigest' IS DISTINCT FROM v_link.protected_call->>'operationInputDigest' OR
   v_link.protected_call->>'componentId' IS DISTINCT FROM v_link.component_id OR
   (v_link.protected_intent-ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','operationInputDigest','parentInstanceId','logicalOperationKey']) IS DISTINCT FROM((v_link.protected_scope->'target')-ARRAY['accountId','sourceInput']) OR
   v_link.protected_capacity->'sourceInput' IS DISTINCT FROM v_link.protected_scope->'target'->'sourceInput' OR
   v_link.source_execution_id IS DISTINCT FROM e OR v_link.source_evidence_id IS NULL OR
   v_link.protected_capacity->'sourceInput' IS DISTINCT FROM jsonb_build_object('executionId',v_link.source_execution_id,'inputEvidenceId',v_link.source_input_evidence_id,'stageInputDigest',v_link.source_input->>'inputDigest') OR
   v_link.protected_capacity->'reference' IS DISTINCT FROM jsonb_build_object('kind','WINDOWS_JOB_OBJECT','profileId',v_link.profile_id,'profileDigest',v_link.reserved_profile_digest,'profileVersion',v_link.profile_version) OR
   v_link.protected_capacity->'profile' IS DISTINCT FROM v_link.profile_payload OR v_link.profile_payload->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' OR
   v_link.actual_profile_digest IS DISTINCT FROM v_link.native_profile_digest OR v_link.protected_call->>'kernelDigest' IS DISTINCT FROM v_link.kernel_digest
  THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents ni WHERE ni.account_id=a AND ni.job_id=v_job AND ni.target_kind='EXECUTION' AND ni.target_id=e) OR
   EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations nr WHERE nr.account_id=a AND nr.job_id=v_job AND nr.base_execution_id=e) OR
   EXISTS(SELECT 1 FROM manga_web.native_capacity_adoptions na JOIN manga_web.native_capacity_reservations nr USING(account_id,reservation_id) WHERE na.account_id=a AND nr.job_id=v_job AND na.execution_id=e)
  THEN RETURN NULL;END IF;
  -- 현재 CACHE/QUERY/attempt의 도달 관계는 producer 소속과 공존할 수 있다.
  IF v_job=ANY(v_non_source_jobs) THEN CONTINUE;END IF;
  -- 제외하기 전에 원 슬롯·adoption도 같은 B 소속임을 확인한다.
  IF(v_link.root_kind='EXECUTION' AND v_link.base_execution_id IS DISTINCT FROM v_link.execution_id) OR
   (v_link.root_kind='STANDALONE' AND v_link.base_execution_id IS NOT NULL) OR
   EXISTS(SELECT 1 FROM manga_web.native_capacity_adoptions ad WHERE ad.account_id=a AND ad.reservation_id=v_link.reservation_id AND ad.execution_id IS DISTINCT FROM v_link.execution_id)
  THEN RETURN NULL;END IF;
  SELECT count(*),count(*) FILTER(WHERE kind='WINDOWS_NATIVE_OPERATION'),count(*) FILTER(WHERE kind='WINDOWS_NATIVE_TERMINATION')
   INTO v_pair_count,v_op_count,v_term_count FROM(
    SELECT ev.kind FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND
    ((ev.kind='WINDOWS_NATIVE_OPERATION' AND ev.protected_observation->'value'->'binding'->>'jobId'=v_job::text) OR(ev.kind='WINDOWS_NATIVE_TERMINATION' AND ev.protected_observation->'value'->>'jobId'=v_job::text)) LIMIT 3) whole_pair;
  IF v_pair_count>0 THEN
   IF v_pair_count<>2 OR v_op_count<>1 OR v_term_count<>1 THEN RETURN NULL;END IF;
   v_identity:=manga_web.windows_stage_cost_original(v_foreign_owner,v_job);
   IF v_identity->>'classification' IS DISTINCT FROM 'FRESH' OR v_identity->'key' IS NULL OR v_identity->'key'='null'::jsonb THEN RETURN NULL;END IF;
   v_bundle:=manga_web.windows_native_evidence_bundle(v_identity->'key',NULL);IF v_bundle IS NULL THEN RETURN NULL;END IF;
   v_expected:=manga_web.windows_native_evidence_values(v_bundle,v_identity->'key');
   FOR v_bridge IN SELECT ev.* FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND
    ((ev.kind='WINDOWS_NATIVE_OPERATION' AND ev.protected_observation->'value'->'binding'->>'jobId'=v_job::text) OR(ev.kind='WINDOWS_NATIVE_TERMINATION' AND ev.protected_observation->'value'->>'jobId'=v_job::text)) LOOP
    IF v_bridge.protected_observation IS DISTINCT FROM (CASE WHEN v_bridge.kind='WINDOWS_NATIVE_OPERATION' THEN v_expected->'operation' ELSE v_expected->'termination' END) OR
     v_bridge.evidence_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(v_bridge.protected_observation) OR v_bridge.protected_evidence_ref IS DISTINCT FROM v_bridge.evidence_id::text OR
     (CASE WHEN v_bridge.kind='WINDOWS_NATIVE_OPERATION' THEN v_identity->'sourceOperation' ELSE v_identity->'sourceTermination' END) IS DISTINCT FROM jsonb_build_object('evidenceId',v_bridge.evidence_id,'evidenceDigest',v_bridge.evidence_digest)
    THEN RETURN NULL;END IF;
    v_foreign_evidence:=array_append(v_foreign_evidence,v_bridge.evidence_id);
   END LOOP;
  END IF;
  v_foreign_jobs:=array_append(v_foreign_jobs,v_job);
 END LOOP;
 SELECT COALESCE(array_agg(job_id ORDER BY job_id),'{}') INTO jobs FROM(SELECT job_id FROM(
  SELECT unnest(v_non_source_jobs) job_id
  UNION (SELECT unnest(v_source_jobs) EXCEPT SELECT unnest(v_foreign_jobs))
 ) selected_jobs ORDER BY job_id LIMIT 65) bounded_jobs;
 IF cardinality(jobs)>64 OR cardinality(jobs)>"limit" THEN RETURN NULL;END IF;
 SELECT COALESCE(array_agg(attempt_id ORDER BY attempt_id),'{}') INTO attempts FROM manga_web.native_controller_attempts WHERE account_id=a AND job_id=ANY(jobs);

 SELECT COALESCE(array_agg(DISTINCT source_execution_id),'{}') INTO source_executions FROM manga_web.native_capacity_reservations WHERE account_id=a AND job_id=ANY(jobs) AND source_execution_id IS NOT NULL;
 source_executions:=array_append(source_executions,e);
 -- 원 출처 일반 증거 대신 선택 job의 봉인된 INPUT/BASIS ref만 결합한다.
 SELECT COALESCE(array_agg(DISTINCT ev.evidence_id),'{}') INTO v_source_evidence FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND(
  EXISTS(SELECT 1 FROM manga_web.native_capacity_reservations nr WHERE nr.account_id=a AND nr.job_id=ANY(jobs) AND nr.source_input_evidence_id=ev.evidence_id AND nr.source_execution_id=ev.execution_id)
  OR EXISTS(SELECT 1 FROM manga_web.windows_native_origins origin JOIN manga_web.native_controller_attempts at USING(account_id,attempt_id)
   WHERE origin.account_id=a AND at.job_id=ANY(jobs) AND(
    (origin.input_snapshot->>'evidenceId'=ev.evidence_id::text AND origin.input_snapshot->>'evidenceDigest'=ev.evidence_digest)
    OR(origin.basis_snapshot->>'evidenceId'=ev.evidence_id::text AND origin.basis_snapshot->>'evidenceDigest'=ev.evidence_digest))));
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

   FROM manga_web.execution_evidence x WHERE x.account_id=a AND(
    x.execution_id=e OR x.evidence_id=ANY(v_source_evidence) OR(
     x.execution_id=ANY(source_executions) AND(
      (x.kind='WINDOWS_NATIVE_OPERATION' AND x.protected_observation->'value'->'binding'->>'jobId'=ANY(SELECT job_id::text FROM unnest(jobs) job_id))
      OR(x.kind='WINDOWS_NATIVE_TERMINATION' AND x.protected_observation->'value'->>'jobId'=ANY(SELECT job_id::text FROM unnest(jobs) job_id)))))
    AND NOT(x.evidence_id=ANY(v_foreign_evidence)) AND x.kind NOT IN('WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')
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

DO $new_observation$
DECLARE v_initial_context text:=current_setting('trio.account_id',true);v_stage record;v_seal record;v_observed jsonb;v_reason text;
BEGIN
 FOR v_stage IN SELECT * FROM pg_temp.windows_stage_cost_transition_stage ORDER BY account_id,execution_id LOOP
  SELECT * INTO v_seal FROM manga_web.windows_stage_cost_seals WHERE account_id=v_stage.account_id AND execution_id=v_stage.execution_id AND seal_id=v_stage.seal_id AND seal_digest=v_stage.seal_digest;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_SEAL_CHANGED';END IF;
  PERFORM set_config('trio.account_id',v_stage.account_id::text,true);
  v_observed:=manga_web.windows_stage_cost_collect(v_seal.owner_body,64,true);
  v_reason:=CASE WHEN NOT v_stage.old_exact THEN v_stage.old_reason
   WHEN v_observed IS NULL OR v_observed->>'rawSetDigest' IS DISTINCT FROM v_seal.raw_set_digest OR v_observed->'originals' IS DISTINCT FROM v_seal.lookup_membership->'originals' THEN 'NEW_RULE_CHANGED' ELSE 'EXACT' END;
  INSERT INTO manga_web.windows_stage_cost_ownership_transitions(account_id,execution_id,seal_id,seal_digest,old_rule,old_raw_set_digest,old_originals_digest,new_raw_set_digest,new_originals_digest,disposition,reason,recorded_at)
   VALUES(v_stage.account_id,v_stage.execution_id,v_stage.seal_id,v_stage.seal_digest,'windows-stage-cost-0025',v_stage.old_raw_set_digest,v_stage.old_originals_digest,
    v_observed->>'rawSetDigest',CASE WHEN v_observed IS NULL THEN NULL ELSE manga_web.windows_native_cost_hash(v_observed->'originals') END,
    CASE WHEN v_reason='EXACT' THEN 'LEGACY_EXACT' ELSE 'LEGACY_HOLD' END,v_reason,clock_timestamp());
  PERFORM set_config('trio.account_id',COALESCE(v_initial_context,''),true);
 END LOOP;
 IF EXISTS((SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_seals EXCEPT SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_ownership_transitions)
  UNION ALL(SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_ownership_transitions EXCEPT SELECT account_id,execution_id,seal_id,seal_digest FROM manga_web.windows_stage_cost_seals))
  OR(SELECT count(*) FROM pg_temp.windows_stage_cost_transition_stage)<>(SELECT count(*) FROM manga_web.windows_stage_cost_ownership_transitions)
 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_MEMBERSHIP_CHANGED';END IF;
 PERFORM set_config('trio.account_id',COALESCE(v_initial_context,''),true);
END $new_observation$;

-- 모든 판정이 기록된 뒤 최종 읽기 가드를 같은 OID에 설치한다.

-- 전환 판정 전수 기록 뒤 같은 함수의 최종 가드만 설치한다.
DO $install_guard$
DECLARE v_definition text;v_top text:=' SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=a AND execution_id=e;';
 v_bottom text:=' body:=jsonb_build_object(''version'',1,''mode'',''CENSUS''';

BEGIN
 SELECT pg_get_functiondef('manga_web.windows_stage_cost_collect(jsonb,integer,boolean)'::regprocedure) INTO v_definition;
 IF array_length(string_to_array(v_definition,v_top),1)<>2 OR array_length(string_to_array(v_definition,v_bottom),1)<>2
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_STAGE_COST_TRANSITION_GUARD_POINT_CHANGED';END IF;
 v_definition:=replace(v_definition,v_top,v_top||$top_text$

 -- 구 규칙에서 이미 불일치한 봉인을 새 규칙의 일치만으로 풀지 않는다.
 SELECT * INTO v_transition FROM manga_web.windows_stage_cost_ownership_transitions WHERE account_id=a AND execution_id=e;
 IF FOUND THEN
  SELECT * INTO v_saved_seal FROM manga_web.windows_stage_cost_seals WHERE account_id=a AND execution_id=e;
  IF NOT FOUND OR v_transition.disposition IS DISTINCT FROM 'LEGACY_EXACT' OR v_transition.old_rule IS DISTINCT FROM 'windows-stage-cost-0025' OR
   v_transition.seal_id IS DISTINCT FROM v_saved_seal.seal_id OR v_transition.seal_digest IS DISTINCT FROM v_saved_seal.seal_digest OR
   v_transition.old_raw_set_digest IS DISTINCT FROM v_saved_seal.raw_set_digest OR v_transition.old_originals_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(v_saved_seal.lookup_membership->'originals') OR
   v_transition.new_raw_set_digest IS DISTINCT FROM v_saved_seal.raw_set_digest OR v_transition.new_originals_digest IS DISTINCT FROM v_transition.old_originals_digest
  THEN RETURN NULL;END IF;
 END IF;

$top_text$);
 v_definition:=replace(v_definition,v_bottom,$bottom_text$

 IF v_transition.execution_id IS NOT NULL AND(
  manga_web.windows_native_cost_hash(manifest) IS DISTINCT FROM v_saved_seal.raw_set_digest OR
  (include_originals AND originals IS DISTINCT FROM v_saved_seal.lookup_membership->'originals'))
 THEN RETURN NULL;END IF;

$bottom_text$||v_bottom);
 EXECUTE v_definition;
END $install_guard$;

