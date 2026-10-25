-- W3-B Windows raw 객체 접근의 현재 권한 경계.
-- 0016 원 raw 조회의 v1 경로·bucket/source/retention/asset 검사는 보존한다.
-- 기존 함수 OID/서명/ACL을 유지하며 새 실행 권한·설정·활성화를 추가하지 않는다.
SET LOCAL search_path TO manga_web,pg_catalog;
CREATE OR REPLACE FUNCTION native_controller_raw_lookup(p_binding jsonb,p_controller uuid,p_peer_service text,p_bucket text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE original manga_web.native_controller_attempts%ROWTYPE; raw manga_web.native_controller_raw_results%ROWTYPE; sampled timestamptz:=clock_timestamp(); deadline timestamptz; original_deadline timestamptz; owner_capture jsonb;
BEGIN
  original:=manga_web.native_controller_original(p_binding,p_controller,p_peer_service);
  -- Windows bytes 접근은 원 이력 검증과 분리해 현재 계정·소유권을 확인한다.
  -- 이미 소비한 GO를 다시 검사하거나 새 attempt/GO를 만들지 않는다.
  IF original.protected_capacity->'reference'->>'kind'='WINDOWS_JOB_OBJECT' THEN
    SELECT protected_intent->'protectedOwnerCapture' INTO owner_capture
      FROM manga_web.native_job_intents WHERE account_id=original.account_id AND job_id=original.job_id;
    IF NOT FOUND OR manga_web.windows_native_owner_current(owner_capture) IS DISTINCT FROM true THEN
      RETURN jsonb_build_object('allowed',true,'available',false);
    END IF;
    -- 첫 검사에서 획득한 account/context/session/binding 잠금을 유지한 채
    -- 새 시각으로 만료를 재검사한다. 잠금 대기 전 시각은 재사용하지 않는다.
    IF manga_web.windows_native_owner_current(owner_capture) IS DISTINCT FROM true THEN
      RETURN jsonb_build_object('allowed',true,'available',false);
    END IF;
    sampled:=clock_timestamp();
  END IF;
  SELECT * INTO raw FROM manga_web.native_controller_raw_results WHERE account_id=original.account_id AND attempt_id=original.attempt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',true,'available',false);END IF;
  IF raw.bucket_ref IS DISTINCT FROM p_bucket THEN RETURN jsonb_build_object('allowed',false,'reason','NATIVE_CONTROL_RAW_MISMATCH');END IF;
  deadline:=original.access_deadline;
  IF original.asset_purpose='LIBRARY' THEN
    -- The original Library receipt may confirm its expiry after this attempt
    -- was captured. An immutable NULL capture cannot extend that later fact.
    SELECT l.expires_at INTO original_deadline FROM manga_web.library_store_operations l JOIN manga_web.native_job_intents i ON i.account_id=l.account_id AND i.target_id=l.store_operation_id AND i.target_kind='LIBRARY' WHERE i.account_id=original.account_id AND i.job_id=original.job_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('allowed',true,'available',false);END IF;
    deadline:=least(deadline,original_deadline);
    SELECT least(deadline,min((protected_receipt->>'completedAt')::timestamptz)+interval '30 days') INTO deadline FROM manga_web.native_controller_object_receipts WHERE account_id=original.account_id AND raw_result_id=raw.raw_result_id;
  END IF;
  RETURN jsonb_build_object('allowed',true,'available',(deadline IS NULL OR sampled<deadline) AND manga_web.native_receipt_assets_current(original.source_asset_dependencies,sampled) AND NOT EXISTS(SELECT 1 FROM manga_web.native_controller_object_receipts r LEFT JOIN manga_web.assets b ON b.account_id=r.account_id AND b.asset_id=r.asset_id WHERE r.account_id=original.account_id AND r.raw_result_id=raw.raw_result_id AND(b.asset_id IS NULL OR b.bucket_ref IS DISTINCT FROM raw.bucket_ref OR b.object_key IS DISTINCT FROM r.protected_receipt->>'key' OR b.sha256 IS DISTINCT FROM r.protected_receipt->>'sha256' OR b.bytes_length IS DISTINCT FROM(r.protected_receipt->>'bytesLength')::bigint OR b.purpose IS DISTINCT FROM original.asset_purpose OR b.related_context_id IS DISTINCT FROM original.related_context_id OR b.object_created_at IS DISTINCT FROM(r.protected_receipt->>'completedAt')::timestamptz OR b.media_type IS DISTINCT FROM 'application/octet-stream' OR b.deletion_state='CONFIRMED' OR(b.access_deadline IS NOT NULL AND sampled>=b.access_deadline))),
    'allocation',jsonb_build_object('attemptId',original.attempt_id,'reference',jsonb_build_object('rawResultId',raw.raw_result_id,'resultDigest',raw.result_digest),'result',raw.result_canonical::jsonb),'blobRefs',raw.blob_refs);
END $$;
