/**
 * Build the Jarvis playbook chunks from the google-ads-titan skill.
 *
 * Manual tool, never run in CI. The knowledge base is private: the output goes
 * to a gitignored folder and must never be committed.
 *
 * Usage:
 *   npx tsx scripts/jarvis/build-playbook.ts [skillDir] [outFile] [--summaries overrides.json]
 *
 *   skillDir   defaults to /mnt/skills/plugins/google-ads-titan
 *   outFile    defaults to ./.playbook-build/chunks.json
 *   --summaries  optional JSON object { "bid-05": "one line summary", ... }
 *                that replaces the auto-generated placeholder summaries.
 *
 * Then, to load it into the database (also manual):
 *   npx tsx --env-file=.env.local scripts/jarvis/import-playbook.ts
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { applySummaryOverrides, buildPlaybook, computePlaybookVersion, validatePlaybookChunks } from '../../lib/jarvis/playbook/build';
import type { PlaybookBuildFile } from '../../lib/jarvis/playbook/types';

const DEFAULT_SKILL_DIR = '/mnt/skills/plugins/google-ads-titan';
const DEFAULT_OUT_FILE = './.playbook-build/chunks.json';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let summaries: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--summaries') {
      summaries = argv[++i] ?? null;
      if (!summaries) throw new Error('--summaries needs a file path.');
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown option ${argv[i]}.`);
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    skillDir: resolve(positional[0] ?? DEFAULT_SKILL_DIR),
    outFile: resolve(positional[1] ?? DEFAULT_OUT_FILE),
    summaries: summaries ? resolve(summaries) : null,
  };
}

function main() {
  const { skillDir, outFile, summaries } = parseArgs(process.argv.slice(2));

  const referencesDir = join(skillDir, 'references');
  if (!statSync(referencesDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`No references/ folder under ${skillDir}.`);
  }
  const files = readdirSync(referencesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, content: readFileSync(join(referencesDir, name), 'utf8') }));
  if (files.length === 0) throw new Error(`No .md files in ${referencesDir}.`);

  const built = buildPlaybook(files);
  let chunks = built.chunks;

  if (summaries) {
    const result = applySummaryOverrides(chunks, JSON.parse(readFileSync(summaries, 'utf8')));
    chunks = result.chunks;
    console.log(`summaries: ${result.applied.length} applied, ${result.unknown.length} unknown id(s)${result.unknown.length ? ` (${result.unknown.join(', ')})` : ''}`);
  }

  const problems = validatePlaybookChunks(chunks);
  if (problems.length) {
    console.error(`Refusing to write: ${problems.length} problem(s).`);
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const output: PlaybookBuildFile = { version: computePlaybookVersion(chunks), chunks };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  const { stats, removed } = built;
  console.log(`wrote ${outFile}`);
  console.log(`version: ${output.version}`);
  console.log(`files: ${files.length}`);
  console.log(`chunks: ${stats.count}`);
  console.log(`tokens per chunk: min ${stats.minTokens}, median ${stats.medianTokens}, max ${stats.maxTokens} (total ${stats.totalTokens})`);
  console.log(`volatile chunks: ${stats.volatile}`);
  console.log(
    `lines removed by sanitization: ${built.removedLines} ` +
      `(denied terms ${removed.deniedLines}, pointers into the skill ${removed.pointerLines}, dropped sections ${removed.sectionLines})`
  );
  console.log(`lines reworded instead of dropped: ${built.rewrittenLines}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
