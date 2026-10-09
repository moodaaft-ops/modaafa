import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runCallStart, type CallStartDeps } from '../lib/ai/voice-call-start';

/** A world of fakes that records every resource the start attempt touches. */
function world() {
  let current = true;
  const log = {
    contextsOpened: 0,
    contextsClosed: 0,
    streamsOpened: 0,
    tracksStopped: 0,
    sessionsEnded: [] as string[],
    committed: 0,
    intervals: 0,
  };
  const gates = {
    session: null as null | ((v: { ok: true; token: string } | { ok: false }) => void),
    mic: null as null | { resolve: (s: { id: number }) => void; reject: (e: unknown) => void },
  };
  const deps: CallStartDeps<{ id: number }, { id: number }> = {
    isCurrent: () => current,
    createContext: () => ({ id: ++log.contextsOpened }),
    closeContext: () => void log.contextsClosed++,
    openSession: () => new Promise((resolve) => (gates.session = resolve)),
    endSessionOnServer: (token) => void log.sessionsEnded.push(token),
    acquireMic: () =>
      new Promise((resolve, reject) => {
        log.streamsOpened++; // the browser opens the mic as soon as the person allows it
        gates.mic = { resolve, reject };
      }),
    stopStream: () => void log.tracksStopped++,
    resumeContext: async () => undefined,
    commit: () => {
      log.committed++;
      log.intervals++;
    },
  };
  return { deps, log, gates, end: () => (current = false) };
}

const tick = () => new Promise((r) => setImmediate(r));

test('ending while the session request is pending: the late session is closed on the server and nothing is opened', async () => {
  const w = world();
  const run = runCallStart(w.deps);
  await tick();
  w.end(); // the person pressed end (or switched account) before the session answered
  w.gates.session!({ ok: true, token: 'late-token' });
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(w.log.sessionsEnded, ['late-token']);
  assert.equal(w.log.streamsOpened, 0, 'the microphone is never requested after the call is over');
  assert.equal(w.log.committed, 0);
  assert.equal(w.log.intervals, 0);
  assert.equal(w.log.contextsClosed, w.log.contextsOpened);
});

test('ending while the microphone prompt is open: the stream that arrives afterwards is stopped, no interval starts', async () => {
  const w = world();
  const run = runCallStart(w.deps);
  await tick();
  w.gates.session!({ ok: true, token: 'tok' });
  await tick();
  assert.equal(w.log.streamsOpened, 1, 'the prompt is open');
  w.end(); // closed the panel while the browser was still asking
  w.gates.mic!.resolve({ id: 1 });
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(w.log.tracksStopped, 1, 'the returned stream is stopped');
  assert.equal(w.log.committed, 0);
  assert.equal(w.log.intervals, 0);
  assert.equal(w.log.contextsClosed, w.log.contextsOpened);
  assert.deepEqual(w.log.sessionsEnded, ['tok'], 'the session opened for this attempt is closed too');
});

test('a permission error that arrives after the call ended is swallowed and cleaned up, not shown', async () => {
  const w = world();
  const run = runCallStart(w.deps);
  await tick();
  w.gates.session!({ ok: true, token: 'tok' });
  await tick();
  w.end();
  w.gates.mic!.reject(new Error('NotAllowedError'));
  assert.equal((await run).status, 'cancelled');
  assert.equal(w.log.committed, 0);
  assert.equal(w.log.contextsClosed, w.log.contextsOpened);
});

test('an uninterrupted start commits once, with nothing released', async () => {
  const w = world();
  const run = runCallStart(w.deps);
  await tick();
  w.gates.session!({ ok: true, token: 'tok' });
  await tick();
  w.gates.mic!.resolve({ id: 1 });
  assert.equal((await run).status, 'started');
  assert.equal(w.log.committed, 1);
  assert.equal(w.log.tracksStopped, 0);
  assert.equal(w.log.contextsClosed, 0);
  assert.deepEqual(w.log.sessionsEnded, []);
});

test('failures while the call is still wanted are reported and cleaned: session refused, mic denied', async () => {
  const a = world();
  const runA = runCallStart(a.deps);
  await tick();
  a.gates.session!({ ok: false });
  assert.equal((await runA).status, 'session_failed');
  assert.equal(a.log.streamsOpened, 0);
  assert.equal(a.log.contextsClosed, 1);

  const b = world();
  const runB = runCallStart(b.deps);
  await tick();
  b.gates.session!({ ok: true, token: 'tok' });
  await tick();
  b.gates.mic!.reject(new Error('NotAllowedError'));
  const failed = await runB;
  assert.equal(failed.status, 'failed');
  assert.equal(b.log.committed, 0);
  assert.equal(b.log.contextsClosed, 1);
});

test('panel wiring: generation bump before the early return, startCall goes through runCallStart, the end request keeps its token', () => {
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  const endCall = panel.slice(panel.indexOf('const endCall'), panel.indexOf('// Hard ceiling'));
  assert.ok(endCall.indexOf('genRef.current += 1') > -1 && endCall.indexOf('genRef.current += 1') < endCall.indexOf('if (endedRef.current) return'), 'a second end press must still invalidate a pending start');
  const cleanup = panel.slice(panel.indexOf('// Hard ceiling'), panel.indexOf('// Closing or leaving the tab'));
  assert.ok(cleanup.includes('genRef.current += 1'), 'unmount invalidates a pending start');
  const startCall = panel.slice(panel.indexOf('async function startCall'), panel.indexOf('function toggleMute'));
  assert.ok(startCall.includes('runCallStart<') && startCall.includes('++genRef.current'));
  assert.ok(!startCall.includes('endedRef.current = false;') || startCall.indexOf('endedRef.current = false;') > startCall.indexOf('commit:'), 'endedRef is only reset inside commit');
  const fail = panel.slice(panel.indexOf('const failWith'), panel.indexOf('[beginListening, endOnServer, releaseMic]'));
  assert.ok(fail.indexOf('endOnServer()') > -1 && fail.indexOf('endOnServer()') < fail.indexOf('sessionRef.current = null'), 'the token is used for the end request before it is cleared');
});
