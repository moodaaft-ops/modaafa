import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIENT_TIMING_HEADER,
  createStageTimer,
  formatClientTimings,
  logVoiceTiming,
  parseClientTimings,
  resetColdStartForTests,
  takeColdStart,
} from '../lib/ai/voice-timing';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

test('the stage timer records each stage, adds repeats up, and keeps the order they first ran', async () => {
  const c = clock();
  const timer = createStageTimer(c.now);
  await timer.time('auth', async () => c.tick(120));
  await timer.time('model', async () => c.tick(2400));
  timer.add('model', 1100);
  assert.deepEqual(timer.snapshot(), { auth: 120, model: 3500 });
  assert.equal(timer.totalMs, 2520);
});

test('a stage that throws is still timed, and the error goes through untouched', async () => {
  const c = clock();
  const timer = createStageTimer(c.now);
  await assert.rejects(
    timer.time('stt', async () => {
      c.tick(900);
      throw new Error('provider down');
    }),
    /provider down/
  );
  assert.equal(timer.snapshot().stt, 900);
});

test('stage names that are not header-safe are ignored instead of leaking into Server-Timing', () => {
  const timer = createStageTimer(clock().now);
  timer.add('ok_name', 5);
  timer.add('Bad Name', 5);
  timer.add('a;b', 5);
  timer.add('x\r\nSet-Cookie: y=1', 5);
  timer.add('', 5);
  assert.deepEqual(Object.keys(timer.snapshot()), ['ok_name']);
});

test('Server-Timing is name;dur pairs plus the total, and durations never go negative', () => {
  const c = clock();
  const timer = createStageTimer(c.now);
  timer.add('auth', 80);
  timer.add('state', -5);
  c.tick(300);
  assert.equal(timer.serverTiming(), 'auth;dur=80, state;dur=0, total;dur=300');
});

test('the cold start flag is true once per instance, then false', () => {
  resetColdStartForTests();
  assert.equal(takeColdStart(), true);
  assert.equal(takeColdStart(), false);
  assert.equal(takeColdStart(), false);
  resetColdStartForTests();
  assert.equal(takeColdStart(), true);
});

test('the timing log line is one JSON object with numbers and labels only', () => {
  const lines: string[] = [];
  logVoiceTiming(
    'chat',
    { status: 200, cold: true, totalMs: 6100, stages: { auth: 90, model: 4200 }, extra: { path: 'jarvis', model_calls: [2100, 2100] } },
    (line) => lines.push(line)
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[voice-timing] '));
  const parsed = JSON.parse(lines[0].slice('[voice-timing] '.length));
  assert.deepEqual(parsed, {
    route: 'chat',
    status: 200,
    cold: true,
    total_ms: 6100,
    auth: 90,
    model: 4200,
    path: 'jarvis',
    model_calls: [2100, 2100],
  });
});

test('a failing logger never breaks a voice turn', () => {
  assert.doesNotThrow(() =>
    logVoiceTiming('speak', { status: 200, cold: false, totalMs: 1, stages: {} }, () => {
      throw new Error('log sink down');
    })
  );
});

test('client timings: only the four known names, plain whole numbers, nothing else gets into the log', () => {
  assert.deepEqual(parseClientTimings('stt=1840,chat=6210'), { c_stt: 1840, c_chat: 6210 });
  assert.deepEqual(parseClientTimings('stt=1840, chat=6210, prev_audio=900, filler=700'), {
    c_stt: 1840,
    c_chat: 6210,
    c_prev_audio: 900,
    c_filler: 700,
  });
  // Unknown names, signs, decimals, exponents, junk and oversize values are all dropped.
  assert.deepEqual(parseClientTimings('evil=5,stt=-1,chat=1.5,filler=1e3,prev_audio=999999,stt2=4'), {});
  assert.deepEqual(parseClientTimings('stt=<script>,chat=1 2'), {});
  assert.deepEqual(parseClientTimings('constructor=1,__proto__=1'), {});
  assert.deepEqual(parseClientTimings(null), {});
  assert.deepEqual(parseClientTimings(''), {});
  assert.deepEqual(parseClientTimings('stt=1'.padEnd(250, ',')), {});
});

test('the client header round-trips through the formatter and the parser', () => {
  assert.equal(CLIENT_TIMING_HEADER, 'x-voice-client-ms');
  const header = formatClientTimings({ stt: 1840.4, chat: 6210.6, prev_audio: undefined });
  assert.equal(header, 'stt=1840,chat=6211');
  assert.deepEqual(parseClientTimings(header), { c_stt: 1840, c_chat: 6211 });
  assert.equal(formatClientTimings({}), '');
  assert.equal(formatClientTimings({ stt: Number.NaN }), '');
});
