-- W4-B1: immutable owner attribution and bounded invocation/I/O authority.
-- No price, charge allocation, work-set seal or operational collector is created.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE TABLE windows_native_cost_enrollments(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,input_evidence_id uuid NOT NULL,input_fingerprint text NOT NULL,
 input_xact xid8 NOT NULL,evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,execution_id),UNIQUE(account_id,input_evidence_id),
 FOREIGN KEY(account_id,input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id));
CREATE TABLE windows_native_cost_roots(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,owner_identity jsonb NOT NULL,components jsonb NOT NULL,components_digest text NOT NULL,
 evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,execution_id),FOREIGN KEY(account_id,execution_id) REFERENCES windows_native_cost_enrollments(account_id,execution_id));
CREATE TABLE windows_native_cost_scopes(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,scope_id uuid NOT NULL,scope_digest text NOT NULL,protected_scope jsonb NOT NULL,
 created_at timestamptz NOT NULL,PRIMARY KEY(account_id,scope_id),
 FOREIGN KEY(account_id,execution_id) REFERENCES windows_native_cost_roots(account_id,execution_id));
CREATE TABLE windows_native_cost_calls(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,scope_id uuid NOT NULL,call_id uuid NOT NULL,call_digest text NOT NULL,protected_call jsonb NOT NULL,
 created_at timestamptz NOT NULL,PRIMARY KEY(account_id,call_id),FOREIGN KEY(account_id,scope_id) REFERENCES windows_native_cost_scopes(account_id,scope_id));
CREATE TABLE windows_native_cost_scope_ends(
 account_id uuid NOT NULL,scope_id uuid NOT NULL,protected_end jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,scope_id),FOREIGN KEY(account_id,scope_id) REFERENCES windows_native_cost_scopes(account_id,scope_id));
CREATE TABLE windows_native_cost_bindings(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,call_id uuid NOT NULL,job_id uuid NOT NULL,protected_intent jsonb NOT NULL,protected_capacity jsonb NOT NULL,
 component_id text NOT NULL,evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,job_id),FOREIGN KEY(account_id,call_id) REFERENCES windows_native_cost_calls(account_id,call_id),
 FOREIGN KEY(account_id,job_id) REFERENCES native_job_intents(account_id,job_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE windows_native_cost_io_starts(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,call_id uuid NOT NULL,operation_id uuid NOT NULL,event_id uuid NOT NULL,
 protected_request jsonb NOT NULL,principal text NOT NULL,job_id uuid,read_context jsonb,
 evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,operation_id),UNIQUE(account_id,event_id),FOREIGN KEY(account_id,call_id) REFERENCES windows_native_cost_calls(account_id,call_id));
CREATE TABLE windows_native_cost_io_ends(
 account_id uuid NOT NULL,operation_id uuid NOT NULL,protected_event jsonb NOT NULL,evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,operation_id),FOREIGN KEY(account_id,operation_id) REFERENCES windows_native_cost_io_starts(account_id,operation_id));
CREATE TABLE windows_native_cost_cache_uses(
 account_id uuid NOT NULL,call_id uuid NOT NULL,job_id uuid NOT NULL,protected_source jsonb NOT NULL,
 evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,call_id,job_id),FOREIGN KEY(account_id,call_id) REFERENCES windows_native_cost_calls(account_id,call_id));
CREATE TABLE windows_native_cost_result_queries(
 account_id uuid NOT NULL,execution_id uuid NOT NULL,call_id uuid NOT NULL,job_id uuid NOT NULL,request_id uuid NOT NULL,request_digest text NOT NULL,
 protected_request jsonb NOT NULL,authority jsonb NOT NULL,evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,call_id) REFERENCES windows_native_cost_calls(account_id,call_id));
CREATE TABLE windows_native_cost_result_claims(
 account_id uuid NOT NULL,request_id uuid NOT NULL,claim_id uuid NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,request_id),UNIQUE(account_id,claim_id),FOREIGN KEY(account_id,request_id) REFERENCES windows_native_cost_result_queries(account_id,request_id));
CREATE TABLE windows_native_cost_result_acks(
 account_id uuid NOT NULL,request_id uuid NOT NULL,response_ref jsonb NOT NULL,evidence_id uuid NOT NULL,evidence_digest text NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES windows_native_cost_result_queries(account_id,request_id));

DO $tables$ DECLARE t text; BEGIN
 FOR t IN SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND c.relkind='r' AND c.relname LIKE 'windows_native_cost_%' LOOP
  EXECUTE format('REVOKE ALL ON TABLE manga_web.%I FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator',t);
  EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE OR TRUNCATE ON manga_web.%I FOR EACH STATEMENT EXECUTE FUNCTION manga_web.immutable_native_job_record()',t);
 END LOOP;
END $tables$;

CREATE FUNCTION windows_native_cost_uuid(v text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT COALESCE(v~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)$$;
CREATE FUNCTION windows_native_cost_ref(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT COALESCE(manga_web.windows_native_object(v,ARRAY['evidenceId','evidenceDigest']) AND manga_web.windows_native_cost_uuid(v->>'evidenceId') AND v->>'evidenceDigest'~'^[a-f0-9]{64}$',false)$$;
CREATE FUNCTION windows_native_cost_reference(id uuid,digest text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT jsonb_build_object('evidenceId',id,'evidenceDigest',digest)$$;
-- INPUT permits fractional geometry/settings. Never feed its body into the
-- integer-only Windows canonicalizer. This encoder retains ECMAScript number
-- spelling, including its fixed/scientific notation thresholds.
CREATE FUNCTION windows_native_cost_canonical(p jsonb,depth integer DEFAULT 0) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE s text; n double precision; exponent integer; mantissa text;
BEGIN
 IF p IS NULL OR depth>64 OR octet_length(p::text)>1048576 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_BOUNDS';END IF;
 CASE jsonb_typeof(p)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||manga_web.windows_native_cost_canonical(value,depth+1),',' ORDER BY key COLLATE "C"),'')||'}' INTO s FROM jsonb_each(p);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(manga_web.windows_native_cost_canonical(value,depth+1),',' ORDER BY ordinal),'')||']' INTO s FROM jsonb_array_elements(p) WITH ORDINALITY a(value,ordinal);
 WHEN 'number' THEN
  n:=p::text::double precision;IF n=0 THEN RETURN '0';END IF;s:=n::text;
  IF abs(n)>=0.000001 AND abs(n)<1e21 THEN s:=s::numeric::text;IF position('.' IN s)>0 THEN s:=rtrim(rtrim(s,'0'),'.');END IF;
  ELSIF position('e' IN s)>0 THEN mantissa:=split_part(s,'e',1);exponent:=split_part(s,'e',2)::integer;s:=mantissa||'e'||CASE WHEN exponent>=0 THEN '+' ELSE '-' END||abs(exponent)::text;END IF;
 ELSE s:=p::text;END CASE;RETURN s;
END $$;
CREATE FUNCTION windows_native_cost_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT encode(sha256(convert_to(manga_web.windows_native_cost_canonical(v),'UTF8')),'hex')$$;
CREATE FUNCTION windows_native_cost_worker() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN IF manga_web.native_job_caller() IS DISTINCT FROM 'trio_web_worker' OR manga_web.current_account() IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_COST_ACCESS_DENIED';END IF;END $$;
CREATE FUNCTION windows_native_cost_lock_owner(execution uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
 PERFORM 1 FROM manga_web.accounts WHERE account_id=manga_web.current_account() FOR UPDATE;
 PERFORM 1 FROM manga_web.executions WHERE account_id=manga_web.current_account() AND execution_id=execution FOR UPDATE;
 PERFORM 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=manga_web.current_account() AND execution_id=execution FOR UPDATE;
 PERFORM 1 FROM manga_web.windows_native_cost_roots WHERE account_id=manga_web.current_account() AND execution_id=execution FOR UPDATE;
END $$;
CREATE FUNCTION windows_native_cost_owner_valid(owner jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE i manga_web.execution_evidence%ROWTYPE;b manga_web.execution_evidence%ROWTYPE;a uuid:=manga_web.current_account();
BEGIN
 IF NOT manga_web.windows_native_object(owner,ARRAY['executionId','inputEvidenceId','inputFingerprint','basisRef','claim','validationAttemptRef']) OR
  NOT manga_web.windows_native_cost_uuid(owner->>'executionId') OR NOT manga_web.windows_native_cost_uuid(owner->>'inputEvidenceId') OR NOT manga_web.windows_native_cost_ref(owner->'basisRef') OR
  NOT manga_web.windows_native_object(owner->'claim',ARRAY['generation','ownerId','workItemId']) OR NOT manga_web.windows_native_cost_uuid(owner->'claim'->>'ownerId') OR NOT manga_web.windows_native_cost_uuid(owner->'claim'->>'workItemId') OR (owner->'claim'->>'generation'~'^(0|[1-9][0-9]{0,18})$') IS DISTINCT FROM true OR
  (owner->'validationAttemptRef'<>'null'::jsonb AND NOT manga_web.windows_native_cost_ref(owner->'validationAttemptRef')) THEN RETURN false;END IF;
 SELECT * INTO i FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=(owner->>'executionId')::uuid AND evidence_id=(owner->>'inputEvidenceId')::uuid AND kind='INPUT';
 IF NOT FOUND OR i.evidence_digest IS DISTINCT FROM owner->>'inputFingerprint' OR manga_web.windows_native_cost_hash(i.protected_observation) IS DISTINCT FROM i.evidence_digest OR
  EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=i.execution_id AND kind='INPUT' AND evidence_id<>i.evidence_id) THEN RETURN false;END IF;
 SELECT * INTO b FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=i.execution_id AND evidence_id=(owner->'basisRef'->>'evidenceId')::uuid AND kind='OPERATIONAL_COST_BASIS';
 RETURN FOUND AND b.evidence_digest=owner->'basisRef'->>'evidenceDigest' AND manga_web.windows_native_cost_hash(b.protected_observation)=b.evidence_digest AND
 b.protected_observation->>'executionId'=i.execution_id::text AND b.protected_observation->>'accountId'=a::text AND b.protected_observation->>'inputFingerprint'=i.evidence_digest AND
 b.protected_observation->>'inputDigest'=i.protected_observation->>'inputDigest' AND b.protected_observation->'value'->'capture'->>'inputFingerprint'=i.evidence_digest AND
 b.protected_observation->'value'->'capture'->>'executionId'=i.execution_id::text AND b.protected_observation->'value'->'capture'->>'accountId'=a::text AND
 b.protected_observation->'value'->'capture'->>'inputDigest'=i.protected_observation->>'inputDigest' AND
 b.protected_observation->'value'->>'captureDigest'=b.protected_observation->'value'->'capture'->>'captureDigest' AND
 manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'kind','FULL_STAGE_COST_CAPTURE','capture',(b.protected_observation->'value'->'capture')-'captureDigest'))=b.protected_observation->'value'->>'captureDigest' AND
 (b.protected_observation->'value'->'snapshot'='null'::jsonb OR manga_web.windows_native_cost_hash(b.protected_observation->'value'->'snapshot')=b.protected_observation->'value'->>'snapshotDigest') AND
 NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=i.execution_id AND kind='OPERATIONAL_COST_BASIS' AND evidence_id<>b.evidence_id);
END $$;
CREATE FUNCTION windows_native_cost_owner_current(owner jsonb,capture jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();request uuid;sampled timestamptz;
BEGIN
 PERFORM manga_web.windows_native_cost_lock_owner((owner->>'executionId')::uuid);
 IF manga_web.windows_native_cost_owner_valid(owner) IS DISTINCT FROM true THEN RETURN false;END IF;
 SELECT request_id INTO request FROM manga_web.executions WHERE account_id=a AND execution_id=(owner->>'executionId')::uuid;
 PERFORM 1 FROM manga_web.processing_requests WHERE account_id=a AND request_id=request FOR UPDATE;
 PERFORM 1 FROM manga_web.workspace_contexts WHERE account_id=a AND context_id=(capture->>'contextId')::uuid FOR UPDATE;
 PERFORM 1 FROM manga_web.work_items WHERE account_id=a AND work_item_id=(owner->'claim'->>'workItemId')::uuid FOR UPDATE;
 IF manga_web.windows_native_owner_current(capture) IS DISTINCT FROM true THEN RETURN false;END IF;sampled:=clock_timestamp();
 RETURN EXISTS(SELECT 1 FROM manga_web.executions e JOIN manga_web.processing_requests r USING(account_id,request_id) JOIN manga_web.work_items w ON w.account_id=e.account_id AND w.work_item_id=(owner->'claim'->>'workItemId')::uuid
 WHERE e.account_id=a AND e.execution_id=(owner->>'executionId')::uuid AND e.claim_generation::text=owner->'claim'->>'generation' AND w.claim_generation::text=owner->'claim'->>'generation' AND w.claim_owner=owner->'claim'->>'ownerId' AND w.state='CLAIMED' AND w.lease_until>sampled AND
 ((w.kind IN('DISPATCH','APPLY') AND w.target_ref->>'requestId'=r.request_id::text) OR(w.kind='RECONCILE' AND w.target_ref->>'executionId'=e.execution_id::text)) AND r.terminal_at IS NULL AND r.state IN('ACCEPTED','ACTIVE','WAITING') AND
 r.context_id::text=capture->>'contextId' AND r.context_generation::text=capture->>'contextGeneration' AND
 EXISTS(SELECT 1 FROM manga_web.active_page_requests p WHERE p.account_id=a AND p.request_id=r.request_id AND p.page_lineage_id=r.page_lineage_id) AND
 EXISTS(SELECT 1 FROM manga_web.workspace_pages p WHERE p.account_id=a AND p.context_id=r.context_id AND p.page_lineage_id=r.page_lineage_id AND NOT p.excluded AND p.result_revision=r.expected_result_revision));
END $$;
CREATE FUNCTION windows_native_cost_enroll_input(input_ref jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();i manga_web.execution_evidence%ROWTYPE;r manga_web.windows_native_cost_enrollments%ROWTYPE;id uuid:=gen_random_uuid();h text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF NOT manga_web.windows_native_cost_ref(input_ref) THEN RETURN NULL;END IF;
 PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
 SELECT * INTO i FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(input_ref->>'evidenceId')::uuid AND kind='INPUT';IF NOT FOUND OR i.evidence_digest IS DISTINCT FROM input_ref->>'evidenceDigest' THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(i.execution_id);
 SELECT * INTO r FROM manga_web.windows_native_cost_enrollments WHERE account_id=a AND execution_id=i.execution_id;
 IF FOUND THEN IF r.input_evidence_id=i.evidence_id AND r.input_fingerprint=i.evidence_digest THEN RETURN manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest);END IF;RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=i.evidence_id AND xmin::text=pg_current_xact_id()::text) OR manga_web.windows_native_cost_hash(i.protected_observation) IS DISTINCT FROM i.evidence_digest THEN RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'kind','WINDOWS_NATIVE_COST_ENROLLMENT','executionId',i.execution_id,'input',input_ref));
 INSERT INTO manga_web.windows_native_cost_enrollments VALUES(a,i.execution_id,i.evidence_id,i.evidence_digest,pg_current_xact_id(),id,h,clock_timestamp());RETURN manga_web.windows_native_cost_reference(id,h);
END $$;
CREATE FUNCTION windows_native_cost_activate(owner jsonb,components jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();r manga_web.windows_native_cost_roots%ROWTYPE;b jsonb;c jsonb;identity jsonb;id uuid:=gen_random_uuid();h text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_owner_valid(owner) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner((owner->>'executionId')::uuid);identity:=owner-'claim'-'validationAttemptRef';
 IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=a AND execution_id=(owner->>'executionId')::uuid AND input_evidence_id=(owner->>'inputEvidenceId')::uuid AND input_fingerprint=owner->>'inputFingerprint') THEN RETURN NULL;END IF;
 IF jsonb_typeof(components) IS DISTINCT FROM 'array' OR jsonb_array_length(components) NOT BETWEEN 1 AND 64 OR octet_length(components::text)>16384 THEN RETURN NULL;END IF;
 SELECT protected_observation->'value'->'snapshot' INTO b FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(owner->'basisRef'->>'evidenceId')::uuid;
 FOR c IN SELECT value FROM jsonb_array_elements(components) LOOP
  IF NOT manga_web.windows_native_object(c,ARRAY['task','componentId']) OR c->>'task' NOT IN('DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE') OR octet_length(c->>'componentId') NOT BETWEEN 1 AND 256 OR
   (SELECT count(*) FROM jsonb_array_elements(COALESCE(b->'components','[]')) rate WHERE rate->>'componentId'=c->>'componentId' AND rate->>'kind' IN('IMAGE','RENDER') AND rate->>'unit'='windows-job-cpu-second-v1')<>1 THEN RETURN NULL;END IF;
 END LOOP;
 IF(SELECT count(DISTINCT value->>'task') FROM jsonb_array_elements(components))<>jsonb_array_length(components) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=a AND execution_id=(owner->>'executionId')::uuid;
 IF FOUND THEN IF r.owner_identity=identity AND r.components=components THEN RETURN manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest);END IF;RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'owner',identity,'components',components));
 INSERT INTO manga_web.windows_native_cost_roots VALUES(a,(owner->>'executionId')::uuid,identity,components,manga_web.windows_native_cost_hash(components),id,h,clock_timestamp());RETURN manga_web.windows_native_cost_reference(id,h);
END $$;

CREATE FUNCTION windows_native_cost_scope_check(s jsonb,current_required boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();o jsonb:=s->'owner';t jsonb:=s->'target';r manga_web.windows_native_cost_roots%ROWTYPE;i manga_web.execution_evidence%ROWTYPE;v manga_web.execution_evidence%ROWTYPE;attempt jsonb;candidate jsonb;source manga_web.execution_evidence%ROWTYPE;cp manga_web.checkpoints%ROWTYPE;request uuid;expected text;
BEGIN
 IF NOT manga_web.windows_native_object(s,ARRAY['version','scopeId','scopeDigest','owner','target','phase','validationTargetDigest']) OR s->'version'<>'1'::jsonb OR octet_length(s::text)>16384 OR NOT manga_web.windows_native_cost_uuid(s->>'scopeId') OR s->>'scopeDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(s-'scopeDigest') OR (s->>'phase' IN('INPUT','CHECKPOINT','VALIDATION','LOOKUP','DISPATCH')) IS DISTINCT FROM true OR
 NOT manga_web.windows_native_object(t,ARRAY['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim','sourceInput']) OR t->>'accountId' IS DISTINCT FROM a::text OR t->'claim' IS DISTINCT FROM o->'claim' OR NOT manga_web.native_job_valid_tuple(t) OR NOT manga_web.native_capacity_source_valid(t->'sourceInput') THEN RETURN false;END IF;
 IF manga_web.windows_native_cost_owner_valid(o) IS DISTINCT FROM true THEN RETURN false;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=a AND execution_id=(o->>'executionId')::uuid;
 IF NOT FOUND OR r.owner_identity IS DISTINCT FROM o-'claim'-'validationAttemptRef' THEN RETURN false;END IF;
 SELECT * INTO i FROM manga_web.execution_evidence WHERE account_id=a AND evidence_id=(o->>'inputEvidenceId')::uuid;request:=(i.protected_observation->>'requestId')::uuid;
 IF t->>'targetKind'='EXECUTION' THEN
  IF s->>'phase'='CHECKPOINT' OR o->'validationAttemptRef'<>'null'::jsonb OR s->'validationTargetDigest'<>'null'::jsonb OR t->>'targetId' IS DISTINCT FROM o->>'executionId' OR t->'sourceInput' IS DISTINCT FROM jsonb_build_object('executionId',i.execution_id,'inputEvidenceId',i.evidence_id,'stageInputDigest',i.protected_observation->>'inputDigest') THEN RETURN false;END IF;
  expected:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'phase',s->>'phase','currentRequestId',request,'originExecutionId',i.execution_id,'inputFingerprint',i.evidence_digest,'outputDigest',NULL));
 ELSE
  IF t->>'targetKind' IS DISTINCT FROM 'REQUEST_CHECKPOINT' OR s->>'phase'<>'CHECKPOINT' OR t->>'targetId' IS DISTINCT FROM request::text OR NOT manga_web.windows_native_cost_ref(o->'validationAttemptRef') OR s->>'validationTargetDigest'!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  SELECT * INTO v FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=i.execution_id AND evidence_id=(o->'validationAttemptRef'->>'evidenceId')::uuid AND kind='CHECKPOINT_VALIDATION_ATTEMPT';
  IF NOT FOUND OR v.evidence_digest IS DISTINCT FROM o->'validationAttemptRef'->>'evidenceDigest' OR manga_web.windows_native_cost_hash(v.protected_observation) IS DISTINCT FROM v.evidence_digest OR v.protected_observation->>'inputFingerprint' IS DISTINCT FROM i.evidence_digest THEN RETURN false;END IF;attempt:=v.protected_observation->'value';
  IF attempt->>'consumerExecutionId' IS DISTINCT FROM i.execution_id::text OR attempt->>'consumerRequestId' IS DISTINCT FROM request::text OR attempt->>'inputEvidenceId' IS DISTINCT FROM i.evidence_id::text OR attempt->>'inputEvidenceDigest' IS DISTINCT FROM i.evidence_digest OR attempt->>'basisEvidenceId' IS DISTINCT FROM o->'basisRef'->>'evidenceId' OR attempt->>'basisEvidenceDigest' IS DISTINCT FROM o->'basisRef'->>'evidenceDigest' OR attempt->>'claimGeneration' IS DISTINCT FROM o->'claim'->>'generation' OR attempt->'owner' IS DISTINCT FROM t->'protectedOwnerCapture' OR attempt->>'purpose' NOT IN('PRE_DISPATCH','FINAL_COMMIT') OR attempt->>'attemptDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(attempt-'attemptDigest') THEN RETURN false;END IF;
  IF(SELECT count(*) FROM jsonb_array_elements(attempt->'targets') x WHERE manga_web.windows_native_cost_hash(x)=s->>'validationTargetDigest')<>1 THEN RETURN false;END IF;
  SELECT value INTO candidate FROM jsonb_array_elements(attempt->'targets') x(value) WHERE manga_web.windows_native_cost_hash(value)=s->>'validationTargetDigest';
  SELECT * INTO source FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=(candidate->>'sourceExecutionId')::uuid AND evidence_id=(candidate->'input'->>'evidenceId')::uuid AND kind='INPUT';
  IF NOT FOUND OR source.evidence_digest IS DISTINCT FROM candidate->'input'->>'evidenceDigest' OR source.evidence_digest IS DISTINCT FROM candidate->>'inputFingerprint' OR manga_web.windows_native_cost_hash(source.protected_observation) IS DISTINCT FROM source.evidence_digest OR t->'sourceInput' IS DISTINCT FROM jsonb_build_object('executionId',source.execution_id,'inputEvidenceId',source.evidence_id,'stageInputDigest',source.protected_observation->>'inputDigest') THEN RETURN false;END IF;
  SELECT * INTO cp FROM manga_web.checkpoints WHERE account_id=a AND checkpoint_id=(candidate->>'checkpointId')::uuid AND execution_id=source.execution_id;
  IF NOT FOUND OR cp.verification_state<>'VERIFIED' OR cp.dependency_digest IS DISTINCT FROM source.protected_observation->>'inputDigest' OR candidate->>'outputDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(cp.output_envelope) OR candidate->>'sourceRequestId' IS DISTINCT FROM source.protected_observation->>'requestId' OR
   NOT EXISTS(SELECT 1 FROM manga_web.request_steps rs WHERE rs.account_id=a AND rs.request_id=request AND (rs.reuse_checkpoint_id=cp.checkpoint_id OR(rs.current_execution_id=cp.execution_id AND rs.reuse_checkpoint_id IS NULL))) OR
   NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=source.execution_id AND ev.kind='OUTCOME' AND manga_web.windows_native_cost_hash(ev.protected_observation)=candidate->>'outputDigest') THEN RETURN false;END IF;
  expected:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'phase','CHECKPOINT','currentRequestId',request,'originExecutionId',source.execution_id,'inputFingerprint',source.evidence_digest,'outputDigest',candidate->>'outputDigest'));
 END IF;
 IF t->>'semanticCaptureDigest' IS DISTINCT FROM expected THEN RETURN false;END IF;
 IF NOT current_required THEN RETURN true;END IF;
 RETURN manga_web.windows_native_cost_owner_current(o,t->'protectedOwnerCapture');
END $$;
CREATE FUNCTION windows_native_cost_scope_valid(s jsonb) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT manga_web.windows_native_cost_scope_check(s,true)$$;
CREATE FUNCTION windows_native_cost_scope_history_valid(s jsonb) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT manga_web.windows_native_cost_scope_check(s,false)$$;
CREATE FUNCTION windows_native_cost_open(execution uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT NOT EXISTS(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=manga_web.current_account() AND execution_id=execution AND kind='OPERATIONAL_COST_CLOSURE')$$;
CREATE FUNCTION windows_native_cost_begin(owner jsonb,scope jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();r manga_web.windows_native_cost_scopes%ROWTYPE;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF NOT manga_web.windows_native_cost_uuid(owner->>'executionId') THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner((owner->>'executionId')::uuid);
 SELECT * INTO r FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=(scope->>'scopeId')::uuid;
 IF FOUND THEN IF r.protected_scope=scope AND scope->'owner'=owner THEN RETURN r.protected_scope;END IF;RETURN NULL;END IF;
 IF scope->'owner' IS DISTINCT FROM owner OR manga_web.windows_native_cost_scope_valid(scope) IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_open((owner->>'executionId')::uuid) OR(SELECT count(*) FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND execution_id=(owner->>'executionId')::uuid)>=64 THEN RETURN NULL;END IF;
 INSERT INTO manga_web.windows_native_cost_scopes VALUES(a,(owner->>'executionId')::uuid,(scope->>'scopeId')::uuid,scope->>'scopeDigest',scope,clock_timestamp());RETURN scope;
END $$;
CREATE FUNCTION windows_native_cost_lock_call(id uuid,current_required boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE c manga_web.windows_native_cost_calls%ROWTYPE;s manga_web.windows_native_cost_scopes%ROWTYPE;
BEGIN
 SELECT * INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=manga_web.current_account() AND call_id=id;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(c.execution_id);
 SELECT * INTO s FROM manga_web.windows_native_cost_scopes WHERE account_id=c.account_id AND scope_id=c.scope_id;
 IF current_required AND (manga_web.windows_native_cost_scope_valid(s.protected_scope) IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_open(c.execution_id)) THEN RETURN NULL;END IF;
 IF current_required THEN PERFORM 1 FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;PERFORM 1 FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;END IF;
 PERFORM 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=c.account_id AND scope_id=c.scope_id FOR UPDATE;
 PERFORM 1 FROM manga_web.windows_native_cost_calls WHERE account_id=c.account_id AND call_id=id FOR UPDATE;
 IF current_required AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scope_ends WHERE account_id=c.account_id AND scope_id=c.scope_id) THEN RETURN NULL;END IF;
 RETURN s.protected_scope;
END $$;
CREATE FUNCTION windows_native_cost_register_call(scope uuid,call jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();s manga_web.windows_native_cost_scopes%ROWTYPE;r manga_web.windows_native_cost_calls%ROWTYPE;components jsonb;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();SELECT * INTO s FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=scope;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(s.execution_id);
 IF NOT manga_web.windows_native_object(call,ARRAY['version','callId','callDigest','scopeId','scopeDigest','task','taskVersion','profileDigest','kernelDigest','operationInputDigest','componentId']) OR octet_length(call::text)>4096 OR call->'version'<>'1'::jsonb OR NOT manga_web.windows_native_cost_uuid(call->>'callId') OR call->>'callDigest' IS DISTINCT FROM manga_web.windows_native_cost_hash(call-'callDigest') OR call->>'scopeId' IS DISTINCT FROM s.scope_id::text OR call->>'scopeDigest' IS DISTINCT FROM s.scope_digest OR call->>'taskVersion' IS DISTINCT FROM 'native-pure-v1' OR NOT manga_web.windows_native_shape(call->'profileDigest','"hex"') OR NOT manga_web.windows_native_shape(call->'kernelDigest','"hex"') OR NOT manga_web.windows_native_shape(call->'operationInputDigest','"hex"') THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=(call->>'callId')::uuid;
 IF FOUND THEN IF r.protected_call=call THEN RETURN call;END IF;RETURN NULL;END IF;
 IF manga_web.windows_native_cost_scope_valid(s.protected_scope) IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_open(s.execution_id) THEN RETURN NULL;END IF;
 PERFORM 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=scope FOR UPDATE;
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scope_ends WHERE account_id=a AND scope_id=scope) OR(SELECT count(*) FROM manga_web.windows_native_cost_calls WHERE account_id=a AND scope_id=scope)>=64 OR(SELECT count(*) FROM manga_web.windows_native_cost_calls WHERE account_id=a AND execution_id=s.execution_id)>=256 THEN RETURN NULL;END IF;
 SELECT root.components INTO components FROM manga_web.windows_native_cost_roots root WHERE root.account_id=a AND root.execution_id=s.execution_id;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(components) x WHERE x->>'task'=call->>'task' AND x->>'componentId'=call->>'componentId') THEN RETURN NULL;END IF;
 INSERT INTO manga_web.windows_native_cost_calls VALUES(a,s.execution_id,scope,(call->>'callId')::uuid,call->>'callDigest',call,clock_timestamp());RETURN call;
END $$;
CREATE FUNCTION windows_native_cost_lookup(owner jsonb,"limit" integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE result jsonb;n integer;s manga_web.windows_native_cost_scopes%ROWTYPE;historical_scope jsonb;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF "limit" IS NULL OR "limit" NOT BETWEEN 1 AND 64 THEN RETURN NULL;END IF;
 IF manga_web.windows_native_object(owner,ARRAY['scopeId']) THEN
  IF NOT manga_web.windows_native_cost_uuid(owner->>'scopeId') THEN RETURN NULL;END IF;
  SELECT * INTO s FROM manga_web.windows_native_cost_scopes WHERE account_id=manga_web.current_account() AND scope_id=(owner->>'scopeId')::uuid;
  IF NOT FOUND THEN RETURN NULL;END IF;
  PERFORM manga_web.windows_native_cost_lock_owner(s.execution_id);
  IF manga_web.windows_native_cost_scope_history_valid(s.protected_scope) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_roots WHERE account_id=s.account_id AND execution_id=s.execution_id AND owner_identity=(s.protected_scope->'owner')-'claim'-'validationAttemptRef') THEN RETURN NULL;END IF;
  RETURN s.protected_scope;
 END IF;
 IF manga_web.windows_native_cost_owner_valid(owner) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner((owner->>'executionId')::uuid);
 IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_roots WHERE account_id=manga_web.current_account() AND execution_id=(owner->>'executionId')::uuid AND owner_identity=owner-'claim'-'validationAttemptRef') THEN RETURN NULL;END IF;
 SELECT count(*),jsonb_build_object('scopes',COALESCE(jsonb_agg(protected_scope ORDER BY scope_id),'[]'::jsonb)) INTO n,result FROM(SELECT * FROM manga_web.windows_native_cost_scopes WHERE account_id=manga_web.current_account() AND execution_id=(owner->>'executionId')::uuid ORDER BY scope_id LIMIT "limit"+1) s;
 IF n>"limit" OR octet_length(result::text)>1048576 THEN RETURN NULL;END IF;
 FOR historical_scope IN SELECT value FROM jsonb_array_elements(result->'scopes') LOOP IF manga_web.windows_native_cost_scope_history_valid(historical_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;END LOOP;RETURN result;
END $$;

-- Save only the unchanged validated cores needed by the explicitly scoped API.
-- CREATE OR REPLACE below preserves existing public OIDs/owners/search_path/ACL.
DO $cores$ DECLARE name text;signature text;definition text; BEGIN
 FOR name,signature IN SELECT * FROM(VALUES
 ('native_capacity_create_intent','jsonb,boolean,jsonb'),('native_receipt_lookup','jsonb'),('native_receipt_prepare','jsonb,jsonb'),('native_receipt_register_asset','uuid,text,jsonb,text,jsonb'),('native_receipt_verify','uuid,jsonb,jsonb'),('native_controller_raw_lookup','jsonb,uuid,text,text')) x(name,signature) LOOP
  SELECT pg_get_functiondef(to_regprocedure('manga_web.'||name||'('||signature||')')) INTO definition;
  EXECUTE replace(definition,'FUNCTION manga_web.'||name||'(','FUNCTION manga_web.windows_native_cost_'||name||'_core(');
 END LOOP;
END $cores$;
CREATE FUNCTION windows_native_cost_admit(call uuid,intent jsonb,capacity jsonb,component text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();s jsonb;c manga_web.windows_native_cost_calls%ROWTYPE;b manga_web.windows_native_cost_bindings%ROWTYPE;decision jsonb;id uuid:=gen_random_uuid();h text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();SELECT source_scope.protected_scope INTO s FROM manga_web.windows_native_cost_calls source_call JOIN manga_web.windows_native_cost_scopes source_scope USING(account_id,scope_id) WHERE source_call.account_id=a AND source_call.call_id=call;IF s IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_COST_SCOPE_UNCONFIRMED');END IF;
 PERFORM manga_web.windows_native_cost_lock_owner((s->'owner'->>'executionId')::uuid);
 SELECT * INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=call;
 IF NOT manga_web.native_job_valid_tuple(intent) OR intent->>'task' IS DISTINCT FROM c.protected_call->>'task' OR intent->>'taskVersion' IS DISTINCT FROM c.protected_call->>'taskVersion' OR intent->>'profileDigest' IS DISTINCT FROM c.protected_call->>'profileDigest' OR intent->>'operationInputDigest' IS DISTINCT FROM c.protected_call->>'operationInputDigest' OR component IS DISTINCT FROM c.protected_call->>'componentId' OR capacity->'sourceInput' IS DISTINCT FROM s->'target'->'sourceInput' OR
 capacity->'profile'->>'kernelDigest' IS DISTINCT FROM c.protected_call->>'kernelDigest' OR (intent-ARRAY['version','jobId','task','taskVersion','profileDigest','inputDigest','operationInputDigest','parentInstanceId','logicalOperationKey']) IS DISTINCT FROM((s->'target')-ARRAY['accountId','sourceInput']) THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_COST_BINDING_MISMATCH');END IF;
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND job_id=(intent->>'jobId')::uuid;
 IF FOUND THEN IF b.call_id=call AND b.protected_intent=intent AND b.protected_capacity=capacity AND b.component_id=component THEN RETURN jsonb_build_object('allowed',true,'reason','NATIVE_INTENT_EXISTS','capacityReservationId',(SELECT reservation_id FROM manga_web.native_capacity_reservations WHERE account_id=a AND job_id=b.job_id));END IF;RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_COST_BINDING_CONFLICT');END IF;
 IF manga_web.windows_native_cost_lock_call(call,true) IS NULL OR(SELECT count(*) FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND execution_id=c.execution_id)>=64 THEN RETURN jsonb_build_object('allowed',false,'reason','WINDOWS_NATIVE_COST_SCOPE_UNCONFIRMED');END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('call',c.protected_call,'intent',intent,'capacity',capacity,'componentId',component));
 BEGIN
  INSERT INTO manga_web.windows_native_cost_bindings VALUES(a,c.execution_id,call,(intent->>'jobId')::uuid,intent,capacity,component,id,h,clock_timestamp());
  decision:=manga_web.windows_native_cost_native_capacity_create_intent_core(intent,true,capacity);
  IF decision->>'allowed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='WINDOWS_NATIVE_COST_ADMISSION_DENIED';END IF;
 EXCEPTION WHEN no_data_found THEN RETURN decision;END;
 RETURN decision;
END $$;

CREATE FUNCTION windows_native_cost_io_request_valid(request jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT COALESCE(manga_web.windows_native_object(request,ARRAY['version','operationId','eventId','call','kind','key','expected']) AND request->'version'='1'::jsonb AND octet_length(request::text)<=8192 AND manga_web.windows_native_cost_uuid(request->>'operationId') AND manga_web.windows_native_cost_uuid(request->>'eventId') AND manga_web.windows_native_object(request->'call',ARRAY['callId','callDigest']) AND manga_web.windows_native_cost_uuid(request->'call'->>'callId') AND request->'call'->>'callDigest'~'^[a-f0-9]{64}$' AND request->>'kind' IN('OBJECT_READ','OBJECT_RECEIPT','OBJECT_PUT') AND octet_length(request->>'key') BETWEEN 1 AND 256 AND(request->'expected'='null'::jsonb OR(manga_web.windows_native_object(request->'expected',ARRAY['sha256','bytesLength']) AND request->'expected'->>'sha256'~'^[a-f0-9]{64}$' AND request->'expected'->>'bytesLength'~'^(0|[1-9][0-9]{0,15})$' AND(request->'expected'->>'bytesLength')::numeric<=16777216)),false)
$$;
CREATE FUNCTION windows_native_cost_io_view(r manga_web.windows_native_cost_io_starts) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT COALESCE((SELECT protected_event FROM manga_web.windows_native_cost_io_ends WHERE account_id=r.account_id AND operation_id=r.operation_id),r.protected_request-'expected'||jsonb_build_object('started',manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest),'ended',NULL,'state','UNCONFIRMED','observed',NULL,'code',NULL))
$$;
CREATE FUNCTION windows_native_cost_io_begin_owned(request jsonb,principal text,job uuid,context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();r manga_web.windows_native_cost_io_starts%ROWTYPE;c manga_web.windows_native_cost_calls%ROWTYPE;s jsonb;id uuid:=gen_random_uuid();h text;
BEGIN
 IF NOT manga_web.windows_native_cost_io_request_valid(request) THEN RETURN NULL;END IF;
 SELECT * INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=(request->'call'->>'callId')::uuid;IF NOT FOUND OR c.call_digest IS DISTINCT FROM request->'call'->>'callDigest' THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(c.execution_id);
 SELECT * INTO r FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND operation_id=(request->>'operationId')::uuid;
 IF FOUND THEN IF r.protected_request=request AND r.principal=principal AND r.job_id IS NOT DISTINCT FROM job AND r.read_context IS NOT DISTINCT FROM context THEN RETURN manga_web.windows_native_cost_io_view(r);END IF;RETURN NULL;END IF;
 s:=manga_web.windows_native_cost_lock_call(c.call_id,true);IF s IS NULL OR request->>'key' NOT LIKE a::text||'/%' OR
 (SELECT count(*) FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND call_id=c.call_id)>=64 OR(SELECT count(*) FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND execution_id=c.execution_id)>=1024 THEN RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'kind','WINDOWS_NATIVE_COST_IO_START','request',request,'principal',principal,'jobId',job,'context',context));
 INSERT INTO manga_web.windows_native_cost_io_starts VALUES(a,c.execution_id,c.call_id,(request->>'operationId')::uuid,(request->>'eventId')::uuid,request,principal,job,context,id,h,clock_timestamp()) RETURNING * INTO r;
 RETURN manga_web.windows_native_cost_io_view(r);
END $$;
CREATE FUNCTION windows_native_cost_io_end_owned(event jsonb,principal text,job uuid,context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();r manga_web.windows_native_cost_io_starts%ROWTYPE;e manga_web.windows_native_cost_io_ends%ROWTYPE;id uuid:=gen_random_uuid();h text;value jsonb;
BEGIN
 IF NOT manga_web.windows_native_object(event,ARRAY['version','operationId','eventId','call','kind','key','started','ended','state','observed','code']) OR event->'version'<>'1'::jsonb OR octet_length(event::text)>8192 OR NOT manga_web.windows_native_cost_uuid(event->>'operationId') OR (event->>'state' IN('RETURNED','THREW','UNCONFIRMED')) IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_ref(event->'started') THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_io_starts WHERE account_id=a AND operation_id=(event->>'operationId')::uuid;
 IF NOT FOUND OR r.principal IS DISTINCT FROM principal OR r.job_id IS DISTINCT FROM job OR r.read_context IS DISTINCT FROM context OR(event-ARRAY['started','ended','state','observed','code']) IS DISTINCT FROM(r.protected_request-'expected') OR event->'started' IS DISTINCT FROM manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest) THEN RETURN NULL;END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(r.execution_id);PERFORM manga_web.windows_native_cost_lock_call(r.call_id,false);
 SELECT * INTO e FROM manga_web.windows_native_cost_io_ends WHERE account_id=a AND operation_id=r.operation_id;
 IF FOUND THEN IF e.protected_event-'ended'=event-'ended' AND(event->'ended'='null'::jsonb OR event->'ended'=e.protected_event->'ended') THEN RETURN e.protected_event;END IF;RETURN NULL;END IF;
 IF event->>'state'='UNCONFIRMED' THEN RETURN manga_web.windows_native_cost_io_view(r);END IF;
 IF event->'observed'<>'null'::jsonb AND (NOT manga_web.windows_native_object(event->'observed',ARRAY['sha256','bytesLength']) OR event->'observed'->>'sha256'!~'^[a-f0-9]{64}$' OR event->'observed'->>'bytesLength'!~'^(0|[1-9][0-9]{0,15})$' OR(event->'observed'->>'bytesLength')::numeric>16777216) THEN RETURN NULL;END IF;
 IF(event->>'state'='RETURNED' AND(event->'code'<>'null'::jsonb OR(event->'observed'='null'::jsonb AND event->>'kind'<>'OBJECT_RECEIPT') OR(r.protected_request->'expected'<>'null'::jsonb AND r.protected_request->'expected' IS DISTINCT FROM event->'observed'))) OR(event->>'state'='THREW' AND((event->>'code'~'^[A-Z0-9_]{1,128}$') IS DISTINCT FROM true)) THEN RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'kind','WINDOWS_NATIVE_COST_IO_END','event',event-'ended'));
 value:=event||jsonb_build_object('ended',manga_web.windows_native_cost_reference(id,h));
 INSERT INTO manga_web.windows_native_cost_io_ends VALUES(a,r.operation_id,value,id,h,clock_timestamp());RETURN value;
END $$;
CREATE FUNCTION windows_native_cost_io_begin(request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN PERFORM manga_web.windows_native_cost_worker();RETURN manga_web.windows_native_cost_io_begin_owned(request,'trio_web_worker',NULL,NULL);END $$;
CREATE FUNCTION windows_native_cost_io_end(event jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN PERFORM manga_web.windows_native_cost_worker();RETURN manga_web.windows_native_cost_io_end_owned(event,'trio_web_worker',NULL,NULL);END $$;
CREATE FUNCTION windows_native_cost_io_lookup(request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.windows_native_cost_io_starts%ROWTYPE;BEGIN PERFORM manga_web.windows_native_cost_worker();IF NOT manga_web.windows_native_cost_io_request_valid(request) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_io_starts WHERE account_id=manga_web.current_account() AND operation_id=(request->>'operationId')::uuid AND principal='trio_web_worker' AND job_id IS NULL AND protected_request=request;
 IF NOT FOUND THEN RETURN NULL;END IF;PERFORM manga_web.windows_native_cost_lock_call(r.call_id,false);RETURN manga_web.windows_native_cost_io_view(r);END $$;
CREATE FUNCTION windows_native_cost_join(scope uuid,ending jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();s manga_web.windows_native_cost_scopes%ROWTYPE;e jsonb;original record;bridge jsonb;allowed_refs jsonb:='[]'::jsonb;original_count integer:=0;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();SELECT * INTO s FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=scope;IF NOT FOUND THEN RETURN '"WAIT"';END IF;
 PERFORM manga_web.windows_native_cost_lock_owner(s.execution_id);PERFORM 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=scope FOR UPDATE;
 IF NOT manga_web.windows_native_object(ending,ARRAY['version','scopeId','scopeDigest','eventId','outcome','terminalEvidence']) OR ending->'version'<>'1'::jsonb OR ending->>'scopeId' IS DISTINCT FROM scope::text OR ending->>'scopeDigest' IS DISTINCT FROM s.scope_digest OR NOT manga_web.windows_native_cost_uuid(ending->>'eventId') OR (ending->>'outcome' IN('RETURNED','THREW')) IS DISTINCT FROM true OR jsonb_typeof(ending->'terminalEvidence') IS DISTINCT FROM 'array' OR jsonb_array_length(ending->'terminalEvidence')>128 OR octet_length(ending::text)>32768 THEN RETURN '"WAIT"';END IF;
 SELECT protected_end INTO e FROM manga_web.windows_native_cost_scope_ends WHERE account_id=a AND scope_id=scope;
 IF FOUND THEN RETURN to_jsonb(CASE WHEN e=ending THEN 'JOINED' ELSE 'WAIT' END::text);END IF;
 IF(SELECT count(DISTINCT value->>'evidenceId') FROM jsonb_array_elements(ending->'terminalEvidence'))<>jsonb_array_length(ending->'terminalEvidence') THEN RETURN '"WAIT"';END IF;
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts r JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) LEFT JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE r.account_id=a AND c.scope_id=scope AND e.operation_id IS NULL) OR
 EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_queries q JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) LEFT JOIN manga_web.windows_native_cost_result_acks e USING(account_id,request_id) WHERE q.account_id=a AND c.scope_id=scope AND e.request_id IS NULL) OR
 EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings b JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE b.account_id=a AND c.scope_id=scope AND NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=b.job_id AND o.event='TERMINATION' AND o.protected_observation->'termination'->>'operationJoined'='true')) THEN RETURN '"WAIT"';END IF;
 -- Resolve each admitted original at most once. The unchanged W4-A reader
 -- proves both immutable bridge bodies/digests against its actual source and
 -- Windows original. Consumer/source execution inequality remains intact.
 FOR original IN SELECT binding.protected_capacity,attempt.protected_binding,
   jsonb_build_object('recordId',seal.record_id,'recordDigest',seal.digest,'linkId',link.link_id,'linkDigest',link.digest) AS expected,
   operation.protected_observation AS operation,termination.protected_observation AS termination
  FROM manga_web.windows_native_cost_bindings binding JOIN manga_web.windows_native_cost_calls task_call USING(account_id,call_id)
  JOIN manga_web.native_controller_attempts attempt USING(account_id,job_id)
  JOIN manga_web.windows_native_records seal ON seal.account_id=attempt.account_id AND seal.attempt_id=attempt.attempt_id AND seal.purpose='SEAL'
  JOIN manga_web.windows_native_links link ON link.account_id=attempt.account_id AND link.attempt_id=attempt.attempt_id
  JOIN manga_web.execution_evidence operation ON operation.account_id=binding.account_id AND operation.execution_id::text=binding.protected_capacity->'sourceInput'->>'executionId' AND operation.kind='WINDOWS_NATIVE_OPERATION' AND operation.protected_observation->'value'->'binding'=attempt.protected_binding
  JOIN manga_web.execution_evidence termination ON termination.account_id=binding.account_id AND termination.execution_id=operation.execution_id AND termination.kind='WINDOWS_NATIVE_TERMINATION' AND termination.protected_observation->'value'->>'jobId'=binding.job_id::text AND termination.protected_observation->'value'->>'capacityReservationId'=attempt.reservation_id::text AND termination.protected_observation->'value'->>'parentInstanceId'=attempt.protected_binding->>'parentInstanceId'
  WHERE binding.account_id=a AND task_call.scope_id=scope AND operation.protected_observation->'value'->'source'->'input'=binding.protected_capacity->'sourceInput' AND termination.protected_observation->'value'->'source'->'input'=binding.protected_capacity->'sourceInput'
  ORDER BY binding.job_id LIMIT 65 LOOP
  original_count:=original_count+1;IF original_count>64 THEN RETURN '"WAIT"';END IF;
  bridge:=manga_web.windows_native_evidence_bridge(jsonb_build_object('binding',original.protected_binding,'expected',original.expected),original.operation,original.termination,false);
  IF bridge->>'state'='VERIFIED' THEN allowed_refs:=allowed_refs||jsonb_build_array(bridge->'operation',bridge->'termination');END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(ending->'terminalEvidence') LOOP
  IF NOT manga_web.windows_native_cost_ref(e) OR NOT(allowed_refs @> jsonb_build_array(e) OR EXISTS(SELECT 1 FROM manga_web.execution_evidence x WHERE x.account_id=a AND x.execution_id=s.execution_id AND x.kind NOT IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') AND x.evidence_id=(e->>'evidenceId')::uuid AND x.evidence_digest=e->>'evidenceDigest') OR EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_ends x JOIN manga_web.windows_native_cost_io_starts r USING(account_id,operation_id) JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE x.account_id=a AND c.scope_id=scope AND x.evidence_id=(e->>'evidenceId')::uuid AND x.evidence_digest=e->>'evidenceDigest')) THEN RETURN '"WAIT"';END IF;
 END LOOP;
 INSERT INTO manga_web.windows_native_cost_scope_ends VALUES(a,scope,ending,clock_timestamp());RETURN '"JOINED"';
END $$;

CREATE FUNCTION windows_native_cost_receipt_guard(call uuid,target jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE s jsonb;c jsonb;t jsonb;
BEGIN
 s:=manga_web.windows_native_cost_lock_call(call,true);IF s IS NULL THEN RETURN false;END IF;
 SELECT protected_call INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=manga_web.current_account() AND call_id=call;t:=s->'target';
 RETURN manga_web.native_receipt_lookup_valid(target) AND(target-ARRAY['version','task','taskVersion','profileDigest','operationInputDigest','kernelImplementationDigest'])=t-ARRAY['accountId','sourceInput'] AND
 target->>'task'=c->>'task' AND target->>'taskVersion'=c->>'taskVersion' AND target->>'profileDigest'=c->>'profileDigest' AND target->>'operationInputDigest'=c->>'operationInputDigest' AND target->>'kernelImplementationDigest'=c->>'kernelDigest';
END $$;
CREATE FUNCTION windows_native_cost_receipt_lookup(call uuid,query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_receipt_guard(call,query) IS DISTINCT FROM true THEN RETURN NULL;END IF;RETURN manga_web.windows_native_cost_native_receipt_lookup_core(query);END $$;
CREATE FUNCTION windows_native_cost_receipt_prepare(call uuid,candidate jsonb,target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_receipt_guard(call,target) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings WHERE account_id=manga_web.current_account() AND call_id=call AND job_id=(candidate->>'jobId')::uuid) THEN RETURN NULL;END IF;RETURN manga_web.windows_native_cost_native_receipt_prepare_core(candidate,target);END $$;
CREATE FUNCTION windows_native_cost_receipt_register_asset(call uuid,candidate uuid,blob text,receipt jsonb,bucket text,target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_receipt_guard(call,target) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM manga_web.native_result_candidates c JOIN manga_web.windows_native_cost_bindings b USING(account_id,job_id) WHERE c.account_id=manga_web.current_account() AND c.candidate_id=candidate AND b.call_id=call) OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_ends e JOIN manga_web.windows_native_cost_io_starts s USING(account_id,operation_id) WHERE s.account_id=manga_web.current_account() AND s.call_id=call AND s.protected_request->>'kind'='OBJECT_PUT' AND s.protected_request->>'key'=receipt->>'key' AND e.protected_event->>'state'='RETURNED' AND e.protected_event->'observed'=jsonb_build_object('sha256',receipt->>'sha256','bytesLength',receipt->>'bytesLength')) THEN RETURN NULL;END IF;RETURN manga_web.windows_native_cost_native_receipt_register_asset_core(candidate,blob,receipt,bucket,target);END $$;
CREATE FUNCTION windows_native_cost_receipt_verify(call uuid,candidate uuid,receipt jsonb,target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();stored manga_web.native_result_candidates%ROWTYPE;fresh boolean;cached boolean;blob_ref jsonb;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_receipt_guard(call,target) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 SELECT * INTO stored FROM manga_web.native_result_candidates WHERE account_id=a AND candidate_id=candidate;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings b WHERE b.account_id=a AND b.job_id=stored.job_id AND b.call_id=call) INTO fresh;
 SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.native_result_receipts proof ON proof.account_id=u.account_id AND proof.candidate_id=candidate JOIN manga_web.native_job_intents intent ON intent.account_id=u.account_id AND intent.job_id=stored.job_id
  WHERE u.account_id=a AND u.call_id=call AND u.job_id=stored.job_id AND u.protected_source->>'origin'='CACHE' AND u.protected_source->'candidate'=stored.protected_candidate AND u.protected_source->'receipt'=proof.protected_receipt AND proof.protected_receipt=receipt AND u.protected_source->'intent'=intent.protected_intent AND
  manga_web.native_receipt_windows_candidate_valid(stored.protected_candidate) AND manga_web.native_receipt_windows_receipt_valid(receipt,stored.protected_candidate) AND
  EXISTS(SELECT 1 FROM manga_web.native_job_observations observation WHERE observation.account_id=a AND observation.job_id=stored.job_id AND observation.event='TERMINATION' AND observation.protected_observation->'version'='2'::jsonb AND observation.protected_observation->'termination'->>'isolation'='WINDOWS_JOB_OBJECT' AND observation.protected_observation->'termination'->>'kind' IN('NO_CHILD_CREATED','WINDOWS_JOB_EMPTY','UNCONFIRMED') AND
   manga_web.windows_native_object(u.protected_source->'termination',ARRAY['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind']) AND
   observation.protected_observation->'windowsRecordRef'=(stored.protected_candidate->'windowsEvidenceRef')-ARRAY['linkId','linkDigest'] AND
   (observation.protected_observation->'termination')-'isolation'=u.protected_source->'termination')) INTO cached;
 IF NOT fresh AND NOT cached THEN RETURN NULL;END IF;
 -- Each actual blob read is bound to this call's durable source event. A CACHE
 -- proof never lends its old GET to a new consumer, and successful PUT metadata
 -- alone does not prove this call's readback.
 FOR blob_ref IN SELECT value FROM jsonb_array_elements(stored.protected_candidate->'blobs') LOOP
  IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts start JOIN manga_web.windows_native_cost_io_ends ending USING(account_id,operation_id) WHERE start.account_id=a AND start.call_id=call AND start.protected_request->>'kind'='OBJECT_READ' AND start.protected_request->>'key'=a::text||'/'||(blob_ref->>'assetId') AND ending.protected_event->>'state'='RETURNED' AND ending.protected_event->'observed'=jsonb_build_object('sha256',blob_ref->>'sha256','bytesLength',blob_ref->>'bytesLength')) OR
   NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts start JOIN manga_web.windows_native_cost_io_ends ending USING(account_id,operation_id) WHERE start.account_id=a AND start.call_id=call AND start.protected_request->>'kind'=ANY(CASE WHEN fresh THEN ARRAY['OBJECT_RECEIPT','OBJECT_PUT'] ELSE ARRAY['OBJECT_RECEIPT'] END) AND start.protected_request->>'key'=a::text||'/'||(blob_ref->>'assetId') AND ending.protected_event->>'state'='RETURNED' AND ending.protected_event->'observed'=jsonb_build_object('sha256',blob_ref->>'sha256','bytesLength',blob_ref->>'bytesLength')) THEN RETURN NULL;END IF;
 END LOOP;
 RETURN manga_web.windows_native_cost_native_receipt_verify_core(candidate,receipt,target);
END $$;
CREATE FUNCTION windows_native_cost_cache_use(call uuid,source jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();c jsonb;r manga_web.windows_native_cost_cache_uses%ROWTYPE;id uuid:=gen_random_uuid();h text;candidate jsonb;proof jsonb;job uuid;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF manga_web.windows_native_cost_lock_call(call,true) IS NULL OR NOT manga_web.windows_native_object(source,ARRAY['candidate','receipt','intent','termination','origin']) OR source->>'origin' IS DISTINCT FROM 'CACHE' OR octet_length(source::text)>1048576 THEN RETURN NULL;END IF;
 candidate:=source->'candidate';proof:=source->'receipt';job:=(candidate->>'jobId')::uuid;
 SELECT protected_call INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=call;
 IF NOT manga_web.native_receipt_windows_candidate_valid(candidate) OR NOT manga_web.native_receipt_windows_receipt_valid(proof,candidate) OR candidate->>'operationInputDigest' IS DISTINCT FROM c->>'operationInputDigest' OR candidate->>'kernelImplementationDigest' IS DISTINCT FROM c->>'kernelDigest' OR
 NOT EXISTS(SELECT 1 FROM manga_web.native_result_candidates x JOIN manga_web.native_result_receipts p USING(account_id,candidate_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) WHERE x.account_id=a AND x.job_id=job AND x.protected_candidate=candidate AND p.protected_receipt=proof AND i.protected_intent=source->'intent') THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_cache_uses WHERE account_id=a AND call_id=call AND job_id=job;
 IF FOUND THEN IF r.protected_source=source THEN RETURN manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest);END IF;RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('callId',call,'source',source));INSERT INTO manga_web.windows_native_cost_cache_uses VALUES(a,call,job,source,id,h,clock_timestamp());RETURN manga_web.windows_native_cost_reference(id,h);
END $$;

CREATE FUNCTION windows_native_cost_authorize_result_query(call uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();s jsonb;b manga_web.windows_native_cost_bindings%ROWTYPE;o manga_web.native_controller_attempts%ROWTYPE;q manga_web.windows_native_cost_result_queries%ROWTYPE;c manga_web.windows_native_cost_calls%ROWTYPE;authority jsonb;id uuid:=gen_random_uuid();h text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF NOT manga_web.windows_native_object(request,ARRAY['control']) THEN RETURN NULL;END IF;request:=request->'control';IF NOT manga_web.windows_native_object(request,ARRAY['version','requestId','binding','command','includeRawResult']) OR request->'version'<>'2'::jsonb OR request->>'command' IS DISTINCT FROM 'QUERY' OR request->'includeRawResult'<>'true'::jsonb OR NOT manga_web.windows_native_cost_uuid(request->>'requestId') OR NOT manga_web.native_controller_binding_valid(request->'binding') OR octet_length(request::text)>8192 OR request->'binding'->>'accountId' IS DISTINCT FROM a::text THEN RETURN NULL;END IF;
 SELECT * INTO c FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=call;IF NOT FOUND THEN RETURN NULL;END IF;PERFORM manga_web.windows_native_cost_lock_owner(c.execution_id);
 SELECT * INTO q FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND request_id=(request->>'requestId')::uuid;
 IF FOUND THEN IF q.call_id=call AND q.protected_request=request THEN RETURN manga_web.windows_native_cost_reference(q.evidence_id,q.evidence_digest);END IF;RETURN NULL;END IF;
 s:=manga_web.windows_native_cost_lock_call(call,true);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND job_id=(request->'binding'->>'jobId')::uuid AND call_id=call;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO o FROM manga_web.native_controller_attempts WHERE account_id=a AND job_id=b.job_id AND protected_binding=request->'binding';IF NOT FOUND OR o.owner_service<>'trio_web_worker' OR NOT EXISTS(SELECT 1 FROM manga_web.native_controller_raw_results WHERE account_id=a AND attempt_id=o.attempt_id) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_queries pending LEFT JOIN manga_web.windows_native_cost_result_acks ack USING(account_id,request_id) WHERE pending.account_id=a AND pending.job_id=b.job_id AND ack.request_id IS NULL) OR(SELECT count(*) FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND call_id=call)>=64 OR(SELECT count(*) FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND execution_id=c.execution_id)>=1024 THEN RETURN NULL;END IF;
 authority:=jsonb_build_object('version',1,'requestId',request->>'requestId','requestDigest',manga_web.windows_native_cost_hash(request),'callRef',jsonb_build_object('callId',call,'callDigest',c.call_digest),'binding',o.protected_binding,'attemptId',o.attempt_id,'controllerInstanceId',o.controller_instance_id,'peerService',o.owner_service,'peerId',o.authenticated_peer_id);
 h:=manga_web.windows_native_cost_hash(authority);INSERT INTO manga_web.windows_native_cost_result_queries VALUES(a,c.execution_id,call,b.job_id,(request->>'requestId')::uuid,manga_web.windows_native_cost_hash(request),request,authority,id,h,clock_timestamp());RETURN manga_web.windows_native_cost_reference(id,h);
END $$;
CREATE FUNCTION windows_native_cost_claim_result_query(binding jsonb,controller uuid,peer_service text,read_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.native_controller_attempts%ROWTYPE;q manga_web.windows_native_cost_result_queries%ROWTYPE;r manga_web.windows_native_cost_result_claims%ROWTYPE;
BEGIN
 IF NOT manga_web.native_controller_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_COST_ACCESS_DENIED';END IF;
 IF NOT manga_web.windows_native_object(read_context,ARRAY['purpose','requestId','requestDigest','deliveryClaimId','authenticatedPeerId']) OR read_context->>'purpose' IS DISTINCT FROM 'PARENT_QUERY' OR NOT manga_web.windows_native_cost_uuid(read_context->>'requestId') OR NOT manga_web.windows_native_cost_uuid(read_context->>'deliveryClaimId') OR NOT manga_web.windows_native_cost_uuid(read_context->>'authenticatedPeerId') THEN RETURN NULL;END IF;
 o:=manga_web.native_controller_original(binding,controller,peer_service);
 SELECT * INTO q FROM manga_web.windows_native_cost_result_queries WHERE account_id=o.account_id AND request_id=(read_context->>'requestId')::uuid AND job_id=o.job_id AND request_digest=read_context->>'requestDigest';
 IF NOT FOUND OR read_context->>'authenticatedPeerId' IS DISTINCT FROM o.authenticated_peer_id::text OR q.authority->>'peerId' IS DISTINCT FROM read_context->>'authenticatedPeerId' OR q.authority->>'attemptId' IS DISTINCT FROM o.attempt_id::text OR q.authority->>'controllerInstanceId' IS DISTINCT FROM o.controller_instance_id::text OR q.authority->>'peerId' IS DISTINCT FROM o.authenticated_peer_id::text OR q.authority->>'peerService' IS DISTINCT FROM peer_service OR q.authority->'binding' IS DISTINCT FROM binding OR manga_web.windows_native_cost_lock_call(q.call_id,true) IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_result_claims WHERE account_id=o.account_id AND request_id=q.request_id;
 IF FOUND THEN IF r.claim_id::text=read_context->>'deliveryClaimId' THEN RETURN q.authority||jsonb_build_object('deliveryClaimId',r.claim_id);END IF;RETURN NULL;END IF;
 INSERT INTO manga_web.windows_native_cost_result_claims VALUES(o.account_id,q.request_id,(read_context->>'deliveryClaimId')::uuid,clock_timestamp());RETURN q.authority||jsonb_build_object('deliveryClaimId',read_context->>'deliveryClaimId');
END $$;
CREATE FUNCTION windows_native_cost_raw_context(binding jsonb,controller uuid,peer_service text,read_context jsonb,current_required boolean) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE o manga_web.native_controller_attempts%ROWTYPE;b manga_web.windows_native_cost_bindings%ROWTYPE;q manga_web.windows_native_cost_result_queries%ROWTYPE;
BEGIN
 IF NOT manga_web.native_controller_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_COST_ACCESS_DENIED';END IF;
 o:=manga_web.native_controller_original(binding,controller,peer_service);
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=o.account_id AND job_id=o.job_id;IF NOT FOUND THEN RETURN NULL;END IF;
 IF read_context=jsonb_build_object('purpose','RUN_RECOVERY') THEN
  IF current_required AND manga_web.windows_native_cost_lock_call(b.call_id,true) IS NULL THEN RETURN NULL;END IF;RETURN b.call_id;
 END IF;
 IF NOT manga_web.windows_native_object(read_context,ARRAY['purpose','requestId','requestDigest','deliveryClaimId','authenticatedPeerId']) OR read_context->>'purpose' IS DISTINCT FROM 'PARENT_QUERY' OR NOT manga_web.windows_native_cost_uuid(read_context->>'requestId') OR NOT manga_web.windows_native_cost_uuid(read_context->>'deliveryClaimId') OR NOT manga_web.windows_native_cost_uuid(read_context->>'authenticatedPeerId') THEN RETURN NULL;END IF;
 SELECT * INTO q FROM manga_web.windows_native_cost_result_queries WHERE account_id=o.account_id AND request_id=(read_context->>'requestId')::uuid AND job_id=o.job_id AND call_id=b.call_id AND request_digest=read_context->>'requestDigest';
 IF NOT FOUND OR read_context->>'authenticatedPeerId' IS DISTINCT FROM o.authenticated_peer_id::text OR q.authority->>'peerId' IS DISTINCT FROM read_context->>'authenticatedPeerId' OR q.authority->>'peerService' IS DISTINCT FROM peer_service OR q.authority->>'peerId' IS DISTINCT FROM o.authenticated_peer_id::text OR q.authority->>'attemptId' IS DISTINCT FROM o.attempt_id::text OR q.authority->>'controllerInstanceId' IS DISTINCT FROM o.controller_instance_id::text OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_claims WHERE account_id=o.account_id AND request_id=q.request_id AND claim_id=(read_context->>'deliveryClaimId')::uuid) THEN RETURN NULL;END IF;
 IF current_required AND (manga_web.windows_native_cost_lock_call(b.call_id,true) IS NULL OR EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_acks WHERE account_id=o.account_id AND request_id=q.request_id)) THEN RETURN NULL;END IF;RETURN b.call_id;
END $$;
CREATE FUNCTION windows_native_cost_raw_lookup(binding jsonb,controller uuid,peer_service text,bucket text,read_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE call uuid;value jsonb;
BEGIN call:=manga_web.windows_native_cost_raw_context(binding,controller,peer_service,read_context,true);IF call IS NULL THEN RETURN jsonb_build_object('allowed',true,'available',false);END IF;
 value:=manga_web.windows_native_cost_native_controller_raw_lookup_core(binding,controller,peer_service,bucket);RETURN value||jsonb_build_object('callRef',(SELECT jsonb_build_object('callId',call,'callDigest',call_digest) FROM manga_web.windows_native_cost_calls WHERE account_id=manga_web.current_account() AND call_id=call));
END $$;
CREATE FUNCTION windows_native_cost_controller_io_begin(binding jsonb,controller uuid,peer_service text,request jsonb,read_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE call uuid;job uuid:=(binding->>'jobId')::uuid;raw manga_web.native_controller_raw_results%ROWTYPE;r manga_web.windows_native_cost_io_starts%ROWTYPE;
BEGIN
 call:=manga_web.windows_native_cost_raw_context(binding,controller,peer_service,read_context,false);IF call IS NULL OR request->'call'->>'callId' IS DISTINCT FROM call::text OR NOT manga_web.windows_native_cost_io_request_valid(request) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_io_starts WHERE account_id=manga_web.current_account() AND operation_id=(request->>'operationId')::uuid;
 IF NOT FOUND THEN
  IF manga_web.windows_native_cost_raw_context(binding,controller,peer_service,read_context,true) IS NULL THEN RETURN NULL;END IF;
  SELECT raw_source.* INTO raw FROM manga_web.native_controller_raw_results raw_source JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id) WHERE a.account_id=manga_web.current_account() AND a.job_id=job;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(raw.blob_refs) x WHERE manga_web.current_account()::text||'/'||(x->>'assetId')=request->>'key' AND jsonb_build_object('sha256',x->>'sha256','bytesLength',x->>'bytesLength')=request->'expected') THEN RETURN NULL;END IF;
  IF read_context->>'purpose'='PARENT_QUERY' AND(request->>'kind'='OBJECT_PUT' OR EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts s WHERE s.account_id=manga_web.current_account() AND s.job_id=job AND s.read_context=windows_native_cost_controller_io_begin.read_context AND s.protected_request->>'kind'=request->>'kind' AND s.protected_request->>'key'=request->>'key')) THEN RETURN NULL;END IF;
 END IF;
 RETURN manga_web.windows_native_cost_io_begin_owned(request,'trio_web_controller',job,read_context);
END $$;
CREATE FUNCTION windows_native_cost_controller_io_end(binding jsonb,controller uuid,peer_service text,event jsonb,read_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE call uuid;BEGIN call:=manga_web.windows_native_cost_raw_context(binding,controller,peer_service,read_context,false);IF call IS NULL OR event->'call'->>'callId' IS DISTINCT FROM call::text THEN RETURN NULL;END IF;RETURN manga_web.windows_native_cost_io_end_owned(event,'trio_web_controller',(binding->>'jobId')::uuid,read_context);END $$;
CREATE FUNCTION windows_native_cost_controller_io_lookup(binding jsonb,controller uuid,peer_service text,request jsonb,read_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE call uuid;r manga_web.windows_native_cost_io_starts%ROWTYPE;BEGIN call:=manga_web.windows_native_cost_raw_context(binding,controller,peer_service,read_context,false);IF call IS NULL OR NOT manga_web.windows_native_cost_io_request_valid(request) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_io_starts WHERE account_id=manga_web.current_account() AND operation_id=(request->>'operationId')::uuid AND principal='trio_web_controller' AND job_id=(binding->>'jobId')::uuid AND windows_native_cost_io_starts.read_context=windows_native_cost_controller_io_lookup.read_context AND protected_request=request;
 IF NOT FOUND THEN RETURN NULL;END IF;RETURN manga_web.windows_native_cost_io_view(r);END $$;
CREATE FUNCTION windows_native_cost_finish_result_query(call uuid,request jsonb,response_ref jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();q manga_web.windows_native_cost_result_queries%ROWTYPE;r manga_web.windows_native_cost_result_acks%ROWTYPE;id uuid:=gen_random_uuid();h text;
BEGIN
 PERFORM manga_web.windows_native_cost_worker();IF NOT manga_web.windows_native_object(request,ARRAY['control']) OR NOT manga_web.windows_native_object(response_ref,ARRAY['requestId','responseDigest']) THEN RETURN NULL;END IF;request:=request->'control';IF NOT manga_web.windows_native_cost_uuid(request->>'requestId') OR response_ref->>'requestId' IS DISTINCT FROM request->>'requestId' OR response_ref->>'responseDigest'!~'^[a-f0-9]{64}$' THEN RETURN NULL;END IF;
 IF manga_web.windows_native_cost_lock_call(call,false) IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO q FROM manga_web.windows_native_cost_result_queries WHERE account_id=a AND request_id=(request->>'requestId')::uuid AND call_id=call AND protected_request=request;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM manga_web.windows_native_cost_result_acks WHERE account_id=a AND request_id=q.request_id;
 IF FOUND THEN IF r.response_ref=response_ref THEN RETURN manga_web.windows_native_cost_reference(r.evidence_id,r.evidence_digest);END IF;RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_result_claims WHERE account_id=a AND request_id=q.request_id) OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts s JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE s.account_id=a AND s.job_id=q.job_id AND s.read_context->>'requestId'=q.request_id::text AND s.protected_request->>'kind'='OBJECT_READ' AND e.protected_event->>'state'='RETURNED') OR EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts s LEFT JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE s.account_id=a AND s.job_id=q.job_id AND s.read_context->>'requestId'=q.request_id::text AND e.operation_id IS NULL) THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM manga_web.native_controller_attempts a JOIN manga_web.native_controller_raw_results raw_result USING(account_id,attempt_id) WHERE a.account_id=q.account_id AND a.job_id=q.job_id AND response_ref->>'responseDigest'=manga_web.windows_native_cost_hash(jsonb_build_object('control',jsonb_build_object('version',2,'requestId',q.request_id,'command','QUERY','binding',a.protected_binding,'snapshot',(manga_web.native_controller_snapshot(a.account_id,a.attempt_id)->'snapshot')-'isolation'),'rawResult',raw_result.result_canonical::jsonb))) THEN RETURN NULL;END IF;
 h:=manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'requestId',q.request_id,'response',response_ref));INSERT INTO manga_web.windows_native_cost_result_acks VALUES(a,q.request_id,response_ref,id,h,clock_timestamp());RETURN manga_web.windows_native_cost_reference(id,h);
END $$;

CREATE FUNCTION windows_native_cost_related(target jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments n JOIN manga_web.executions e USING(account_id,execution_id) WHERE n.account_id=manga_web.current_account() AND
 ((target->>'targetKind'='EXECUTION' AND e.execution_id::text=target->>'targetId') OR(target->>'targetKind'='REQUEST_CHECKPOINT' AND(e.request_id::text=target->>'targetId' OR EXISTS(SELECT 1 FROM manga_web.work_items w WHERE w.account_id=e.account_id AND w.work_item_id::text=target->'claim'->>'workItemId' AND w.target_ref->>'executionId'=e.execution_id::text)))))
$$;
CREATE FUNCTION windows_native_cost_prelude(target jsonb,current_required boolean) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();id uuid;s jsonb;
BEGIN
 PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
 FOR id IN SELECT n.execution_id FROM manga_web.windows_native_cost_enrollments n JOIN manga_web.executions e USING(account_id,execution_id) WHERE n.account_id=a AND
 ((target->>'targetKind'='EXECUTION' AND e.execution_id::text=target->>'targetId') OR(target->>'targetKind'='REQUEST_CHECKPOINT' AND e.request_id::text=target->>'targetId')) ORDER BY n.execution_id LOOP PERFORM manga_web.windows_native_cost_lock_owner(id);END LOOP;
 IF current_required THEN
  PERFORM 1 FROM manga_web.processing_requests r WHERE r.account_id=a AND((target->>'targetKind'='REQUEST_CHECKPOINT' AND r.request_id::text=target->>'targetId') OR EXISTS(SELECT 1 FROM manga_web.executions e WHERE e.account_id=a AND e.request_id=r.request_id AND e.execution_id::text=target->>'targetId')) ORDER BY r.request_id FOR UPDATE;
  PERFORM 1 FROM manga_web.workspace_contexts WHERE account_id=a AND context_id::text=target->'protectedOwnerCapture'->>'contextId' ORDER BY context_id FOR UPDATE;
  PERFORM 1 FROM manga_web.work_items WHERE account_id=a AND work_item_id::text=target->'claim'->>'workItemId' ORDER BY work_item_id FOR UPDATE;
  PERFORM 1 FROM manga_web.app_sessions WHERE account_id=a AND session_id::text=target->'protectedOwnerCapture'->>'ownerSessionId' ORDER BY session_id FOR UPDATE;
  PERFORM 1 FROM manga_web.login_bindings b WHERE b.account_id=a AND EXISTS(SELECT 1 FROM manga_web.app_sessions s WHERE s.account_id=a AND s.session_id::text=target->'protectedOwnerCapture'->>'ownerSessionId' AND s.binding_id=b.binding_id) ORDER BY b.binding_id FOR UPDATE;
  PERFORM 1 FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;PERFORM 1 FROM manga_web.native_capacity_authority WHERE singleton FOR UPDATE;
 END IF;
END $$;
CREATE FUNCTION windows_native_cost_job_prelude(job uuid,current_required boolean) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();b manga_web.windows_native_cost_bindings%ROWTYPE;t jsonb;s jsonb;
BEGIN
 SELECT protected_intent INTO t FROM manga_web.native_job_intents WHERE account_id=a AND job_id=job;
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND job_id=job;
 PERFORM manga_web.windows_native_cost_prelude(t,false);IF FOUND AND b.execution_id IS NOT NULL THEN PERFORM manga_web.windows_native_cost_lock_owner(b.execution_id);END IF;
 IF current_required THEN
  IF b.call_id IS NOT NULL THEN
   SELECT protected_scope INTO s FROM manga_web.windows_native_cost_scopes WHERE account_id=a AND scope_id=(SELECT scope_id FROM manga_web.windows_native_cost_calls WHERE account_id=a AND call_id=b.call_id);
   PERFORM manga_web.windows_native_cost_owner_current(s->'owner',s->'target'->'protectedOwnerCapture');
  END IF;
  PERFORM manga_web.windows_native_cost_prelude(t,true);
 END IF;
END $$;
CREATE FUNCTION windows_native_cost_job_open(job uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();b manga_web.windows_native_cost_bindings%ROWTYPE;t jsonb;
BEGIN
 PERFORM manga_web.windows_native_cost_job_prelude(job,true);SELECT protected_intent INTO t FROM manga_web.native_job_intents WHERE account_id=a AND job_id=job;
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=a AND job_id=job;
 IF FOUND THEN RETURN manga_web.windows_native_cost_lock_call(b.call_id,true) IS NOT NULL AND b.protected_intent=t;END IF;
 RETURN NOT manga_web.windows_native_cost_related(t);
END $$;
CREATE FUNCTION windows_native_cost_intent_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
 PERFORM manga_web.windows_native_cost_prelude(NEW.protected_intent,true);
 IF manga_web.windows_native_cost_related(NEW.protected_intent) AND NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings WHERE account_id=NEW.account_id AND job_id=NEW.job_id AND protected_intent=NEW.protected_intent) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_SCOPE_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER windows_native_cost_intent_guard BEFORE INSERT ON native_job_intents FOR EACH ROW EXECUTE FUNCTION windows_native_cost_intent_guard();
CREATE FUNCTION windows_native_cost_total_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id) THEN
  PERFORM manga_web.windows_native_cost_lock_owner(NEW.execution_id);
  IF(TG_TABLE_NAME='execution_evidence' AND NEW.kind IN('WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_PROJECTION','WINDOWS_NATIVE_COST_SEAL','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CLOSURE')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_SEAL_UNAVAILABLE';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER windows_native_cost_total_guard BEFORE INSERT OR UPDATE ON execution_evidence FOR EACH ROW EXECUTE FUNCTION windows_native_cost_total_guard();
CREATE FUNCTION windows_native_cost_cost_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
 IF NEW.component='STAGE_TOTAL' AND(NEW.state='CONFIRMED' OR NEW.actual_usd IS NOT NULL) AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id) THEN PERFORM manga_web.windows_native_cost_lock_owner(NEW.execution_id);RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_SEAL_UNAVAILABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER windows_native_cost_cost_guard BEFORE INSERT OR UPDATE ON cost_items FOR EACH ROW EXECUTE FUNCTION windows_native_cost_cost_guard();
CREATE FUNCTION windows_native_cost_adoption_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE b manga_web.windows_native_cost_bindings%ROWTYPE;r manga_web.native_capacity_reservations%ROWTYPE;
BEGIN
 SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=NEW.account_id AND reservation_id=NEW.reservation_id;
 SELECT * INTO b FROM manga_web.windows_native_cost_bindings WHERE account_id=NEW.account_id AND job_id=r.job_id;
 IF FOUND AND b.execution_id IS DISTINCT FROM NEW.execution_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_OWNER_IMMUTABLE';END IF;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM manga_web.windows_native_cost_enrollments WHERE account_id=NEW.account_id AND execution_id=NEW.execution_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_COST_BINDING_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER windows_native_cost_adoption_guard BEFORE INSERT ON native_capacity_adoptions FOR EACH ROW EXECUTE FUNCTION windows_native_cost_adoption_guard();

-- Prefix prelude/guards in place. Function bodies, validation and private cores
-- remain behind their original signatures; no caller-set bypass state exists.
DO $guards$ DECLARE r record;definition text;body text;prefix text;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('native_job_create_intent(jsonb)','PERFORM manga_web.windows_native_cost_prelude(p,true);IF manga_web.windows_native_cost_related(p) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_receipt_create_intent(jsonb)','PERFORM manga_web.windows_native_cost_prelude(p,true);IF manga_web.windows_native_cost_related(p) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_create_intent(jsonb,boolean,jsonb)','PERFORM manga_web.windows_native_cost_prelude(p,true);IF manga_web.windows_native_cost_related(p) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_base_intent(jsonb,boolean)','PERFORM manga_web.windows_native_cost_prelude(p,true);IF manga_web.windows_native_cost_related(p) AND NOT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings WHERE account_id=manga_web.current_account() AND job_id::text=p->>''jobId'' AND protected_intent=p) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_base_create_intent_v13(jsonb)','PERFORM manga_web.windows_native_cost_prelude(p,true);'),
 ('native_job_consume_go(uuid,uuid,jsonb,jsonb)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_job_go_current_owned(uuid,uuid,jsonb,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_job_go_owned(uuid,uuid,jsonb,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open(p_job) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('windows_native_offer(jsonb)','PERFORM manga_web.windows_native_cost_job_prelude((p->''binding''->>''jobId'')::uuid,true);IF NOT manga_web.windows_native_cost_job_open((p->''binding''->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('windows_native_capture(jsonb,text,text)','PERFORM manga_web.windows_native_cost_job_prelude((p->''binding''->>''jobId'')::uuid,true);IF NOT manga_web.windows_native_cost_job_open((p->''binding''->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('windows_native_scope(jsonb)','PERFORM manga_web.windows_native_cost_job_prelude((p->''binding''->>''jobId'')::uuid,false);PERFORM 1 FROM manga_web.windows_native_cost_scopes s JOIN manga_web.windows_native_cost_calls c USING(account_id,scope_id) JOIN manga_web.windows_native_cost_bindings b USING(account_id,call_id) WHERE b.account_id=manga_web.current_account() AND b.job_id::text=p->''binding''->>''jobId'' FOR UPDATE OF s,c;PERFORM 1 FROM manga_web.native_capacity_reservations WHERE account_id=manga_web.current_account() AND job_id::text=p->''binding''->>''jobId'' FOR UPDATE;'),
 ('windows_native_current(jsonb)','IF NOT manga_web.windows_native_cost_job_open((p->''binding''->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('windows_native_ready(jsonb,text)','IF NOT manga_web.windows_native_cost_job_open((p->''binding''->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('windows_native_grant_go(jsonb)','PERFORM manga_web.windows_native_cost_job_prelude((p->''binding''->>''jobId'')::uuid,NOT EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=manga_web.current_account() AND job_id::text=p->''binding''->>''jobId''));IF NOT EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=manga_web.current_account() AND job_id::text=p->''binding''->>''jobId'') AND NOT manga_web.windows_native_cost_job_open((p->''binding''->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_original(jsonb,uuid,text)','PERFORM manga_web.windows_native_cost_job_prelude((p_binding->>''jobId'')::uuid,false);'),
 ('native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid)','IF NOT manga_web.windows_native_cost_job_open((p_binding->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid)','IF NOT manga_web.windows_native_cost_job_open((p_binding->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_grant_go(jsonb,uuid,uuid,uuid,text)','IF NOT manga_web.windows_native_cost_job_open((p_binding->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open((p_binding->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text)','IF NOT manga_web.windows_native_cost_job_open((p_binding->>''jobId'')::uuid) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_controller_raw_lookup(jsonb,uuid,text,text)','PERFORM manga_web.windows_native_cost_job_prelude((p_binding->>''jobId'')::uuid,true);IF EXISTS(SELECT 1 FROM manga_web.windows_native_cost_bindings WHERE account_id=manga_web.current_account() AND job_id::text=p_binding->>''jobId'') OR manga_web.windows_native_cost_related((SELECT protected_intent FROM manga_web.native_job_intents WHERE account_id=manga_web.current_account() AND job_id::text=p_binding->>''jobId'')) THEN RETURN jsonb_build_object(''allowed'',true,''available'',false);END IF;'),
 ('native_receipt_lookup(jsonb)','PERFORM manga_web.windows_native_cost_prelude(p,true);IF manga_web.windows_native_cost_related(p) THEN RETURN jsonb_build_object(''state'',''CONFLICT'',''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_receipt_prepare(jsonb,jsonb)','PERFORM manga_web.windows_native_cost_prelude(p_target,true);IF manga_web.windows_native_cost_related(p_target) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_receipt_register_asset(uuid,text,jsonb,text,jsonb)','PERFORM manga_web.windows_native_cost_prelude(p_target,true);IF manga_web.windows_native_cost_related(p_target) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('native_receipt_verify(uuid,jsonb,jsonb)','PERFORM manga_web.windows_native_cost_prelude(p_target,true);IF manga_web.windows_native_cost_related(p_target) THEN RETURN jsonb_build_object(''allowed'',false,''reason'',''WINDOWS_NATIVE_COST_SCOPE_REQUIRED'');END IF;'),
 ('reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb)','PERFORM manga_web.windows_native_cost_prelude(jsonb_build_object(''targetKind'',''EXECUTION'',''targetId'',p_execution),true);')
 ) x(signature,prefix) LOOP
  SELECT pg_get_functiondef(p.oid),p.prosrc INTO definition,body FROM pg_proc p WHERE p.oid=to_regprocedure('manga_web.'||r.signature);
  IF definition IS NULL THEN RAISE EXCEPTION 'W4B1 required original missing: %',r.signature;END IF;
  IF position('BEGIN' IN body)=0 THEN
   -- SQL forwarding entrypoints keep their original arguments and ACLs.
   IF r.signature='native_receipt_lookup(jsonb)' THEN body:='BEGIN '||r.prefix||' RETURN manga_web.windows_native_cost_native_receipt_lookup_core(p);END';
   ELSIF r.signature='native_receipt_prepare(jsonb,jsonb)' THEN body:='BEGIN '||r.prefix||' RETURN manga_web.windows_native_cost_native_receipt_prepare_core(p,p_target);END';
   ELSIF r.signature='native_receipt_register_asset(uuid,text,jsonb,text,jsonb)' THEN body:='BEGIN '||r.prefix||' RETURN manga_web.windows_native_cost_native_receipt_register_asset_core(p_candidate,p_blob,p_receipt,p_bucket,p_target);END';
   ELSIF r.signature='native_receipt_verify(uuid,jsonb,jsonb)' THEN body:='BEGIN '||r.prefix||' RETURN manga_web.windows_native_cost_native_receipt_verify_core(p_candidate,p,p_target);END';
   ELSE RAISE EXCEPTION 'W4B1 unsupported original SQL forwarding: %',r.signature;END IF;
   definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
  ELSE body:=overlay(body placing 'BEGIN'||chr(10)||r.prefix||chr(10) from position('BEGIN' IN body) for 5);END IF;
  SELECT replace(definition,p.prosrc,body) INTO definition FROM pg_proc p WHERE p.oid=to_regprocedure('manga_web.'||r.signature);
  definition:=replace(definition,' STABLE',' VOLATILE');EXECUTE definition;
 END LOOP;
END $guards$;

-- Every new helper is private by default, including copied original cores.
DO $acl$ DECLARE r record;BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND p.proname LIKE 'windows_native_cost_%' LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||r.signature||' FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator';
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION windows_native_cost_enroll_input(jsonb),windows_native_cost_activate(jsonb,jsonb),windows_native_cost_begin(jsonb,jsonb),windows_native_cost_register_call(uuid,jsonb),windows_native_cost_admit(uuid,jsonb,jsonb,text),windows_native_cost_join(uuid,jsonb),windows_native_cost_lookup(jsonb,integer),windows_native_cost_receipt_lookup(uuid,jsonb),windows_native_cost_receipt_prepare(uuid,jsonb,jsonb),windows_native_cost_receipt_register_asset(uuid,uuid,text,jsonb,text,jsonb),windows_native_cost_receipt_verify(uuid,uuid,jsonb,jsonb),windows_native_cost_io_begin(jsonb),windows_native_cost_io_end(jsonb),windows_native_cost_io_lookup(jsonb),windows_native_cost_cache_use(uuid,jsonb),windows_native_cost_authorize_result_query(uuid,jsonb),windows_native_cost_finish_result_query(uuid,jsonb,jsonb) TO trio_web_worker;
GRANT EXECUTE ON FUNCTION windows_native_cost_claim_result_query(jsonb,uuid,text,jsonb),windows_native_cost_raw_lookup(jsonb,uuid,text,text,jsonb),windows_native_cost_controller_io_begin(jsonb,uuid,text,jsonb,jsonb),windows_native_cost_controller_io_end(jsonb,uuid,text,jsonb,jsonb),windows_native_cost_controller_io_lookup(jsonb,uuid,text,jsonb,jsonb) TO trio_web_controller;
