/** The slice of the REST customer (lib/google-ads/client.ts getCustomer) the growth executors use. Tests stub it. */
export interface GrowthCustomer {
  query(gaql: string): Promise<any[]>;
  mutateOperations(operations: unknown[], options?: { validateOnly?: boolean }): Promise<any>;
  credentials?: { customer_id?: string };
  experiments?: {
    mutate(operations: unknown[], options?: { validateOnly?: boolean }): Promise<any>;
    schedule(resourceName: string, options?: { validateOnly?: boolean }): Promise<any>;
    end(resourceName: string, options?: { validateOnly?: boolean }): Promise<any>;
    promote(resourceName: string, options?: { validateOnly?: boolean }): Promise<any>;
  };
  experimentArms?: {
    mutate(operations: unknown[], options?: { validateOnly?: boolean; responseContentType?: string }): Promise<any>;
  };
}

export type MutateOperation = Record<string, { create?: Record<string, unknown>; update?: Record<string, unknown>; update_mask?: string; remove?: string }>;

type Rec = Record<string, any>;

export const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const escapeGaql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Rows come back camelCase over REST and snake_case from some helpers: read either. */
export function pick(row: any, dotted: string): unknown {
  const camelSegments = dotted.split('.').map((part) => part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
  for (const parts of [dotted.split('.'), camelSegments]) {
    let cursor = row;
    for (const part of parts) cursor = cursor?.[part];
    if (cursor !== undefined && cursor !== null) return cursor;
  }
  return undefined;
}

export const pickNum = (row: any, dotted: string) => num(pick(row, dotted));
export const pickStr = (row: any, dotted: string) => {
  const v = pick(row, dotted);
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
};

/** Resource names Google returned, one per operation in order. */
export function resultNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  return results.map((entry) => {
    const name = entry?.resourceName ?? entry?.resource_name;
    return typeof name === 'string' ? name : '';
  });
}

export async function safeQuery(customer: Pick<GrowthCustomer, 'query'>, gaql: string): Promise<any[]> {
  try {
    return await customer.query(gaql);
  } catch {
    return [];
  }
}

export function customerIdOf(customer: GrowthCustomer, fallback?: string | null): string {
  const id = String(fallback ?? customer?.credentials?.customer_id ?? '').replace(/\D/g, '');
  if (!id) throw new Error('Customer id is unavailable.');
  return id;
}

export const resourcePattern = (customerId: string | null | undefined, collection: string) =>
  new RegExp(`^customers/${customerId ? String(customerId).replace(/\D/g, '') : '\\d+'}/${collection}/[^/]+$`);
