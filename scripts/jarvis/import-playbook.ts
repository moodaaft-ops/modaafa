/**
 * Load the built Jarvis playbook into the jarvis_playbook_chunks table.
 *
 * Manual tool, run by the owner only, never in CI. It needs the service role
 * key, so it must run against the environment you mean to change.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/jarvis/import-playbook.ts [chunksFile] [--summaries overrides.json] [--dry-run]
 *
 *   chunksFile   defaults to ./.playbook-build/chunks.json (from build-playbook.ts)
 *   --summaries  optional JSON object { "bid-05": "one line summary", ... }
 *                applied on top of the file before importing
 *   --dry-run    validate and print the counts, write nothing
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * Order of work: validate (refuse on any denied term), upsert every chunk, and
 * only after every upsert succeeded delete rows of older versions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

import {
  applySummaryOverrides,
  computePlaybookVersion,
  summarizeChunkStats,
  validatePlaybookChunks,
} from '../../lib/jarvis/playbook/build';
import { PLAYBOOK_TABLE, type PlaybookBuildFile, type PlaybookChunk } from '../../lib/jarvis/playbook/types';
import { isConfiguredEnv } from '../../lib/platform/env';

const DEFAULT_CHUNKS_FILE = './.playbook-build/chunks.json';
const BATCH_SIZE = 40;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let summaries: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--summaries') {
      summaries = argv[++i] ?? null;
      if (!summaries) throw new Error('--summaries needs a file path.');
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown option ${argv[i]}.`);
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    chunksFile: resolve(positional[0] ?? DEFAULT_CHUNKS_FILE),
    summaries: summaries ? resolve(summaries) : null,
    dryRun,
  };
}

function loadChunks(chunksFile: string, summariesFile: string | null): PlaybookBuildFile {
  const raw = JSON.parse(readFileSync(chunksFile, 'utf8')) as Partial<PlaybookBuildFile>;
  let chunks = (raw.chunks ?? []) as PlaybookChunk[];

  const problems = validatePlaybookChunks(chunks);
  if (problems.length) {
    console.error(`Refusing to import: ${problems.length} problem(s) in ${chunksFile}.`);
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }

  if (summariesFile) {
    const result = applySummaryOverrides(chunks, JSON.parse(readFileSync(summariesFile, 'utf8')));
    chunks = result.chunks;
    console.log(
      `summaries: ${result.applied.length} applied, ${result.unknown.length} unknown id(s)` +
        (result.unknown.length ? ` (${result.unknown.join(', ')})` : '')
    );
  }

  // Summaries are part of what the model sees, so they are part of the version.
  return { version: computePlaybookVersion(chunks), chunks };
}

async function main() {
  const { chunksFile, summaries, dryRun } = parseArgs(process.argv.slice(2));
  const { version, chunks } = loadChunks(chunksFile, summaries);
  const stats = summarizeChunkStats(chunks);
  console.log(`file: ${chunksFile}`);
  console.log(`version: ${version}`);
  console.log(`chunks: ${stats.count} (volatile ${stats.volatile}, ${stats.totalTokens} tokens in total)`);

  if (dryRun) {
    console.log('dry run: nothing written.');
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!isConfiguredEnv(url) || !isConfiguredEnv(key)) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (for example with --env-file).');
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // One timestamp for the whole import: the newest rows define the current version.
  const updatedAt = new Date().toISOString();
  let upserted = 0;
  for (let from = 0; from < chunks.length; from += BATCH_SIZE) {
    const rows = chunks.slice(from, from + BATCH_SIZE).map((chunk) => ({ ...chunk, version, updated_at: updatedAt }));
    const { error } = await admin.from(PLAYBOOK_TABLE).upsert(rows, { onConflict: 'id' });
    if (error) {
      throw new Error(`Upsert failed after ${upserted} row(s): ${error.message}. Older versions were left in place.`);
    }
    upserted += rows.length;
  }
  console.log(`upserted: ${upserted}`);

  const { error: deleteError, count: deleted } = await admin
    .from(PLAYBOOK_TABLE)
    .delete({ count: 'exact' })
    .neq('version', version);
  if (deleteError) {
    throw new Error(`Rows were upserted but removing older versions failed: ${deleteError.message}`);
  }
  console.log(`deleted from older versions: ${deleted ?? 0}`);

  const { count: current, error: countError } = await admin
    .from(PLAYBOOK_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('version', version);
  if (countError) throw new Error(`Could not verify the import: ${countError.message}`);
  console.log(`rows now at ${version}: ${current ?? 0}`);
  if (current !== chunks.length) {
    throw new Error(`Expected ${chunks.length} rows at ${version} but found ${current ?? 0}.`);
  }
  console.log('done. The assistant picks up the new index within ten minutes.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
