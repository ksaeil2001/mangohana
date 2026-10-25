SET search_path TO manga_web;
CREATE TABLE batches (
  account_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_generation bigint NOT NULL,
  settings_revision bigint NOT NULL,
  captured_target_order jsonb NOT NULL,
  state text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, batch_id),
  UNIQUE (account_id, context_id, batch_id),
  FOREIGN KEY (account_id, context_id, context_generation) REFERENCES workspace_contexts (account_id, context_id, generation),
  FOREIGN KEY (account_id, context_id, settings_revision) REFERENCES settings_revisions (account_id, context_id, settings_revision)
);

CREATE TABLE processing_requests (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  retry_of_request_id uuid,
  context_id uuid NOT NULL,
  context_generation bigint NOT NULL,
  project_lineage_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  batch_id uuid,
  settings_revision bigint NOT NULL,
  scope_digest text NOT NULL,
  captured_scope jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ACCEPTED','ACTIVE','WAITING','STOP_REQUESTED','COMPLETED','STOPPED','FAILED')),
  hold_reasons jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('FREE','PAID')),
  first_start_at timestamptz,
  terminal_at timestamptz,
  terminal_evidence_ref text,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, request_id),
  UNIQUE (account_id, request_id, project_lineage_id, page_lineage_id),
  UNIQUE (account_id, request_id, context_id, page_lineage_id),
  FOREIGN KEY (account_id, retry_of_request_id) REFERENCES processing_requests (account_id, request_id),
  FOREIGN KEY (account_id, context_id, context_generation) REFERENCES workspace_contexts (account_id, context_id, generation),
  FOREIGN KEY (account_id, context_id, project_lineage_id) REFERENCES workspace_contexts (account_id, context_id, project_lineage_id),
  FOREIGN KEY (account_id, project_lineage_id, page_lineage_id) REFERENCES page_lineages (account_id, project_lineage_id, page_lineage_id),
  FOREIGN KEY (account_id, context_id, batch_id) REFERENCES batches (account_id, context_id, batch_id),
  FOREIGN KEY (account_id, context_id, settings_revision) REFERENCES settings_revisions (account_id, context_id, settings_revision),
  CHECK ((state IN ('COMPLETED','STOPPED','FAILED') AND terminal_at IS NOT NULL AND terminal_evidence_ref IS NOT NULL) OR (state NOT IN ('COMPLETED','STOPPED','FAILED') AND terminal_at IS NULL))
);

CREATE TABLE request_steps (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  logical_step_id text NOT NULL,
  current_execution_id uuid,
  execution_generation bigint NOT NULL CHECK (execution_generation >= 0),
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, request_id, logical_step_id),
  FOREIGN KEY (account_id, request_id) REFERENCES processing_requests (account_id, request_id)
);

CREATE TABLE executions (
  account_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  request_id uuid NOT NULL,
  logical_step_id text NOT NULL,
  contract_version text NOT NULL,
  input_digest text NOT NULL,
  input_asset_refs jsonb NOT NULL,
  claim_generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARED','DISPATCHING','RUNNING','UNKNOWN','SUCCEEDED','REJECTED','FAILED')),
  dispatch_attempted_at timestamptz,
  provider_ref text,
  start_confirmed_at timestamptz,
  finished_confirmed_at timestamptz,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, execution_id),
  UNIQUE (account_id, request_id, logical_step_id, execution_id),
  UNIQUE (account_id, request_id, execution_id),
  FOREIGN KEY (account_id, request_id, logical_step_id) REFERENCES request_steps (account_id, request_id, logical_step_id)
);

CREATE TABLE active_page_requests (
  account_id uuid NOT NULL,
  project_lineage_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  request_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, project_lineage_id, page_lineage_id),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, request_id, project_lineage_id, page_lineage_id) REFERENCES processing_requests (account_id, request_id, project_lineage_id, page_lineage_id)
);

CREATE TABLE provider_wait_rounds (
  account_id uuid NOT NULL,
  wait_round_id uuid NOT NULL,
  request_id uuid NOT NULL,
  logical_step_id text NOT NULL,
  linked_execution_id uuid,
  started_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  closed_at timestamptz,
  close_evidence_ref text,
  PRIMARY KEY (account_id, wait_round_id),
  FOREIGN KEY (account_id, request_id, logical_step_id) REFERENCES request_steps (account_id, request_id, logical_step_id),
  FOREIGN KEY (account_id, request_id, logical_step_id, linked_execution_id) REFERENCES executions (account_id, request_id, logical_step_id, execution_id),
  CHECK (deadline = started_at + interval '10 minutes')
);

CREATE TABLE connection_rounds (
  account_id uuid NOT NULL,
  connection_round_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_generation bigint NOT NULL,
  owner_revision bigint NOT NULL,
  last_valid_at timestamptz NOT NULL,
  disconnect_confirmed_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  reason text NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (account_id, connection_round_id),
  FOREIGN KEY (account_id, context_id, context_generation) REFERENCES workspace_contexts (account_id, context_id, generation),
  CHECK (deadline = disconnect_confirmed_at + interval '5 minutes'),
  CHECK (disconnect_confirmed_at >= last_valid_at)
);

CREATE TABLE execution_evidence (
  account_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  kind text NOT NULL,
  evidence_digest text NOT NULL,
  protected_evidence_ref text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, evidence_id),
  UNIQUE (account_id, execution_id, kind, evidence_digest),
  FOREIGN KEY (account_id, execution_id) REFERENCES executions (account_id, execution_id)
);

CREATE TABLE free_reservations (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('HELD','CONVERTED','RELEASED_CONFIRMED')),
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, request_id),
  FOREIGN KEY (account_id, request_id) REFERENCES processing_requests (account_id, request_id)
);

CREATE TABLE free_starts (
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL,
  unit_count integer NOT NULL CHECK (unit_count = 1),
  PRIMARY KEY (account_id, request_id),
  FOREIGN KEY (account_id, request_id, execution_id) REFERENCES executions (account_id, request_id, execution_id)
);

CREATE TABLE headroom_holds (
  account_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  request_id uuid NOT NULL,
  execution_id uuid,
  bound_usd numeric(28,12) CHECK (bound_usd >= 0) CHECK (bound_usd <> 'NaN'::numeric),
  bound_version text,
  state text NOT NULL CHECK (state IN ('HELD','UNCONFIRMED','RELEASED_CONFIRMED')),
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (account_id, hold_id),
  FOREIGN KEY (account_id, request_id) REFERENCES processing_requests (account_id, request_id),
  FOREIGN KEY (account_id, request_id, execution_id) REFERENCES executions (account_id, request_id, execution_id)
);

CREATE TABLE cost_items (
  account_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  component text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  state text NOT NULL CHECK (state IN ('UNCONFIRMED','CONFIRMED')),
  actual_usd numeric(28,12) CHECK (actual_usd >= 0) CHECK (actual_usd <> 'NaN'::numeric),
  usage_ref text,
  rate_version text,
  confirmed_at timestamptz,
  PRIMARY KEY (account_id, cost_item_id),
  UNIQUE (account_id, execution_id, component, ordinal),
  FOREIGN KEY (account_id, execution_id) REFERENCES executions (account_id, execution_id),
  CHECK ((state = 'UNCONFIRMED' AND actual_usd IS NULL) OR (state = 'CONFIRMED' AND actual_usd IS NOT NULL AND confirmed_at IS NOT NULL AND rate_version IS NOT NULL AND usage_ref IS NOT NULL))
);

CREATE TABLE ledger_entries (
  account_id uuid NOT NULL,
  ledger_entry_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SETTLEMENT','PURCHASE','REFUND_ADJUSTMENT')),
  credit_delta numeric(28,12) NOT NULL CHECK (credit_delta <> 'NaN'::numeric),
  basis_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, ledger_entry_id),
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
);

CREATE TABLE settlements (
  account_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  ledger_entry_id uuid,
  debit_credit numeric(28,12) NOT NULL CHECK (debit_credit >= 0) CHECK (debit_credit <> 'NaN'::numeric),
  mode text NOT NULL CHECK (mode IN ('FREE','PAID')),
  basis_version text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, cost_item_id),
  UNIQUE (account_id, ledger_entry_id),
  FOREIGN KEY (account_id, cost_item_id) REFERENCES cost_items (account_id, cost_item_id),
  FOREIGN KEY (account_id, ledger_entry_id) REFERENCES ledger_entries (account_id, ledger_entry_id),
  CHECK ((mode = 'FREE' AND debit_credit = 0 AND ledger_entry_id IS NULL) OR (mode = 'PAID' AND ledger_entry_id IS NOT NULL))
);


ALTER TABLE request_steps ADD CONSTRAINT request_steps_current_execution_fk
  FOREIGN KEY (account_id, request_id, logical_step_id, current_execution_id)
  REFERENCES executions (account_id, request_id, logical_step_id, execution_id);
CREATE UNIQUE INDEX one_open_provider_wait ON provider_wait_rounds (account_id, request_id, logical_step_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX one_open_disconnect ON connection_rounds (account_id, context_id, context_generation) WHERE closed_at IS NULL;
