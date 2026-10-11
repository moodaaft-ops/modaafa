// Negative tests for preflight.mjs: each case must be refused (or allowed) before anything is written.
// Run by verify.sh. Needs no running stack; it only spawns preflight.mjs with a controlled environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preflight.mjs');
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (args, extra = {}) =>
  spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...baseEnv, ...extra } });
const refused = (args, extra) => assert.notEqual(run(args, extra).status, 0);
const allowed = (args, extra) => assert.equal(run(args, extra).status, 0, run(args, extra).stderr);

test('clean environment is allowed', () => allowed(['env']));
test('production ref inside any variable is refused', () => refused(['env'], { SOME_VAR: 'x-xxnkubcfwabesungeskz-y' }));
test('ai.modaafa.com inside any variable is refused', () => refused(['env'], { X: 'https://ai.modaafa.com/api' }));
test('DATABASE_URL on a hosted host is refused', () =>
  refused(['env'], { DATABASE_URL: 'postgresql://u:p@db.abcdefghij1234567890.supabase.co:5432/postgres' }));
test('SUPABASE_DB_URL on a pooler is refused', () =>
  refused(['env'], { SUPABASE_DB_URL: 'postgresql://postgres.zzzz:p@aws-0-eu.pooler.supabase.com:6543/postgres' }));
test('PGHOST remote is refused, loopback is allowed', () => {
  refused(['env'], { PGHOST: '10.1.2.3' });
  allowed(['env'], { PGHOST: '127.0.0.1' });
});
test('PGSERVICE is refused', () => refused(['env'], { PGSERVICE: 'prod' }));
test('a remote DOCKER_HOST is refused', () => {
  refused(['env'], { DOCKER_HOST: 'tcp://10.0.0.5:2375' });
  refused(['env'], { DOCKER_HOST: 'ssh://me@host' });
});
test('database URL: host, hostaddr and service overrides are refused', () => {
  for (const q of ['?host=db.xxnkubcfwabesungeskz.supabase.co', '?hostaddr=203.0.113.9', '?service=prod']) {
    refused(['db', `postgresql://u:p@127.0.0.1:54999/app${q}`, '54999']);
  }
});
test('database URL: production, remote, wrong port, wrong protocol and host lists are refused', () => {
  refused(['db', 'postgresql://u:p@db.xxnkubcfwabesungeskz.supabase.co:5432/postgres', '54999']);
  refused(['db', 'postgresql://u:p@203.0.113.9:54999/app', '54999']);
  refused(['db', 'postgresql://u:p@127.0.0.1:5432/app', '54999']);
  refused(['db', 'mysql://u:p@127.0.0.1:54999/app', '54999']);
  refused(['db', 'postgresql://u:p@127.0.0.1,db.x.supabase.co:54999/app', '54999']);
});
test('env file: only loopback URLs and no production marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  allowed(['envfile', write('good', 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54320\nSTRIPE_SECRET_KEY=""\n')]);
  refused(['envfile', write('bad1', 'NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\n')]);
  refused(['envfile', write('bad2', 'X=http://10.0.0.9:80/\n')]);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('a refusal names the variable and never prints its value', () => {
  const r = run(['env'], { DATABASE_URL: 'postgresql://u:SECRETPW123@db.abcdefghij1234567890.supabase.co:5432/postgres' });
  assert.match(r.stderr, /DATABASE_URL/);
  assert.doesNotMatch(r.stderr + r.stdout, /SECRETPW123|abcdefghij1234567890/);
});

// ---- Docker daemon selection (uses a fake `docker` that only answers `context inspect`) ----
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
fs.writeFileSync(
  path.join(fakeDir, 'docker'),
  `#!/bin/sh
# usage: docker context inspect [NAME] --format FMT   (anything else is an error: no daemon is contacted)
[ "$1" = context ] && [ "$2" = inspect ] || { echo "unexpected docker call: $*" >&2; exit 9; }
name=""
for a in "$@"; do case "$a" in context|inspect|--format|'{{.Endpoints.docker.Host}}') ;; *) name="$a";; esac; done
[ -z "$name" ] && name="\${DOCKER_CONTEXT:-\${FAKE_CURRENT:-default}}"
case "$name" in
  default) echo unix:///var/run/docker.sock;;
  colima-modaafa-qa) echo unix:///Users/qa/.colima/modaafa-qa/docker.sock;;
  desktop-linux) echo unix:///Users/qa/.docker/run/docker.sock;;
  remote-tcp) echo tcp://10.0.0.5:2375;;
  remote-ssh) echo ssh://u@host;;
  *) exit 1;;
esac
`,
  { mode: 0o755 }
);
const withFakeDocker = (extra = {}) => ({ PATH: `${fakeDir}:${process.env.PATH}`, ...extra });
const endpoint = (extra) => run(['docker-endpoint'], withFakeDocker(extra));

test('docker-endpoint: the current context is used when nothing is set', () => {
  assert.equal(endpoint().stdout.trim(), 'unix:///var/run/docker.sock');
  assert.equal(endpoint({ FAKE_CURRENT: 'desktop-linux' }).stdout.trim(), 'unix:///Users/qa/.docker/run/docker.sock');
});
test('docker-endpoint: DOCKER_CONTEXT selects that context socket (Colima case)', () => {
  const r = endpoint({ DOCKER_CONTEXT: 'colima-modaafa-qa' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'unix:///Users/qa/.colima/modaafa-qa/docker.sock');
});
test('docker-endpoint: a local DOCKER_HOST is used as given', () => {
  assert.equal(endpoint({ DOCKER_HOST: 'unix:///tmp/x.sock' }).stdout.trim(), 'unix:///tmp/x.sock');
});
test('docker-endpoint: remote DOCKER_HOST is refused and prints nothing', () => {
  for (const host of ['tcp://10.0.0.5:2375', 'ssh://me@host', 'https://docker.example.com']) {
    const r = endpoint({ DOCKER_HOST: host });
    assert.notEqual(r.status, 0, host);
    assert.equal(r.stdout.trim(), '');
  }
});
test('a remote context is refused, whether named, current, or checked by the env mode', () => {
  for (const name of ['remote-tcp', 'remote-ssh']) {
    assert.notEqual(endpoint({ DOCKER_CONTEXT: name }).status, 0, `named ${name}`);
    assert.notEqual(endpoint({ FAKE_CURRENT: name }).status, 0, `current ${name}`);
    assert.notEqual(run(['env'], withFakeDocker({ DOCKER_CONTEXT: name })).status, 0, `env mode ${name}`);
  }
});
test('DOCKER_HOST and DOCKER_CONTEXT naming different daemons are refused; the same daemon is accepted', () => {
  assert.notEqual(endpoint({ DOCKER_HOST: 'unix:///tmp/other.sock', DOCKER_CONTEXT: 'colima-modaafa-qa' }).status, 0);
  const same = endpoint({ DOCKER_HOST: 'unix:///Users/qa/.colima/modaafa-qa/docker.sock', DOCKER_CONTEXT: 'colima-modaafa-qa' });
  assert.equal(same.status, 0);
});
test('an unknown context, or a docker that cannot answer, is refused', () => {
  assert.notEqual(endpoint({ DOCKER_CONTEXT: 'no-such-context' }).status, 0);
  assert.notEqual(run(['docker-endpoint'], { PATH: '/nonexistent' }).status, 0);
});
