SET LOCAL search_path TO manga_web,pg_catalog;
-- Capture claim_authorization and runtime evidence cannot be reconstructed from pre-durable exports.
-- Those rows stay intact and require a new capture; no current-owner backfill is performed.
CREATE TABLE export_builds(
  account_id uuid NOT NULL,
  export_id uuid NOT NULL,
  capture_digest text NOT NULL CHECK(capture_digest~'^[0-9a-f]{64}$'),
  runtime_fingerprint text NOT NULL CHECK(runtime_fingerprint~'^[0-9a-f]{64}$'),
  protected_runtime jsonb NOT NULL CHECK(jsonb_typeof(protected_runtime)='object'),
  captured_authorization jsonb NOT NULL CHECK(jsonb_typeof(captured_authorization)='object'),
  claim_authorization jsonb NOT NULL CHECK(jsonb_typeof(claim_authorization)='object'),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  owner_id uuid,
  lease_until timestamptz,
  state text NOT NULL CHECK(state IN ('ACCEPTED','BUILDING','FAILED','COMPLETE')),
  captured_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error_code text,
  PRIMARY KEY(account_id,export_id),
  FOREIGN KEY(account_id,export_id) REFERENCES exports(account_id,export_id),
  CHECK((generation=0 AND owner_id IS NULL AND lease_until IS NULL AND state='ACCEPTED') OR (generation>0 AND owner_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((state='COMPLETE')=(completed_at IS NOT NULL))
);
CREATE TABLE export_build_candidates(
  account_id uuid NOT NULL,
  export_id uuid NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  asset_id uuid NOT NULL,
  object_key text NOT NULL CHECK(object_key=account_id::text||'/'||asset_id::text),
  capture_digest text NOT NULL CHECK(capture_digest~'^[0-9a-f]{64}$'),
  runtime_fingerprint text NOT NULL CHECK(runtime_fingerprint~'^[0-9a-f]{64}$'),
  sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  bytes_length bigint NOT NULL CHECK(bytes_length>0),
  media_type text NOT NULL CHECK(media_type='application/zip'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,export_id,generation),
  UNIQUE(account_id,asset_id),
  FOREIGN KEY(account_id,export_id) REFERENCES export_builds(account_id,export_id)
);
ALTER TABLE export_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_build_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_builds FORCE ROW LEVEL SECURITY;
ALTER TABLE export_build_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON export_builds TO trio_web_api USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
CREATE POLICY account_scope ON export_build_candidates TO trio_web_api USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
REVOKE ALL ON export_builds,export_build_candidates FROM PUBLIC,trio_web_worker;
GRANT SELECT,INSERT ON export_builds,export_build_candidates TO trio_web_api;
GRANT UPDATE(claim_authorization,generation,owner_id,lease_until,state,completed_at,last_error_code) ON export_builds TO trio_web_api;
-- Candidates are append-only pre-I/O intent. Unknown/partial objects retain their original key
-- and generation for later reconciliation or cleanup; no service may overwrite their intent.
CREATE FUNCTION export_build_scan(observed_at timestamptz) RETURNS TABLE(account_id uuid,export_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT e.account_id,e.export_id
  FROM manga_web.exports e JOIN manga_web.export_builds x USING(account_id,export_id)
  JOIN manga_web.workspace_contexts c ON c.account_id=e.account_id AND c.context_id=e.context_id
  JOIN manga_web.accounts a ON a.account_id=e.account_id
  JOIN manga_web.app_sessions s ON s.account_id=e.account_id AND s.session_id::text=x.claim_authorization->>'sessionId'
  JOIN manga_web.login_bindings b ON b.account_id=s.account_id AND b.binding_id=s.binding_id
  WHERE e.state='ACCEPTED' AND x.state IN ('ACCEPTED','BUILDING') AND c.lifecycle<>'CLOSED'
    AND e.retry_deadline>observed_at AND s.absolute_expires_at>observed_at
    AND (x.state='ACCEPTED' OR x.lease_until<=observed_at)
    AND a.access_state='ACTIVE' AND s.revoked_at IS NULL AND s.auth_generation=a.auth_generation AND b.state='ACTIVE'
    AND s.binding_id::text=x.claim_authorization->>'bindingId' AND a.auth_generation::text=x.claim_authorization->>'authGeneration'
    AND c.generation=e.context_generation AND c.generation::text=x.claim_authorization->>'contextGeneration'
    AND c.owner_session_id::text=x.claim_authorization->>'sessionId' AND c.owner_tab_id::text=x.claim_authorization->>'tabId'
    AND c.owner_revision::text=x.claim_authorization->>'ownerRevision'
  ORDER BY e.captured_at,e.export_id LIMIT 50
$$;
REVOKE ALL ON FUNCTION export_build_scan(timestamptz) FROM PUBLIC,trio_web_worker;
GRANT EXECUTE ON FUNCTION export_build_scan(timestamptz) TO trio_web_api;
-- The service supplies its observed clock; all time and ownership facts are rechecked under the account lock.
-- This advisory scan returns only IDs, never manifests, session secrets, or signing material.
