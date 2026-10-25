SET LOCAL search_path TO manga_web,pg_catalog;
CREATE TABLE s3_object_puts(
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  attempt_id uuid NOT NULL,
  bucket_ref text NOT NULL CHECK(length(bucket_ref)>0),
  object_key text NOT NULL CHECK(split_part(object_key,'/',1)=account_id::text AND object_key~'^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  bytes_length bigint NOT NULL CHECK(bytes_length>=0),
  transport_state text NOT NULL CHECK(transport_state IN ('RESERVED','SENDING','ACKNOWLEDGED','REJECTED','UNKNOWN')),
  reserved_at timestamptz NOT NULL,
  transport_completed_at timestamptz,
  PRIMARY KEY(account_id,attempt_id),
  UNIQUE(account_id,bucket_ref,object_key),
  UNIQUE(account_id,attempt_id,sha256,bytes_length),
  CHECK((transport_state IN ('RESERVED','SENDING') AND transport_completed_at IS NULL) OR (transport_state IN ('ACKNOWLEDGED','REJECTED','UNKNOWN') AND transport_completed_at IS NOT NULL))
);
CREATE TABLE s3_put_confirmations(
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  sha256 text NOT NULL,
  bytes_length bigint NOT NULL,
  completed_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK(evidence_digest~'^[0-9a-f]{64}$'),
  protected_proof jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,attempt_id),
  FOREIGN KEY(account_id,attempt_id,sha256,bytes_length) REFERENCES s3_object_puts(account_id,attempt_id,sha256,bytes_length),
  CHECK((jsonb_typeof(protected_proof)='object' AND protected_proof->>'attemptId'=attempt_id::text AND protected_proof->>'sha256'=sha256 AND protected_proof->>'bytesLength'=bytes_length::text AND (protected_proof->>'uploadedAt')::timestamptz=completed_at) IS TRUE)
);
ALTER TABLE s3_object_puts ENABLE ROW LEVEL SECURITY;
ALTER TABLE s3_object_puts FORCE ROW LEVEL SECURITY;
ALTER TABLE s3_put_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE s3_put_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON s3_object_puts TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
CREATE POLICY account_scope ON s3_put_confirmations TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
GRANT SELECT,INSERT ON s3_object_puts,s3_put_confirmations TO trio_web_api,trio_web_worker;
GRANT UPDATE(transport_state,transport_completed_at) ON s3_object_puts TO trio_web_api,trio_web_worker;
