SET search_path TO manga_web;
CREATE TABLE assets (
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('LIVE','UPLOAD_TEMP','EXPORT','LIBRARY','FONT')),
  bucket_ref text NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64 AND sha256 ~ '^[0-9a-f]+$'),
  bytes_length bigint NOT NULL CHECK (bytes_length >= 0),
  media_type text NOT NULL,
  verified_at timestamptz,
  access_deadline timestamptz,
  deletion_state text NOT NULL CHECK (deletion_state IN ('NOT_DUE','PENDING','CONFIRMED','UNCONFIRMED')),
  PRIMARY KEY (account_id, asset_id),
  UNIQUE (bucket_ref, object_key),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
);

CREATE TABLE checkpoints (
  account_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  stage_contract text NOT NULL,
  dependency_digest text NOT NULL,
  protected_manifest_ref text NOT NULL,
  verification_state text NOT NULL,
  PRIMARY KEY (account_id, checkpoint_id),
  FOREIGN KEY (account_id, execution_id) REFERENCES executions (account_id, execution_id)
);

CREATE TABLE results (
  account_id uuid NOT NULL,
  result_id uuid NOT NULL,
  context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  result_revision bigint NOT NULL,
  original_asset_id uuid NOT NULL,
  cleaned_asset_id uuid,
  render_asset_id uuid,
  protected_edit_data_ref text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('UPLOAD','IMPORT_BASELINE','AI_APPLIED','MANUAL_EDIT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, result_id),
  UNIQUE (account_id, context_id, page_lineage_id, result_revision),
  UNIQUE (account_id, context_id, result_id),
  UNIQUE (account_id, context_id, page_lineage_id, result_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id) REFERENCES workspace_pages (account_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, original_asset_id) REFERENCES assets (account_id, asset_id),
  FOREIGN KEY (account_id, cleaned_asset_id) REFERENCES assets (account_id, asset_id),
  FOREIGN KEY (account_id, render_asset_id) REFERENCES assets (account_id, asset_id)
);

CREATE TABLE result_applications (
  account_id uuid NOT NULL,
  application_id uuid NOT NULL,
  request_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  result_id uuid NOT NULL,
  context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','NOT_APPLICABLE')),
  applied_at timestamptz,
  PRIMARY KEY (account_id, application_id),
  UNIQUE (account_id, execution_id, result_id),
  FOREIGN KEY (account_id, request_id, execution_id) REFERENCES executions (account_id, request_id, execution_id),
  FOREIGN KEY (account_id, request_id, context_id, page_lineage_id) REFERENCES processing_requests (account_id, request_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id, result_id) REFERENCES results (account_id, context_id, page_lineage_id, result_id)
);

CREATE TABLE manual_history (
  account_id uuid NOT NULL,
  history_id uuid NOT NULL,
  context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  parent_history_id uuid,
  dependency_digest text NOT NULL,
  protected_delta_ref text NOT NULL,
  validity text NOT NULL CHECK (validity IN ('VALID','INVALIDATED')),
  invalid_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, history_id),
  UNIQUE (account_id, context_id, page_lineage_id, history_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id) REFERENCES workspace_pages (account_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id, parent_history_id) REFERENCES manual_history (account_id, context_id, page_lineage_id, history_id)
);

CREATE TABLE history_cursors (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  cursor_history_id uuid,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id) REFERENCES workspace_pages (account_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id, cursor_history_id) REFERENCES manual_history (account_id, context_id, page_lineage_id, history_id)
);

CREATE TABLE uploads (
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  context_id uuid,
  purpose text NOT NULL,
  preview_revision bigint NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, upload_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (account_id, context_id) REFERENCES workspace_contexts (account_id, context_id),
  CHECK (expires_at = created_at + interval '1 hour')
);

CREATE TABLE upload_candidates (
  account_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  asset_id uuid,
  protected_display_name_ref text NOT NULL,
  input_ordinal integer NOT NULL,
  decode_state text NOT NULL,
  reason_code text NOT NULL,
  duplicate_asset_id uuid,
  PRIMARY KEY (account_id, candidate_id),
  UNIQUE (account_id, upload_id, input_ordinal),
  FOREIGN KEY (account_id, upload_id) REFERENCES uploads (account_id, upload_id),
  FOREIGN KEY (account_id, asset_id) REFERENCES assets (account_id, asset_id),
  FOREIGN KEY (account_id, duplicate_asset_id) REFERENCES assets (account_id, asset_id)
);

CREATE TABLE exports (
  account_id uuid NOT NULL,
  export_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_generation bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PROJECT_FILE','FINAL_ZIP')),
  snapshot_revision bigint NOT NULL,
  protected_manifest_ref text NOT NULL,
  captured_at timestamptz NOT NULL,
  retry_deadline timestamptz NOT NULL,
  output_asset_id uuid,
  state text NOT NULL,
  PRIMARY KEY (account_id, export_id),
  UNIQUE (account_id, context_id, export_id),
  FOREIGN KEY (account_id, context_id, context_generation) REFERENCES workspace_contexts (account_id, context_id, generation),
  FOREIGN KEY (account_id, output_asset_id) REFERENCES assets (account_id, asset_id),
  CHECK (retry_deadline = captured_at + interval '30 minutes')
);

CREATE TABLE export_page_inputs (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  export_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  result_id uuid NOT NULL,
  input_digest text NOT NULL,
  render_state text NOT NULL,
  PRIMARY KEY (account_id, export_id, page_lineage_id),
  UNIQUE (account_id, export_id, ordinal),
  FOREIGN KEY (account_id, context_id, export_id) REFERENCES exports (account_id, context_id, export_id),
  FOREIGN KEY (account_id, context_id, page_lineage_id, result_id) REFERENCES results (account_id, context_id, page_lineage_id, result_id)
);

CREATE TABLE exit_operations (
  account_id uuid NOT NULL,
  exit_operation_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_generation bigint NOT NULL,
  owner_session_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('SAVE_AND_EXIT','LOGOUT_CURRENT')),
  state text NOT NULL,
  latest_export_id uuid,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, exit_operation_id),
  UNIQUE (account_id, context_id, exit_operation_id),
  FOREIGN KEY (account_id, context_id, context_generation) REFERENCES workspace_contexts (account_id, context_id, generation),
  FOREIGN KEY (account_id, owner_session_id) REFERENCES app_sessions (account_id, session_id),
  FOREIGN KEY (account_id, context_id, latest_export_id) REFERENCES exports (account_id, context_id, export_id)
);

CREATE TABLE draft_barriers (
  account_id uuid NOT NULL,
  draft_barrier_id uuid NOT NULL,
  context_id uuid NOT NULL,
  exit_operation_id uuid NOT NULL,
  owner_revision bigint NOT NULL,
  workspace_revision bigint NOT NULL,
  acknowledged_mutation_refs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, draft_barrier_id),
  UNIQUE (account_id, exit_operation_id, draft_barrier_id),
  FOREIGN KEY (account_id, context_id, exit_operation_id) REFERENCES exit_operations (account_id, context_id, exit_operation_id)
);

CREATE TABLE file_attestations (
  account_id uuid NOT NULL,
  attestation_id uuid NOT NULL,
  context_id uuid NOT NULL,
  exit_operation_id uuid NOT NULL,
  export_id uuid NOT NULL,
  draft_barrier_id uuid NOT NULL,
  snapshot_revision bigint NOT NULL,
  owner_revision bigint NOT NULL,
  file_sha256 text NOT NULL,
  attested_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, attestation_id),
  UNIQUE (account_id, exit_operation_id, export_id),
  FOREIGN KEY (account_id, context_id, exit_operation_id) REFERENCES exit_operations (account_id, context_id, exit_operation_id),
  FOREIGN KEY (account_id, context_id, export_id) REFERENCES exports (account_id, context_id, export_id),
  FOREIGN KEY (account_id, exit_operation_id, draft_barrier_id) REFERENCES draft_barriers (account_id, exit_operation_id, draft_barrier_id)
);

CREATE TABLE library_store_operations (
  account_id uuid NOT NULL,
  store_operation_id uuid NOT NULL,
  source_context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  result_id uuid NOT NULL,
  render_digest text NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'LIBRARY_RESULT'),
  asset_id uuid,
  state text NOT NULL,
  store_completed_at timestamptz,
  expires_at timestamptz,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, store_operation_id),
  UNIQUE (account_id, page_lineage_id, store_operation_id),
  UNIQUE (account_id, source_context_id, page_lineage_id, result_id, render_digest, purpose),
  FOREIGN KEY (account_id, source_context_id, page_lineage_id, result_id) REFERENCES results (account_id, context_id, page_lineage_id, result_id),
  FOREIGN KEY (account_id, page_lineage_id) REFERENCES page_lineages (account_id, page_lineage_id),
  FOREIGN KEY (account_id, asset_id) REFERENCES assets (account_id, asset_id),
  CHECK ((store_completed_at IS NULL AND expires_at IS NULL) OR (store_completed_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at = store_completed_at + interval '30 days'))
);

CREATE TABLE library_store_attempts (
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  store_operation_id uuid NOT NULL,
  retry_group_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  due_at timestamptz NOT NULL,
  state text NOT NULL,
  evidence_ref text,
  PRIMARY KEY (account_id, attempt_id),
  UNIQUE (account_id, store_operation_id, retry_group_id, ordinal),
  FOREIGN KEY (account_id, store_operation_id) REFERENCES library_store_operations (account_id, store_operation_id)
);

CREATE TABLE library_heads (
  account_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  store_operation_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, page_lineage_id),
  FOREIGN KEY (account_id, page_lineage_id) REFERENCES page_lineages (account_id, page_lineage_id),
  FOREIGN KEY (account_id, page_lineage_id, store_operation_id) REFERENCES library_store_operations (account_id, page_lineage_id, store_operation_id)
);

CREATE TABLE work_items (
  account_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DISPATCH','RECONCILE','APPLY','SETTLE','DEADLINE','STORE','DELETE_OBJECT')),
  operation_digest text NOT NULL,
  target_ref jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  lease_until timestamptz,
  claim_owner text,
  claim_generation bigint NOT NULL CHECK (claim_generation >= 0),
  state text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, work_item_id),
  UNIQUE (account_id, kind, operation_digest),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
);

CREATE TABLE signing_verifiers (
  key_id text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm = 'Ed25519'),
  issuer text NOT NULL,
  public_key bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('ISSUING','VERIFY_ONLY','REVOKED','UNCONFIRMED')),
  catalog_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key_id),
  CHECK (octet_length(public_key) = 32)
);

CREATE TABLE model_capabilities (
  contract_version text NOT NULL,
  provider text NOT NULL,
  model_id text NOT NULL,
  endpoint text NOT NULL,
  capability_evidence_ref text,
  level_mapping jsonb,
  state text NOT NULL CHECK (state IN ('UNVERIFIED','VERIFIED','UNAVAILABLE')),
  PRIMARY KEY (contract_version)
);

CREATE TABLE parameter_profiles (
  profile_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('UNMEASURED','VERIFIED','WITHDRAWN')),
  protected_profile_ref text NOT NULL,
  evidence_ref text,
  PRIMARY KEY (profile_version),
  CHECK (state <> 'VERIFIED' OR evidence_ref IS NOT NULL)
);

CREATE TABLE domain_events (
  account_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  operation_ref text NOT NULL,
  reason_code text NOT NULL,
  event_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  minimal_metadata jsonb NOT NULL,
  PRIMARY KEY (account_id, event_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
);

-- Circular current execution pointer is checked after both tables exist.

CREATE INDEX work_due ON work_items (due_at, work_item_id);
CREATE INDEX export_expiry ON exports (retry_deadline);
CREATE INDEX library_expiry ON library_store_operations (expires_at);
-- Append-only monetary/free/evidence facts; service roles must not UPDATE/DELETE them.
-- PostgreSQL role/grant setup, RLS decision, migrations and real FK/race checks remain NOT RUN.
