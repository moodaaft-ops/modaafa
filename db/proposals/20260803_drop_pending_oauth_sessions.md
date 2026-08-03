# Proposed removal of `pending_oauth_sessions`

This proposal is intentionally outside `db/migrations`. Do not execute it
without explicit owner approval because dropping the table is irreversible.

## 1. Confirm the table is unused

```bash
rg -n "pending_oauth_sessions" app lib scripts db/schema.sql
```

The current linking flow must not read or write the table. Before scheduling
the removal, delete its legacy entry from `scripts/reencrypt-refresh-tokens.ts`
and remove its table, index, RLS, policy, and grant declarations from
`db/schema.sql` in the same release.

## 2. Create and verify a backup

Use the production database URL without printing it:

```bash
pg_dump "$SUPABASE_DB_URL" \
  --table=public.pending_oauth_sessions \
  --format=custom \
  --file="pending_oauth_sessions-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Verify that the archive is readable before continuing:

```bash
pg_restore --list pending_oauth_sessions-*.dump
```

Store the encrypted archive in the approved private backup location. Never
commit it: rows may contain encrypted Google refresh tokens.

## 3. Record a reversible evidence snapshot

Record only aggregate metadata in the change ticket, never token values:

```sql
SELECT COUNT(*) AS rows,
       MIN(created_at) AS oldest_row,
       MAX(created_at) AS newest_row,
       MIN(expires_at) AS earliest_expiry,
       MAX(expires_at) AS latest_expiry
FROM public.pending_oauth_sessions;
```

## 4. Execute during a maintenance window

After owner approval, copy
`db/proposals/20260803_drop_pending_oauth_sessions.sql` to a newly dated file
under `db/migrations`, apply it once, and verify:

```sql
SELECT to_regclass('public.pending_oauth_sessions') IS NULL AS removed;
```

Run the full application check and `/api/health` before ending the window.

## Restore procedure

If rollback is required, restore only this table from the verified archive:

```bash
pg_restore \
  --dbname="$SUPABASE_DB_URL" \
  --table=public.pending_oauth_sessions \
  --clean --if-exists \
  pending_oauth_sessions-YYYYMMDDTHHMMSSZ.dump
```

Reapply the RLS policy and grants from the matching pre-removal version of
`db/schema.sql`, then verify that browser roles still have no table access.
