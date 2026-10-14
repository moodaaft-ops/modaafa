/**
 * A tiny PostgREST stand-in for route tests: it replaces globalThis.fetch for
 * one fake Supabase URL and serves `eq.` filters, `limit`, GET and PATCH over
 * in-memory tables, so a real route handler can run through the real
 * supabase-js client without a network.
 *
 * Usage:
 *   const db = installFakePostgrest({ users: [...], message_log: [...] });
 *   ... call the route ...
 *   db.restore();
 */
type Row = Record<string, any>;

export const FAKE_SUPABASE_URL = 'http://supabase.test';
export const FAKE_SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: FAKE_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
};

export function installFakePostgrest(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { ...seed };
  const calls: Array<{ method: string; table: string; query: string; body: any }> = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== FAKE_SUPABASE_URL) return realFetch(input, init);

    const method = String(request?.method ?? init.method ?? 'GET').toUpperCase();
    const table = url.pathname.replace('/rest/v1/', '');
    const rawBody = request ? await request.text() : init.body;
    const body = rawBody ? JSON.parse(String(rawBody)) : null;
    calls.push({ method, table, query: url.search, body });

    const rows = (tables[table] ??= []);
    const matches = (row: Row) => {
      for (const [key, value] of url.searchParams) {
        if (key === 'select' || key === 'limit' || key === 'order' || key === 'offset') continue;
        if (typeof value === 'string' && value.startsWith('eq.') && String(row[key]) !== value.slice(3)) return false;
      }
      return true;
    };
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (method === 'GET' || method === 'HEAD') {
      const limit = url.searchParams.get('limit');
      let result = rows.filter(matches).map((row) => ({ ...row }));
      if (limit) result = result.slice(0, Number(limit));
      return json(result);
    }
    if (method === 'PATCH') {
      for (const row of rows.filter(matches)) Object.assign(row, body);
      return new Response(null, { status: 204 });
    }
    return json({ message: `unsupported ${method}` }, 405);
  }) as typeof fetch;

  return {
    tables,
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
