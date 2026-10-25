SET LOCAL search_path TO manga_web,pg_catalog;
DO $roles$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trio_web_api') THEN CREATE ROLE trio_web_api NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trio_web_worker') THEN CREATE ROLE trio_web_worker NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trio_web_operator') THEN CREATE ROLE trio_web_operator NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $roles$;
REVOKE ALL ON SCHEMA manga_web FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA manga_web FROM PUBLIC;
GRANT USAGE ON SCHEMA manga_web TO trio_web_api,trio_web_worker,trio_web_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA manga_web TO trio_web_api,trio_web_worker;
REVOKE SELECT ON auth_attempts,auth_evidence,auth_limiter_events,login_bindings,app_sessions,signing_verifiers,uploads,upload_candidates,exports,exit_operations,draft_barriers,file_attestations FROM trio_web_worker;
GRANT SELECT(account_id,binding_id,state) ON login_bindings TO trio_web_worker;
GRANT SELECT(account_id,session_id,binding_id,revoked_at,auth_generation,absolute_expires_at) ON app_sessions TO trio_web_worker;
REVOKE SELECT ON execution_evidence FROM trio_web_api;
GRANT SELECT(account_id,evidence_id,execution_id,kind,evidence_digest,received_at) ON execution_evidence TO trio_web_api;
GRANT UPDATE(revision,auth_generation,binding_revision,last_all_logout_order) ON accounts TO trio_web_api;
GRANT UPDATE(revision,balance_credit,free_started_count) ON accounts TO trio_web_worker;
GRANT INSERT,UPDATE ON login_bindings,auth_attempts,auth_evidence,app_sessions,workspace_contexts,settings_revisions,workspace_pages,command_receipts,
  processing_requests,request_steps,free_reservations,batches,assets,manual_history,history_cursors,uploads,upload_candidates,exports,exit_operations,draft_barriers,file_attestations,work_items,account_clock_observations,paint_selections,connection_rounds TO trio_web_api;
GRANT INSERT ON project_lineages,page_lineages,auth_limiter_events,domain_events TO trio_web_api;
GRANT UPDATE,DELETE ON auth_limiter_events TO trio_web_api;
GRANT INSERT,DELETE,UPDATE ON account_live_context_slots,active_page_requests TO trio_web_api;
GRANT INSERT,UPDATE ON processing_requests,request_steps,executions,cost_items,free_reservations,batches,workspace_contexts,workspace_pages,connection_rounds,provider_wait_rounds,assets,manual_history,history_cursors,work_items,account_clock_observations,library_store_operations,library_store_attempts,library_heads TO trio_web_worker;
GRANT UPDATE(retry_group_id,state,revision) ON library_store_operations TO trio_web_api;
GRANT INSERT ON execution_evidence,free_starts,ledger_entries,settlements,checkpoints,results,result_applications,domain_events TO trio_web_worker;
GRANT INSERT ON results TO trio_web_api;
GRANT DELETE ON account_live_context_slots,active_page_requests TO trio_web_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA manga_web TO trio_web_api,trio_web_worker;
-- No service role can UPDATE/DELETE irreversible evidence, free-start facts or ledger entries.
REVOKE UPDATE,DELETE ON execution_evidence,free_starts,ledger_entries,settlements FROM trio_web_api,trio_web_worker;
CREATE FUNCTION current_account() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('trio.account_id',true),'')::uuid$$;
DO $policies$ DECLARE item record; BEGIN
  FOR item IN SELECT table_name FROM information_schema.columns WHERE table_schema='manga_web' AND column_name='account_id' LOOP
    EXECUTE format('ALTER TABLE manga_web.%I ENABLE ROW LEVEL SECURITY',item.table_name);
    EXECUTE format('CREATE POLICY account_scope ON manga_web.%I TO trio_web_api,trio_web_worker USING (account_id=manga_web.current_account()) WITH CHECK (account_id=manga_web.current_account())',item.table_name);
  END LOOP;
END $policies$;
CREATE FUNCTION resolve_session(token_digest text) RETURNS TABLE(account_id uuid,session_id uuid,csrf_digest text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT s.account_id,s.session_id,s.csrf_digest FROM manga_web.app_sessions s JOIN manga_web.accounts a USING(account_id) JOIN manga_web.login_bindings b USING(account_id,binding_id)
  WHERE s.cookie_digest=token_digest AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp() AND s.auth_generation=a.auth_generation AND a.access_state='ACTIVE' AND b.state='ACTIVE'$$;
CREATE FUNCTION binding_owner(binding_issuer text,binding_subject text) RETURNS TABLE(account_id uuid,binding_id uuid,state text,method text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT b.account_id,b.binding_id,b.state,b.method FROM manga_web.login_bindings b WHERE b.issuer=binding_issuer AND b.subject=binding_subject$$;
CREATE FUNCTION dispatch_candidates() RETURNS SETOF work_items LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT w.* FROM manga_web.work_items w WHERE w.state IN ('READY','CLAIMED') AND w.kind IN ('DISPATCH','RECONCILE','SETTLE','BATCH') ORDER BY w.due_at,w.work_item_id LIMIT 50$$;
CREATE FUNCTION active_accounts() RETURNS TABLE(account_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT DISTINCT c.account_id FROM manga_web.workspace_contexts c WHERE c.lifecycle<>'CLOSED'$$;
CREATE FUNCTION media_candidates() RETURNS SETOF work_items LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
  SELECT w.* FROM manga_web.work_items w WHERE w.state IN ('READY','CLAIMED') AND w.kind IN ('STORE','DELETE_OBJECT') ORDER BY w.due_at,w.work_item_id LIMIT 50$$;
CREATE FUNCTION retention_accounts() RETURNS TABLE(account_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT DISTINCT o.account_id FROM manga_web.library_store_operations o UNION SELECT DISTINCT c.account_id FROM manga_web.workspace_contexts c WHERE c.lifecycle<>'CLOSED'$$;
REVOKE ALL ON FUNCTION resolve_session(text),binding_owner(text,text),dispatch_candidates(),active_accounts(),media_candidates() FROM PUBLIC;
REVOKE ALL ON FUNCTION retention_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_session(text),binding_owner(text,text) TO trio_web_api;
GRANT EXECUTE ON FUNCTION dispatch_candidates(),active_accounts(),media_candidates() TO trio_web_worker;
GRANT EXECUTE ON FUNCTION retention_accounts() TO trio_web_worker;
CREATE VIEW operations_metadata AS SELECT event_id,kind,reason_code,event_time FROM domain_events;
GRANT SELECT ON operations_metadata TO trio_web_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA manga_web REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
