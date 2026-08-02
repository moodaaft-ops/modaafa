import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

import { decryptForRotation, encrypt } from '../lib/crypto';

// Keep the legacy session table in the rotation set while it exists. It is
// browser-inaccessible but may still contain credentials from older flows.
const TABLES = ['google_ads_accounts', 'pending_oauth_sessions'] as const;
const DEFAULT_BATCH_SIZE = 100;
const CHECKPOINT_VERSION = 1;

type TokenTable = (typeof TABLES)[number];

type TokenRow = {
  id: string;
  refresh_token_encrypted: string;
};

type Checkpoint = {
  version: number;
  keyFingerprint: string;
  tableIndex: number;
  after: string | null;
  processed: number;
  updated: number;
  completed: boolean;
  skippedMissingTables: TokenTable[];
};

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const resetCheckpoint = args.includes('--reset-checkpoint');
const batchSize = integerOption('--batch-size', DEFAULT_BATCH_SIZE);
const checkpointPath = resolve(
  process.cwd(),
  stringOption('--checkpoint') ?? '.modaafa-reencrypt-progress.json'
);

if (args.includes('--help')) {
  console.log(`
Re-encrypt stored Google OAuth refresh tokens with the current ENCRYPTION_KEY.

Usage:
  pnpm exec tsx scripts/reencrypt-refresh-tokens.ts [options]

Options:
  --apply                  Persist changes. Without this flag the script is read-only.
  --batch-size=<number>    Rows per batch (default: ${DEFAULT_BATCH_SIZE}).
  --checkpoint=<path>      Resume checkpoint path.
  --reset-checkpoint       Remove the checkpoint before starting a new rotation.
  --help                   Show this help.
`);
  process.exit(0);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Refresh-token rotation failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const encryptionKey = requiredEnv('ENCRYPTION_KEY');
  const keyFingerprint = createHash('sha256').update(encryptionKey).digest('hex').slice(0, 16);

  if (resetCheckpoint) {
    await removeCheckpoint();
  }

  const checkpoint = applyChanges
    ? await loadCheckpoint(keyFingerprint)
    : newCheckpoint(keyFingerprint);

  if (checkpoint.completed) {
    console.log('This key rotation is already complete. Use --reset-checkpoint for a new run.');
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `${applyChanges ? 'APPLY' : 'DRY RUN'}: scanning encrypted refresh tokens in batches of ${batchSize}.`
  );

  while (checkpoint.tableIndex < TABLES.length) {
    const table = TABLES[checkpoint.tableIndex];
    let query = supabase
      .from(table)
      .select('id, refresh_token_encrypted')
      .order('id', { ascending: true })
      .limit(batchSize);

    if (checkpoint.after) {
      query = query.gt('id', checkpoint.after);
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error.code, error.message)) {
        checkpoint.skippedMissingTables.push(table);
        checkpoint.tableIndex += 1;
        checkpoint.after = null;
        await saveCheckpointIfNeeded(checkpoint);
        console.log(`${table}: table is absent, skipped.`);
        continue;
      }
      throw new Error(`${table}: failed to read a batch (${error.code ?? 'unknown'}).`);
    }

    const rows = (data ?? []) as TokenRow[];
    if (rows.length === 0) {
      checkpoint.tableIndex += 1;
      checkpoint.after = null;
      await saveCheckpointIfNeeded(checkpoint);
      console.log(`${table}: complete.`);
      continue;
    }

    let batchUpdates = 0;
    for (const row of rows) {
      let decrypted;
      try {
        decrypted = decryptForRotation(row.refresh_token_encrypted);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown decryption error';
        throw new Error(
          `${table}:${row.id} could not be decrypted (${message}). ` +
            'The checkpoint was not advanced; fix the keys and resume.'
        );
      }

      if (!decrypted.needsReencryption) {
        continue;
      }

      batchUpdates += 1;
      if (!applyChanges) {
        continue;
      }

      const replacement = encrypt(decrypted.plaintext);
      const { data: updatedRows, error: updateError } = await supabase
        .from(table)
        .update({ refresh_token_encrypted: replacement })
        .eq('id', row.id)
        .eq('refresh_token_encrypted', row.refresh_token_encrypted)
        .select('id');

      if (updateError) {
        throw new Error(
          `${table}:${row.id} failed to update (${updateError.code ?? 'unknown'}). ` +
            'The checkpoint was not advanced; rerunning this batch is safe.'
        );
      }
      if (!updatedRows || updatedRows.length !== 1) {
        throw new Error(
          `${table}:${row.id} changed concurrently. The checkpoint was not advanced; rerun safely.`
        );
      }
    }

    checkpoint.processed += rows.length;
    checkpoint.updated += batchUpdates;
    checkpoint.after = rows[rows.length - 1].id;
    await saveCheckpointIfNeeded(checkpoint);

    console.log(
      `${table}: processed ${checkpoint.processed} total row(s); ` +
        `${checkpoint.updated} require${applyChanges ? 'd' : ''} re-encryption.`
    );
  }

  checkpoint.completed = true;
  await saveCheckpointIfNeeded(checkpoint);
  console.log(
    `${applyChanges ? 'Rotation' : 'Dry run'} complete: ` +
      `${checkpoint.processed} row(s) scanned, ${checkpoint.updated} row(s) ` +
      `${applyChanges ? 'updated' : 'would be updated'}.`
  );
}

function newCheckpoint(keyFingerprint: string): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    keyFingerprint,
    tableIndex: 0,
    after: null,
    processed: 0,
    updated: 0,
    completed: false,
    skippedMissingTables: [],
  };
}

async function loadCheckpoint(keyFingerprint: string): Promise<Checkpoint> {
  try {
    const parsed = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
    if (parsed.version !== CHECKPOINT_VERSION) {
      throw new Error(`Unsupported checkpoint version ${parsed.version}.`);
    }
    if (parsed.keyFingerprint !== keyFingerprint) {
      throw new Error(
        'The checkpoint belongs to a different ENCRYPTION_KEY. ' +
          'Use --reset-checkpoint only after confirming the prior rotation is finished.'
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return newCheckpoint(keyFingerprint);
    }
    throw error;
  }
}

async function saveCheckpointIfNeeded(checkpoint: Checkpoint) {
  if (!applyChanges) return;

  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, checkpointPath);
}

async function removeCheckpoint() {
  try {
    await unlink(checkpointPath);
    console.log(`Removed checkpoint ${checkpointPath}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function stringOption(name: string): string | undefined {
  const prefix = `${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function integerOption(name: string, fallback: number): number {
  const raw = stringOption(name);
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`${name} must be an integer between 1 and 1000.`);
  }
  return value;
}

function isMissingTableError(code: string | undefined, message: string): boolean {
  return code === '42P01' || code === 'PGRST205' || /relation .* does not exist/i.test(message);
}
