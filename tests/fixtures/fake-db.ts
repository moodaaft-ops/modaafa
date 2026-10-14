/**
 * A table-keyed fake of the Supabase query builder, enough for the setup and
 * plan loaders: every filter method records and returns the chain, a terminal
 * `maybeSingle()` / `single()` resolves the first row, and awaiting the chain
 * resolves the list. Writes (`update`, `insert`, `upsert`, `delete`) are
 * recorded and resolve `{ error: null }`. All data in tests is synthetic.
 */

export type FakeQuery = {
  table: string;
  op: 'select' | 'update' | 'insert' | 'upsert' | 'delete';
  /** [method, column, value] for eq / neq / in / is / not / gte / lte ... in call order. */
  filters: Array<[string, string, unknown]>;
  payload?: unknown;
  options?: unknown;
};

export type FakeRows = unknown[] | { error: string } | ((query: FakeQuery) => unknown[] | { error: string });

export function eqValue(query: FakeQuery, column: string): unknown {
  return query.filters.find(([method, col]) => method === 'eq' && col === column)?.[2];
}

export function fakeDb(tables: Record<string, FakeRows> = {}, opts: { failWrite?: (query: FakeQuery) => boolean } = {}) {
  const queries: FakeQuery[] = [];
  const reads = () => queries.filter((query) => query.op === 'select');
  const client = {
    from(table: string) {
      const query: FakeQuery = { table, op: 'select', filters: [] };
      queries.push(query);
      const resolveRows = () => {
        const source = tables[table];
        const rows = typeof source === 'function' ? source(query) : source ?? [];
        if (rows && !Array.isArray(rows)) return { data: null, error: { message: (rows as { error: string }).error } };
        return { data: rows as unknown[], error: null };
      };
      const chain: any = {};
      for (const method of ['eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'gt', 'lt', 'contains', 'or', 'ilike']) {
        chain[method] = (column: string, ...rest: unknown[]) => {
          query.filters.push([method, column, rest.length > 1 ? rest : rest[0]]);
          return chain;
        };
      }
      for (const method of ['select', 'order', 'limit', 'range']) chain[method] = () => chain;
      chain.update = (payload: unknown) => {
        query.op = 'update';
        query.payload = payload;
        return chain;
      };
      chain.insert = (payload: unknown) => {
        query.op = 'insert';
        query.payload = payload;
        return chain;
      };
      chain.upsert = (payload: unknown, options?: unknown) => {
        query.op = 'upsert';
        query.payload = payload;
        query.options = options;
        return chain;
      };
      chain.delete = () => {
        query.op = 'delete';
        return chain;
      };
      const one = () => {
        if (query.op !== 'select') return Promise.resolve(opts.failWrite?.(query) ? { data: null, error: { message: 'write failed' } } : { data: null, error: null });
        const result = resolveRows();
        return Promise.resolve(result.error ? result : { data: (result.data as unknown[])[0] ?? null, error: null });
      };
      chain.maybeSingle = one;
      chain.single = one;
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const result =
          query.op === 'select'
            ? resolveRows()
            : opts.failWrite?.(query)
              ? { data: null, error: { message: 'write failed' } }
              : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      };
      return chain;
    },
  };
  return { client, queries, reads, writes: () => queries.filter((query) => query.op !== 'select') };
}
