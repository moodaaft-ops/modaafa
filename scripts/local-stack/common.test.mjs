// Tests for common.sh: how the Docker daemon is pinned and carried through the clean environment.
// A fake `docker` logs every call, so these also prove that nothing changes the user's Docker setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLIMA = 'unix:///Users/qa/.colima/modaafa-qa/docker.sock';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'common-test-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  const log = path.join(dir, 'docker-calls.log');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh
echo "$*" >> "${log}"
[ "$1" = context ] && [ "$2" = inspect ] || exit 9
name=""
for a in "$@"; do case "$a" in context|inspect|--format|'{{.Endpoints.docker.Host}}') ;; *) name="$a";; esac; done
[ -z "$name" ] && name="\${DOCKER_CONTEXT:-default}"
case "$name" in
  default) echo unix:///var/run/docker.sock;;
  colima-modaafa-qa) echo ${COLIMA};;
  remote-tcp) echo tcp://10.0.0.5:2375;;
  *) exit 1;;
esac
`,
    { mode: 0o755 }
  );
  const run = (script, env = {}) =>
    spawnSync('bash', ['-c', `set -u; umask 077; HERE='${HERE}'; STATE='${state}'; . "$HERE/common.sh"; ${script}`], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
    });
  return { dir, home, state, log, run, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('clean_env drops inherited variables, DOCKER_CONTEXT and DOCKER_HOST included, and keeps proxy names', () => {
  const { run } = sandbox();
  const r = run('clean_env env', {
    STRIPE_SECRET_KEY: 'not-a-real-value', DATABASE_URL: 'postgres://x', NODE_ENV: 'development',
    DOCKER_CONTEXT: 'colima-modaafa-qa', DOCKER_HOST: COLIMA, HTTPS_PROXY: 'http://127.0.0.1:1',
  });
  const names = new Set(r.stdout.split('\n').map((l) => l.split('=')[0]));
  for (const gone of ['STRIPE_SECRET_KEY', 'DATABASE_URL', 'NODE_ENV', 'DOCKER_CONTEXT', 'DOCKER_HOST']) assert.ok(!names.has(gone), gone);
  for (const kept of ['PATH', 'HOME', 'HTTPS_PROXY']) assert.ok(names.has(kept), kept);
});

test('pin_docker follows DOCKER_CONTEXT, exports DOCKER_HOST, drops DOCKER_CONTEXT and records the daemon (0600)', () => {
  const { run, state } = sandbox();
  const r = run('pin_docker && echo "HOST=$DOCKER_HOST CTX=${DOCKER_CONTEXT:-unset}"', { DOCKER_CONTEXT: 'colima-modaafa-qa' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`HOST=${COLIMA.replaceAll('/', '\\/')} CTX=unset`));
  const file = path.join(state, 'docker-host');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), COLIMA);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('pin_docker refuses a remote context and records nothing', () => {
  const { run, state } = sandbox();
  const r = run('pin_docker', { DOCKER_CONTEXT: 'remote-tcp' });
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(state, 'docker-host')));
});

test('use_stack_docker keeps the daemon up.sh chose, even when this shell selects another one', () => {
  const { run, state } = sandbox();
  fs.writeFileSync(path.join(state, 'docker-host'), `${COLIMA}\n`);
  const r = run('use_stack_docker && echo "HOST=$DOCKER_HOST CTX=${DOCKER_CONTEXT:-unset}"', { DOCKER_HOST: 'unix:///var/run/docker.sock' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`HOST=${COLIMA} CTX=unset`));
  assert.match(r.stderr, /not the one in this shell/);
});

test('use_stack_docker without a record resolves from the environment and refuses remote endpoints', () => {
  const { run } = sandbox();
  const ok = run('use_stack_docker && echo "$DOCKER_HOST"', { DOCKER_CONTEXT: 'colima-modaafa-qa' });
  assert.equal(ok.stdout.trim(), COLIMA);
  assert.notEqual(run('use_stack_docker', { DOCKER_CONTEXT: 'remote-tcp' }).status, 0);
});

test('a tampered docker-host record (not a local socket) is refused', () => {
  const { run, state } = sandbox();
  fs.writeFileSync(path.join(state, 'docker-host'), 'tcp://10.0.0.5:2375\n');
  assert.notEqual(run('use_stack_docker').status, 0);
});

test('pinning only reads contexts: no `context use`, no daemon call, no Docker file written', () => {
  const { run, calls, home } = sandbox();
  run('pin_docker; use_stack_docker', { DOCKER_CONTEXT: 'colima-modaafa-qa' });
  const seen = calls();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((c) => c.startsWith('context inspect')), seen.join(' | '));
  assert.deepEqual(fs.readdirSync(home), []);
});

test('with_stack_env hands the app the stack variables but not DOCKER_HOST unless asked', () => {
  const { run, state } = sandbox();
  fs.writeFileSync(path.join(state, 'env'), 'STACK_VALUE=1\n');
  const plain = run('with_stack_env env', { DOCKER_HOST: COLIMA });
  assert.ok(plain.stdout.includes('STACK_VALUE=1'));
  assert.ok(!plain.stdout.includes('DOCKER_HOST'));
  const asked = run('with_stack_env env DOCKER_HOST="$DOCKER_HOST" env', { DOCKER_HOST: COLIMA });
  assert.ok(asked.stdout.includes(`DOCKER_HOST=${COLIMA}`));
});
