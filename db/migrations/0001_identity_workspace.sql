-- Initial migration derived from the linked design; verified by isolated PostgreSQL tests.
CREATE SCHEMA manga_web;
SET search_path TO manga_web;

CREATE TABLE accounts (
  account_id uuid NOT NULL,
  access_state text NOT NULL CHECK (access_state IN ('ACTIVE','RESTRICTED','CLOSED')),
  revision bigint NOT NULL CHECK (revision >= 0),
  auth_generation bigint NOT NULL CHECK (auth_generation >= 0),
  balance_credit numeric(28,12) NOT NULL CHECK (balance_credit >= 0) CHECK (balance_credit <> 'NaN'::numeric),
  free_started_count integer NOT NULL CHECK (free_started_count BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id)
);

CREATE TABLE login_bindings (
  account_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  method text NOT NULL CHECK (method IN ('GOOGLE','EMAIL_OTP')),
  state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, binding_id),
  UNIQUE (issuer, subject),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  CHECK ((state = 'ACTIVE' AND revoked_at IS NULL) OR (state = 'REVOKED' AND revoked_at IS NOT NULL))
);

CREATE TABLE auth_attempts (
  attempt_id uuid NOT NULL,
  purpose text NOT NULL,
  method text NOT NULL,
  correlation_digest text NOT NULL,
  provider_scope_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_count integer NOT NULL CHECK (failed_count BETWEEN 0 AND 5),
  next_send_at timestamptz NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (attempt_id),
  CHECK (expires_at = created_at + interval '5 minutes')
);

CREATE TABLE auth_evidence (
  account_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  binding_id uuid,
  purpose text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_command_id uuid,
  PRIMARY KEY (account_id, evidence_id),
  UNIQUE (attempt_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (attempt_id) REFERENCES auth_attempts (attempt_id),
  FOREIGN KEY (account_id, binding_id) REFERENCES login_bindings (account_id, binding_id),
  CHECK (expires_at >= verified_at)
);

CREATE TABLE app_sessions (
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  login_evidence_id uuid NOT NULL,
  cookie_digest text NOT NULL,
  auth_generation bigint NOT NULL,
  fresh_login_verified_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (account_id, session_id),
  UNIQUE (cookie_digest),
  UNIQUE (account_id, login_evidence_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (account_id, binding_id) REFERENCES login_bindings (account_id, binding_id),
  FOREIGN KEY (account_id, login_evidence_id) REFERENCES auth_evidence (account_id, evidence_id),
  CHECK (absolute_expires_at = fresh_login_verified_at + interval '7 days'),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE TABLE project_lineages (
  account_id uuid NOT NULL,
  project_lineage_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, project_lineage_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
);

CREATE TABLE page_lineages (
  account_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  project_lineage_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, page_lineage_id),
  UNIQUE (account_id, project_lineage_id, page_lineage_id),
  FOREIGN KEY (account_id, project_lineage_id) REFERENCES project_lineages (account_id, project_lineage_id)
);

CREATE TABLE workspace_contexts (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  project_lineage_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  lifecycle text NOT NULL CHECK (lifecycle IN ('OPEN','EXITING','CLOSED')),
  owner_session_id uuid,
  owner_tab_id uuid,
  owner_revision bigint NOT NULL CHECK (owner_revision >= 0),
  workspace_revision bigint NOT NULL CHECK (workspace_revision >= 0),
  connection_generation bigint NOT NULL CHECK (connection_generation >= 0),
  heartbeat_seq bigint NOT NULL CHECK (heartbeat_seq >= 0),
  last_valid_heartbeat_at timestamptz,
  owner_capability_digest text,
  project_status text NOT NULL CHECK (project_status IN ('IN_PROGRESS','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('NORMAL_EXIT','DISCONNECT_EXPIRED','ALL_SESSIONS_LOGOUT')),
  PRIMARY KEY (account_id, context_id),
  UNIQUE (account_id, context_id, generation),
  UNIQUE (account_id, context_id, project_lineage_id),
  UNIQUE (account_id, project_lineage_id, generation),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (account_id, project_lineage_id) REFERENCES project_lineages (account_id, project_lineage_id),
  FOREIGN KEY (account_id, owner_session_id) REFERENCES app_sessions (account_id, session_id),
  CHECK ((lifecycle = 'CLOSED' AND closed_at IS NOT NULL AND close_reason IS NOT NULL AND owner_session_id IS NULL AND owner_tab_id IS NULL) OR (lifecycle <> 'CLOSED' AND closed_at IS NULL AND close_reason IS NULL))
);

CREATE TABLE account_live_context_slots (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  generation bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id),
  UNIQUE (account_id, context_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (account_id, context_id, generation) REFERENCES workspace_contexts (account_id, context_id, generation)
);

CREATE TABLE workspace_pages (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  project_lineage_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 0),
  excluded boolean NOT NULL,
  skip boolean NOT NULL,
  result_revision bigint NOT NULL CHECK (result_revision >= 0),
  paid_baseline_state text NOT NULL DEFAULT 'CONFIRMED' CHECK (paid_baseline_state IN ('CONFIRMED','UNCONFIRMED')),
  baseline_unsettled_refs jsonb NOT NULL DEFAULT '[]',
  paid_baseline_credit numeric(28,12) NOT NULL CHECK (paid_baseline_credit >= 0) CHECK (paid_baseline_credit <> 'NaN'::numeric),
  baseline_contribution_refs jsonb NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, context_id, page_lineage_id),
  UNIQUE (account_id, context_id, display_order) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (account_id, context_id, project_lineage_id) REFERENCES workspace_contexts (account_id, context_id, project_lineage_id),
  FOREIGN KEY (account_id, project_lineage_id, page_lineage_id) REFERENCES page_lineages (account_id, project_lineage_id, page_lineage_id)
);

CREATE TABLE command_receipts (
  account_id uuid NOT NULL,
  command_id uuid NOT NULL,
  intent_version integer NOT NULL CHECK (intent_version = 1),
  intent_digest text NOT NULL,
  operation_kind text NOT NULL,
  context_id uuid,
  disposition text NOT NULL,
  operation_ref jsonb NOT NULL,
  observed_revision bigint,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, command_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  FOREIGN KEY (account_id, context_id) REFERENCES workspace_contexts (account_id, context_id)
);

CREATE TABLE settings_revisions (
  account_id uuid NOT NULL,
  context_id uuid NOT NULL,
  settings_revision bigint NOT NULL CHECK (settings_revision >= 0),
  contract_version text NOT NULL,
  captured_settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, context_id, settings_revision),
  FOREIGN KEY (account_id, context_id) REFERENCES workspace_contexts (account_id, context_id)
);

