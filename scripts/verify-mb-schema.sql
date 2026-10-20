WITH wanted(name) AS (VALUES ('guard_findings'), ('lead_loop_settings'), ('lead_clicks'),
 ('lead_conversion_uploads'), ('measurement_scans'), ('google_scope_grants'), ('merchant_context_facts'),
 ('store_connections'), ('store_orders'), ('agency_handoffs'), ('autopilot_autonomy'), ('landing_checks'),
 ('shadow_accounts'), ('shadow_decisions'), ('shadow_reviews'))
SELECT w.name, c.oid IS NOT NULL AS exists, COALESCE(c.relrowsecurity,false) AS rls,
 (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=w.name) AS policies,
 has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE') AS browser_write
FROM wanted w LEFT JOIN pg_class c ON c.relname=w.name AND c.relnamespace='public'::regnamespace ORDER BY w.name;

SELECT role,
 has_column_privilege(role,'public.store_connections','access_token_encrypted','SELECT') AS access_token_read,
 has_column_privilege(role,'public.store_connections','refresh_token_encrypted','SELECT') AS refresh_token_read,
 has_table_privilege(role,'public.store_connections','INSERT,UPDATE,DELETE') AS connection_write,
 has_table_privilege(role,'public.store_orders','INSERT,UPDATE,DELETE') AS order_write,
 has_table_privilege(role,'public.google_scope_grants','SELECT,INSERT,UPDATE,DELETE') AS google_grant_access
FROM (VALUES ('anon'), ('authenticated')) r(role);
