/**
 * Reads the Merchant Center product status the Google Ads API exposes as the
 * `shopping_product` resource (account scope: every product of the linked
 * Merchant Center accounts that Shopping and Performance Max can include).
 * Read-only and rules-only: no model call. A failed read is "unknown", never
 * "healthy": readShoppingHealth returns null.
 *
 * Fields checked against the v22 ShoppingProduct proto: item_id, title, brand,
 * channel, status (NOT_ELIGIBLE, ELIGIBLE_LIMITED, ELIGIBLE), issues[]
 * { error_code, ads_severity, attribute_name, description, detail }.
 */

export const SHOPPING_PRODUCT_LIMIT = 5000;
export const SHOPPING_PRODUCTS_QUERY = `
  SELECT shopping_product.item_id, shopping_product.title, shopping_product.brand,
    shopping_product.channel, shopping_product.status, shopping_product.issues
  FROM shopping_product
  LIMIT ${SHOPPING_PRODUCT_LIMIT}
`;

export type ProductStatus = 'ELIGIBLE' | 'ELIGIBLE_LIMITED' | 'NOT_ELIGIBLE' | 'UNKNOWN';
export type IssueSeverity = 'DISAPPROVED' | 'DEMOTED' | 'PENDING' | 'UNKNOWN';

export type ShoppingProduct = {
  itemId: string;
  title: string;
  brand: string;
  status: ProductStatus;
  issues: Array<{ code: string; severity: IssueSeverity; attribute: string; description: string }>;
};

export type ShoppingIssueGroup = {
  code: string;
  severity: IssueSeverity;
  description: string;
  attribute: string;
  products: number;
  sample_items: string[];
};

export type ShoppingHealth = {
  total: number;
  eligible: number;
  eligible_limited: number;
  not_eligible: number;
  unknown: number;
  /** not_eligible / total, 0 when there are no products. */
  not_eligible_share: number;
  /** True when the read hit the row limit: the counts are a floor, not the full feed. */
  truncated: boolean;
  issues: ShoppingIssueGroup[];
};

const STATUSES = new Set(['ELIGIBLE', 'ELIGIBLE_LIMITED', 'NOT_ELIGIBLE']);
const SEVERITIES = new Set(['DISAPPROVED', 'DEMOTED', 'PENDING']);

function pick(o: any, camel: string, snake: string) {
  return o && typeof o === 'object' ? (o[camel] !== undefined ? o[camel] : o[snake]) : undefined;
}

export function parseShoppingProducts(rows: unknown): ShoppingProduct[] {
  if (!Array.isArray(rows)) return [];
  const out: ShoppingProduct[] = [];
  for (const row of rows) {
    const p = pick(row, 'shoppingProduct', 'shopping_product');
    if (!p) continue;
    const status = String(p.status ?? '');
    const issues = (Array.isArray(p.issues) ? p.issues : []).map((i: any) => {
      const severity = String(pick(i, 'adsSeverity', 'ads_severity') ?? '');
      return {
        code: String(pick(i, 'errorCode', 'error_code') ?? '').slice(0, 80),
        severity: (SEVERITIES.has(severity) ? severity : 'UNKNOWN') as IssueSeverity,
        attribute: String(pick(i, 'attributeName', 'attribute_name') ?? '').slice(0, 60),
        description: String(i?.description ?? '').slice(0, 160),
      };
    });
    out.push({
      itemId: String(pick(p, 'itemId', 'item_id') ?? '').slice(0, 80),
      title: String(p.title ?? '').slice(0, 120),
      brand: String(p.brand ?? '').slice(0, 60),
      status: (STATUSES.has(status) ? status : 'UNKNOWN') as ProductStatus,
      issues,
    });
  }
  return out;
}

export function summarizeShopping(products: ShoppingProduct[], limit = SHOPPING_PRODUCT_LIMIT, maxIssues = 10): ShoppingHealth {
  const counts = { eligible: 0, eligible_limited: 0, not_eligible: 0, unknown: 0 };
  const groups = new Map<string, ShoppingIssueGroup>();
  for (const product of products) {
    if (product.status === 'ELIGIBLE') counts.eligible += 1;
    else if (product.status === 'ELIGIBLE_LIMITED') counts.eligible_limited += 1;
    else if (product.status === 'NOT_ELIGIBLE') counts.not_eligible += 1;
    else counts.unknown += 1;
    const seen = new Set<string>();
    for (const issue of product.issues) {
      if (!issue.code) continue;
      const key = `${issue.code}:${issue.severity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? {
        code: issue.code,
        severity: issue.severity,
        description: issue.description,
        attribute: issue.attribute,
        products: 0,
        sample_items: [],
      };
      group.products += 1;
      if (group.sample_items.length < 3 && product.itemId) group.sample_items.push(product.itemId);
      groups.set(key, group);
    }
  }
  const total = products.length;
  const weight = (s: IssueSeverity) => (s === 'DISAPPROVED' ? 0 : s === 'DEMOTED' ? 1 : 2);
  const issues = [...groups.values()]
    .sort((a, b) => weight(a.severity) - weight(b.severity) || b.products - a.products || a.code.localeCompare(b.code))
    .slice(0, maxIssues);
  return {
    total,
    ...counts,
    not_eligible_share: total > 0 ? Math.round((counts.not_eligible / total) * 1000) / 1000 : 0,
    truncated: total >= limit,
    issues,
  };
}

export async function readShoppingHealth(customer: { query(gaql: string): Promise<any[]> }): Promise<ShoppingHealth | null> {
  try {
    return summarizeShopping(parseShoppingProducts(await customer.query(SHOPPING_PRODUCTS_QUERY)));
  } catch {
    return null;
  }
}

/** Same read, but a failure throws (the guard needs to tell "unreadable" from "no products"). */
export async function readShoppingHealthOrThrow(customer: { query(gaql: string): Promise<any[]> }): Promise<ShoppingHealth> {
  return summarizeShopping(parseShoppingProducts(await customer.query(SHOPPING_PRODUCTS_QUERY)));
}
