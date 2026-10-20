/** A small chainable stand-in for the Supabase client: filters collect, the await applies them. */
type Row = Record<string, any>;

export function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row; id: unknown }> = [];
  const reads: string[] = [];
  const db = {
    updates,
    reads,
    tables,
    from(table: string) {
      reads.push(table);
      const filters: Array<(row: Row) => boolean> = [];
      let limitN = Infinity;
      let patch: Row | null = null;
      const builder: any = {
        select: () => builder,
        update: (p: Row) => {
          patch = p;
          return builder;
        },
        eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), builder),
        neq: (col: string, value: unknown) => (filters.push((r) => r[col] !== value), builder),
        in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), builder),
        not: (col: string, _op: string, value: unknown) => (filters.push((r) => r[col] !== value), builder),
        gte: (col: string, value: string) => (filters.push((r) => String(r[col]) >= value), builder),
        order: () => builder,
        limit: (n: number) => ((limitN = n), builder),
        then(resolve: (v: any) => void) {
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (patch) {
            for (const r of rows) {
              Object.assign(r, patch);
              updates.push({ table, patch: patch!, id: r.id });
            }
            return resolve({ data: null, error: null });
          }
          return resolve({ data: rows.slice(0, limitN), error: null });
        },
      };
      return builder;
    },
  };
  return db;
}
