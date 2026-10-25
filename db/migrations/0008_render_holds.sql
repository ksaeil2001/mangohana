SET LOCAL search_path TO manga_web,pg_catalog;
CREATE TABLE result_render_holds(
  account_id uuid NOT NULL,
  result_id uuid NOT NULL,
  render_digest text NOT NULL CHECK(render_digest~'^[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK(evidence_digest~'^[0-9a-f]{64}$'),
  protected_layout jsonb NOT NULL CHECK((jsonb_typeof(protected_layout)='object' AND protected_layout->>'qa'='HOLD') IS TRUE),
  protected_overlays jsonb NOT NULL CHECK(jsonb_typeof(protected_overlays)='array'),
  claim_generation bigint NOT NULL CHECK(claim_generation>0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,result_id),
  FOREIGN KEY(account_id,result_id) REFERENCES results(account_id,result_id)
);
ALTER TABLE result_render_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_render_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON result_render_holds TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
GRANT SELECT,INSERT ON result_render_holds TO trio_web_api,trio_web_worker;
