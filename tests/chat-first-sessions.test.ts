import assert from 'node:assert/strict';
import test from 'node:test';
import { loadScopedHistory, sessionBelongsTo } from '../lib/chat-first/sessions';

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])];
      let single = false;
      const q: any = {
        select: () => q,
        eq: (k: string, v: any) => ((rows = rows.filter((r) => r[k] === v)), q),
        is: (k: string, v: any) => ((rows = rows.filter((r) => (r[k] ?? null) === v)), q),
        order: (k: string, o: { ascending: boolean }) => (
          rows.sort((a, b) => (a[k] > b[k] ? 1 : -1) * (o.ascending ? 1 : -1)), q
        ),
        limit: (n: number) => ((rows = rows.slice(0, n)), q),
        maybeSingle: () => ((single = true), q),
        then: (res: any) => res({ data: single ? (rows[0] ?? null) : rows, error: null }),
      };
      return q;
    },
  };
}

const db = () =>
  fakeDb({
    chat_sessions: [
      { id: 'sA', user_id: 'u1', account_id: 'accA', updated_at: '2026-10-09T01:00:00Z' },
      { id: 'sB', user_id: 'u1', account_id: 'accB', updated_at: '2026-10-09T02:00:00Z' },
      { id: 'sX', user_id: 'u2', account_id: 'accX', updated_at: '2026-10-09T03:00:00Z' },
      { id: 'sN', user_id: 'u3', account_id: null, updated_at: '2026-10-09T03:00:00Z' },
    ],
    chat_messages: [
      { session_id: 'sA', seq: 1, role: 'user', content: 'وش وضع حسابي', tool_results: null },
      {
        session_id: 'sA',
        seq: 2,
        role: 'assistant',
        content: 'تقرير A: صحة 62',
        tool_results: { cards: [{ kind: 'approval', recommendationId: 'recA' }], actions: [{ label: 'نفّذ الحين', action: { type: 'execute', recommendationId: 'recA' } }] },
      },
      { session_id: 'sB', seq: 1, role: 'assistant', content: 'تقرير B: صحة 80', tool_results: { cards: [], actions: [] } },
      { session_id: 'sX', seq: 1, role: 'assistant', content: 'سري لمستخدم آخر', tool_results: { cards: [], actions: [] } },
    ],
  });

test('same user, account B: latest history is B only, never A', async () => {
  const r = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: 'accB', wantedSessionId: null });
  assert.ok(r.found && r.sessionId === 'sB');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('تقرير A') && !text.includes('recA'));
});

test('same user, account A: latest history is A even though B is newer', async () => {
  const r = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: 'accA', wantedSessionId: null });
  assert.ok(r.found && r.sessionId === 'sA');
});

test('asking for A session id while on account B is not found', async () => {
  const r = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: 'accB', wantedSessionId: 'sA' });
  assert.equal(r.found, false);
  assert.equal(await sessionBelongsTo({ supabase: db(), userId: 'u1', sessionId: 'sA', accountId: 'accB' }), false);
  assert.equal(await sessionBelongsTo({ supabase: db(), userId: 'u1', sessionId: 'sA', accountId: 'accA' }), true);
});

test('foreign user: other user sessions are invisible with any account id', async () => {
  for (const acc of ['accX', 'accA', null]) {
    const r = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: acc, wantedSessionId: 'sX' });
    assert.equal(r.found, false);
    assert.equal(await sessionBelongsTo({ supabase: db(), userId: 'u1', sessionId: 'sX', accountId: acc }), false);
  }
  const hist = await loadScopedHistory({ supabase: db(), userId: 'u2', accountId: 'accX', wantedSessionId: null });
  assert.ok(hist.found && JSON.stringify(hist).includes('سري'));
  const foreign = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: 'accX', wantedSessionId: null });
  assert.equal(foreign.found, false);
});

test('old cards stay as read-only history and old actions are never replayed', async () => {
  const r = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: 'accA', wantedSessionId: null });
  assert.ok(r.found);
  const turn = r.messages.find((m) => m.seq === 2)!;
  assert.equal(turn.tool_results.cards.length, 1);
  assert.deepEqual(turn.tool_results.actions, []);
});

test('user with no account only sees account-less sessions', async () => {
  const none = await loadScopedHistory({ supabase: db(), userId: 'u1', accountId: null, wantedSessionId: null });
  assert.equal(none.found, false);
  const own = await loadScopedHistory({ supabase: db(), userId: 'u3', accountId: null, wantedSessionId: null });
  assert.ok(own.found && own.sessionId === 'sN');
  assert.equal(await sessionBelongsTo({ supabase: db(), userId: 'u3', sessionId: 'sN', accountId: 'accA' }), false);
});
