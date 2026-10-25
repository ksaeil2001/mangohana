-- W4-B3-B: root와 각 체크포인트 scope의 원 권위를 따로 보존한다.
-- 승인된 기존 private helper 세 개만 교체한다. 공개 권한과 현재 작업 조건,
-- 단가, 테이블, grant, 기존 서명 검증 경계는 유지한다.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE OR REPLACE FUNCTION windows_stage_cost_owner(selector jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.windows_native_cost_roots%ROWTYPE;o jsonb;n integer;scope_row record;scope_context jsonb;validated_contexts jsonb[]:=ARRAY[]::jsonb[];validated_scopes jsonb[]:=ARRAY[]::jsonb[];scope_count integer:=0;original_scope jsonb;
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
 IF o-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR manga_web.windows_native_cost_owner_valid(o) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 FOR scope_row IN SELECT * FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id LIMIT 65 LOOP
  scope_count:=scope_count+1;IF scope_count>64 THEN RETURN NULL;END IF;
  IF (scope_row.protected_scope->'owner')-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR
   scope_row.protected_scope->>'scopeId' IS DISTINCT FROM scope_row.scope_id::text OR scope_row.protected_scope->>'scopeDigest' IS DISTINCT FROM scope_row.scope_digest OR
   NOT manga_web.windows_native_object(scope_row.protected_scope,ARRAY['version','scopeId','scopeDigest','owner','target','phase','validationTargetDigest']) OR
   scope_row.protected_scope->'version' IS DISTINCT FROM '1'::jsonb OR octet_length(scope_row.protected_scope::text)>16384 OR
   NOT manga_web.windows_native_cost_uuid(scope_row.protected_scope->>'scopeId') OR
   scope_row.scope_digest IS DISTINCT FROM manga_web.windows_native_cost_hash(scope_row.protected_scope-'scopeDigest') THEN RETURN NULL;END IF;
  IF scope_row.protected_scope->'target'->>'targetKind'='EXECUTION' THEN
   -- EXECUTION의 원 INPUT/BASIS와 root는 변경 불가하다. 같은 원 문맥만
   -- 호출 안에서 묶고, 추가 중복 기록은 아래 VOLATILE 종료 검증으로 거부한다.
   scope_context:=scope_row.protected_scope-'scopeId'-'scopeDigest';
   IF NOT(scope_context=ANY(validated_contexts)) THEN
    IF manga_web.windows_native_cost_scope_history_valid(scope_row.protected_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;
    validated_contexts:=array_append(validated_contexts,scope_context);validated_scopes:=array_append(validated_scopes,scope_row.protected_scope);
   END IF;
  ELSE
   -- CHECKPOINT는 가변 checkpoint/request_steps를 읽으므로 매 행 검증한다.
   IF manga_web.windows_native_cost_scope_history_valid(scope_row.protected_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;
  END IF;
 END LOOP;
 FOREACH original_scope IN ARRAY validated_scopes LOOP
  IF manga_web.windows_native_cost_scope_history_valid(original_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 END LOOP;
 RETURN o;
END $$;

CREATE OR REPLACE FUNCTION windows_stage_cost_original(owner jsonb,job uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid:=(owner->>'executionId')::uuid;v jsonb;items jsonb;cache_used boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_cache_uses cu
  JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id)
  JOIN manga_web.windows_native_cost_scopes sc ON sc.account_id=cc.account_id AND sc.scope_id=cc.scope_id AND sc.execution_id=cc.execution_id
  JOIN manga_web.native_result_candidates nc ON nc.account_id=cu.account_id AND nc.job_id=cu.job_id AND nc.protected_candidate=cu.protected_source->'candidate'
  JOIN manga_web.native_result_receipts nr ON nr.account_id=nc.account_id AND nr.candidate_id=nc.candidate_id AND nr.protected_receipt=cu.protected_source->'receipt'
  JOIN manga_web.native_job_intents ni ON ni.account_id=cu.account_id AND ni.job_id=cu.job_id AND ni.protected_intent=cu.protected_source->'intent'
  WHERE cu.account_id=a AND cc.execution_id=e AND cu.job_id=job AND ((sc.protected_scope->'owner')-'claim'-'validationAttemptRef')=owner-'claim'-'validationAttemptRef' AND manga_web.windows_native_cost_scope_history_valid(sc.protected_scope) IS TRUE AND cu.protected_source->>'origin'='CACHE'
   AND cu.protected_source->'candidate'->>'operationInputDigest'=cc.protected_call->>'operationInputDigest' AND cu.protected_source->'candidate'->>'kernelImplementationDigest'=cc.protected_call->>'kernelDigest') INTO cache_used;
 SELECT jsonb_agg(identity) INTO items FROM(SELECT jsonb_build_object(
  'key',CASE WHEN at.attempt_id IS NULL OR se.record_id IS NULL OR li.link_id IS NULL THEN NULL ELSE jsonb_build_object('binding',at.protected_binding,'expected',jsonb_build_object('recordId',se.record_id,'recordDigest',se.digest,'linkId',li.link_id,'linkDigest',li.digest)) END,
  'scopeRef',CASE WHEN sc.scope_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(sc.scope_id,sc.scope_digest) END,
  'callRef',CASE WHEN ca.call_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(ca.call_id,ca.call_digest) END,'componentId',bi.component_id,
  'sourceOperation',CASE WHEN op.evidence_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(op.evidence_id,op.evidence_digest) END,
  'sourceTermination',CASE WHEN te.evidence_id IS NULL THEN NULL ELSE manga_web.windows_native_cost_reference(te.evidence_id,te.evidence_digest) END,
  'classification',CASE WHEN bi.job_id IS NOT NULL AND ca.execution_id=e AND sc.execution_id=e AND ((sc.protected_scope->'owner')-'claim'-'validationAttemptRef')=owner-'claim'-'validationAttemptRef' AND manga_web.windows_native_cost_scope_history_valid(sc.protected_scope) IS TRUE AND ni.protected_intent=bi.protected_intent AND at.attempt_id IS NOT NULL AND se.record_id IS NOT NULL AND li.link_id IS NOT NULL AND op.evidence_id IS NOT NULL AND te.evidence_id IS NOT NULL THEN 'FRESH'
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

CREATE OR REPLACE FUNCTION windows_stage_cost_non_windows(work jsonb,owner jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid:=(owner->>'executionId')::uuid;s jsonb;r jsonb;f jsonb;proof jsonb;proof_kind text;fact_target text;all_refs jsonb:='[]';seen uuid[]:='{}';used uuid[]:='{}';matching integer;terminal_count integer;expected_refs jsonb;reference_group_keys jsonb[]:='{}';reference_group_refs jsonb[]:='{}';reference_group_key jsonb;reference_group_index integer;
 checkpoint_operation jsonb;checkpoint_scopes uuid[];required_native_jobs uuid[];native_jobs uuid[];checkpoint_attempt_count integer;checkpoint_attempt jsonb;checkpoint_target jsonb;
 sealed_native jsonb;native_candidate jsonb;native_job uuid;native_row record;native_key jsonb;native_bundle jsonb;native_identity jsonb;native_match_count integer;
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
     NOT manga_web.windows_native_object(proof->'value',ARRAY['version','operationId','attemptId','attemptDigest','validationVersion','targetDigest','sourceInputFingerprint','outputDigest','semantic','storage','native']) OR proof->'value'->'version' IS DISTINCT FROM '1'::jsonb OR proof->'value'->>'validationVersion' IS DISTINCT FROM 'checkpoint-validation-v1' OR jsonb_typeof(proof->'value'->'native') IS DISTINCT FROM 'array' OR jsonb_typeof(proof->'value'->'storage') IS DISTINCT FROM 'array' OR
     NOT manga_web.windows_native_object(proof->'value'->'semantic',ARRAY['eventId','kind','outcome']) OR proof->'value'->'semantic'->>'kind' IS DISTINCT FROM 'SEMANTIC_VALIDATION' OR proof->'value'->'semantic'->>'outcome' IS DISTINCT FROM 'RETURNED' OR proof->'value'->>'operationId' IS DISTINCT FROM s->>'sourceOperationId' OR proof->'value'->'semantic'->>'eventId' IS DISTINCT FROM s->>'sourceEventId' OR
     s->>'target' IS DISTINCT FROM 'QUANTITY' OR f->>'componentId' IS DISTINCT FROM s->>'componentId' OR f->>'captureDigest' IS DISTINCT FROM work->>'captureDigest' OR NOT EXISTS(
      SELECT 1 FROM manga_web.execution_evidence basis,LATERAL jsonb_array_elements(basis.protected_observation->'value'->'snapshot'->'components') rate WHERE basis.account_id=a AND basis.execution_id=e AND basis.kind='OPERATIONAL_COST_BASIS' AND basis.evidence_id::text=owner->'basisRef'->>'evidenceId' AND basis.evidence_digest=owner->'basisRef'->>'evidenceDigest' AND basis.protected_observation->'value'->>'captureDigest'=f->>'captureDigest' AND rate->>'componentId'=s->>'componentId' AND rate->>'kind'='RENDER' AND rate->>'unit'=f->>'unit') OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'value'->'storage') observed WHERE NOT manga_web.windows_native_object(observed,ARRAY['eventId','kind','assetId','sha256','bytesLength','outcome']) OR observed->>'kind' IS DISTINCT FROM 'OBJECT_READ' OR observed->>'outcome' IS DISTINCT FROM 'RETURNED' OR NOT EXISTS(
      SELECT 1 FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=a AND st.execution_id=e AND st.event_id::text=observed->>'eventId' AND st.protected_request->>'kind'='OBJECT_READ' AND st.protected_request->>'key'=a::text||'/'||(observed->>'assetId') AND en.protected_event->>'state'='RETURNED' AND en.protected_event->'observed'=jsonb_build_object('sha256',observed->>'sha256','bytesLength',observed->>'bytesLength') AND EXISTS(
       SELECT 1 FROM jsonb_array_elements(work->'sources') io_source WHERE io_source->>'sourceOperationId'=st.operation_id::text AND io_source->>'sourceEventId'=st.event_id::text))) THEN RETURN false;END IF;

    -- 제출 목록이 비어 있어도 원 DB의 scope/call/binding/CACHE_USE에서
    -- 필수 native 집합을 구한다. job 없이 등록된 call도 허용한다.
    checkpoint_operation:=proof->'value';native_jobs:='{}';
    IF jsonb_array_length(checkpoint_operation->'native')>64 THEN RETURN false;END IF;
    SELECT COALESCE(array_agg(sc.scope_id ORDER BY sc.scope_id),'{}'::uuid[]) INTO checkpoint_scopes
     FROM manga_web.windows_native_cost_scopes sc
     JOIN manga_web.execution_evidence av ON av.account_id=sc.account_id AND av.execution_id=sc.execution_id AND av.kind='CHECKPOINT_VALIDATION_ATTEMPT'
      AND av.evidence_id::text=sc.protected_scope->'owner'->'validationAttemptRef'->>'evidenceId'
      AND av.evidence_digest=sc.protected_scope->'owner'->'validationAttemptRef'->>'evidenceDigest'
     WHERE sc.account_id=a AND sc.execution_id=e AND sc.protected_scope->>'phase'='CHECKPOINT'
      AND ((sc.protected_scope->'owner')-'claim'-'validationAttemptRef')=owner-'claim'-'validationAttemptRef'
      AND sc.protected_scope->>'validationTargetDigest'=checkpoint_operation->>'targetDigest'
      AND av.protected_observation->'value'->>'attemptId'=checkpoint_operation->>'attemptId'
      AND av.protected_observation->'value'->>'attemptDigest'=checkpoint_operation->>'attemptDigest';
    SELECT COALESCE(array_agg(DISTINCT job_id ORDER BY job_id),'{}'::uuid[]) INTO required_native_jobs FROM(
     SELECT bi.job_id FROM manga_web.windows_native_cost_bindings bi
      JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id)
      WHERE bi.account_id=a AND bi.execution_id=e AND cc.execution_id=e AND cc.scope_id=ANY(checkpoint_scopes)
     UNION SELECT cu.job_id FROM manga_web.windows_native_cost_cache_uses cu
      JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id)
      WHERE cu.account_id=a AND cc.execution_id=e AND cc.scope_id=ANY(checkpoint_scopes)) actual_jobs;
    IF cardinality(required_native_jobs)>64 THEN RETURN false;END IF;
    IF jsonb_array_length(checkpoint_operation->'native')>0 OR cardinality(required_native_jobs)>0 THEN
     SELECT count(*),min(av.protected_observation::text)::jsonb INTO checkpoint_attempt_count,checkpoint_attempt
      FROM manga_web.execution_evidence av WHERE av.account_id=a AND av.execution_id=e AND av.kind='CHECKPOINT_VALIDATION_ATTEMPT'
       AND av.protected_observation->'value'->>'attemptId'=checkpoint_operation->>'attemptId'
       AND av.protected_observation->'value'->>'attemptDigest'=checkpoint_operation->>'attemptDigest';
     IF checkpoint_attempt_count<>1 OR cardinality(checkpoint_scopes)=0 OR
      manga_web.windows_native_cost_hash(checkpoint_attempt) IS DISTINCT FROM(
       SELECT av.evidence_digest FROM manga_web.execution_evidence av WHERE av.account_id=a AND av.execution_id=e AND av.kind='CHECKPOINT_VALIDATION_ATTEMPT'
        AND av.protected_observation->'value'->>'attemptId'=checkpoint_operation->>'attemptId' AND av.protected_observation->'value'->>'attemptDigest'=checkpoint_operation->>'attemptDigest') OR
      checkpoint_attempt->'value'->>'attemptDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash((checkpoint_attempt->'value')-'attemptDigest') OR
      checkpoint_attempt->'value'->>'consumerExecutionId' IS DISTINCT FROM e::text OR checkpoint_attempt->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' THEN RETURN false;END IF;
     SELECT count(*),min(value::text)::jsonb INTO checkpoint_attempt_count,checkpoint_target
      FROM jsonb_array_elements(checkpoint_attempt->'value'->'targets') WHERE manga_web.windows_native_cost_hash(value)=checkpoint_operation->>'targetDigest';
     IF checkpoint_attempt_count<>1 OR checkpoint_target->>'inputFingerprint' IS DISTINCT FROM checkpoint_operation->>'sourceInputFingerprint' OR
      checkpoint_target->>'outputDigest' IS DISTINCT FROM checkpoint_operation->>'outputDigest' OR
      jsonb_array_length(checkpoint_operation->'storage') IS DISTINCT FROM jsonb_array_length(checkpoint_target->'assets') OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(checkpoint_target->'assets') dep WHERE
       (SELECT count(*) FROM jsonb_array_elements(checkpoint_operation->'storage') observed WHERE observed->>'assetId'=dep->>'assetId' AND observed->>'sha256'=dep->>'sha256' AND observed->>'bytesLength'=dep->>'bytesLength')<>1) OR
      EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scopes sc WHERE sc.account_id=a AND sc.scope_id=ANY(checkpoint_scopes)
       AND manga_web.windows_native_cost_scope_history_valid(sc.protected_scope) IS DISTINCT FROM true) THEN RETURN false;END IF;
    END IF;
    FOR sealed_native IN SELECT value FROM jsonb_array_elements(checkpoint_operation->'native') LOOP
     IF NOT manga_web.windows_native_object(sealed_native,ARRAY['candidate','receipt','intent','termination','origin']) OR
      (sealed_native->>'origin' IN('FRESH','CACHE')) IS DISTINCT FROM true OR
      manga_web.native_receipt_windows_candidate_valid(sealed_native->'candidate') IS DISTINCT FROM true OR
      manga_web.native_receipt_windows_receipt_valid(sealed_native->'receipt',sealed_native->'candidate') IS DISTINCT FROM true THEN RETURN false;END IF;
     native_candidate:=sealed_native->'candidate';native_job:=(native_candidate->>'jobId')::uuid;
     IF native_job=ANY(native_jobs) OR NOT(native_job=ANY(required_native_jobs)) THEN RETURN false;END IF;native_jobs:=array_append(native_jobs,native_job);
     SELECT nc.protected_candidate,nr.protected_receipt,ni.protected_intent,at.protected_binding INTO native_row
      FROM manga_web.native_result_candidates nc JOIN manga_web.native_result_receipts nr USING(account_id,candidate_id)
      JOIN manga_web.native_job_intents ni USING(account_id,job_id)
      JOIN manga_web.native_controller_attempts at ON at.account_id=ni.account_id AND at.job_id=ni.job_id
      WHERE nc.account_id=a AND nc.candidate_id=(native_candidate->>'candidateId')::uuid AND nc.job_id=native_job
       AND nc.protected_candidate=native_candidate AND nr.protected_receipt=sealed_native->'receipt' AND ni.protected_intent=sealed_native->'intent'
       AND nc.candidate_digest=encode(sha256(convert_to(nc.protected_candidate::text,'UTF8')),'hex')
       AND nr.receipt_digest=encode(sha256(convert_to(nr.protected_receipt::text,'UTF8')),'hex');
     IF NOT FOUND THEN RETURN false;END IF;
     native_key:=jsonb_build_object('binding',native_row.protected_binding,'expected',native_candidate->'windowsEvidenceRef');
     -- 같은 거래에서 상한을 둔 원 조회와 기존 DB link 검증 경계를 재사용한다.
     -- 과거 자료를 현재 receipt lookup으로 다시 허가하지 않는다.
     WITH bounded_windows_native_evidence_lookup AS MATERIALIZED(SELECT manga_web.windows_native_evidence_lookup(native_key) value)
      SELECT CASE WHEN octet_length(value::text)<=1572864 THEN value ELSE NULL END INTO native_bundle FROM bounded_windows_native_evidence_lookup;
     IF native_bundle IS NULL OR native_bundle->'state'->'facts'->'rawResult'='null'::jsonb OR
      native_bundle->'state'->'facts'->'goGrantRef'='null'::jsonb OR
      jsonb_array_length(native_bundle->'state'->'facts'->'observations')<>2 OR
      sealed_native->'termination' IS DISTINCT FROM((native_bundle->'state'->'facts'->'observations'->1->'value'->'termination')-'isolation') THEN RETURN false;END IF;
     IF native_bundle->'original'->>'sourceExecutionId' IS DISTINCT FROM checkpoint_target->>'sourceExecutionId' OR
      native_bundle->'original'->>'sourceInputEvidenceId' IS DISTINCT FROM checkpoint_target->'input'->>'evidenceId' OR
      (native_bundle->'state'->'facts'->'input')-'value' IS DISTINCT FROM checkpoint_target->'input' OR
      native_bundle->'state'->'facts'->'input'->>'evidenceDigest' IS DISTINCT FROM checkpoint_target->>'inputFingerprint' OR
      native_bundle->'state'->'facts'->'input'->'value'->>'inputDigest' IS DISTINCT FROM checkpoint_target->>'inputDigest' OR
      (CASE WHEN jsonb_typeof(native_bundle->'state'->'facts'->'basis')='object' THEN (native_bundle->'state'->'facts'->'basis')-'value' ELSE 'null'::jsonb END) IS DISTINCT FROM checkpoint_target->'basis'
      THEN RETURN false;END IF;
     native_identity:=manga_web.windows_stage_cost_original(owner,native_job);
     IF native_identity->'key' IS DISTINCT FROM native_key OR (native_identity->>'classification' IN('FRESH','CACHE')) IS DISTINCT FROM true THEN RETURN false;END IF;
     -- 같은 metadata의 여러 job을 허용하고 실제 call 각각의 관계를 확인한다.
     -- CPU 원 귀속이 FRESH여도 현재 OP의 CACHE origin은 CACHE_USE로 판단한다.
     SELECT count(*) INTO native_match_count FROM manga_web.windows_native_cost_calls cc
      JOIN manga_web.windows_native_cost_scopes sc ON sc.account_id=cc.account_id AND sc.scope_id=cc.scope_id AND sc.execution_id=cc.execution_id
      WHERE cc.account_id=a AND cc.execution_id=e AND cc.scope_id=ANY(checkpoint_scopes)
       AND cc.protected_call->>'callDigest'=cc.call_digest AND cc.call_digest=manga_web.windows_native_cost_hash(cc.protected_call-'callDigest')
       AND cc.protected_call-'callDigest'=jsonb_build_object('version',1,'callId',cc.call_id,'scopeId',sc.scope_id,'scopeDigest',sc.scope_digest,
        'task',native_row.protected_intent->>'task','taskVersion',native_row.protected_intent->>'taskVersion','profileDigest',native_row.protected_intent->>'profileDigest',
        'kernelDigest',native_candidate->>'kernelImplementationDigest','operationInputDigest',native_candidate->>'operationInputDigest','componentId',cc.protected_call->>'componentId')
       AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_roots root,LATERAL jsonb_array_elements(root.components) component
        WHERE root.account_id=a AND root.execution_id=e AND component->>'task'=cc.protected_call->>'task' AND component->>'componentId'=cc.protected_call->>'componentId')
       AND CASE WHEN sealed_native->>'origin'='FRESH' THEN EXISTS(
        SELECT 1 FROM manga_web.windows_native_cost_bindings bi WHERE bi.account_id=a AND bi.execution_id=e AND bi.call_id=cc.call_id AND bi.job_id=native_job
         AND bi.protected_intent=sealed_native->'intent' AND bi.component_id=cc.protected_call->>'componentId'
         AND native_identity->>'classification'='FRESH'
         AND native_identity->'scopeRef'=manga_web.windows_native_cost_reference(sc.scope_id,sc.scope_digest)
         AND native_identity->'callRef'=manga_web.windows_native_cost_reference(cc.call_id,cc.call_digest))
       ELSE EXISTS(SELECT 1 FROM manga_web.windows_native_cost_cache_uses cu WHERE cu.account_id=a AND cu.call_id=cc.call_id AND cu.job_id=native_job
        AND cu.protected_source=sealed_native AND cu.evidence_digest=manga_web.windows_native_cost_hash(jsonb_build_object('callId',cu.call_id,'source',cu.protected_source))) END;
     IF native_match_count<1 THEN RETURN false;END IF;
    END LOOP;
    SELECT COALESCE(array_agg(job ORDER BY job),'{}'::uuid[]) INTO native_jobs FROM unnest(native_jobs) job;
    IF native_jobs IS DISTINCT FROM required_native_jobs THEN RETURN false;END IF;
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
