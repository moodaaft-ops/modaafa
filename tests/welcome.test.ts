import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  USER_EVENT_NAMES,
  USER_STAGES,
  cleanEventProperties,
  trackUserEvent,
} from '../lib/events/user-events';
import { getWelcomeVideo, isGoogleAppVerified } from '../lib/welcome/config';
import { WELCOME_COPY } from '../lib/welcome/copy';
import { whatsappHelpUrl } from '../lib/support/contact';

const migration = readFileSync(resolve('db/migrations/20261012_user_events.sql'), 'utf8');

test('the shared event and stage names are exactly the agreed ones', () => {
  assert.deepEqual([...USER_EVENT_NAMES], [
    'registration_completed',
    'welcome_email_sent',
    'onboarding_viewed',
    'connect_clicked',
    'ads_account_connected',
    'first_analysis_viewed',
    'subscription_paid',
  ]);
  assert.deepEqual([...USER_STAGES], ['registered', 'connected', 'analysis_viewed', 'subscribed']);
});

test('the SQL CHECK lists every event name and nothing else', () => {
  const block = migration.match(/event in \(([\s\S]*?)\)\s*\)/i)?.[1] ?? '';
  const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, [...USER_EVENT_NAMES]);
});

test('user_events is server-only and onboarding_viewed is unique per user', () => {
  assert.match(migration, /alter table public\.user_events enable row level security/i);
  assert.match(migration, /revoke all on table public\.user_events from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant select, insert on table public\.user_events to service_role/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(
    migration,
    /create unique index if not exists user_events_onboarding_viewed_once\s+on public\.user_events \(user_id\)\s+where event = 'onboarding_viewed'/i
  );
  assert.match(migration, /references auth\.users \(id\) on delete cascade/i);
});

test('trackUserEvent writes the row and cleans properties', async () => {
  const rows: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => {
      assert.equal(table, 'user_events');
      return {
        insert: async (row: Record<string, unknown>) => {
          rows.push(row);
          return { error: null };
        },
      };
    },
  };
  const ok = await trackUserEvent(
    { userId: 'u1', event: 'connect_clicked', properties: { source: 'welcome', 'Bad Key': 'x', nested: { a: 1 } } },
    { client }
  );
  assert.equal(ok, true);
  assert.deepEqual(rows[0], { user_id: 'u1', event: 'connect_clicked', properties: { source: 'welcome' } });
});

test('a repeat onboarding_viewed is quiet, a real failure never throws', async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const duplicate = {
      from: () => ({ insert: async () => ({ error: { code: '23505', message: 'duplicate' } }) }),
    };
    assert.equal(await trackUserEvent({ userId: 'u1', event: 'onboarding_viewed' }, { client: duplicate }), false);
    assert.equal(warnings.length, 0);

    const missingTable = {
      from: () => ({ insert: async () => ({ error: { code: '42P01', message: 'relation does not exist' } }) }),
    };
    assert.equal(await trackUserEvent({ userId: 'u1', event: 'connect_clicked' }, { client: missingTable }), false);
    assert.equal(warnings.length, 1);

    const throwing = {
      from: () => {
        throw new Error('network down');
      },
    };
    assert.equal(await trackUserEvent({ userId: 'u1', event: 'connect_clicked' }, { client: throwing }), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('cleanEventProperties keeps short plain values only', () => {
  const out = cleanEventProperties({ source: 'x'.repeat(500), n: 3, ok: true, bad: Number.NaN, o: {}, A: 'x' });
  assert.equal((out.source as string).length, 120);
  assert.equal(out.n, 3);
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out).sort(), ['n', 'ok', 'source']);
});

test('the demo video slot only accepts the one embed host the CSP allows', () => {
  assert.equal(getWelcomeVideo({}), null);
  assert.equal(getWelcomeVideo({ NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL: 'https://evil.example/embed/x' }), null);
  assert.equal(getWelcomeVideo({ NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL: 'https://www.youtube.com/embed/x' }), null);
  assert.equal(
    getWelcomeVideo({ NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL: 'https://www.youtube-nocookie.com/embed/abc' })?.embedUrl,
    'https://www.youtube-nocookie.com/embed/abc'
  );
  assert.equal(isGoogleAppVerified({ GOOGLE_OAUTH_APP_VERIFIED: 'true' }), true);
  assert.equal(isGoogleAppVerified({}), false);
});

test('the team link opens WhatsApp on the support number with the user email', () => {
  const url = whatsappHelpUrl('talk_to_team', 'a@b.com');
  assert.ok(url.startsWith('https://wa.me/966541004029?text='));
  assert.match(decodeURIComponent(url), /ابي اكلم احد من الفريق/);
  assert.match(decodeURIComponent(url), /a@b\.com/);
});

function allCopy(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(WELCOME_COPY);
  return out;
}

test('the copy follows the house rules: no dashes, Arabic comma, no banned phrases', () => {
  const banned = [
    'ليس مجرد',
    'لا يتعلق الأمر',
    'يُعتبر من أبرز',
    'بالإضافة إلى ذلك',
    'علاوة على ذلك',
    'من الجدير بالذكر',
    'في عالم اليوم',
    'في ظل التطور',
    'رحلتك نحو',
    'خذها للمستوى التالي',
    'لا تفوت الفرصة',
    'حلول متكاملة',
    'مصمم خصيصاً',
    'سواء كنت',
    'باختصار',
    'في النهاية',
    'هل تعاني',
    'جودة عالية',
  ];
  for (const text of allCopy()) {
    assert.doesNotMatch(text, /[—–]/, `dash in: ${text}`);
    if (/[؀-ۿ]/.test(text)) assert.doesNotMatch(text, /,/, `Latin comma in: ${text}`);
    assert.doesNotMatch(text, /[​-‏‪-‮ ]/, `hidden character in: ${text}`);
    for (const phrase of banned) assert.ok(!text.includes(phrase), `"${phrase}" in: ${text}`);
  }
});

test('the trust answers state the real permission and the real limits', () => {
  const text = allCopy().join('\n');
  assert.match(text, /Google Ads/);
  assert.match(text, /مركز الموافقات/);
  assert.match(text, /الطيار الآلي مطفي/);
  assert.match(text, /myaccount\.google\.com\/connections|اتصالات حساب Google/);
  assert.match(text, /ما عندنا زر فصل داخل المنصة/);
});
