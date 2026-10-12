/**
 * A small in-memory stand-in for the Supabase admin client, covering exactly
 * the query shapes the stage code uses. The record_user_event rpc mirrors
 * db/migrations/20261012_user_stages.sql (the SQL itself was exercised on a
 * real Postgres engine separately); it exists so the journey test can walk a
 * user through the stages without a network.
 */
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const STAGE_RANK: Record<string, number> = { registered: 1, connected: 2, analysis_viewed: 3, subscribed: 4 };
const EVENT_STAGE: Record<string, string> = {
  ads_account_connected: 'connected',
  first_analysis_viewed: 'analysis_viewed',
  subscription_paid: 'subscribed',
};
const UNIQUE: Record<string, string[]> = {
  user_events: ['user_id', 'event_type'],
  message_log: ['user_id', 'template_key'],
};

export function createFakeAdmin(seed: Tables = {}) {
  const tables: Tables = {
    users: [],
    user_events: [],
    message_log: [],
    subscriptions: [],
    ...seed,
  };
  const confirmed = new Set<string>();
  const rpcCalls: Array<{ name: string; args: any }> = [];
  let clockNow = () => new Date();

  const admin = {
    tables,
    confirmEmail(userId: string) {
      confirmed.add(userId);
    },
    setClock(fn: () => Date) {
      clockNow = fn;
    },
    rpcCalls,
    auth: {
      admin: {
        async getUserById(id: string) {
          return { data: { user: { id, email_confirmed_at: confirmed.has(id) ? '2026-10-12T00:00:00Z' : null } }, error: null };
        },
      },
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name !== 'record_user_event') return { data: null, error: { code: '42883' } };
      const exists = tables.user_events.some((e) => e.user_id === args.p_user_id && e.event_type === args.p_event_type);
      if (!exists) {
        tables.user_events.push({
          id: `ev-${tables.user_events.length + 1}`,
          user_id: args.p_user_id,
          event_type: args.p_event_type,
          occurred_at: args.p_occurred_at ?? clockNow().toISOString(),
          metadata: args.p_metadata ?? {},
        });
      }
      const stage = EVENT_STAGE[args.p_event_type];
      const user = tables.users.find((u) => u.id === args.p_user_id);
      if (stage && user && (STAGE_RANK[user.stage] ?? 0) < STAGE_RANK[stage]) {
        user.stage = stage;
        user.stage_changed_at = args.p_occurred_at;
      }
      return { data: !exists, error: null };
    },
    from(table: string) {
      return new Query(tables, table);
    },
  };
  return admin;
}

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Array<(row: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: any;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private rangeFrom = 0;
  private rangeTo = Infinity;
  private single = false;
  private returning = false;
  private orderBy: Array<{ column: string; ascending: boolean }> = [];

  constructor(private tables: Tables, private table: string) {
    if (!tables[table]) tables[table] = [];
  }

  select() {
    if (this.op === 'update' || this.op === 'insert') this.returning = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert';
    this.payload = payload;
    this.upsertOptions = options;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(column: string, value: any) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: any[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: any) {
    this.filters.push((row) => row[column] != null && new Date(row[column]).getTime() >= new Date(value).getTime());
    return this;
  }
  lt(column: string, value: any) {
    this.filters.push((row) => row[column] != null && row[column] < value);
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, ascending: options.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  limit(count: number) {
    this.rangeTo = this.rangeFrom + count - 1;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private uniqueKey(row: Row) {
    const cols = UNIQUE[this.table];
    return cols ? cols.map((c) => row[c]).join('|') : null;
  }

  private run(): { data: any; error: any } {
    const rows = this.tables[this.table];
    const matching = () => rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.op === 'insert' || this.op === 'upsert') {
      const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const item of list) {
        const key = this.uniqueKey(item);
        const clash = key !== null && rows.some((row) => this.uniqueKey(row) === key);
        if (clash) {
          if (this.op === 'insert') return { data: null, error: { code: '23505' } };
          if (this.upsertOptions.ignoreDuplicates) continue;
        }
        rows.push({ id: `row-${this.table}-${rows.length + 1}`, ...item });
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = matching();
      hit.forEach((row) => Object.assign(row, this.payload));
      return { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === 'delete') {
      const hit = new Set(matching());
      this.tables[this.table] = rows.filter((row) => !hit.has(row));
      return { data: null, error: null };
    }

    let result = matching();
    for (const { column, ascending } of [...this.orderBy].reverse()) {
      result = [...result].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
    }
    result = result.slice(this.rangeFrom, this.rangeTo === Infinity ? undefined : this.rangeTo + 1).map((r) => ({ ...r }));
    return { data: this.single ? result[0] ?? null : result, error: null };
  }

  then<T1 = { data: any; error: any }, T2 = never>(
    onfulfilled?: ((value: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}
