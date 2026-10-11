// Tests for run-timed.mjs. Fake commands only (node one-liners); nothing here builds the app or touches Docker.
//   node --test scripts/local-stack/run-timed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-timed.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-timed-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
  return out !== '' && !out.startsWith('Z');
}
function aliveSafe(pid) {
  try {
    return alive(pid);
  } catch {
    return false; // `ps -p` exits non-zero when the pid does not exist
  }
}
function run(args, command, env = {}) {
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
  const result = spawnSync(process.execPath, [RUNNER, '--label', 'build', '--log', log, ...args, '--', ...command], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    timeout: 60000,
  });
  return { ...result, log };
}
const node = (code) => [process.execPath, '-e', code];

test('success: exit 0, stages named, no output values echoed', () => {
  const r = run(['--timeout', '20', '--idle', '10'], node(`
    console.log('Creating an optimized production build ...');
    console.log(' ✓ Compiled successfully in 1s');
    console.log('   Linting and checking validity of types ...');
    console.log('   Collecting page data ...');
    console.log(' ✓ Generating static pages (65/65)');
    console.log('Route (app)  Size');`));
  assert.equal(r.status, 0, r.stderr);
  for (const stage of ['compiling', 'compiled', 'type-check', 'collecting-page-data', 'static-pages', 'summary']) {
    assert.match(r.stdout, new RegExp(`stage: ${stage}`));
  }
  assert.match(r.stdout, /done \(stage: summary\)/);
  assert.match(fs.readFileSync(r.log, 'utf8'), /Compiled successfully/);
});

test('warnings are a stage, not a failure', () => {
  const r = run(['--timeout', '20', '--idle', '10'], node(`console.log(' ⚠ Compiled with warnings in 2s'); console.log('A Node.js API (process.version) is used in the Edge Runtime');`));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stage: compiled-with-warnings/);
});

test('command failure keeps its exit code and shows the last lines', () => {
  const r = run(['--timeout', '20', '--idle', '10'], node(`console.log('Creating an optimized production build ...'); console.error('Failed to compile.'); console.error('Type error: nope'); process.exit(3)`));
  assert.equal(r.status, 3);
  assert.match(r.stderr, /command exited with 3 at stage "compile-failed"/);
  assert.match(r.stderr, /Type error: nope/);
});

test('total time limit: exit 124, whole process tree gone, other processes untouched', async () => {
  const pidFile = path.join(dir, 'pids-total.json');
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  const r = run(['--timeout', '3', '--idle', '60'], node(`
    const { spawn } = require('node:child_process');
    const same = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const own = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, same.pid, own.pid]));
    console.log('Collecting page data ...');
    setInterval(() => console.log('tick'), 300);`));
  assert.equal(r.status, 124, r.stderr);
  assert.match(r.stderr, /TIMEOUT: no result after 3s \(last stage: collecting-page-data\)/);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  await sleep(300);
  for (const pid of pids) assert.equal(aliveSafe(pid), false, `pid ${pid} should be stopped`);
  assert.equal(aliveSafe(bystander.pid), true, 'a process that is not a child of the command must survive');
  process.kill(bystander.pid, 'SIGKILL');
});

test('idle limit: silent command is stopped, exit 125, names the stage it stuck at', () => {
  const r = run(['--timeout', '60', '--idle', '2'], node(`console.log('Collecting page data ...'); setInterval(()=>{}, 1000)`));
  assert.equal(r.status, 125, r.stderr);
  assert.match(r.stderr, /HUNG: no output for 2s \(last stage: collecting-page-data\)/);
});

test('a command that ignores SIGTERM is killed after the grace period', () => {
  const t0 = Date.now();
  const r = run(['--timeout', '2', '--idle', '60'], node(`process.on('SIGTERM', () => {}); setInterval(() => console.log('x'), 200)`));
  assert.equal(r.status, 124, r.stderr);
  assert.ok(Date.now() - t0 < 15000);
});

test('leftover background process of a finished command is cleaned up', async () => {
  const pidFile = path.join(dir, 'pid-leftover.txt');
  const r = run(['--timeout', '20', '--idle', '10'], node(`
    const { spawn } = require('node:child_process');
    const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    kid.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
    console.log('Route (app)');`));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /stopped 1 leftover process\(es\)/);
  await sleep(300);
  assert.equal(aliveSafe(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

test('failure output is redacted: env-file values, tokens and remote URLs never reach the console', () => {
  const envFile = path.join(dir, 'fake.env');
  fs.writeFileSync(envFile, 'SOME_KEY=this-is-a-fake-value-123\nOTHER="quoted-fake-value-456"\n');
  const r = run(['--timeout', '20', '--idle', '10', '--env-file', envFile], node(`
    console.error('using this-is-a-fake-value-123 and quoted-fake-value-456');
    console.error('token eyJabcdefghij.klmnopqrstuv.wxyz1234');
    console.error('fetch https://example.invalid/path?x=1 failed, local http://127.0.0.1:54320/rest ok');
    process.exit(1)`));
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /this-is-a-fake-value|quoted-fake-value|eyJabc|example\.invalid/);
  assert.match(r.stderr, /<redacted>/);
  assert.match(r.stderr, /<url>/);
  assert.match(r.stderr, /http:\/\/127\.0\.0\.1:54320\/rest/);
});

test('the environment is never printed, only the stage log', () => {
  const r = run(['--timeout', '20', '--idle', '10'], node(`console.log('Compiled successfully')`), { SECRET_FOR_TEST: 'do-not-print-this-1' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /do-not-print-this-1/);
});

test('SIGTERM to the runner stops the command tree and exits 143', async () => {
  const pidFile = path.join(dir, 'pid-sigterm.txt');
  const log = path.join(dir, 'sigterm.log');
  const runner = spawn(process.execPath, [RUNNER, '--label', 'build', '--log', log, '--timeout', '60', '--idle', '60', '--',
    ...node(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  runner.stderr.on('data', (c) => (stderr += c));
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) await sleep(100);
  const commandPid = Number(fs.readFileSync(pidFile, 'utf8'));
  runner.kill('SIGTERM');
  const code = await new Promise((resolve) => runner.on('exit', resolve));
  assert.equal(code, 143, stderr);
  assert.equal(aliveSafe(commandPid), false);
});

test('if the script that started the runner is killed, the command tree is stopped', async () => {
  const pidFile = path.join(dir, 'pid-orphan.txt');
  const log = path.join(dir, 'orphan.log');
  // A parent that starts the runner and then dies hard, like a killed app.sh.
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, [${JSON.stringify(RUNNER)}, '--label', 'build', '--log', ${JSON.stringify(log)}, '--timeout', '120', '--idle', '120', '--',
      process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`)}],
      { stdio: 'ignore' }).unref();
    setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) await sleep(100);
  const commandPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(aliveSafe(commandPid), true);
  process.kill(parent.pid, 'SIGKILL');
  let gone = false;
  for (let i = 0; i < 80 && !gone; i += 1) {
    await sleep(250);
    gone = !aliveSafe(commandPid);
  }
  assert.equal(gone, true, 'the command should be stopped within 20s of its launcher dying');
});

test('bad usage is refused with exit 2', () => {
  for (const args of [['--timeout', 'abc', '--idle', '5'], ['--timeout', '0', '--idle', '5'], ['--timeout', '5', '--idle', '1.5'], ['--timeout', '5']]) {
    const r = run(args, node('1'));
    assert.equal(r.status, 2, args.join(' '));
  }
  const r = spawnSync(process.execPath, [RUNNER, '--log', path.join(dir, 'x.log'), '--timeout', '5', '--idle', '5'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('a command that cannot start fails clearly', () => {
  const r = run(['--timeout', '5', '--idle', '5'], ['/nonexistent/definitely-not-here']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not (run|start)/);
});
