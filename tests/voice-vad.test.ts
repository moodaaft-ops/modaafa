import assert from 'node:assert/strict';
import test from 'node:test';
import { BARGE_VAD, createVad, LISTEN_VAD } from '../lib/ai/voice-vad';

/** Feeds `ms` of constant level in 50ms steps and returns every non-empty event with its time. */
function feed(vad: ReturnType<typeof createVad>, from: number, ms: number, rms: number) {
  const events: Array<{ at: number; event: string }> = [];
  for (let t = from; t < from + ms; t += 50) {
    const event = vad.push(rms, t);
    if (event !== 'none') events.push({ at: t, event });
  }
  return { events, end: from + ms };
}

test('a normal question ends by itself about a second after the speaker stops', () => {
  const vad = createVad(LISTEN_VAD);
  let { end } = feed(vad, 0, 500, 0.004); // room noise, calibration
  const talk = feed(vad, end, 2000, 0.12);
  assert.deepEqual(talk.events.map((e) => e.event), ['speech_start']);
  const quiet = feed(vad, talk.end, 2000, 0.004);
  assert.equal(quiet.events.length, 1);
  assert.equal(quiet.events[0].event, 'speech_end');
  const waited = quiet.events[0].at - talk.end;
  assert.ok(waited >= LISTEN_VAD.endSilenceMs - 50 && waited <= LISTEN_VAD.endSilenceMs + 100, `waited ${waited}`);
});

test('silence alone never starts a turn, and a short pause inside a sentence does not end it', () => {
  const vad = createVad(LISTEN_VAD);
  let t = feed(vad, 0, 500, 0.004).end;
  assert.deepEqual(feed(vad, t, 20_000, 0.004).events, []);
  const vad2 = createVad(LISTEN_VAD);
  t = feed(vad2, 0, 500, 0.004).end;
  const a = feed(vad2, t, 1000, 0.12);
  const pause = feed(vad2, a.end, 600, 0.004); // under the 1100ms end window
  const b = feed(vad2, pause.end, 1000, 0.12);
  assert.deepEqual([...a.events, ...pause.events, ...b.events].map((e) => e.event), ['speech_start']);
});

test('a cough shorter than the minimum is cancelled, not sent as a question', () => {
  const vad = createVad(LISTEN_VAD);
  let t = feed(vad, 0, 500, 0.004).end;
  const burst = feed(vad, t, 250, 0.2);
  const after = feed(vad, burst.end, 2000, 0.004);
  assert.deepEqual([...burst.events, ...after.events].map((e) => e.event), ['speech_start', 'speech_cancel']);
});

test('a noisy room raises the bar: steady noise is not speech, a real voice still is', () => {
  const vad = createVad(LISTEN_VAD);
  let t = feed(vad, 0, 500, 0.03).end; // loud fan
  assert.deepEqual(feed(vad, t, 5000, 0.03).events, []);
  t += 5000;
  assert.deepEqual(feed(vad, t, 1500, 0.3).events.map((e) => e.event), ['speech_start']);
});

test('a turn that never stops is cut at the maximum length', () => {
  const vad = createVad(LISTEN_VAD);
  const t = feed(vad, 0, 500, 0.004).end;
  const run = feed(vad, t, 40_000, 0.12);
  assert.ok(run.events.some((e) => e.event === 'too_long'));
});

test('barge-in profile ignores a low echo of the assistant but reacts to a loud voice', () => {
  const echo = createVad(BARGE_VAD);
  let t = feed(echo, 0, 500, 0.01).end;
  assert.deepEqual(feed(echo, t, 3000, 0.04).events, []);
  const voice = createVad(BARGE_VAD);
  t = feed(voice, 0, 500, 0.01).end;
  const talk = feed(voice, t, 1000, 0.2);
  assert.equal(talk.events[0]?.event, 'speech_start');
  assert.ok(talk.events[0].at - t >= BARGE_VAD.startMs);
});
