SET search_path TO manga_web,pg_catalog;

-- A candidate is created only after all parent facade checks. Its object IDs
-- precede PUT, including a crash before receipt/asset registration. Neither
-- record authorizes GO, termination, cost, capacity release or publication.
CREATE TABLE native_result_candidates(
  account_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  job_id uuid NOT NULL,
  parent_instance_id uuid NOT NULL,
  operation_input_digest text NOT NULL CHECK(operation_input_digest~'^[a-f0-9]{64}$'),
  kernel_implementation_digest text NOT NULL CHECK(kernel_implementation_digest~'^[a-f0-9]{64}$'),
  verification_version text NOT NULL CHECK(verification_version='native-facade-verification-v1'),
  result_observation_id uuid NOT NULL,
  protected_candidate jsonb NOT NULL CHECK(jsonb_typeof(protected_candidate)='object' AND octet_length(protected_candidate::text)<=16777216),
  source_asset_dependencies jsonb NOT NULL CHECK(jsonb_typeof(source_asset_dependencies)='array' AND octet_length(source_asset_dependencies::text)<=16777216),
  candidate_digest text NOT NULL CHECK(candidate_digest~'^[a-f0-9]{64}$'),
  asset_purpose text NOT NULL CHECK(asset_purpose IN ('LIVE','UPLOAD_TEMP','EXPORT','LIBRARY')),
  related_context_id uuid,
  access_deadline timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,candidate_id),
  UNIQUE(account_id,job_id),
  UNIQUE(account_id,operation_input_digest,kernel_implementation_digest,verification_version),
  FOREIGN KEY(account_id,job_id,parent_instance_id) REFERENCES native_job_intents(account_id,job_id,parent_instance_id),
  FOREIGN KEY(account_id,result_observation_id) REFERENCES native_job_observations(account_id,observation_id)
);
CREATE TABLE native_result_receipts(
  account_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  protected_receipt jsonb NOT NULL CHECK(jsonb_typeof(protected_receipt)='object' AND octet_length(protected_receipt::text)<=1048576),
  receipt_digest text NOT NULL CHECK(receipt_digest~'^[a-f0-9]{64}$'),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,candidate_id),
  FOREIGN KEY(account_id,candidate_id) REFERENCES native_result_candidates(account_id,candidate_id)
);
CREATE TRIGGER immutable_native_result_candidates BEFORE UPDATE OR DELETE ON native_result_candidates FOR EACH ROW EXECUTE FUNCTION immutable_native_job_record();
CREATE TRIGGER immutable_native_result_receipts BEFORE UPDATE OR DELETE ON native_result_receipts FOR EACH ROW EXECUTE FUNCTION immutable_native_job_record();
DO $rls$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['native_result_candidates','native_result_receipts'] LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE manga_web.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY account_scope ON manga_web.%I TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account())',relation);
  END LOOP;
END $rls$;
REVOKE ALL ON native_result_candidates,native_result_receipts FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT SELECT(account_id,candidate_id,job_id,operation_input_digest,kernel_implementation_digest,verification_version,candidate_digest,asset_purpose,related_context_id,access_deadline,created_at) ON native_result_candidates TO trio_web_api,trio_web_worker;
GRANT SELECT(account_id,candidate_id,receipt_digest,verified_at) ON native_result_receipts TO trio_web_api,trio_web_worker;

CREATE FUNCTION native_receipt_lookup_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE field text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 OR
    (SELECT count(*) FROM jsonb_object_keys(p))<>11 OR NOT p ?& ARRAY['version','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim','task','taskVersion','profileDigest','operationInputDigest','kernelImplementationDigest'] OR
    p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'taskVersion' IS DISTINCT FROM 'native-pure-v1' OR
    jsonb_typeof(p->'task') IS DISTINCT FROM 'string' OR p->>'task' NOT IN ('DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE') OR
    jsonb_typeof(p->'targetKind') IS DISTINCT FROM 'string' OR p->>'targetKind' NOT IN ('UPLOAD','RESTORE','RASTER','EXPORT','LIBRARY','EXECUTION','REQUEST_CHECKPOINT') OR
    jsonb_typeof(p->'targetId') IS DISTINCT FROM 'string' OR p->>'targetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR NOT manga_web.native_job_valid_tuple(p) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['semanticCaptureDigest','profileDigest','operationInputDigest','kernelImplementationDigest'] LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR p->>field !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- A cache MISS is advisory. Serialize the actual admission under the owning
-- account lock so different targets cannot race into the same pure compute.
-- Same-job retries keep the original function's refusal, including ACK loss;
-- neither an old result nor a receipt can grant a new invocation or GO.
CREATE FUNCTION native_receipt_create_intent(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller();
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'jobId') IS DISTINCT FROM 'string' OR p->>'jobId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(p->'operationInputDigest') IS DISTINCT FROM 'string' OR p->>'operationInputDigest' !~ '^[a-f0-9]{64}$' THEN RETURN manga_web.native_job_create_intent(p); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND job_id=(p->>'jobId')::uuid) THEN RETURN manga_web.native_job_create_intent(p); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest') OR EXISTS(SELECT 1 FROM manga_web.native_result_candidates WHERE account_id=a AND operation_input_digest=p->>'operationInputDigest') THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_JOB_UNRESOLVED'); END IF;
  RETURN manga_web.native_job_create_intent(p);
END $$;

-- Retention belongs to the original target and source assets as well as the
-- present caller. A different target cannot revive expired/deleted material.
CREATE FUNCTION native_receipt_retention(p jsonb,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); target uuid:=(p->>'targetId')::uuid; c uuid; deadline timestamptz; purpose text; refs jsonb; result_row manga_web.results%ROWTYPE; operation_row manga_web.library_store_operations%ROWTYPE;
BEGIN
  IF p->>'targetKind' IN ('UPLOAD','RESTORE') THEN
    SELECT context_id,expires_at INTO c,deadline FROM manga_web.uploads WHERE account_id=a AND upload_id=target;
    IF NOT FOUND OR p_now>=deadline THEN RETURN jsonb_build_object('available',false); END IF;
    IF EXISTS(SELECT 1 FROM manga_web.upload_candidates u LEFT JOIN manga_web.assets b USING(account_id,asset_id) WHERE u.account_id=a AND u.upload_id=target AND(b.asset_id IS NULL OR b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND p_now>=b.access_deadline))) THEN RETURN jsonb_build_object('available',false); END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('assetId',b.asset_id,'sha256',b.sha256,'bytesLength',b.bytes_length::text,'mediaType',b.media_type)),'[]'::jsonb) INTO refs FROM manga_web.upload_candidates u JOIN manga_web.assets b USING(account_id,asset_id) WHERE u.account_id=a AND u.upload_id=target;
    IF p->>'targetKind'='RESTORE' AND jsonb_array_length(refs)=0 THEN RETURN jsonb_build_object('available',false); END IF;
    purpose:='UPLOAD_TEMP';
  ELSIF p->>'targetKind'='EXPORT' THEN
    SELECT context_id,retry_deadline,captured_manifest->'assets' INTO c,deadline,refs FROM manga_web.exports WHERE account_id=a AND export_id=target;
    IF NOT FOUND OR p_now>=deadline THEN RETURN jsonb_build_object('available',false); END IF;
    purpose:='EXPORT';
  ELSIF p->>'targetKind' IN ('RASTER','LIBRARY') THEN
    IF p->>'targetKind'='LIBRARY' THEN
      SELECT * INTO operation_row FROM manga_web.library_store_operations WHERE account_id=a AND store_operation_id=target;
      IF FOUND THEN
        IF operation_row.expires_at IS NOT NULL AND p_now>=operation_row.expires_at THEN RETURN jsonb_build_object('available',false); END IF;
        deadline:=operation_row.expires_at;
        SELECT * INTO result_row FROM manga_web.results WHERE account_id=a AND result_id=operation_row.result_id;
      ELSE SELECT * INTO result_row FROM manga_web.results WHERE account_id=a AND result_id=target; END IF;
      purpose:='LIBRARY';
    ELSE SELECT * INTO result_row FROM manga_web.results WHERE account_id=a AND result_id=target;purpose:='LIVE'; END IF;
    IF result_row.result_id IS NULL THEN RETURN jsonb_build_object('available',false); END IF;
    c:=result_row.context_id;
    refs:=jsonb_build_array(jsonb_build_object('assetId',result_row.original_asset_id));
    IF result_row.cleaned_asset_id IS NOT NULL THEN refs:=refs||jsonb_build_array(jsonb_build_object('assetId',result_row.cleaned_asset_id)); END IF;
    IF result_row.render_asset_id IS NOT NULL THEN refs:=refs||jsonb_build_array(jsonb_build_object('assetId',result_row.render_asset_id)); END IF;
  ELSIF p->>'targetKind'='EXECUTION' THEN
    SELECT r.context_id,e.protected_observation->'assetDependencies' INTO c,refs FROM manga_web.executions x JOIN manga_web.processing_requests r USING(account_id,request_id) JOIN manga_web.execution_evidence e ON e.account_id=x.account_id AND e.execution_id=x.execution_id AND e.kind='INPUT' WHERE x.account_id=a AND x.execution_id=target;
    IF NOT FOUND THEN RETURN jsonb_build_object('available',false); END IF;purpose:='LIVE';
  ELSIF p->>'targetKind'='REQUEST_CHECKPOINT' THEN
    SELECT context_id,captured_input->'assetDependencies' INTO c,refs FROM manga_web.processing_requests WHERE account_id=a AND request_id=target;
    IF NOT FOUND THEN RETURN jsonb_build_object('available',false); END IF;purpose:='LIVE';
  ELSE RETURN jsonb_build_object('available',false); END IF;
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('available',false); END IF;
  IF c IS NOT NULL AND NOT EXISTS(SELECT 1 FROM manga_web.workspace_contexts WHERE account_id=a AND context_id=c AND generation::text=p->'protectedOwnerCapture'->>'contextGeneration') THEN RETURN jsonb_build_object('available',false); END IF;
  IF refs IS NOT NULL THEN
    IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) ref LEFT JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.asset_id IS NULL OR b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND p_now>=b.access_deadline) OR(ref ? 'sha256' AND b.sha256 IS DISTINCT FROM ref->>'sha256') OR(ref ? 'bytesLength' AND b.bytes_length::text IS DISTINCT FROM ref->>'bytesLength')) THEN RETURN jsonb_build_object('available',false); END IF;
  END IF;
  RETURN jsonb_build_object('available',true,'purpose',purpose,'contextId',c,'accessDeadline',deadline,'refs',refs);
END $$;

CREATE FUNCTION native_receipt_assets_current(p jsonb,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE ref jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)>4096 THEN RETURN false; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(ref))<>4 OR NOT ref ?& ARRAY['assetId','sha256','bytesLength','mediaType'] OR jsonb_typeof(ref->'assetId') IS DISTINCT FROM 'string' OR ref->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(ref->'sha256') IS DISTINCT FROM 'string' OR ref->>'sha256' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(ref->'bytesLength') IS DISTINCT FROM 'string' OR ref->>'bytesLength' !~ '^(0|[1-9][0-9]{0,15})$' OR jsonb_typeof(ref->'mediaType') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF NOT EXISTS(SELECT 1 FROM manga_web.assets b WHERE b.account_id=manga_web.current_account() AND b.asset_id=(ref->>'assetId')::uuid AND b.sha256=ref->>'sha256' AND b.bytes_length::text=ref->>'bytesLength' AND b.media_type=ref->>'mediaType' AND b.deletion_state<>'CONFIRMED' AND(b.access_deadline IS NULL OR p_now<b.access_deadline)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- Sources are derived only by this owning prepare path, then immutable. The
-- original raw input frame proves font/catalog and stage dependency tuples;
-- checkpoint references additionally follow the exact stored INPUT/output.
CREATE FUNCTION native_receipt_source_assets(p jsonb,p_input jsonb,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); retention jsonb; refs jsonb; captured jsonb; catalog jsonb; entry jsonb; checkpoint record; frozen jsonb; required_ids jsonb;
BEGIN
  retention:=manga_web.native_receipt_retention(p,p_now);
  IF retention->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  refs:=retention->'refs';
  IF p->>'targetKind'='UPLOAD' AND jsonb_array_length(refs)=0 AND(p->>'task' IS DISTINCT FROM 'DECODE_IMAGE' OR jsonb_array_length(p_input->'blobs')<>1 OR p_input->'blobs'->0->>'id' IS DISTINCT FROM p_input->'metadata'->>'sourceBlobId') THEN RETURN NULL; END IF;
  IF p->>'targetKind' IN ('EXECUTION','REQUEST_CHECKPOINT') AND jsonb_array_length(refs)=0 THEN RETURN NULL; END IF;
  captured:=p_input->'metadata'->'input';
  IF captured IS NOT NULL THEN
    IF jsonb_typeof(captured->'assetDependencies') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    refs:=refs||(captured->'assetDependencies');
  END IF;
  catalog:=p_input->'metadata'->'fonts'->'catalog';
  IF p_input->'metadata' ? 'fonts' THEN
    IF jsonb_typeof(catalog->'fonts') IS DISTINCT FROM 'array' OR jsonb_typeof(catalog->'license') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(catalog->'fonts') UNION ALL SELECT catalog->'license' LOOP
      IF jsonb_typeof(entry->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'sha256') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'bytesLength') IS DISTINCT FROM 'string' OR entry->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
      IF NOT EXISTS(SELECT 1 FROM manga_web.assets b WHERE b.account_id=a AND b.asset_id=(entry->>'id')::uuid AND b.purpose='FONT' AND b.sha256=entry->>'sha256' AND b.bytes_length::text=entry->>'bytesLength') THEN RETURN NULL; END IF;
      SELECT refs||jsonb_build_array(jsonb_build_object('assetId',b.asset_id,'sha256',entry->>'sha256','bytesLength',entry->>'bytesLength','mediaType',b.media_type)) INTO refs FROM manga_web.assets b WHERE b.account_id=a AND b.asset_id=(entry->>'id')::uuid;
    END LOOP;
  END IF;
  IF p->>'targetKind'='REQUEST_CHECKPOINT' THEN
    FOR checkpoint IN SELECT c.execution_id,c.output_envelope,e.protected_observation AS original_input FROM manga_web.request_steps s JOIN manga_web.checkpoints c ON c.account_id=s.account_id AND(c.checkpoint_id=s.reuse_checkpoint_id OR(c.execution_id=s.current_execution_id AND s.reuse_checkpoint_id IS NULL)) LEFT JOIN manga_web.execution_evidence e ON e.account_id=c.account_id AND e.execution_id=c.execution_id AND e.kind='INPUT' WHERE s.account_id=a AND s.request_id=(p->>'targetId')::uuid LOOP
      IF jsonb_typeof(checkpoint.original_input->'assetDependencies') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
      refs:=refs||(checkpoint.original_input->'assetDependencies');
      captured:=checkpoint.output_envelope->'assetDependencies';
      IF captured IS NOT NULL THEN IF jsonb_typeof(captured) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;refs:=refs||captured; END IF;
      required_ids:=COALESCE(checkpoint.output_envelope->'outputAssetIds','[]'::jsonb);
      IF jsonb_typeof(required_ids) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
      IF jsonb_typeof(checkpoint.output_envelope->'cleanedAssetId')='string' THEN required_ids:=required_ids||jsonb_build_array(checkpoint.output_envelope->>'cleanedAssetId'); END IF;
      IF jsonb_typeof(checkpoint.output_envelope->'renderAssetId')='string' THEN required_ids:=required_ids||jsonb_build_array(checkpoint.output_envelope->>'renderAssetId'); END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(required_ids) AS required(asset_id) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(captured,'[]'::jsonb)) ref WHERE ref->>'assetId'=required.asset_id)) THEN RETURN NULL; END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>4096 THEN RETURN NULL; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(refs) LOOP
    IF jsonb_typeof(entry->'assetId') IS DISTINCT FROM 'string' OR entry->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(refs) ref LEFT JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.asset_id IS NULL OR(ref ? 'sha256' AND b.sha256 IS DISTINCT FROM ref->>'sha256') OR(ref ? 'bytesLength' AND b.bytes_length::text IS DISTINCT FROM ref->>'bytesLength') OR(ref ? 'mediaType' AND b.media_type IS DISTINCT FROM ref->>'mediaType')) THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetId',b.asset_id,'sha256',b.sha256,'bytesLength',b.bytes_length::text,'mediaType',b.media_type) ORDER BY b.asset_id),'[]'::jsonb) INTO frozen FROM manga_web.assets b WHERE b.account_id=a AND b.asset_id IN(SELECT DISTINCT(ref->>'assetId')::uuid FROM jsonb_array_elements(refs) ref);
  IF NOT manga_web.native_receipt_assets_current(frozen,p_now) THEN RETURN NULL; END IF;
  RETURN frozen;
END $$;

CREATE FUNCTION native_receipt_lookup(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; original manga_web.native_job_intents%ROWTYPE; proof manga_web.native_result_receipts%ROWTYPE; sampled timestamptz; origin_termination jsonb;
BEGIN
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
  SELECT * INTO original FROM manga_web.native_job_intents WHERE account_id=a AND job_id=candidate.job_id;
  SELECT o.protected_observation->'termination' INTO origin_termination FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='TERMINATION' ORDER BY o.received_at DESC,o.observation_id DESC LIMIT 1;
  IF candidate.kernel_implementation_digest IS DISTINCT FROM p->>'kernelImplementationDigest' OR candidate.verification_version<>'native-facade-verification-v1' OR original.task IS DISTINCT FROM p->>'task' OR original.task_version IS DISTINCT FROM p->>'taskVersion' OR original.profile_digest IS DISTINCT FROM p->>'profileDigest' THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_VERSION_CONFLICT','intent',original.protected_intent,'termination',origin_termination); END IF;
  IF (manga_web.native_receipt_retention(original.protected_intent,sampled)->>'available') IS DISTINCT FROM 'true' OR NOT manga_web.native_receipt_assets_current(candidate.source_asset_dependencies,sampled) OR(candidate.access_deadline IS NOT NULL AND sampled>=candidate.access_deadline) OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidate.protected_candidate->'blobs') ref JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND sampled>=b.access_deadline)) THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_RETENTION_EXPIRED','intent',original.protected_intent,'termination',origin_termination); END IF;
  SELECT * INTO proof FROM manga_web.native_result_receipts WHERE account_id=a AND candidate_id=candidate.candidate_id;
  IF proof.candidate_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(candidate.protected_candidate->'blobs') ref LEFT JOIN manga_web.assets b ON b.account_id=a AND b.asset_id=(ref->>'assetId')::uuid WHERE b.asset_id IS NULL OR b.sha256 IS DISTINCT FROM ref->>'sha256' OR b.bytes_length::text IS DISTINCT FROM ref->>'bytesLength' OR b.object_key IS DISTINCT FROM a::text||'/'||(ref->>'assetId') OR b.purpose IS DISTINCT FROM candidate.asset_purpose OR b.related_context_id IS DISTINCT FROM candidate.related_context_id OR b.media_type IS DISTINCT FROM 'application/octet-stream') THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_OBJECT_CONFLICT','intent',original.protected_intent,'termination',origin_termination); END IF;
  IF EXISTS(SELECT 1 FROM manga_web.native_job_observations o WHERE o.account_id=a AND o.job_id=original.job_id AND o.event='ERROR') THEN RETURN jsonb_build_object('state','CONFLICT','reason','NATIVE_RECEIPT_UNCONFIRMED','intent',original.protected_intent,'termination',origin_termination); END IF;
  RETURN jsonb_build_object('state',CASE WHEN proof.candidate_id IS NULL THEN 'PENDING_OR_UNCONFIRMED' ELSE 'VERIFIED' END,'reason',CASE WHEN proof.candidate_id IS NULL THEN 'NATIVE_RECEIPT_UNCONFIRMED' ELSE 'VERIFIED' END,'candidate',candidate.protected_candidate,'receipt',proof.protected_receipt,'intent',original.protected_intent,'termination',origin_termination);
END $$;

CREATE FUNCTION native_receipt_prepare(p jsonb,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); original manga_web.native_job_intents%ROWTYPE; observation manga_web.native_job_observations%ROWTYPE; prior manga_web.native_result_candidates%ROWTYPE; result_frame jsonb; input_frame jsonb; retention jsonb; sources jsonb; field text; entry jsonb; position integer:=0; expected jsonb; sampled timestamptz; seal text;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p_target) OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16777216 OR(SELECT count(*) FROM jsonb_object_keys(p))<>13 OR NOT p ?& ARRAY['version','candidateId','jobId','parentInstanceId','operationInputDigest','kernelImplementationDigest','verificationVersion','resultObservationId','resultObservationDigest','resultDigest','inputCanonical','resultCanonical','blobs'] OR p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'verificationVersion' IS DISTINCT FROM 'native-facade-verification-v1' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
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

CREATE FUNCTION native_receipt_object_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(p))<>5 OR NOT p ?& ARRAY['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds'] OR jsonb_typeof(p->'key') IS DISTINCT FROM 'string' OR p->>'key' !~* '^[0-9a-f-]{36}/[0-9a-f-]{36}$' OR jsonb_typeof(p->'sha256') IS DISTINCT FROM 'string' OR p->>'sha256' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p->'bytesLength') IS DISTINCT FROM 'string' OR p->>'bytesLength' !~ '^(0|[1-9][0-9]{0,15})$' OR(p->>'bytesLength')::numeric>9007199254740991 OR jsonb_typeof(p->'completedAt') IS DISTINCT FROM 'string' OR p->>'completedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' OR p->'completedAtPrecisionMilliseconds' NOT IN ('1'::jsonb,'1000'::jsonb) THEN RETURN false; END IF;
  PERFORM(p->>'completedAt')::timestamptz;
  IF p->'completedAtPrecisionMilliseconds'='1000'::jsonb AND p->>'completedAt' !~ '\.000Z$' THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

-- NULL target is a worker-only Library retention reconciliation. It records
-- the original object's receipt, including after expiry, and grants no read,
-- verification, PUT retry or successful user store operation.
CREATE FUNCTION native_receipt_register_asset(p_candidate uuid,p_blob text,p_receipt jsonb,p_bucket text,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; prior manga_web.assets%ROWTYPE; ref jsonb; completed timestamptz; deadline timestamptz; original_deadline timestamptz; sampled timestamptz;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=a AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
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

CREATE FUNCTION native_receipt_verify(p_candidate uuid,p jsonb,p_target jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account(); service text:=manga_web.native_job_caller(); candidate manga_web.native_result_candidates%ROWTYPE; original manga_web.native_job_intents%ROWTYPE; prior manga_web.native_result_receipts%ROWTYPE; entry jsonb; ref jsonb; position integer:=0; asset manga_web.assets%ROWTYPE; seal text; sampled timestamptz;
BEGIN
  IF a IS NULL OR service IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a AND access_state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','ACCOUNT_ACCESS_DENIED'); END IF;
  SELECT * INTO candidate FROM manga_web.native_result_candidates WHERE account_id=a AND candidate_id=p_candidate;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_RECEIPT_FENCE_REJECTED'); END IF;
  IF NOT manga_web.native_receipt_lookup_valid(p_target) OR p_target->>'operationInputDigest' IS DISTINCT FROM candidate.operation_input_digest OR p_target->>'kernelImplementationDigest' IS DISTINCT FROM candidate.kernel_implementation_digest OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>1048576 OR(SELECT count(*) FROM jsonb_object_keys(p))<>5 OR NOT p ?& ARRAY['version','candidateId','kernelImplementationDigest','verificationVersion','blobs'] OR p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'candidateId' IS DISTINCT FROM p_candidate::text OR p->>'kernelImplementationDigest' IS DISTINCT FROM candidate.kernel_implementation_digest OR p->>'verificationVersion' IS DISTINCT FROM candidate.verification_version OR jsonb_typeof(p->'blobs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'blobs')<>jsonb_array_length(candidate.protected_candidate->'blobs') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_RECEIPT_INVALID'; END IF;
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

CREATE FUNCTION native_receipt_library_candidates(p_after_at timestamptz,p_after_id uuid,p_through timestamptz) RETURNS TABLE(candidate_id uuid,created_at_cursor text,blobs jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT c.candidate_id,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),c.protected_candidate->'blobs' FROM manga_web.native_result_candidates c WHERE c.account_id=manga_web.current_account() AND c.asset_purpose='LIBRARY' AND manga_web.native_job_caller()='trio_web_worker' AND p_through IS NOT NULL AND isfinite(p_through) AND p_through<=clock_timestamp() AND c.created_at<=p_through AND((p_after_at IS NULL AND p_after_id IS NULL) OR(c.created_at,c.candidate_id)>(p_after_at,p_after_id)) ORDER BY c.created_at,c.candidate_id LIMIT 16
$$;
REVOKE ALL ON FUNCTION native_receipt_create_intent(jsonb),native_receipt_lookup_valid(jsonb),native_receipt_retention(jsonb,timestamptz),native_receipt_assets_current(jsonb,timestamptz),native_receipt_source_assets(jsonb,jsonb,timestamptz),native_receipt_object_valid(jsonb),native_receipt_lookup(jsonb),native_receipt_prepare(jsonb,jsonb),native_receipt_register_asset(uuid,text,jsonb,text,jsonb),native_receipt_verify(uuid,jsonb,jsonb),native_receipt_library_candidates(timestamptz,uuid,timestamptz) FROM PUBLIC,trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION native_receipt_create_intent(jsonb),native_receipt_lookup(jsonb),native_receipt_prepare(jsonb,jsonb),native_receipt_register_asset(uuid,text,jsonb,text,jsonb),native_receipt_verify(uuid,jsonb,jsonb) TO trio_web_api,trio_web_worker;
GRANT EXECUTE ON FUNCTION native_receipt_library_candidates(timestamptz,uuid,timestamptz) TO trio_web_worker;
