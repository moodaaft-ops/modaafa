export const CID = '1234567890';
export const P = `customers/${CID}`;

type Handler = { match: RegExp; rows: any[] | ((gaql: string) => any[]) };

export type Stub = ReturnType<typeof makeCustomer>;

/** A GrowthCustomer stub: GAQL is routed by regex; every mutate call is recorded. */
export function makeCustomer(handlers: Handler[] = [], options: { failLive?: (ops: any[]) => Error | null; mutateNames?: (ops: any[]) => string[] } = {}) {
  const queries: string[] = [];
  const mutates: Array<{ ops: any[]; validateOnly: boolean }> = [];
  const experimentCalls: Array<{ kind: string; args: any[] }> = [];
  let counter = 100;
  const customer = {
    credentials: { customer_id: CID, login_customer_id: null, refresh_token: 'x' } as any,
    queries,
    mutates,
    experimentCalls,
    async query(gaql: string) {
      queries.push(gaql);
      for (const h of handlers) {
        if (h.match.test(gaql)) return typeof h.rows === 'function' ? h.rows(gaql) : h.rows;
      }
      return [];
    },
    async mutateOperations(ops: any[], opts?: { validateOnly?: boolean }) {
      const validateOnly = Boolean(opts?.validateOnly);
      mutates.push({ ops, validateOnly });
      if (!validateOnly) {
        const err = options.failLive?.(ops);
        if (err) throw err;
      }
      const names = options.mutateNames?.(ops) ?? ops.map(() => `${P}/assets/${(counter += 1)}`);
      return { mutateOperationResponses: names.map((resourceName) => ({ x: { resourceName } })) };
    },
    experiments: {
      async mutate(ops: any[], opts?: any) {
        experimentCalls.push({ kind: 'experiments.mutate', args: [ops, opts] });
        return { results: [{ resourceName: `${P}/experiments/77` }] };
      },
      async schedule(r: string, opts?: any) { experimentCalls.push({ kind: 'schedule', args: [r, opts] }); return {}; },
      async end(r: string, opts?: any) { experimentCalls.push({ kind: 'end', args: [r, opts] }); return {}; },
      async promote(r: string, opts?: any) { experimentCalls.push({ kind: 'promote', args: [r, opts] }); return {}; },
    },
    experimentArms: {
      async mutate(ops: any[], opts?: any) {
        experimentCalls.push({ kind: 'arms.mutate', args: [ops, opts] });
        return { results: [{ resourceName: `${P}/experimentArms/77~1` }, { resourceName: `${P}/experimentArms/77~2` }] };
      },
    },
  };
  return customer as typeof customer & any;
}

/** Account that passes the tracking gate: an enabled primary purchase action with recent conversions. */
export function healthyHandlers(conversions30d = 200): Handler[] {
  const day = (offset: number) => {
    const d = new Date(Date.now() - offset * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  return [
    {
      match: /FROM conversion_action/,
      rows: [{ conversionAction: { name: 'Purchase', status: 'ENABLED', category: 'PURCHASE', primaryForGoal: true, includeInConversionsMetric: true } }],
    },
    {
      match: /segments\.conversion_action_name/,
      rows: [1, 2, 3, 4, 5].map((o) => ({ segments: { date: day(o), conversionActionName: 'Purchase' }, metrics: { allConversions: 4 } })),
    },
    { match: /FROM customer LIMIT 1/, rows: [{ customer: { autoTaggingEnabled: true, timeZone: 'Asia/Riyadh', currencyCode: 'SAR' } }] },
    { match: /LAST_7_DAYS/, rows: [{ metrics: { clicks: 120, conversions: 9 } }] },
    { match: /FROM customer WHERE segments\.date DURING LAST_30_DAYS/, rows: [{ metrics: { conversions: conversions30d } }] },
  ];
}
