SET LOCAL search_path TO manga_web, pg_catalog;

ALTER TABLE workspace_contexts ADD COLUMN title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 256);
ALTER TABLE workspace_contexts ADD COLUMN current_settings_revision bigint;
ALTER TABLE workspace_contexts ADD CONSTRAINT context_settings_fk FOREIGN KEY(account_id,context_id,current_settings_revision) REFERENCES settings_revisions(account_id,context_id,settings_revision);
ALTER TABLE workspace_pages ADD COLUMN current_result_id uuid;
ALTER TABLE workspace_pages ADD COLUMN image_width integer CHECK(image_width > 0);
ALTER TABLE workspace_pages ADD COLUMN image_height integer CHECK(image_height > 0);
ALTER TABLE workspace_pages ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(char_length(display_name) <= 256);
ALTER TABLE workspace_pages ADD CONSTRAINT page_current_result_fk FOREIGN KEY(account_id,context_id,page_lineage_id,current_result_id) REFERENCES results(account_id,context_id,page_lineage_id,result_id);
ALTER TABLE command_receipts ADD COLUMN response jsonb;
ALTER TABLE app_sessions ADD COLUMN csrf_digest text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN binding_revision bigint NOT NULL DEFAULT 0 CHECK(binding_revision >= 0);
CREATE SEQUENCE auth_intent_order AS bigint;
ALTER TABLE accounts ADD COLUMN last_all_logout_order bigint NOT NULL DEFAULT 0;
ALTER TABLE auth_attempts ADD COLUMN intent_order bigint NOT NULL DEFAULT nextval('auth_intent_order');
ALTER TABLE auth_attempts ADD COLUMN protected_intent jsonb NOT NULL DEFAULT '{}';
ALTER TABLE auth_attempts ADD COLUMN recipient_digest text;
ALTER TABLE auth_attempts ADD COLUMN command_id uuid;
ALTER TABLE auth_attempts ADD COLUMN command_intent_digest text;
ALTER TABLE auth_attempts ADD COLUMN verified_account_id uuid REFERENCES accounts(account_id);
ALTER TABLE auth_attempts ADD COLUMN verified_evidence_id uuid;
ALTER TABLE auth_attempts ADD COLUMN completed_session_id uuid;
ALTER TABLE auth_attempts ADD COLUMN verified_command_intent_digest text;
ALTER TABLE auth_attempts ADD COLUMN verification_reservation_id uuid;
ALTER TABLE library_store_operations ADD COLUMN render_asset_id uuid;
CREATE UNIQUE INDEX one_auth_attempt_command ON auth_attempts(command_id) WHERE command_id IS NOT NULL;
ALTER TABLE auth_evidence ADD COLUMN proof_digest text;
ALTER TABLE executions ADD COLUMN output_envelope jsonb;
ALTER TABLE executions ADD COLUMN safe_error_code text;
ALTER TABLE processing_requests ADD COLUMN expected_result_revision bigint NOT NULL DEFAULT 0 CHECK(expected_result_revision >= 0);
ALTER TABLE processing_requests ADD COLUMN captured_stage_order jsonb NOT NULL DEFAULT '["OCR","TRANSLATE"]';
ALTER TABLE processing_requests ADD COLUMN captured_input jsonb NOT NULL DEFAULT '{}';
ALTER TABLE processing_requests ADD COLUMN accepted_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE batches ADD COLUMN next_target_index integer NOT NULL DEFAULT 0 CHECK(next_target_index>=0);
ALTER TABLE batches ADD COLUMN current_request_id uuid;
ALTER TABLE batches ADD COLUMN pause_reason text;
ALTER TABLE batches ADD CONSTRAINT batch_current_request_fk FOREIGN KEY(account_id,current_request_id) REFERENCES processing_requests(account_id,request_id);
ALTER TABLE work_items DROP CONSTRAINT work_items_kind_check;
ALTER TABLE work_items ADD CHECK(kind IN ('DISPATCH','RECONCILE','SETTLE','BATCH','STORE','DELETE_OBJECT'));
ALTER TABLE batches ADD COLUMN stop_command_id uuid;
ALTER TABLE batches ADD COLUMN started_page_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE request_steps ADD COLUMN ordinal integer NOT NULL DEFAULT 0 CHECK(ordinal >= 0);
ALTER TABLE request_steps ADD COLUMN reuse_checkpoint_id uuid;
ALTER TABLE request_steps ADD CONSTRAINT reuse_checkpoint_fk FOREIGN KEY(account_id,reuse_checkpoint_id) REFERENCES checkpoints(account_id,checkpoint_id);
ALTER TABLE checkpoints ADD COLUMN output_envelope jsonb;
CREATE UNIQUE INDEX one_checkpoint_per_execution ON checkpoints(account_id,execution_id,stage_contract,dependency_digest);
ALTER TABLE cost_items ADD COLUMN evidence_conflict boolean NOT NULL DEFAULT false;
ALTER TABLE execution_evidence ADD COLUMN protected_observation jsonb;
ALTER TABLE manual_history ADD COLUMN before_result_id uuid;
ALTER TABLE manual_history ADD COLUMN after_result_id uuid;
ALTER TABLE manual_history ADD COLUMN protected_delta jsonb;
ALTER TABLE manual_history ADD COLUMN sequence_no bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE manual_history ADD CONSTRAINT history_before_result_fk FOREIGN KEY(account_id,context_id,page_lineage_id,before_result_id) REFERENCES results(account_id,context_id,page_lineage_id,result_id);
ALTER TABLE manual_history ADD CONSTRAINT history_after_result_fk FOREIGN KEY(account_id,context_id,page_lineage_id,after_result_id) REFERENCES results(account_id,context_id,page_lineage_id,result_id);
ALTER TABLE results ADD COLUMN edit_data jsonb NOT NULL DEFAULT '{}';
ALTER TABLE uploads ADD COLUMN owner_revision bigint;
ALTER TABLE uploads ADD COLUMN context_generation bigint;
ALTER TABLE upload_candidates ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE upload_candidates ADD COLUMN width integer;
ALTER TABLE upload_candidates ADD COLUMN height integer;
ALTER TABLE exports ADD COLUMN captured_manifest jsonb;
ALTER TABLE exports ADD COLUMN captured_asset_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE exports ADD COLUMN safe_error_code text;
ALTER TABLE exports ADD COLUMN failed_page_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE exports ADD COLUMN delivered_at timestamptz;
ALTER TABLE library_store_operations ADD COLUMN retry_group_id uuid;
ALTER TABLE library_store_operations ADD COLUMN safe_error_code text;
ALTER TABLE exit_operations ADD COLUMN captured_owner_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE exit_operations ADD COLUMN draft_barrier_id uuid;
ALTER TABLE assets ADD COLUMN related_context_id uuid;
ALTER TABLE assets ADD CONSTRAINT asset_context_fk FOREIGN KEY(account_id,related_context_id) REFERENCES workspace_contexts(account_id,context_id);
ALTER TABLE assets ADD COLUMN object_created_at timestamptz;
ALTER TABLE uploads ADD COLUMN owner_session_id uuid;
ALTER TABLE uploads ADD COLUMN owner_tab_id uuid;
ALTER TABLE uploads ADD COLUMN prepare_command_id uuid;
ALTER TABLE uploads ADD COLUMN captured_workspace_revision bigint;
ALTER TABLE uploads ADD COLUMN restored_assessment jsonb;

CREATE TABLE account_clock_observations (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  last_observed_at timestamptz NOT NULL
);
CREATE TABLE auth_limiter_events (
  limiter_key text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('SEND','FAILED_VERIFY','VERIFY_PENDING','VERIFY_UNKNOWN')),
  event_id uuid NOT NULL,
  event_time timestamptz NOT NULL,
  PRIMARY KEY(limiter_key,event_id)
);
CREATE INDEX auth_limiter_window ON auth_limiter_events(limiter_key,purpose,event_time);
CREATE TABLE paint_selections (
  account_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  context_id uuid NOT NULL,
  page_lineage_id uuid NOT NULL,
  result_revision bigint NOT NULL,
  captured_strokes jsonb NOT NULL,
  selection_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,selection_id),
  FOREIGN KEY(account_id,context_id,page_lineage_id) REFERENCES workspace_pages(account_id,context_id,page_lineage_id)
);

-- Preserve finite precision; NUMERIC Infinity is not a cost or account balance.
ALTER TABLE accounts ADD CHECK(balance_credit NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
ALTER TABLE workspace_pages ADD CHECK(paid_baseline_credit NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
ALTER TABLE headroom_holds ADD CHECK(bound_usd NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
ALTER TABLE cost_items ADD CHECK(actual_usd NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
ALTER TABLE ledger_entries ADD CHECK(credit_delta NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
ALTER TABLE settlements ADD CHECK(debit_credit NOT IN ('Infinity'::numeric,'-Infinity'::numeric));
