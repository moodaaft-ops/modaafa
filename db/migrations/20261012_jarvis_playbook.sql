-- =============================================================================
-- 2026-10-12 — Jarvis playbook chunks (PR-J8: titan playbook retrieval)
--
-- The Google Ads playbook the assistant reads on demand, one chunk per row. The
-- text is private knowledge: it is loaded by scripts/jarvis/import-playbook.ts
-- from a gitignored build, never from this repository.
--
-- Forward-only, non-destructive and safe to run repeatedly.
-- Server-only data: RLS is enabled with NO policies, anon and authenticated
-- hold no privilege at all, and only the service role reads and writes.
--
-- Supabase gives new objects in schema public default privileges for anon,
-- authenticated and service_role. So this file never relies on "grant only
-- what is needed": it first revokes everything, then grants back the minimum.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.jarvis_playbook_chunks (
  id TEXT PRIMARY KEY
    CHECK (id ~ '^[a-z]{2,6}-[0-9]{2,3}$'),
  version TEXT NOT NULL
    CHECK (char_length(version) BETWEEN 1 AND 64),
  file TEXT NOT NULL,
  section TEXT,
  title_ar TEXT NOT NULL,
  summary_ar TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  campaign_types TEXT[] NOT NULL DEFAULT '{}',
  volatile BOOLEAN NOT NULL DEFAULT FALSE,
  tokens INTEGER NOT NULL
    CHECK (tokens > 0),
  body_ar TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jarvis_playbook_chunks_version
  ON public.jarvis_playbook_chunks(version);

ALTER TABLE public.jarvis_playbook_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.jarvis_playbook_chunks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jarvis_playbook_chunks TO service_role;

COMMENT ON TABLE public.jarvis_playbook_chunks IS
  'Chunked Google Ads playbook for the Jarvis assistant. Service role only; no browser access. Loaded manually by scripts/jarvis/import-playbook.ts.';
