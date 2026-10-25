SET LOCAL search_path TO manga_web,pg_catalog;
-- After the current batch page finishes, the worker admits the next captured page.
-- The existing per-account RLS and unique active-page slot still enforce ownership.
GRANT INSERT ON active_page_requests TO trio_web_worker;
