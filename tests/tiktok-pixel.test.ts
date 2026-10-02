import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildTikTokEventId,
  claimTikTokEvent,
  isRecentRegistration,
  planTikTokPixel,
  REGISTRATION_WINDOW_MS,
  resolveTikTokPixelId,
  tiktokBaseSnippet,
} from '../lib/analytics/tiktok';

const PIXEL_ID = 'DAULSBJC77U2BHFHG39G';
const USER_ID = '6f1c1a0e-8d0b-4f3a-9a52-2f4f3e5a7c11';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test('the pixel is fully off when the env var is missing, blank or a placeholder', () => {
  for (const raw of [undefined, null, '', '   ', '\n', '""', "''", 'undefined', 'null']) {
    assert.equal(resolveTikTokPixelId(raw), null, `${JSON.stringify(raw)} must disable the pixel`);
    assert.equal(planTikTokPixel(raw, { pageView: true }), null, 'no plan means no script and no events');
    assert.equal(
      planTikTokPixel(raw, { conversion: { event: 'Subscribe', userId: USER_ID } }),
      null,
      'a conversion must not fire when the pixel is off',
    );
  }
});

test('a pixel code that could break out of the inline script is treated as off', () => {
  for (const raw of ['ABC"; alert(1);//', 'DAULSBJC77U2 BHFHG39G', 'short', "ABC'DEF1234567", '</script><script>x', 'A'.repeat(64)]) {
    assert.equal(resolveTikTokPixelId(raw), null, `${raw} must be rejected`);
  }
});

test('the production pixel code is accepted, trimmed of env whitespace', () => {
  assert.equal(resolveTikTokPixelId(PIXEL_ID), PIXEL_ID);
  assert.equal(resolveTikTokPixelId(`  ${PIXEL_ID}\n`), PIXEL_ID);
});

test('a plan carries the snippet, the page view flag and the keyed conversion', () => {
  const plan = planTikTokPixel(PIXEL_ID, {
    pageView: true,
    conversion: { event: 'CompleteRegistration', userId: USER_ID },
  });
  assert.ok(plan);
  assert.equal(plan.pageView, true);
  assert.deepEqual(plan.conversion, { event: 'CompleteRegistration', eventId: `reg_${USER_ID}` });
  assert.ok(plan.snippet.includes(JSON.stringify(PIXEL_ID)));

  const bare = planTikTokPixel(PIXEL_ID, {});
  assert.ok(bare);
  assert.equal(bare.pageView, false, 'PageView is opt-in per page');
  assert.equal(bare.conversion, null);
});

test('a conversion without a user id is dropped rather than sent unkeyed', () => {
  const plan = planTikTokPixel(PIXEL_ID, { conversion: { event: 'Subscribe', userId: '  ' } });
  assert.ok(plan);
  assert.equal(plan.conversion, null);
});

test('the registration window is strictly under 30 minutes', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  assert.equal(REGISTRATION_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(isRecentRegistration(ago(0), now), true);
  assert.equal(isRecentRegistration(ago(60 * 1000), now), true);
  assert.equal(isRecentRegistration(ago(REGISTRATION_WINDOW_MS - 1), now), true, '29m59.999s still counts');
  assert.equal(isRecentRegistration(ago(REGISTRATION_WINDOW_MS), now), false, 'exactly 30 minutes is out');
  assert.equal(isRecentRegistration(ago(31 * 60 * 1000), now), false);
  assert.equal(isRecentRegistration(ago(3 * 24 * 60 * 60 * 1000), now), false, 'an old account never re-registers');
});

test('the registration window tolerates small clock skew but not a far-future timestamp', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  assert.equal(isRecentRegistration(new Date(now + 10 * 1000).toISOString(), now), true);
  assert.equal(isRecentRegistration(new Date(now + 60 * 60 * 1000).toISOString(), now), false);
});

test('a missing or unparseable created_at is never a registration', () => {
  for (const raw of [undefined, null, '', 'not-a-date']) {
    assert.equal(isRecentRegistration(raw), false, `${JSON.stringify(raw)} must not count`);
  }
});

test('event ids are stable, per user and per event', () => {
  assert.equal(buildTikTokEventId('CompleteRegistration', USER_ID), `reg_${USER_ID}`);
  assert.equal(buildTikTokEventId('Subscribe', USER_ID), `sub_${USER_ID}`);
  assert.equal(buildTikTokEventId('Subscribe', USER_ID), buildTikTokEventId('Subscribe', USER_ID));
  assert.notEqual(buildTikTokEventId('Subscribe', USER_ID), buildTikTokEventId('CompleteRegistration', USER_ID));
  assert.notEqual(buildTikTokEventId('Subscribe', USER_ID), buildTikTokEventId('Subscribe', 'another-user'));
});

test('an event id cannot be built without a user', () => {
  for (const userId of [undefined, null, '', '   ']) {
    assert.equal(buildTikTokEventId('Subscribe', userId), null);
  }
});

test('the browser guard lets an event through exactly once', () => {
  const storage = memoryStorage();
  const id = buildTikTokEventId('CompleteRegistration', USER_ID)!;

  assert.equal(claimTikTokEvent(storage, id), true);
  assert.equal(claimTikTokEvent(storage, id), false, 'a reload must not re-fire');
  assert.equal(claimTikTokEvent(storage, buildTikTokEventId('Subscribe', USER_ID)!), true, 'events are guarded independently');
  assert.equal(claimTikTokEvent(storage, buildTikTokEventId('CompleteRegistration', 'other-user')!), true, 'users are guarded independently');
});

test('the browser guard still sends when storage is unavailable', () => {
  const throwing = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(claimTikTokEvent(throwing, 'reg_x'), true);
  assert.equal(claimTikTokEvent(null, 'reg_x'), true);
  assert.equal(claimTikTokEvent(undefined, 'reg_x'), true);

  const writeBlocked = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(claimTikTokEvent(writeBlocked, 'reg_x'), true);
});

test('the base snippet queues calls, loads events.js for this pixel and sends no PageView by itself', () => {
  const inserted: Array<{ src: string; type: string; async: boolean }> = [];
  const anchor = {
    parentNode: { insertBefore: (node: { src: string; type: string; async: boolean }) => inserted.push(node) },
  };
  const window: Record<string, unknown> = {};
  const document = {
    createElement: () => ({ src: '', type: '', async: false }),
    getElementsByTagName: () => [anchor],
  };
  vm.runInNewContext(tiktokBaseSnippet(PIXEL_ID), { window, document });

  assert.equal(window.TiktokAnalyticsObject, 'ttq');
  const ttq = window.ttq as unknown as unknown[] & {
    page: () => void;
    track: (...args: unknown[]) => void;
    identify: unknown;
  };
  assert.ok(ttq, 'the ttq queue must exist before any event is fired');
  assert.equal(ttq.length, 0, 'the snippet itself queues no page view');

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].src, `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${PIXEL_ID}&lib=ttq`);
  assert.equal(inserted[0].async, true);

  // Calls made before events.js arrives are queued for replay.
  ttq.page();
  ttq.track('Subscribe', {}, { event_id: `sub_${USER_ID}` });
  assert.deepEqual(JSON.parse(JSON.stringify([...ttq])), [
    ['page'],
    ['track', 'Subscribe', {}, { event_id: `sub_${USER_ID}` }],
  ]);
});

test('the base snippet never identifies the user', () => {
  const snippet = tiktokBaseSnippet(PIXEL_ID);
  assert.ok(!/ttq\.identify\(/.test(snippet), 'no advanced matching call');
  assert.ok(!/ttq\.page\(/.test(snippet), 'the page decides whether to report a PageView');
  assert.ok(!snippet.includes('</script'), 'cannot terminate the inline script early');
});
