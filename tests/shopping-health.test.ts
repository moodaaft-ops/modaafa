import assert from 'node:assert/strict';
import test from 'node:test';

import { isShoppingHealthEnabled } from '../lib/shopping/flag';
import { parseShoppingProducts, summarizeShopping, readShoppingHealth, SHOPPING_PRODUCTS_QUERY } from '../lib/shopping/reader';
import { shoppingHealthBlock } from '../lib/shopping/snapshot';
import { detectProductDisapprovals } from '../lib/shopping/guard';
import { analyze } from '../lib/guard/analyze';
import { reconcile } from '../lib/guard/persist';
import { CODE_SOURCE, GUARD_CODES } from '../lib/guard/types';
import { getShoppingHealthTool } from '../lib/jarvis/tools/get-shopping-health';
import { baseSignals } from './support/guard';

function row(id: string, status: string, issues: Array<[string, string]> = []) {
  return {
    shoppingProduct: {
      itemId: id,
      title: `منتج ${id}`,
      brand: 'ماركة',
      status,
      issues: issues.map(([errorCode, adsSeverity]) => ({ errorCode, adsSeverity, attributeName: 'price', description: 'السعر ما يطابق الصفحة' })),
    },
  };
}

function feed(total: number, blocked: number) {
  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push(i < blocked ? row(`p${i}`, 'NOT_ELIGIBLE', [['PRICE_MISMATCH', 'DISAPPROVED']]) : row(`p${i}`, 'ELIGIBLE'));
  }
  return summarizeShopping(parseShoppingProducts(rows));
}

test('flag defaults off and needs the literal true', () => {
  assert.equal(isShoppingHealthEnabled({}), false);
  assert.equal(isShoppingHealthEnabled({ SHOPPING_HEALTH_ENABLED: '1' }), false);
  assert.equal(isShoppingHealthEnabled({ SHOPPING_HEALTH_ENABLED: 'true' }), true);
});

test('reader: parses camel and snake rows, counts statuses, groups issues by cause', () => {
  const rows = [
    row('a', 'ELIGIBLE'),
    row('b', 'NOT_ELIGIBLE', [['PRICE_MISMATCH', 'DISAPPROVED'], ['PRICE_MISMATCH', 'DISAPPROVED']]),
    row('c', 'NOT_ELIGIBLE', [['PRICE_MISMATCH', 'DISAPPROVED'], ['IMAGE_TOO_SMALL', 'DEMOTED']]),
    row('d', 'ELIGIBLE_LIMITED', [['IMAGE_TOO_SMALL', 'DEMOTED']]),
    { shopping_product: { item_id: 'e', status: 'SOMETHING_NEW', issues: [{ error_code: 'X', ads_severity: 'PENDING' }] } },
    { nothing: true },
  ];
  const health = summarizeShopping(parseShoppingProducts(rows));
  assert.equal(health.total, 5);
  assert.equal(health.eligible, 1);
  assert.equal(health.not_eligible, 2);
  assert.equal(health.eligible_limited, 1);
  assert.equal(health.unknown, 1);
  assert.equal(health.not_eligible_share, 0.4);
  assert.equal(health.truncated, false);
  // A product repeating one issue counts once; disapprovals sort before demotions.
  assert.deepEqual(health.issues.map((i) => [i.code, i.severity, i.products]), [
    ['PRICE_MISMATCH', 'DISAPPROVED', 2],
    ['IMAGE_TOO_SMALL', 'DEMOTED', 2],
    ['X', 'PENDING', 1],
  ]);
  assert.deepEqual(health.issues[0].sample_items, ['b', 'c']);
});

test('reader: empty and malformed input, row limit marks the counts as a floor', () => {
  assert.equal(summarizeShopping(parseShoppingProducts(null)).total, 0);
  assert.equal(summarizeShopping(parseShoppingProducts([])).not_eligible_share, 0);
  const capped = summarizeShopping(parseShoppingProducts([row('a', 'ELIGIBLE'), row('b', 'ELIGIBLE')]), 2);
  assert.equal(capped.truncated, true);
});

test('reader: a failed read is unknown (null), the query asks only for status fields', async () => {
  assert.equal(await readShoppingHealth({ query: async () => { throw new Error('nope'); } }), null);
  const seen: string[] = [];
  const health = await readShoppingHealth({ query: async (g) => { seen.push(g); return [row('a', 'ELIGIBLE')]; } });
  assert.equal(health?.total, 1);
  assert.equal(seen[0], SHOPPING_PRODUCTS_QUERY);
  assert.match(SHOPPING_PRODUCTS_QUERY, /FROM shopping_product/);
});

test('optimizer snapshot block: no products, no block; no titles or item ids inside', () => {
  assert.equal(shoppingHealthBlock(feed(0, 0)), null);
  const block = shoppingHealthBlock(feed(40, 12))!;
  assert.equal(block.not_eligible, 12);
  assert.equal(block.top_issues[0].code, 'PRICE_MISMATCH');
  const text = JSON.stringify(block);
  assert.doesNotMatch(text, /منتج p|"p\d/);
});

test('guard: fires only on enough products, enough blocked products and a high share', () => {
  const make = (total: number, blocked: number, ok = true) =>
    baseSignals({ shopping: feed(total, blocked), ok: { ...baseSignals().ok, shopping: ok } });
  assert.deepEqual(detectProductDisapprovals(make(100, 10)), []); // 10 percent
  assert.deepEqual(detectProductDisapprovals(make(15, 15)), []); // too small a feed
  assert.deepEqual(detectProductDisapprovals(make(100, 9)), []);
  assert.deepEqual(detectProductDisapprovals(make(100, 30, false)), []); // unreadable is not a finding
  assert.deepEqual(detectProductDisapprovals(baseSignals({ shopping: null })), []);
  assert.deepEqual(detectProductDisapprovals(baseSignals()), []); // flag off: signal absent

  const [high] = detectProductDisapprovals(make(100, 25));
  assert.equal(high.code, 'product_disapprovals');
  assert.equal(high.severity, 'high');
  assert.equal(high.escalation, 'none');
  assert.equal(high.dedupeKey, 'product_disapprovals:high:PRICE_MISMATCH');
  assert.match(high.whatAr, /25/);
  const [critical] = detectProductDisapprovals(make(100, 60));
  assert.equal(critical.severity, 'critical');
  assert.notEqual(critical.dedupeKey, high.dedupeKey);
  for (const text of [high.whatAr, high.stepAr]) {
    assert.doesNotMatch(text, /[–—]/);
    assert.doesNotMatch(text, /,/);
  }
});

test('guard: analyze includes the rule only when shopping signals exist; the code is registered', () => {
  assert.ok(GUARD_CODES.includes('product_disapprovals'));
  assert.equal(CODE_SOURCE.product_disapprovals, 'shopping');
  const without = analyze(baseSignals());
  assert.equal(without.some((f) => f.code === 'product_disapprovals'), false);
  const withFeed = analyze(baseSignals({ shopping: feed(100, 40), ok: { ...baseSignals().ok, shopping: true } }));
  assert.equal(withFeed.some((f) => f.code === 'product_disapprovals'), true);
});

test('guard: a finding closes only when the shopping read worked', () => {
  const existing = [{ id: 'r1', code: 'product_disapprovals' as const, dedupe_key: 'product_disapprovals:high:PRICE_MISMATCH', status: 'open' as const, seen_count: 1 }];
  const base = baseSignals().ok;
  assert.deepEqual(reconcile(existing as any, [], { ...base, shopping: true }).resolve, ['r1']);
  assert.deepEqual(reconcile(existing as any, [], { ...base, shopping: false }).resolve, []);
  assert.deepEqual(reconcile(existing as any, [], base).resolve, []); // flag off: unknown, never closed
});

test('Jarvis tool: refuses when the flag is off, otherwise returns counts and evidence without ids in the summary', async () => {
  const old = process.env.SHOPPING_HEALTH_ENABLED;
  try {
    delete process.env.SHOPPING_HEALTH_ENABLED;
    await assert.rejects(() => getShoppingHealthTool.run({}, { customer: { query: async () => [] } } as any), /disabled/);
    process.env.SHOPPING_HEALTH_ENABLED = 'true';
    const rows = [row('a', 'ELIGIBLE'), row('b', 'NOT_ELIGIBLE', [['PRICE_MISMATCH', 'DISAPPROVED']])];
    const result = await getShoppingHealthTool.run({}, { customer: { query: async () => rows } } as any);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.summary.not_eligible, 1);
      assert.equal(result.rows[0].kind, 'shopping_issue');
      assert.deepEqual((result.rows[0].data as any).sample_items, ['b']);
      assert.doesNotMatch(JSON.stringify(result.summary), /"b"/);
    }
  } finally {
    if (old === undefined) delete process.env.SHOPPING_HEALTH_ENABLED;
    else process.env.SHOPPING_HEALTH_ENABLED = old;
  }
});
