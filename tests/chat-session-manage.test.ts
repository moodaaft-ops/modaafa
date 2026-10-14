import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { createChatSessionHandlers, type ChatSessionRouteDeps } from '../lib/chat-first/session-routes';
import { CHAT_TITLE_MAX, filterChatsByTitle, parseChatTitle } from '../lib/chat-first/session-manage';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MINE = '99999999-9999-4999-8999-999999999901';
const MINE_TOO = '99999999-9999-4999-8999-999999999902';
const THEIRS = '99999999-9999-4999-8999-999999999903';
const MISSING = '99999999-9999-4999-8999-999999999999';

type Row = { id: string; user_id: string; title: string };
type Call = { op: 'update' | 'delete'; filters: Array<[string, unknown]>; patch?: Record<string, unknown> };

/** Just enough of the Supabase query builder: update/delete + eq + select, awaited for { data, error }. */
function fakeSupabase(args: { user: { id: string } | null; rows?: Row[]; error?: boolean }) {
  const rows: Row[] = args.rows ?? [
    { id: MINE, user_id: ME, title: 'وين تروح فلوسي في الإعلانات؟' },
    { id: MINE_TOO, user_id: ME, title: 'ليش الطلبات قليلة في الويكند؟' },
    { id: THEIRS, user_id: OTHER, title: 'سري لمستخدم آخر' },
  ];
  const calls: Call[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: args.user }, error: null }) },
    from(table: string) {
      assert.equal(table, 'chat_sessions');
      let op: Call['op'] | null = null;
      let patch: Record<string, unknown> | undefined;
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        update: (value: Record<string, unknown>) => ((op = 'update'), (patch = value), query),
        delete: () => ((op = 'delete'), query),
        select: () => query,
        eq: (column: string, value: unknown) => (filters.push([column, value]), query),
        then: (resolve: (value: unknown) => void) => {
          assert.ok(op, 'the route must update or delete');
          calls.push({ op, filters: [...filters], patch });
          if (args.error) return resolve({ data: null, error: { message: 'boom' } });
          const matched = rows.filter((row) => filters.every(([column, value]) => (row as any)[column] === value));
          if (op === 'update') for (const row of matched) Object.assign(row, patch);
          if (op === 'delete') for (const row of matched) rows.splice(rows.indexOf(row), 1);
          resolve({ data: matched.map((row) => ({ id: row.id, title: row.title })), error: null });
        },
      };
      return query;
    },
  };
  return { client, rows, calls };
}

function handlersFor(
  fake: ReturnType<typeof fakeSupabase>,
  overrides: Partial<ChatSessionRouteDeps> = {},
) {
  return createChatSessionHandlers({
    createServerClient: async () => fake.client,
    checkRateLimit: async () => ({ allowed: true, remaining: 59, resetAt: new Date().toISOString(), retryAfterSeconds: 1 }),
    rateLimitHeaders: (result) => ({ 'Retry-After': String(result.retryAfterSeconds) }),
    ...overrides,
  });
}

function request(method: 'PATCH' | 'DELETE', id: string, body?: unknown, headers: Record<string, string> = {}) {
  const hasBody = body !== undefined;
  return new NextRequest(`http://localhost:3000/api/chat/sessions/${id}`, {
    method,
    headers: {
      origin: 'http://localhost:3000',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

test('without a signed-in user both verbs answer 401 and touch nothing', async () => {
  const fake = fakeSupabase({ user: null });
  const { PATCH, DELETE } = handlersFor(fake);

  const renamed = await PATCH(request('PATCH', MINE, { title: 'اسم جديد' }), context(MINE));
  const removed = await DELETE(request('DELETE', MINE), context(MINE));

  assert.equal(renamed.status, 401);
  assert.equal(removed.status, 401);
  assert.deepEqual(await removed.json(), { error: 'unauthorized' });
  assert.equal(fake.calls.length, 0);
});

test('an id that is not a UUID is a 400 and never reaches the database', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const { PATCH, DELETE } = handlersFor(fake);

  for (const bad of ['abc', '1', '99999999-9999-4999-8999-99999999990', `${MINE}'; drop table chat_sessions;--`, '..%2F..']) {
    const renamed = await PATCH(request('PATCH', 'x', { title: 'اسم' }), context(bad));
    const removed = await DELETE(request('DELETE', 'x'), context(bad));
    assert.equal(renamed.status, 400, bad);
    assert.equal(removed.status, 400, bad);
    assert.deepEqual(await removed.json(), { error: 'invalid_id' });
  }
  assert.equal(fake.calls.length, 0);
});

test('a missing id and somebody else\'s id are both 404, and the other row is untouched', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const { PATCH, DELETE } = handlersFor(fake);

  for (const id of [MISSING, THEIRS]) {
    const renamed = await PATCH(request('PATCH', id, { title: 'خذيته' }), context(id));
    const removed = await DELETE(request('DELETE', id), context(id));
    assert.equal(renamed.status, 404, id);
    assert.equal(removed.status, 404, id);
    assert.deepEqual(await removed.json(), { error: 'not_found' });
  }
  const theirs = fake.rows.find((row) => row.id === THEIRS);
  assert.deepEqual(theirs, { id: THEIRS, user_id: OTHER, title: 'سري لمستخدم آخر' });
  // Every write is scoped to the caller, on top of row level security.
  for (const call of fake.calls) assert.deepEqual(call.filters, [['id', call.filters[0][1]], ['user_id', ME]]);
});

test('an empty, blank, 81-character or non-text title is a 400 and changes nothing', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const { PATCH } = handlersFor(fake);

  const bad: unknown[] = ['', '   ', ' \n\t ', 'ا'.repeat(CHAT_TITLE_MAX + 1), 42, null, ['x'], {}];
  for (const title of bad) {
    const response = await PATCH(request('PATCH', MINE, { title }), context(MINE));
    assert.equal(response.status, 400, JSON.stringify(title)?.slice(0, 30));
    assert.deepEqual(await response.json(), { error: 'invalid_title' });
  }
  for (const body of [{}, '{not json', '[]']) {
    const response = await PATCH(request('PATCH', MINE, body), context(MINE));
    assert.equal(response.status, 400);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.rows[0].title, 'وين تروح فلوسي في الإعلانات؟');
});

test('PATCH renames the caller\'s chat, trims it and answers with the saved title', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const { PATCH } = handlersFor(fake);

  const response = await PATCH(request('PATCH', MINE, { title: '  خطة   الميزانية\nلشهر نوفمبر  ' }), context(MINE));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: MINE, title: 'خطة الميزانية لشهر نوفمبر' });
  assert.equal(fake.rows.find((row) => row.id === MINE)?.title, 'خطة الميزانية لشهر نوفمبر');
  assert.equal(fake.rows.find((row) => row.id === MINE_TOO)?.title, 'ليش الطلبات قليلة في الويكند؟');
  assert.deepEqual(fake.calls[0], {
    op: 'update',
    filters: [['id', MINE], ['user_id', ME]],
    patch: { title: 'خطة الميزانية لشهر نوفمبر' },
  });

  // Exactly 80 characters is allowed.
  const longest = 'م'.repeat(CHAT_TITLE_MAX);
  const edge = await PATCH(request('PATCH', MINE_TOO, { title: longest }), context(MINE_TOO));
  assert.equal(edge.status, 200);
  assert.equal(fake.rows.find((row) => row.id === MINE_TOO)?.title, longest);
});

test('DELETE removes only the caller\'s chat', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const { DELETE } = handlersFor(fake);

  const response = await DELETE(request('DELETE', MINE), context(MINE));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: MINE });
  assert.deepEqual(fake.rows.map((row) => row.id), [MINE_TOO, THEIRS]);
  assert.deepEqual(fake.calls[0], { op: 'delete', filters: [['id', MINE], ['user_id', ME]], patch: undefined });

  // Asking again is a 404, not a second delete.
  const again = await DELETE(request('DELETE', MINE), context(MINE));
  assert.equal(again.status, 404);
});

test('a write from another site is refused before anything else happens', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  let signedInChecks = 0;
  const { PATCH, DELETE } = handlersFor(fake, {
    createServerClient: async () => {
      signedInChecks += 1;
      return fake.client;
    },
  });

  for (const origin of ['https://evil.example', 'http://localhost:3001', 'null']) {
    const renamed = await PATCH(request('PATCH', MINE, { title: 'x' }, { origin }), context(MINE));
    const removed = await DELETE(request('DELETE', MINE, undefined, { origin }), context(MINE));
    assert.equal(renamed.status, 403, origin);
    assert.equal(removed.status, 403, origin);
    assert.deepEqual(await renamed.json(), { error: 'invalid_origin' });
  }
  // A Referer from elsewhere counts too when there is no Origin.
  const viaReferer = await DELETE(
    new NextRequest(`http://localhost:3000/api/chat/sessions/${MINE}`, {
      method: 'DELETE',
      headers: { referer: 'https://evil.example/page' },
    }),
    context(MINE),
  );
  assert.equal(viaReferer.status, 403);
  assert.equal(signedInChecks, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.rows.length, 3);

  // Same origin passes; so does a server-to-server style call with no origin header at all.
  const ok = await PATCH(request('PATCH', MINE, { title: 'تمام' }), context(MINE));
  assert.equal(ok.status, 200);
  const bare = await DELETE(
    new NextRequest(`http://localhost:3000/api/chat/sessions/${MINE_TOO}`, { method: 'DELETE' }),
    context(MINE_TOO),
  );
  assert.equal(bare.status, 200);
});

test('too many writes is a 429 with Retry-After, and a broken limiter fails closed with 503', async () => {
  const fake = fakeSupabase({ user: { id: ME } });
  const limited = handlersFor(fake, {
    checkRateLimit: async () => ({ allowed: false, remaining: 0, resetAt: new Date().toISOString(), retryAfterSeconds: 7 }),
  });
  const denied = await limited.DELETE(request('DELETE', MINE), context(MINE));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '7');

  const broken = handlersFor(fake, {
    checkRateLimit: async () => {
      throw new Error('rate_limit_unavailable');
    },
  });
  const failed = await broken.PATCH(request('PATCH', MINE, { title: 'x' }), context(MINE));
  assert.equal(failed.status, 503);
  assert.equal(fake.calls.length, 0);
});

test('a database error is a 500 for both verbs', async () => {
  const fake = fakeSupabase({ user: { id: ME }, error: true });
  const { PATCH, DELETE } = handlersFor(fake);
  const originalError = console.error;
  console.error = () => {};
  try {
    const renamed = await PATCH(request('PATCH', MINE, { title: 'x' }), context(MINE));
    const removed = await DELETE(request('DELETE', MINE), context(MINE));
    assert.equal(renamed.status, 500);
    assert.deepEqual(await renamed.json(), { error: 'update_failed' });
    assert.equal(removed.status, 500);
    assert.deepEqual(await removed.json(), { error: 'delete_failed' });
  } finally {
    console.error = originalError;
  }
});

test('titles: control characters go, spaces collapse, length counts characters', () => {
  assert.equal(parseChatTitle('  أهلاً   بك '), 'أهلاً بك');
  assert.equal(parseChatTitle('a\u0000b\u0007c'), 'abc');
  assert.equal(parseChatTitle('\u0000\u0001'), null);
  assert.equal(parseChatTitle('😀'.repeat(CHAT_TITLE_MAX)), '😀'.repeat(CHAT_TITLE_MAX));
  assert.equal(parseChatTitle('😀'.repeat(CHAT_TITLE_MAX + 1)), null);
  assert.equal(parseChatTitle(undefined), null);
});

test('search matches titles forgivingly: alef, ya, ta marbuta, diacritics and digits', () => {
  const chats = [
    { id: '1', title: 'ليش الطلبات قليلة في الويكند؟' },
    { id: '2', title: 'أفضل ميزانية للحملة' },
    { id: '3', title: 'تقرير الأسبوع 12' },
    { id: '4', title: 'Black Friday plan' },
  ];
  assert.deepEqual(filterChatsByTitle(chats, 'افضل').map((c) => c.id), ['2']);
  assert.deepEqual(filterChatsByTitle(chats, 'قليله').map((c) => c.id), ['1']);
  assert.deepEqual(filterChatsByTitle(chats, '١٢').map((c) => c.id), ['3']);
  assert.deepEqual(filterChatsByTitle(chats, 'black').map((c) => c.id), ['4']);
  assert.deepEqual(filterChatsByTitle(chats, '   ').map((c) => c.id), ['1', '2', '3', '4']);
  assert.deepEqual(filterChatsByTitle(chats, 'ما له وجود'), []);
});
