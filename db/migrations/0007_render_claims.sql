SET LOCAL search_path TO manga_web,pg_catalog;
CREATE TABLE result_render_claims(
  account_id uuid NOT NULL,
  result_id uuid NOT NULL,
  render_digest text NOT NULL CHECK(render_digest~'^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK(generation>0),
  owner_id uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  PRIMARY KEY(account_id,result_id),
  FOREIGN KEY(account_id,result_id) REFERENCES results(account_id,result_id)
);
CREATE TABLE result_render_candidates(
  account_id uuid NOT NULL,
  result_id uuid NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  asset_id uuid NOT NULL,
  render_digest text NOT NULL CHECK(render_digest~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,result_id,generation),
  UNIQUE(account_id,asset_id),
  FOREIGN KEY(account_id,result_id) REFERENCES results(account_id,result_id)
);
ALTER TABLE result_render_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_render_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON result_render_claims TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
CREATE POLICY account_scope ON result_render_candidates TO trio_web_api,trio_web_worker USING(account_id=manga_web.current_account()) WITH CHECK(account_id=manga_web.current_account());
GRANT SELECT,INSERT ON result_render_claims,result_render_candidates TO trio_web_api,trio_web_worker;
GRANT UPDATE(generation,owner_id,lease_until) ON result_render_claims TO trio_web_api,trio_web_worker;
