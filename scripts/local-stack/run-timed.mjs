// Runs one command with a hard time limit, an idle limit and a stage log. Works the same on Linux and macOS
// (only node and `ps`; no `timeout`, no `setsid`, no /proc).
//
//   node run-timed.mjs --label build --timeout 900 --idle 300 --log <file> [--env-file <file>] -- <cmd> [args...]
//
// Exit codes:  the command's own code when it ends by itself · 124 total time limit · 125 idle limit
//              126 a process of the command could not be stopped · 130/143 interrupted · 2 bad usage
//
// What it stops: the command, every process that descends from it, and every process in its process group.
// Nothing else. It never matches by name, so another `next` on the machine is left alone.
// What it prints: stage names (a fixed list of Next.js build markers), seconds, and on failure the last lines
// of the command's output with the values of --env-file and obvious tokens/URLs removed. Never the environment.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STAGES = [
  [/Creating an optimized production build/, 'compiling'],
  [/Compiled with warnings/, 'compiled-with-warnings'],
  [/Compiled successfully/, 'compiled'],
  [/Failed to compile/, 'compile-failed'],
  [/Linting and checking validity of types/, 'type-check'],
  [/Collecting page data/, 'collecting-page-data'],
  [/Generating static pages/, 'static-pages'],
  [/Finalizing page optimization/, 'finalizing'],
  [/Collecting build traces/, 'build-traces'],
  [/^Route \(app\)/, 'summary'],
];
const TAIL_LINES = 15;
const GRACE_MS = 5000;
const HEARTBEAT_MS = 60000;

function usage(message) {
  if (message) console.error(`run-timed: ${message}`);
  console.error(
    'usage: run-timed.mjs --label <name> --timeout <seconds> --idle <seconds> --log <file> [--env-file <file>] -- <cmd> [args...]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) usage('missing "-- <command>"');
  const flags = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const opts = { label: 'command', timeout: NaN, idle: NaN, log: '', envFile: '' };
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    const value = flags[i + 1];
    if (value === undefined) usage(`${key} needs a value`);
    if (key === '--label') opts.label = value;
    else if (key === '--timeout') opts.timeout = Number(value);
    else if (key === '--idle') opts.idle = Number(value);
    else if (key === '--log') opts.log = value;
    else if (key === '--env-file') opts.envFile = value;
    else usage(`unknown option ${key}`);
  }
  for (const key of ['timeout', 'idle']) {
    // Whole seconds, at least 1 and at most 24 hours; anything else is a typo, not a setting.
    if (!Number.isInteger(opts[key]) || opts[key] < 1 || opts[key] > 86400) usage(`--${key} must be a whole number of seconds (1 to 86400)`);
  }
  if (!opts.log) usage('--log is required');
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(opts.label)) usage('--label must be a short lowercase word');
  return { opts, cmd };
}

const { opts, cmd } = parseArgs(process.argv.slice(2));
const started = Date.now();
const secs = () => Math.round((Date.now() - started) / 1000);
const say = (text) => console.log(`[${opts.label} +${secs()}s] ${text}`);

// ---- redaction -------------------------------------------------------------------------------
const knownValues = [];
if (opts.envFile) {
  try {
    for (const line of fs.readFileSync(opts.envFile, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value.length >= 8) knownValues.push(value);
    }
  } catch {
    /* no env file: the generic patterns below still apply */
  }
}
function redact(text) {
  let out = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const value of knownValues) out = out.split(value).join('<redacted>');
  return out
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '<token>')
    .replace(/\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_]{6,}/g, '<token>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (url) => (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url) ? url : '<url>'));
}

// ---- process table (BSD and procps `ps` both understand these keywords) -----------------------
function table() {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 4 && /^\d+$/.test(f[0]))
    .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), pgid: Number(f[2]), stat: f[3] }));
}
// Everything that belongs to the command: its descendants and the members of its process group.
function family(root) {
  const rows = table();
  const mine = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!mine.has(row.pid) && (mine.has(row.ppid) || row.pgid === root)) {
        mine.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => mine.has(row.pid) && !row.stat.startsWith('Z'));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(signal, pids, group) {
  try {
    process.kill(-group, signal);
  } catch {
    /* group already gone */
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
// Stops the family. Returns the pids that survived even SIGKILL (normally none).
async function stopFamily(root) {
  let members = family(root);
  if (members.length === 0) return [];
  // Remember every pid now: once a parent dies its children are re-parented and the walk would lose them.
  const seen = new Set(members.map((m) => m.pid));
  send('SIGTERM', seen, root);
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    members = table().filter((row) => seen.has(row.pid) && !row.stat.startsWith('Z'));
    if (members.length === 0) return [];
  }
  send('SIGKILL', members.map((m) => m.pid), root);
  await sleep(500);
  return table().filter((row) => seen.has(row.pid) && !row.stat.startsWith('Z')).map((row) => row.pid);
}

// ---- run -------------------------------------------------------------------------------------
fs.mkdirSync(path.dirname(path.resolve(opts.log)), { recursive: true });
const logFd = fs.openSync(opts.log, 'a', 0o600);
fs.writeSync(logFd, `\n=== ${opts.label} ${new Date().toISOString()} timeout=${opts.timeout}s idle=${opts.idle}s ===\n`);

let child;
try {
  child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
} catch (error) {
  console.error(`run-timed: could not start ${cmd[0]}: ${error.message}`);
  process.exit(127);
}
let spawnError = '';
child.on('error', (error) => {
  spawnError = error.message;
  if (child.pid === undefined) {
    // never started: no exit event will follow
    console.error(`${opts.label}: could not run ${cmd[0]}: ${error.message}`);
    process.exit(127);
  }
});

let stage = 'starting';
let lastOutput = Date.now();
let lastBeat = Date.now();
const tail = [];
const partial = { out: '', err: '' };
function handle(chunk, key) {
  lastOutput = Date.now();
  fs.writeSync(logFd, chunk);
  partial[key] += chunk.toString('utf8');
  const lines = partial[key].split(/\r?\n|\r/);
  partial[key] = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (!line) continue;
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
    for (const [pattern, name] of STAGES) {
      if (pattern.test(line) && name !== stage) {
        stage = name;
        say(`stage: ${name}`);
        break;
      }
    }
  }
}
child.stdout.on('data', (chunk) => handle(chunk, 'out'));
child.stderr.on('data', (chunk) => handle(chunk, 'err'));

function printTail() {
  if (tail.length === 0) return;
  console.error(`--- last ${tail.length} line(s) of output (values removed) ---`);
  for (const line of tail) console.error(`  ${redact(line).slice(0, 300)}`);
  console.error(`--- full log: ${opts.log} ---`);
}

let finishing = false;
async function finish(code, why) {
  if (finishing) return;
  finishing = true;
  clearInterval(ticker);
  const survivors = await stopFamily(child.pid);
  if (why) console.error(`${opts.label}: ${why}`);
  if (code !== 0) printTail();
  if (survivors.length > 0) {
    console.error(`${opts.label}: could not stop process(es) ${survivors.join(', ')}; stop them by hand.`);
    process.exit(126);
  }
  process.exit(code);
}

let closed = false;
child.on('close', () => {
  closed = true;
});
child.on('exit', async (code, signal) => {
  if (finishing) return;
  // Let the last buffered output arrive (a leftover grandchild can hold the pipe open, so do not wait forever).
  for (let i = 0; i < 10 && !closed; i += 1) await sleep(100);
  // The command ended by itself. Anything it left behind in its group goes too.
  const status = spawnError ? 127 : code ?? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[signal] ?? 1);
  const leftovers = family(child.pid).filter((row) => row.pid !== child.pid).length;
  const note = [spawnError && `could not run ${cmd[0]}: ${spawnError}`, leftovers > 0 && `stopped ${leftovers} leftover process(es) of the command`].filter(Boolean).join('; ');
  if (status === 0) say(`done (stage: ${stage})`);
  else say(`failed with exit ${status} (stage: ${stage})`);
  finish(status, note || (status === 0 ? '' : `command exited with ${status} at stage "${stage}"`));
});

const originalParent = process.ppid;
const ticker = setInterval(() => {
  if (finishing) return;
  const total = (Date.now() - started) / 1000;
  const quiet = (Date.now() - lastOutput) / 1000;
  if (total >= opts.timeout) {
    finish(124, `TIMEOUT: no result after ${opts.timeout}s (last stage: ${stage}). Stopped the command and its child processes.`);
  } else if (quiet >= opts.idle) {
    finish(125, `HUNG: no output for ${opts.idle}s (last stage: ${stage}). Stopped the command and its child processes.`);
  } else if (process.ppid !== originalParent) {
    finish(143, 'the script that started this was killed; stopped the command and its child processes.');
  } else if (Date.now() - lastBeat >= HEARTBEAT_MS) {
    lastBeat = Date.now();
    say(`still running (stage: ${stage}, quiet for ${Math.round(quiet)}s, limit ${opts.timeout}s)`);
  }
}, 500);

for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(name, () => finish(code, `interrupted (${name}); stopped the command and its child processes.`));
}
