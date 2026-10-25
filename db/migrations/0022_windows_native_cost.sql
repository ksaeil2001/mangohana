-- W4-A records historical, non-billing Windows facts and releases only native slots.
-- The original link is verified cryptographically by the isolated TS operator;
-- its signature is retained as an original link signature, never a metadata signature.
SET LOCAL search_path TO manga_web,pg_catalog;

CREATE TABLE windows_native_termination_proofs(
  account_id uuid NOT NULL,proof_id uuid NOT NULL,reservation_id uuid NOT NULL,adoption_id uuid NOT NULL,
  source_execution_id uuid NOT NULL,source_input_evidence_id uuid NOT NULL,
  proof_metadata jsonb NOT NULL CHECK(jsonb_typeof(proof_metadata)='object' AND octet_length(proof_metadata::text)<=16384),
  proof_digest text NOT NULL CHECK(proof_digest~'^[a-f0-9]{64}$'),
  link_canonical text NOT NULL CHECK(octet_length(link_canonical)<=32768),
  link_signature text NOT NULL CHECK(link_signature~'^[A-Za-z0-9+/]{86}==$'),
  observation_id uuid NOT NULL,observation_digest text NOT NULL CHECK(observation_digest~'^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,proof_id),UNIQUE(account_id,reservation_id),UNIQUE(proof_digest),
  FOREIGN KEY(account_id,reservation_id) REFERENCES native_capacity_reservations(account_id,reservation_id),
  FOREIGN KEY(account_id,adoption_id) REFERENCES native_capacity_reservations(account_id,adoption_id),
  FOREIGN KEY(account_id,source_execution_id) REFERENCES executions(account_id,execution_id),
  FOREIGN KEY(account_id,source_input_evidence_id) REFERENCES execution_evidence(account_id,evidence_id),
  FOREIGN KEY(account_id,observation_id) REFERENCES native_job_observations(account_id,observation_id)
);
ALTER TABLE windows_native_termination_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE windows_native_termination_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON windows_native_termination_proofs USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
REVOKE ALL ON windows_native_termination_proofs FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE OR TRUNCATE ON windows_native_termination_proofs FOR EACH STATEMENT EXECUTE FUNCTION immutable_native_job_record();
ALTER TABLE native_capacity_reservations ADD COLUMN windows_release_proof_id uuid;
ALTER TABLE native_capacity_reservations ADD FOREIGN KEY(account_id,windows_release_proof_id) REFERENCES windows_native_termination_proofs(account_id,proof_id);
DO $state_check$ DECLARE names text[];BEGIN
  SELECT array_agg(conname::text) INTO names FROM pg_catalog.pg_constraint WHERE conrelid='manga_web.native_capacity_reservations'::regclass AND contype='c'
    AND position('release_proof_id' IN pg_catalog.pg_get_constraintdef(oid))>0 AND position('released_at' IN pg_catalog.pg_get_constraintdef(oid))>0;
  IF cardinality(names) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'NATIVE_CAPACITY_RELEASE_CHECK_UNCONFIRMED';END IF;
  EXECUTE format('ALTER TABLE manga_web.native_capacity_reservations DROP CONSTRAINT %I',names[1]);
END $state_check$;
ALTER TABLE native_capacity_reservations ADD CONSTRAINT native_capacity_release_state CHECK(
  (state='HELD' AND released_at IS NULL AND release_proof_id IS NULL AND windows_release_proof_id IS NULL) OR
  (state='RELEASED' AND released_at IS NOT NULL AND ((release_proof_id IS NOT NULL AND windows_release_proof_id IS NULL) OR (release_proof_id IS NULL AND windows_release_proof_id IS NOT NULL)))
);

-- Profile-directed private lookup. No service receives table or helper access.
CREATE FUNCTION native_capacity_registered_proof(p_account uuid,p_reservation uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT CASE p.profile_payload->>'kind' WHEN 'OWNED_FIXTURE' THEN v.proof_id WHEN 'WINDOWS_JOB_OBJECT' THEN w.proof_id END
  FROM manga_web.native_capacity_reservations r JOIN manga_web.native_capacity_profiles p ON p.profile_id=r.profile_id
  LEFT JOIN manga_web.native_capacity_termination_proofs v ON v.account_id=r.account_id AND v.reservation_id=r.reservation_id
  LEFT JOIN manga_web.windows_native_termination_proofs w ON w.account_id=r.account_id AND w.reservation_id=r.reservation_id AND w.adoption_id=r.adoption_id
    AND w.source_execution_id=r.source_execution_id AND w.source_input_evidence_id=r.source_input_evidence_id
  WHERE r.account_id=p_account AND r.reservation_id=p_reservation
$$;
CREATE OR REPLACE FUNCTION native_capacity_reservation_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE registered_kind text;confirmed timestamptz;
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','released_at','release_proof_id','windows_release_proof_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','released_at','release_proof_id','windows_release_proof_id']) OR OLD.state<>'HELD' OR NEW.state<>'RELEASED' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_IMMUTABLE';END IF;
  SELECT profile_payload->>'kind' INTO registered_kind FROM manga_web.native_capacity_profiles WHERE profile_id=OLD.profile_id;
  IF registered_kind='OWNED_FIXTURE' AND NEW.windows_release_proof_id IS NULL THEN
    SELECT confirmed_at INTO confirmed FROM manga_web.native_capacity_termination_proofs WHERE account_id=OLD.account_id AND reservation_id=OLD.reservation_id AND proof_id=NEW.release_proof_id;
  ELSIF registered_kind='WINDOWS_JOB_OBJECT' AND NEW.release_proof_id IS NULL THEN
    SELECT confirmed_at INTO confirmed FROM manga_web.windows_native_termination_proofs WHERE account_id=OLD.account_id AND reservation_id=OLD.reservation_id AND proof_id=NEW.windows_release_proof_id AND adoption_id=OLD.adoption_id AND source_execution_id=OLD.source_execution_id AND source_input_evidence_id=OLD.source_input_evidence_id;
  END IF;
  IF confirmed IS NULL OR NEW.released_at IS NULL OR confirmed>NEW.released_at THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='NATIVE_CAPACITY_PROOF_UNCONFIRMED';END IF;RETURN NEW;
END $$;

-- Historical validation has no current owner, lease, account access-state or
-- retention checks. These are still required by the original object/GO gates.
CREATE FUNCTION windows_native_evidence_bundle(p_key jsonb,p_owner text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp SET timezone='UTC' AS $$
DECLARE b jsonb:=p_key->'binding';expected jsonb:=p_key->'expected';r manga_web.native_capacity_reservations%ROWTYPE;i manga_web.native_job_intents%ROWTYPE;
  a manga_web.native_controller_attempts%ROWTYPE;o manga_web.windows_native_origins%ROWTYPE;p manga_web.native_capacity_profiles%ROWTYPE;
  s manga_web.windows_native_records%ROWTYPE;j manga_web.windows_native_records%ROWTYPE;z manga_web.windows_native_records%ROWTYPE;l manga_web.windows_native_links%ROWTYPE;
  v jsonb;f jsonb;origin jsonb;auth jsonb;e jsonb;t jsonb;ob jsonb;row record;previous text:=NULL;counter integer:=0;created boolean;digests jsonb;bundle jsonb;
BEGIN
  IF p_key IS NULL OR octet_length(p_key::text)>8192 OR NOT manga_web.windows_native_object(p_key,ARRAY['binding','expected']) OR NOT manga_web.native_controller_binding_valid(b)
    OR NOT manga_web.windows_native_shape(expected,'{"recordId":"uuid","recordDigest":"hex","linkId":"uuid","linkDigest":"hex"}') THEN RETURN NULL;END IF;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=(b->>'accountId')::uuid AND reservation_id=(b->>'capacityReservationId')::uuid;
  SELECT * INTO i FROM manga_web.native_job_intents WHERE account_id=r.account_id AND job_id=r.job_id;
  SELECT * INTO p FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
  SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=r.account_id AND reservation_id=r.reservation_id;
  SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=a.account_id AND attempt_id=a.attempt_id;
  IF r.account_id IS NULL OR i.job_id IS NULL OR a.attempt_id IS NULL OR o.attempt_id IS NULL OR a.protected_binding IS DISTINCT FROM b OR r.job_id IS DISTINCT FROM a.job_id
    OR r.owner_service IS DISTINCT FROM i.owner_service OR a.owner_service IS DISTINCT FROM i.owner_service OR (p_owner IS NOT NULL AND r.owner_service IS DISTINCT FROM p_owner)
    OR p.profile_payload->>'kind' IS DISTINCT FROM 'WINDOWS_JOB_OBJECT' OR NOT manga_web.native_capacity_windows_profile_valid(p.profile_payload)
    OR p.profile_digest IS DISTINCT FROM encode(sha256(convert_to(p.profile_payload::text,'UTF8')),'hex') OR p.profile_digest IS DISTINCT FROM r.profile_digest OR p.profile_version IS DISTINCT FROM r.profile_version
    OR i.intent_digest IS DISTINCT FROM encode(sha256(convert_to(i.protected_intent::text,'UTF8')),'hex') OR NOT manga_web.native_job_valid_tuple(i.protected_intent)
    OR i.protected_intent->>'jobId' IS DISTINCT FROM r.job_id::text OR i.protected_intent->>'parentInstanceId' IS DISTINCT FROM b->>'parentInstanceId'
    OR i.protected_intent->>'inputDigest' IS DISTINCT FROM b->>'inputDigest' OR i.protected_intent->>'profileDigest' IS DISTINCT FROM b->>'profileDigest'
    OR i.profile_digest IS DISTINCT FROM p.native_profile_digest OR b->>'kernelDigest' IS DISTINCT FROM p.kernel_digest
    OR i.logical_operation_key IS DISTINCT FROM manga_web.native_job_logical_key(i.protected_intent) OR i.protected_intent->>'logicalOperationKey' IS DISTINCT FROM i.logical_operation_key
    OR i.protected_intent->>'targetId' IS DISTINCT FROM i.target_id::text OR i.protected_intent->>'targetKind' IS DISTINCT FROM i.target_kind
    OR r.source_execution_id IS NULL OR r.source_input_evidence_id IS NULL THEN RETURN NULL;END IF;
  IF octet_length(a.input_canonical)>131072 OR octet_length(a.protected_job::text)>131072 OR octet_length(o.origin_canonical)>131072
    -- Match the original SQL INPUT/BASIS value cap (jsonb::text); snapshot refs
    -- are bounded by their own closed UUID/digest grammar, not charged twice.
    OR octet_length((o.input_snapshot->'value')::text)>131072 OR octet_length((o.basis_snapshot->'value')::text)>131072
    OR octet_length(p.profile_payload::text)>16384 OR (SELECT count(*) FROM manga_web.windows_native_events WHERE account_id=r.account_id AND attempt_id=a.attempt_id)>64
    OR EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND octet_length(event_canonical)+octet_length(source_canonical)>131072)
    OR EXISTS(SELECT 1 FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND octet_length(canonical)>65536)
    OR (SELECT count(*) FROM manga_web.execution_evidence WHERE account_id=r.account_id AND execution_id=r.source_execution_id AND kind='INPUT')<>1 THEN RETURN NULL;END IF;
  IF a.input_canonical::jsonb IS DISTINCT FROM a.protected_job-'inputDigest' OR encode(sha256(convert_to(a.input_canonical,'UTF8')),'hex') IS DISTINCT FROM i.input_digest
    OR a.protected_job->>'inputDigest' IS DISTINCT FROM i.input_digest OR a.protected_job->>'jobId' IS DISTINCT FROM i.job_id::text
    OR a.protected_job->>'task' IS DISTINCT FROM i.task OR a.protected_job->>'taskVersion' IS DISTINCT FROM i.task_version OR a.protected_job->>'profileDigest' IS DISTINCT FROM i.profile_digest THEN RETURN NULL;END IF;
  origin:=manga_web.windows_native_parse(o.origin_canonical,131072);auth:=origin->'authority';
  IF origin IS DISTINCT FROM o.protected_origin OR origin->'identity'->'binding' IS DISTINCT FROM b OR origin->'identity'->>'intentDigest' IS DISTINCT FROM i.intent_digest
    OR origin->'identity'->'sourceInput'->>'executionId' IS DISTINCT FROM r.source_execution_id::text OR origin->'identity'->'sourceInput'->>'inputEvidenceId' IS DISTINCT FROM r.source_input_evidence_id::text
    OR auth->>'attemptId' IS DISTINCT FROM a.attempt_id::text OR auth->>'controllerInstanceId' IS DISTINCT FROM a.controller_instance_id::text OR auth->>'controllerId' IS DISTINCT FROM p.controller_id::text
    OR a.controller_id IS DISTINCT FROM p.controller_id OR auth->>'keyVersion' IS DISTINCT FROM p.key_version OR auth->>'environmentDigest' IS DISTINCT FROM p.environment_digest
    OR auth->>'hostEpochId' IS DISTINCT FROM p.profile_payload->'windows'->>'hostEpochId' OR origin->'policy' IS DISTINCT FROM p.profile_payload->'windows'->'policy'
    OR origin->'pins' IS DISTINCT FROM p.profile_payload->'windows'->'pins' OR auth->>'policyDigest' IS DISTINCT FROM manga_web.windows_native_hash(origin->'policy')
    OR origin->'pins'->>'nativeLimitsDigest' IS DISTINCT FROM manga_web.windows_native_hash(origin->'limits')
    OR auth->>'controllerSidDigest' IS DISTINCT FROM p.profile_payload->'windows'->>'controllerSidDigest' OR auth->>'childSidDigest' IS DISTINCT FROM p.profile_payload->'windows'->>'childSidDigest'
    OR auth->>'appContainerSidDigest' IS DISTINCT FROM p.profile_payload->'windows'->>'appContainerSidDigest'
    OR o.frame_input_digest IS DISTINCT FROM i.input_digest OR o.origin_digest IS DISTINCT FROM manga_web.windows_native_hash(jsonb_build_object('identity',origin->'identity','authority',auth,'pins',origin->'pins','policy',origin->'policy','nativeLimitsDigest',manga_web.windows_native_hash(origin->'limits'),'frameInputDigest',i.input_digest)) THEN RETURN NULL;END IF;
  IF a.protected_capacity IS DISTINCT FROM jsonb_build_object('reference',jsonb_build_object('kind','WINDOWS_JOB_OBJECT','profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version),'profile',p.profile_payload,'sourceInput',origin->'identity'->'sourceInput') THEN RETURN NULL;END IF;
  SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='SEAL';
  SELECT * INTO j FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='PARENT_JOIN';
  SELECT * INTO z FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='FINALIZED';
  SELECT * INTO l FROM manga_web.windows_native_links WHERE account_id=r.account_id AND attempt_id=a.attempt_id;
  IF s.record_id IS NULL OR j.record_id IS NULL OR z.record_id IS NULL OR l.link_id IS NULL OR octet_length(l.canonical)>32768 OR l.link_id::text IS DISTINCT FROM expected->>'linkId' OR l.digest IS DISTINCT FROM expected->>'linkDigest'
    OR s.record_id::text IS DISTINCT FROM expected->>'recordId' OR s.digest IS DISTINCT FROM expected->>'recordDigest'
    OR l.signature!~'^[A-Za-z0-9+/]{86}==$' OR octet_length(decode(l.signature,'base64'))<>64 OR replace(encode(decode(l.signature,'base64'),'base64'),E'\n','') IS DISTINCT FROM l.signature THEN RETURN NULL;END IF;
  FOR row IN SELECT * FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id LOOP
    IF manga_web.windows_native_parse(row.canonical,65536) IS DISTINCT FROM row.protected_record OR row.digest IS DISTINCT FROM encode(sha256(convert_to(row.canonical,'UTF8')),'hex') THEN RETURN NULL;END IF;
  END LOOP;
  e:=s.protected_record->'evidence';created:=e->'final'->>'outcome'='JOB_EMPTY';
  IF NOT manga_web.windows_native_object(s.protected_record,ARRAY['version','originDigest','evidence','entries','parentJoinAck']) OR s.protected_record->'version' IS DISTINCT FROM '1'::jsonb
    OR s.protected_record->>'originDigest' IS DISTINCT FROM o.origin_digest OR e->'identity' IS DISTINCT FROM origin->'identity' OR e->'authority' IS DISTINCT FROM auth
    OR e->'pins' IS DISTINCT FROM origin->'pins' OR e->'policy'->'requested' IS DISTINCT FROM origin->'policy' OR manga_web.windows_native_seal_valid(r.account_id,a.attempt_id,s.protected_record) IS DISTINCT FROM true
    OR e->'final'->>'outcome' NOT IN('JOB_EMPTY','NO_CHILD_CREATED') OR e->'final'->'parentIoJoined' IS DISTINCT FROM 'true'::jsonb OR e->'final'->'recordSealed' IS DISTINCT FROM 'true'::jsonb
    OR s.protected_record->'parentJoinAck' IS DISTINCT FROM j.protected_record OR j.protected_record->>'joinId' IS DISTINCT FROM j.record_id::text OR j.protected_record->>'originDigest' IS DISTINCT FROM o.origin_digest
    OR z.protected_record IS DISTINCT FROM jsonb_build_object('version',1,'originDigest',o.origin_digest,'finalized',jsonb_build_object('recordId',s.record_id,'digest',s.digest,'handles','CLOSED','closeCode',NULL),'brokerJoin',jsonb_build_object('end','EXPECTED','finalized',jsonb_build_object('recordId',s.record_id,'digest',s.digest,'handles','CLOSED','closeCode',NULL))) THEN RETURN NULL;END IF;
  FOR row IN SELECT * FROM manga_web.windows_native_events WHERE account_id=r.account_id AND attempt_id=a.attempt_id ORDER BY sequence LOOP
    counter:=counter+1;
    IF row.sequence<>counter OR row.protected_event->>'previousDigest' IS DISTINCT FROM previous OR row.protected_event->>'eventId' IS DISTINCT FROM row.event_id::text
      OR row.protected_event->>'kind' IS DISTINCT FROM row.kind OR row.protected_event->'sequence' IS DISTINCT FROM to_jsonb(row.sequence)
      OR manga_web.windows_native_parse(row.event_canonical,131072) IS DISTINCT FROM row.protected_event OR manga_web.windows_native_parse(row.source_canonical,131072) IS DISTINCT FROM row.protected_source
      OR row.payload_digest IS DISTINCT FROM manga_web.windows_native_hash(row.protected_event-'payloadDigest') OR row.protected_event->>'payloadDigest' IS DISTINCT FROM row.payload_digest
      OR row.source_digest IS DISTINCT FROM manga_web.windows_native_hash(row.protected_source) OR row.protected_source->>'originDigest' IS DISTINCT FROM o.origin_digest OR row.protected_source->>'eventId' IS DISTINCT FROM row.event_id::text
      OR s.protected_record->'entries'->(counter-1) IS DISTINCT FROM jsonb_build_object('eventId',row.event_id,'payloadDigest',row.payload_digest,'sourceDigest',row.source_digest)
      OR e->'lifecycle'->'events'->(counter-1) IS DISTINCT FROM row.protected_event THEN RETURN NULL;END IF;previous:=row.payload_digest;
  END LOOP;
  IF counter<2 OR jsonb_array_length(s.protected_record->'entries')<>counter OR jsonb_array_length(e->'lifecycle'->'events')<>counter THEN RETURN NULL;END IF;
  v:=manga_web.windows_native_view(r.account_id,a.attempt_id);f:=v->'facts';
  IF v->'view'->'windowsEvidenceRef' IS DISTINCT FROM expected OR l.protected_link IS DISTINCT FROM manga_web.windows_native_parse(l.canonical,32768)
    OR l.protected_link IS DISTINCT FROM manga_web.windows_native_link_body(r.account_id,a.attempt_id) OR l.digest IS DISTINCT FROM encode(sha256(convert_to(l.canonical,'UTF8')),'hex')
    OR f->'input'->>'evidenceId' IS DISTINCT FROM r.source_input_evidence_id::text OR f->'input'->>'evidenceDigest' IS DISTINCT FROM origin->'identity'->>'inputEvidenceDigest'
    OR f->'input'->>'evidenceDigest' IS DISTINCT FROM origin->'identity'->>'inputFingerprint' OR f->'input'->'value'->>'accountId' IS DISTINCT FROM r.account_id::text
    OR f->'input'->'value'->>'executionId' IS DISTINCT FROM r.source_execution_id::text OR f->'input'->'value'->>'inputDigest' IS DISTINCT FROM origin->'identity'->'sourceInput'->>'stageInputDigest'
    OR f->'input' IS DISTINCT FROM o.input_snapshot OR f->'input'->'value'->'envelope'->>'executionId' IS DISTINCT FROM r.source_execution_id::text
    OR f->'input'->'value'->'envelope'->>'inputDigest' IS DISTINCT FROM f->'input'->'value'->>'inputDigest'
    OR f->'input'->'value'->'envelope'->'capturedSettings' IS DISTINCT FROM f->'input'->'value'->'settings' THEN RETURN NULL;END IF;
  IF octet_length((f->'input'->'value')::text)>131072 OR octet_length((f->'basis'->'value')::text)>131072 THEN RETURN NULL;END IF;
  IF l.protected_link->'basis'='null'::jsonb THEN IF f->'basis' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL;END IF;
  ELSIF f->'basis'='null'::jsonb OR (f->'basis')-'value' IS DISTINCT FROM l.protected_link->'basis' OR (o.basis_snapshot IS NOT NULL AND f->'basis' IS DISTINCT FROM o.basis_snapshot) THEN RETURN NULL;END IF;
  IF origin->'identity'->'basisRef'<>'null'::jsonb AND origin->'identity'->'basisRef' IS DISTINCT FROM l.protected_link->'basis' THEN RETURN NULL;END IF;
  IF e->'lifecycle'->'goGrantRef' IS DISTINCT FROM f->'goGrantRef' THEN RETURN NULL;END IF;
  IF created THEN
    IF e->'lifecycle'->>'goWrite' IS DISTINCT FROM 'RETURNED' OR f->'goGrantRef'='null'::jsonb OR f->'rawResult'='null'::jsonb OR e->'final'->'accounting'='null'::jsonb
      OR (SELECT count(*) FROM manga_web.native_controller_object_receipts q JOIN manga_web.native_controller_raw_results raw USING(account_id,raw_result_id) WHERE raw.account_id=r.account_id AND raw.attempt_id=a.attempt_id) IS DISTINCT FROM
         (SELECT jsonb_array_length(blob_refs) FROM manga_web.native_controller_raw_results WHERE account_id=r.account_id AND attempt_id=a.attempt_id) THEN RETURN NULL;END IF;
    IF EXISTS(SELECT 1 FROM manga_web.native_controller_raw_results raw CROSS JOIN LATERAL jsonb_array_elements(raw.blob_refs) ref
      LEFT JOIN manga_web.native_controller_object_receipts receipt ON receipt.account_id=raw.account_id AND receipt.raw_result_id=raw.raw_result_id AND receipt.blob_id=ref->>'blobId'
      WHERE raw.account_id=r.account_id AND raw.attempt_id=a.attempt_id AND (receipt.blob_id IS NULL OR receipt.protected_receipt->>'sha256' IS DISTINCT FROM ref->>'sha256' OR receipt.protected_receipt->>'bytesLength' IS DISTINCT FROM ref->>'bytesLength')) THEN RETURN NULL;END IF;
  ELSE
    IF e->'lifecycle'->>'creation' NOT IN('NOT_ATTEMPTED','FAILED') OR e->'lifecycle'->>'goWrite' IS DISTINCT FROM 'NOT_ATTEMPTED' OR f->'goGrantRef' IS DISTINCT FROM 'null'::jsonb OR f->'rawResult' IS DISTINCT FROM 'null'::jsonb
      OR EXISTS(SELECT 1 FROM manga_web.native_controller_go_grants WHERE account_id=r.account_id AND job_id=r.job_id)
      OR EXISTS(SELECT 1 FROM manga_web.native_job_go_consumptions WHERE account_id=r.account_id AND job_id=r.job_id)
      OR NOT EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND kind IN('CREATE_NOT_ATTEMPTED','CREATE_FAILED')) THEN RETURN NULL;END IF;
  END IF;
  t:=jsonb_build_object('jobId',r.job_id,'inputDigest',i.input_digest,'profileDigest',i.profile_digest,'goAttempted',created,'startedComputation',created,'directChildClosed',created,'subtreeTerminationConfirmed',created,'operationJoined',true,'kind',CASE WHEN created THEN 'WINDOWS_JOB_EMPTY' ELSE 'NO_CHILD_CREATED' END,'isolation','WINDOWS_JOB_OBJECT');
  counter:=0;digests:='[]'::jsonb;
  FOR row IN SELECT value FROM jsonb_array_elements(f->'observations') LOOP
    ob:=jsonb_build_object('version',2,'parentInstanceId',i.parent_instance_id,'event',CASE WHEN created AND counter=0 THEN 'RESULT' ELSE 'TERMINATION' END,'code','OK','resultDigest',CASE WHEN created AND counter=0 THEN f->'rawResult'->>'resultDigest' ELSE NULL END,'termination',t,'windowsRecordRef',jsonb_build_object('recordId',s.record_id,'recordDigest',s.digest));
    IF row.value->'value' IS DISTINCT FROM ob OR row.value->>'evidenceDigest' IS DISTINCT FROM encode(sha256(convert_to(ob::text,'UTF8')),'hex') THEN RETURN NULL;END IF;
    digests:=digests||jsonb_build_array(row.value->>'evidenceDigest');counter:=counter+1;
  END LOOP;
  IF counter<>(CASE WHEN created THEN 2 ELSE 1 END) THEN RETURN NULL;END IF;
  bundle:=jsonb_build_object('state',v,'observationDigests',digests,'original',jsonb_build_object('reservationId',r.reservation_id,'adoptionId',r.adoption_id,'sourceExecutionId',r.source_execution_id,'sourceInputEvidenceId',r.source_input_evidence_id,'ownerService',r.owner_service,'profileId',r.profile_id,'profileDigest',r.profile_digest,'profileVersion',r.profile_version,'protectedIntent',i.protected_intent,'intentDigest',i.intent_digest,'actualIntentDigest',encode(sha256(convert_to(i.protected_intent::text,'UTF8')),'hex')),'job',a.protected_job);
  RETURN CASE WHEN octet_length(bundle::text)<=1572864 THEN bundle ELSE NULL END;
EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

CREATE FUNCTION windows_native_evidence_values(p_bundle jsonb,p_key jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE f jsonb:=p_bundle->'state'->'facts';o jsonb:=p_bundle->'state'->'view'->'capture';b jsonb:=p_key->'binding';source jsonb;observations jsonb;records jsonb;accounting jsonb:=NULL;entry jsonb;t jsonb;operation jsonb;termination jsonb;metadata jsonb;wrapper jsonb;
BEGIN
  source:=jsonb_build_object('input',o->'origin'->'identity'->'sourceInput','inputEvidence',(f->'input')-'value','inputFingerprint',f->'input'->>'evidenceDigest','basisRef',CASE WHEN f->'basis'='null'::jsonb THEN 'null'::jsonb ELSE (f->'basis')-'value' END);
  SELECT jsonb_build_object('parentJoin',(SELECT value-'purpose'-'value' FROM jsonb_array_elements(f->'records') WHERE value->>'purpose'='PARENT_JOIN'),'finalized',(SELECT value-'purpose'-'value' FROM jsonb_array_elements(f->'records') WHERE value->>'purpose'='FINALIZED')) INTO records;
  observations:=jsonb_build_object('result',CASE WHEN jsonb_array_length(f->'observations')=2 THEN (f->'observations'->0)-'value' ELSE 'null'::jsonb END,'termination',(f->'observations'->(jsonb_array_length(f->'observations')-1))-'value');
  t:=(f->'observations'->(jsonb_array_length(f->'observations')-1)->'value'->'termination')-'isolation';
  SELECT value INTO entry FROM jsonb_array_elements(p_bundle->'state'->'view'->'record'->'envelope'->'evidence'->'lifecycle'->'events') WHERE value->>'kind'='FINAL_ACCOUNTING';
  IF entry IS NOT NULL THEN
    SELECT jsonb_build_object('event',value,'value',entry->'payload'->'accounting') INTO accounting FROM jsonb_array_elements(p_bundle->'state'->'view'->'record'->'envelope'->'entries') WHERE value->>'eventId'=entry->>'eventId';
  END IF;
  operation:=jsonb_build_object('version',1,'binding',b,'adoptionId',p_bundle->'original'->'adoptionId','capacityRef',f->'capacity'->'reference','source',source,'originDigest',o->>'originDigest','intentDigest',o->'origin'->'identity'->>'intentDigest','windowsEvidenceRef',p_key->'expected','goGrantRef',f->'goGrantRef','rawResult',f->'rawResult','observations',observations,'accounting',accounting,'records',records);
  termination:=jsonb_build_object('version',1,'jobId',b->>'jobId','parentInstanceId',b->>'parentInstanceId','capacityReservationId',b->>'capacityReservationId','source',source,'originDigest',o->>'originDigest','windowsEvidenceRef',p_key->'expected','terminationObservation',observations->'termination','termination',t,'records',records);
  metadata:=jsonb_build_object('version',2,'kind','WINDOWS_JOB_OBJECT','binding',b,'adoptionId',p_bundle->'original'->'adoptionId','capacityRef',f->'capacity'->'reference','source',source,'originDigest',o->>'originDigest','intentDigest',o->'origin'->'identity'->>'intentDigest','windowsEvidenceRef',p_key->'expected','terminationObservation',observations->'termination','accountingDigest',CASE WHEN accounting IS NULL THEN NULL ELSE manga_web.windows_native_hash(accounting->'value') END);
  wrapper:=jsonb_build_object('version',1,'accountId',b->>'accountId','executionId',source->'input'->>'executionId','inputDigest',source->'input'->>'stageInputDigest','inputFingerprint',source->>'inputFingerprint');
  RETURN jsonb_build_object('operation',wrapper||jsonb_build_object('kind','WINDOWS_NATIVE_OPERATION','value',operation),'termination',wrapper||jsonb_build_object('kind','WINDOWS_NATIVE_TERMINATION','value',termination),'metadata',metadata);
END $$;

CREATE FUNCTION windows_native_evidence_lookup(p_key jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF manga_web.native_job_caller() IS DISTINCT FROM 'trio_web_worker' OR p_key->'binding'->>'accountId' IS DISTINCT FROM manga_web.current_account()::text THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_ACCESS_DENIED';END IF;
  RETURN manga_web.windows_native_evidence_bundle(p_key,'trio_web_worker');
END $$;
CREATE FUNCTION native_capacity_windows_operator_evidence(p_key jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  RETURN manga_web.windows_native_evidence_bundle(p_key,NULL);
END $$;

CREATE FUNCTION windows_native_evidence_bridge(p_key jsonb,p_operation jsonb,p_termination jsonb,p_write boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE bundle jsonb;derived jsonb;rows integer;op manga_web.execution_evidence%ROWTYPE;term manga_web.execution_evidence%ROWTYPE;op_digest text;term_digest text;sampled timestamptz;waiting jsonb:=jsonb_build_object('state','WAIT','operation',NULL,'termination',NULL);a uuid:=manga_web.current_account();
BEGIN
  IF manga_web.native_job_caller() IS DISTINCT FROM 'trio_web_worker' OR p_key->'binding'->>'accountId' IS DISTINCT FROM a::text THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WINDOWS_NATIVE_ACCESS_DENIED';END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;
  IF p_operation IS NULL OR p_termination IS NULL OR octet_length(p_operation::text)>32768 OR octet_length(p_termination::text)>32768 OR octet_length((p_operation->'value')::text)>16384 OR octet_length((p_termination->'value')::text)>16384 THEN RETURN waiting;END IF;
  bundle:=manga_web.windows_native_evidence_bundle(p_key,'trio_web_worker');IF bundle IS NULL THEN RETURN waiting;END IF;
  derived:=manga_web.windows_native_evidence_values(bundle,p_key);
  IF p_operation IS DISTINCT FROM derived->'operation' OR p_termination IS DISTINCT FROM derived->'termination' THEN RETURN waiting;END IF;
  op_digest:=manga_web.windows_native_hash(p_operation);term_digest:=manga_web.windows_native_hash(p_termination);
  -- N+1: never deserialize or silently select a prefix of a duplicate bridge.
  SELECT count(*) INTO rows FROM(SELECT 1 FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=(p_operation->>'executionId')::uuid AND
    ((kind='WINDOWS_NATIVE_OPERATION' AND protected_observation->'value'->'binding'->>'jobId'=p_key->'binding'->>'jobId') OR (kind='WINDOWS_NATIVE_TERMINATION' AND protected_observation->'value'->>'jobId'=p_key->'binding'->>'jobId')) LIMIT 3) bounded;
  IF rows=0 AND p_write THEN
    sampled:=clock_timestamp();
    INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
      SELECT a,id,(body->>'executionId')::uuid,body->>'kind',seal,id::text,sampled,body FROM(VALUES(gen_random_uuid(),p_operation,op_digest),(gen_random_uuid(),p_termination,term_digest)) v(id,body,seal);
    rows:=2;
  END IF;
  IF rows<>2 THEN RETURN waiting;END IF;
  SELECT * INTO op FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=(p_operation->>'executionId')::uuid AND kind='WINDOWS_NATIVE_OPERATION' AND protected_observation->'value'->'binding'->>'jobId'=p_key->'binding'->>'jobId';
  SELECT * INTO term FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=(p_operation->>'executionId')::uuid AND kind='WINDOWS_NATIVE_TERMINATION' AND protected_observation->'value'->>'jobId'=p_key->'binding'->>'jobId';
  IF op.evidence_id IS NULL OR term.evidence_id IS NULL OR op.evidence_id=term.evidence_id OR octet_length(op.protected_observation::text)>32768 OR octet_length(term.protected_observation::text)>32768
    OR op.protected_observation IS DISTINCT FROM p_operation OR term.protected_observation IS DISTINCT FROM p_termination OR op.evidence_digest IS DISTINCT FROM op_digest OR term.evidence_digest IS DISTINCT FROM term_digest OR op.protected_evidence_ref IS DISTINCT FROM op.evidence_id::text OR term.protected_evidence_ref IS DISTINCT FROM term.evidence_id::text THEN RETURN waiting;END IF;
  RETURN jsonb_build_object('state','VERIFIED','operation',jsonb_build_object('evidenceId',op.evidence_id,'evidenceDigest',op.evidence_digest),'termination',jsonb_build_object('evidenceId',term.evidence_id,'evidenceDigest',term.evidence_digest));
END $$;
CREATE FUNCTION windows_native_evidence_record(p_key jsonb,p_operation jsonb,p_termination jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT manga_web.windows_native_evidence_bridge(p_key,p_operation,p_termination,true)$$;
CREATE FUNCTION windows_native_evidence_lookup_bridge(p_key jsonb,p_operation jsonb,p_termination jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT manga_web.windows_native_evidence_bridge(p_key,p_operation,p_termination,false)$$;

CREATE FUNCTION windows_native_proof_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE key jsonb;bundle jsonb;derived jsonb;
BEGIN
  key:=jsonb_build_object('binding',NEW.proof_metadata->'binding','expected',NEW.proof_metadata->'windowsEvidenceRef');bundle:=manga_web.windows_native_evidence_bundle(key,NULL);
  IF bundle IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_PROOF_UNCONFIRMED';END IF;
  derived:=manga_web.windows_native_evidence_values(bundle,key);
  IF NEW.proof_metadata IS DISTINCT FROM derived->'metadata' OR NEW.proof_digest IS DISTINCT FROM manga_web.windows_native_hash(NEW.proof_metadata)
    OR NEW.account_id::text IS DISTINCT FROM key->'binding'->>'accountId' OR NEW.reservation_id::text IS DISTINCT FROM key->'binding'->>'capacityReservationId'
    OR NEW.adoption_id::text IS DISTINCT FROM bundle->'original'->>'adoptionId' OR NEW.source_execution_id::text IS DISTINCT FROM bundle->'original'->>'sourceExecutionId' OR NEW.source_input_evidence_id::text IS DISTINCT FROM bundle->'original'->>'sourceInputEvidenceId'
    OR NEW.observation_id::text IS DISTINCT FROM derived->'metadata'->'terminationObservation'->>'evidenceId' OR NEW.observation_digest IS DISTINCT FROM derived->'metadata'->'terminationObservation'->>'evidenceDigest'
    OR NEW.link_canonical IS DISTINCT FROM bundle->'state'->'facts'->'link'->>'canonical' OR NEW.link_signature IS DISTINCT FROM bundle->'state'->'facts'->'link'->>'signature' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WINDOWS_NATIVE_PROOF_UNCONFIRMED';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER windows_native_proof_record BEFORE INSERT ON windows_native_termination_proofs FOR EACH ROW EXECUTE FUNCTION windows_native_proof_record();
CREATE FUNCTION native_capacity_confirm_windows_proof(p_key jsonb,p_metadata jsonb,p_link_canonical text,p_link_signature text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE bundle jsonb;derived jsonb;prior manga_web.windows_native_termination_proofs%ROWTYPE;sampled timestamptz;observed timestamptz;proof uuid:=gen_random_uuid();a uuid;r uuid;seal text;
  refused jsonb:=jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED','capacityReservationId',NULL,'proofId',NULL);
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  IF NOT manga_web.native_controller_binding_valid(p_key->'binding') OR p_metadata IS NULL OR octet_length(p_metadata::text)>16384 OR p_link_canonical IS NULL OR octet_length(p_link_canonical)>32768 OR p_link_signature IS NULL OR octet_length(p_link_signature)<>88 THEN RETURN refused;END IF;
  a:=(p_key->'binding'->>'accountId')::uuid;r:=(p_key->'binding'->>'capacityReservationId')::uuid;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=a FOR UPDATE;IF NOT FOUND THEN RETURN refused;END IF;
  SELECT last_observed_at INTO observed FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  PERFORM 1 FROM manga_web.native_capacity_reservations WHERE account_id=a AND reservation_id=r FOR UPDATE;
  bundle:=manga_web.windows_native_evidence_bundle(p_key,NULL);IF bundle IS NULL THEN RETURN refused;END IF;
  derived:=manga_web.windows_native_evidence_values(bundle,p_key);
  IF p_metadata IS DISTINCT FROM derived->'metadata' OR p_link_canonical IS DISTINCT FROM bundle->'state'->'facts'->'link'->>'canonical' OR p_link_signature IS DISTINCT FROM bundle->'state'->'facts'->'link'->>'signature' THEN RETURN refused;END IF;
  seal:=manga_web.windows_native_hash(p_metadata);
  SELECT * INTO prior FROM manga_web.windows_native_termination_proofs WHERE account_id=a AND reservation_id=r;
  IF FOUND THEN
    IF prior.proof_digest IS DISTINCT FROM seal OR prior.proof_metadata IS DISTINCT FROM p_metadata OR prior.link_canonical IS DISTINCT FROM p_link_canonical OR prior.link_signature IS DISTINCT FROM p_link_signature THEN RETURN refused;END IF;
    RETURN jsonb_build_object('allowed',true,'reason','PROOF_REPLAY','capacityReservationId',r,'proofId',prior.proof_id);
  END IF;
  sampled:=clock_timestamp();IF observed IS NOT NULL AND sampled<observed THEN RETURN refused||jsonb_build_object('reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  INSERT INTO manga_web.windows_native_termination_proofs(account_id,proof_id,reservation_id,adoption_id,source_execution_id,source_input_evidence_id,proof_metadata,proof_digest,link_canonical,link_signature,observation_id,observation_digest,confirmed_at)
  VALUES(a,proof,r,(bundle->'original'->>'adoptionId')::uuid,(bundle->'original'->>'sourceExecutionId')::uuid,(bundle->'original'->>'sourceInputEvidenceId')::uuid,p_metadata,seal,p_link_canonical,p_link_signature,(p_metadata->'terminationObservation'->>'evidenceId')::uuid,p_metadata->'terminationObservation'->>'evidenceDigest',sampled);
  RETURN jsonb_build_object('allowed',true,'reason','PROOF_CONFIRMED','capacityReservationId',r,'proofId',proof);
END $$;
CREATE FUNCTION native_capacity_release_windows(p_account uuid,p_reservation uuid,p_proof uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE r manga_web.native_capacity_reservations%ROWTYPE;p manga_web.windows_native_termination_proofs%ROWTYPE;sampled timestamptz;observed timestamptz;
  refused jsonb:=jsonb_build_object('allowed',false,'reason','NATIVE_CAPACITY_PROOF_UNCONFIRMED','capacityReservationId',p_reservation,'proofId',p_proof);
BEGIN
  IF NOT manga_web.native_capacity_operator_caller() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NATIVE_CAPACITY_OPERATOR_UNCONFIRMED';END IF;
  PERFORM 1 FROM manga_web.accounts WHERE account_id=p_account FOR UPDATE;IF NOT FOUND THEN RETURN refused;END IF;
  SELECT last_observed_at INTO observed FROM manga_web.execution_limit_authority WHERE singleton FOR UPDATE;
  SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=p_account AND reservation_id=p_reservation FOR UPDATE;
  SELECT * INTO p FROM manga_web.windows_native_termination_proofs WHERE account_id=p_account AND reservation_id=p_reservation AND proof_id=p_proof;
  IF r.reservation_id IS NULL OR p.proof_id IS NULL OR manga_web.native_capacity_registered_proof(p_account,p_reservation) IS DISTINCT FROM p_proof THEN RETURN refused;END IF;
  IF r.state='RELEASED' THEN
    IF r.windows_release_proof_id IS DISTINCT FROM p_proof OR r.release_proof_id IS NOT NULL THEN RETURN refused;END IF;
    RETURN jsonb_build_object('allowed',true,'reason','RELEASE_REPLAY','capacityReservationId',p_reservation,'proofId',p_proof);
  END IF;
  sampled:=clock_timestamp();IF observed IS NOT NULL AND sampled<observed THEN RETURN refused||jsonb_build_object('reason','GLOBAL_CLOCK_UNCONFIRMED');END IF;
  UPDATE manga_web.execution_limit_authority SET last_observed_at=sampled,revision=revision+1 WHERE singleton;
  UPDATE manga_web.native_capacity_reservations SET state='RELEASED',released_at=sampled,windows_release_proof_id=p_proof WHERE account_id=p_account AND reservation_id=p_reservation;
  RETURN jsonb_build_object('allowed',true,'reason','NATIVE_CAPACITY_RELEASED','capacityReservationId',p_reservation,'proofId',p_proof);
END $$;

-- Replace only the known proof-consuming expressions in the installed final
-- bodies. CREATE OR REPLACE retains OID, owner, ACL, security and search_path.
-- Any drift in those expressions aborts this migration rather than loosening it.
DO $consumers$ DECLARE spec record;definition text;needle text;replacement text;BEGIN
  FOR spec IN SELECT * FROM(VALUES
    ('manga_web.native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text)',1),
    ('manga_web.native_capacity_go_base_v16(uuid,uuid,jsonb,jsonb,jsonb,text)',1),
    ('manga_web.native_capacity_create_intent(jsonb,boolean,jsonb)',2),
    ('manga_web.native_capacity_recovery(text,uuid)',3),
    ('manga_web.reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb)',3)
  ) v(signature,kind) LOOP
    IF spec.kind=1 THEN needle:='EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs WHERE account_id=a AND reservation_id=r.reservation_id)';replacement:='manga_web.native_capacity_registered_proof(a,r.reservation_id) IS NOT NULL';
    ELSIF spec.kind=2 THEN needle:='NOT EXISTS(SELECT 1 FROM manga_web.native_capacity_termination_proofs f WHERE f.account_id=r.account_id AND f.reservation_id=r.reservation_id)';replacement:='manga_web.native_capacity_registered_proof(r.account_id,r.reservation_id) IS NULL';
    ELSE needle:='LEFT JOIN manga_web.native_capacity_termination_proofs f ON f.account_id=r.account_id AND f.reservation_id=r.reservation_id';replacement:='LEFT JOIN LATERAL(SELECT manga_web.native_capacity_registered_proof(r.account_id,r.reservation_id) AS proof_id) f ON true';END IF;
    definition:=pg_catalog.pg_get_functiondef(spec.signature::regprocedure);
    IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'NATIVE_CAPACITY_PROOF_CONSUMER_UNCONFIRMED: %',spec.signature;END IF;
    EXECUTE replace(definition,needle,replacement);
  END LOOP;
END $consumers$;
REVOKE ALL ON FUNCTION native_capacity_registered_proof(uuid,uuid),windows_native_evidence_bundle(jsonb,text),windows_native_evidence_values(jsonb,jsonb),windows_native_evidence_bridge(jsonb,jsonb,jsonb,boolean),windows_native_proof_record() FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator;
REVOKE ALL ON FUNCTION windows_native_evidence_lookup(jsonb),windows_native_evidence_record(jsonb,jsonb,jsonb),windows_native_evidence_lookup_bridge(jsonb,jsonb,jsonb),native_capacity_windows_operator_evidence(jsonb),native_capacity_confirm_windows_proof(jsonb,jsonb,text,text),native_capacity_release_windows(uuid,uuid,uuid) FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_controller,trio_web_operator;
GRANT EXECUTE ON FUNCTION windows_native_evidence_lookup(jsonb),windows_native_evidence_record(jsonb,jsonb,jsonb),windows_native_evidence_lookup_bridge(jsonb,jsonb,jsonb) TO trio_web_worker;
GRANT EXECUTE ON FUNCTION native_capacity_windows_operator_evidence(jsonb),native_capacity_confirm_windows_proof(jsonb,jsonb,text,text),native_capacity_release_windows(uuid,uuid,uuid) TO trio_web_operator;
