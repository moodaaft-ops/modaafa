import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFiller, FILLER_CLIPS, FILLER_DELAY_MS, FILLER_MAX_TAIL_MS, type FillerAudio } from '../lib/ai/voice-filler';
import { WARM_URLS, warmVoiceRoutes } from '../lib/ai/voice-warm';

/** A clock and timer queue the test drives by hand. */
function world() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const advance = (ms: number) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].run();
    }
    t = target;
  };
  return {
    now: () => t,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    advance,
    pending: () => timers.size,
  };
}

function fakeAudio(opts: { rejectPlay?: boolean } = {}) {
  const log: string[] = [];
  const audio: FillerAudio & { log: string[]; end: () => void } = {
    src: '',
    volume: 1,
    onended: null,
    onerror: null,
    log,
    async play() {
      log.push(`play:${audio.src}`);
      if (opts.rejectPlay) throw new Error('NotAllowedError');
    },
    pause() {
      log.push('pause');
    },
    end() {
      audio.onended?.(new Event('ended'));
    },
  };
  return audio;
}

const setup = (audio: ReturnType<typeof fakeAudio> | null, w = world()) => ({
  w,
  filler: createFiller({ getAudio: () => audio, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now }),
});

test('a reply that beats the delay plays no clip at all', async () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS - 50);
  assert.equal(await filler.finish(), 0);
  w.advance(5000);
  assert.deepEqual(audio.log, []);
  assert.equal(w.pending(), 0);
});

test('after the delay a clip from the list plays at a lowered volume', () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS);
  assert.equal(audio.log.length, 1);
  assert.ok(FILLER_CLIPS.some((clip) => audio.log[0] === `play:${clip}`), audio.log[0]);
  assert.equal(audio.volume, 0.9);
});

test('when the reply is ready mid-clip, the clip finishes first and the wait is reported', async () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS + 300);
  let released = false;
  const finished = filler.finish().then((ms) => {
    released = true;
    return ms;
  });
  w.advance(600);
  await Promise.resolve();
  assert.equal(released, false, 'the clip is still playing, the reply waits');
  audio.end();
  assert.equal(await finished, 600);
  assert.ok(!audio.log.includes('pause'), 'a clip that ends by itself is never paused');
  assert.equal(audio.onended, null, 'handlers are detached so the reply can use the element');
  assert.equal(w.pending(), 0);
});

test('a clip that never ends cannot hold the reply longer than the tail limit', async () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS + 10);
  const finished = filler.finish();
  w.advance(FILLER_MAX_TAIL_MS);
  assert.equal(await finished, FILLER_MAX_TAIL_MS);
  assert.ok(audio.log.includes('pause'));
});

test('a clip that already ended before the reply costs nothing', async () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS);
  audio.end();
  w.advance(4000);
  assert.equal(await filler.finish(), 0);
});

test('cancel silences a playing clip, frees a waiting reply and leaves no timer behind', async () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS + 10);
  const finished = filler.finish();
  filler.cancel();
  await finished;
  assert.ok(audio.log.includes('pause'));
  assert.equal(audio.onended, null);
  assert.equal(w.pending(), 0);
});

test('cancel before the delay runs means the clip never starts', () => {
  const audio = fakeAudio();
  const { w, filler } = setup(audio);
  filler.start();
  filler.cancel();
  w.advance(5000);
  assert.deepEqual(audio.log, []);
});

test('a browser that refuses to play just means no filler, and the reply is not delayed', async () => {
  const audio = fakeAudio({ rejectPlay: true });
  const { w, filler } = setup(audio);
  filler.start();
  w.advance(FILLER_DELAY_MS);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await filler.finish(), 0);
});

test('no audio element, or no clips, is silent and safe', async () => {
  const none = setup(null);
  none.filler.start();
  none.w.advance(1000);
  assert.equal(await none.filler.finish(), 0);
  const w = world();
  const empty = createFiller({ getAudio: () => fakeAudio(), clips: [], setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now });
  empty.start();
  w.advance(1000);
  assert.equal(await empty.finish(), 0);
});

test('starting twice arms one timer, and consecutive turns rotate through the clips', () => {
  const seen = new Set<string>();
  for (let i = 0; i < FILLER_CLIPS.length; i++) {
    const audio = fakeAudio();
    const { w, filler } = setup(audio);
    filler.start();
    filler.start();
    assert.equal(w.pending(), 1);
    w.advance(FILLER_DELAY_MS);
    seen.add(audio.log[0]);
  }
  assert.equal(seen.size, FILLER_CLIPS.length);
});

test('the three wait clips exist and are real mp3 files', () => {
  for (const clip of FILLER_CLIPS) {
    const bytes = readFileSync(`public${clip}`);
    assert.ok(bytes.length > 4000 && bytes.length < 80_000, `${clip} is ${bytes.length} bytes`);
    const id3 = bytes.subarray(0, 3).toString('latin1') === 'ID3';
    const frameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    assert.ok(id3 || frameSync, `${clip} starts like an mp3`);
  }
});

test('warm-up sends one empty GET per route and swallows every failure', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const failing = ((url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return Promise.reject(new Error('offline'));
  }) as unknown as typeof fetch;
  warmVoiceRoutes(failing);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    calls.map(([url]) => url),
    [...WARM_URLS]
  );
  for (const [, init] of calls) {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.body, undefined);
  }
  const throwing = (() => {
    throw new Error('blocked');
  }) as unknown as typeof fetch;
  assert.doesNotThrow(() => warmVoiceRoutes(throwing));
});

test('the warm-up routes answer a bare GET with 204 and never touch an account or a provider', () => {
  for (const file of ['app/api/voice/transcribe/route.ts', 'app/api/voice/speak/route.ts']) {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('export function GET');
    const get = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(get, /status: 204/, file);
    assert.ok(!/buildVoiceDeps|resolveVoiceAccountKey|provider|createServerClient|checkRateLimit/.test(get), `${file} GET stays free`);
  }
  const chat = readFileSync('app/api/chat/start/route.ts', 'utf8');
  const warm = chat.slice(chat.indexOf("get('warm') === '1'"), chat.indexOf('const a = await authed(req);', chat.indexOf("get('warm') === '1'")));
  assert.match(warm, /status: 204/);
  assert.match(warm, /isSameOriginRequest\(req\)/);
  assert.ok(!/createServerClient|loadChatState|createMessageForAgent|answerWithJarvis/.test(warm), 'the chat warm-up is free too');
});
