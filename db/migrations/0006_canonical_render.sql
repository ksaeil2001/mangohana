SET LOCAL search_path TO manga_web,pg_catalog;
CREATE TABLE result_render_snapshots(
  account_id uuid NOT NULL,
  result_id uuid NOT NULL,
  render_digest text NOT NULL CHECK(render_digest~'^[0-9a-f]{64}$'),
  render_asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,result_id),
  FOREIGN KEY(account_id,result_id) REFERENCES results(account_id,result_id),
  FOREIGN KEY(account_id,render_asset_id) REFERENCES assets(account_id,asset_id)
);
ALTER TABLE result_render_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON result_render_snapshots TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
GRANT SELECT,INSERT ON result_render_snapshots TO trio_web_api,trio_web_worker;
