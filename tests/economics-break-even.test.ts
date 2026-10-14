import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BREAK_EVEN_BASIS,
  allowableCpaCut,
  allowableCpaScale,
  breakEvenForCurrency,
  bucketBounds,
  computeBreakEven,
  conservativeEdge,
  deriveEconomicsKind,
  hasBreakEven,
  type EconomicsFacts,
} from '../lib/economics/break-even';
import { loadEconomics, loadEconomicsFacts } from '../lib/economics/load';
import { adaptiveEffects } from '../lib/setup/adaptive/answers';

/** The `data` payload the onboarding writer really produces for one answer. */
function factData(
  key: 'margin' | 'deal_value' | 'profit_per_deal' | 'close_rate' | 'aov_check',
  choice: string,
  extra: object = {}
) {
  const effects = adaptiveEffects({ key, choice, ...extra } as any);
  assert.ok(effects.fact, `${key}:${choice} writes a fact`);
  return effects.fact!.data as Record<string, unknown>;
}

test('a bucket has a low and a high edge: closed buckets keep both, «أقل من» halves the upper, «أكثر من» doubles the lower', () => {
  assert.deepEqual(bucketBounds(0, 20), { low: 10, high: 20 });
  assert.deepEqual(bucketBounds(20, 40), { low: 20, high: 40 });
  // Open-ended top bucket: no upper edge, so the high edge is twice the lower one (the documented convention).
  assert.deepEqual(bucketBounds(40, null), { low: 40, high: 80 });
  assert.deepEqual(bucketBounds(50000, undefined), { low: 50000, high: 100000 });
  assert.deepEqual(bucketBounds(0, 1), { low: 0.5, high: 1 });
  assert.deepEqual(bucketBounds(4, 10), { low: 4, high: 10 });
  assert.equal(bucketBounds(null, null), null);
  assert.equal(bucketBounds(undefined, undefined), null);
  assert.equal(bucketBounds(0, 0), null);
});

test('the conservative edge is the low edge of the bucket', () => {
  assert.equal(conservativeEdge(0, 20), 10);
  assert.equal(conservativeEdge(20, 40), 20);
  assert.equal(conservativeEdge(40, null), 40);
  assert.equal(conservativeEdge(0, 1), 0.5);
  assert.equal(conservativeEdge(4, 10), 4);
  assert.equal(conservativeEdge(null, null), null);
  assert.equal(conservativeEdge(0, 0), null);
});

test('e-commerce: the SCALE ROAS comes from the lowest margin of the bucket and the CUT ROAS from the highest', () => {
  // margin lt20 = 10..20%, 20_40 = 20..40%, gt40 = 40..80% (open-ended: twice the lower edge).
  const expected: Record<string, [number, number]> = { lt20: [10, 5], '20_40': [5, 2.5], gt40: [2.5, 1.25] };
  for (const [choice, [scale, cut]] of Object.entries(expected)) {
    const result = computeBreakEven({
      facts: { type: { choice: 'ecommerce' }, margin: factData('margin', choice) },
    });
    assert.equal(result.kind, 'ecommerce');
    assert.equal(result.break_even_roas, scale, `${choice} scale`);
    assert.equal(result.break_even_roas_cut, cut, `${choice} cut`);
    assert.ok((result.break_even_roas as number) > (result.break_even_roas_cut as number), `${choice}: SCALE needs more than CUT allows`);
    assert.equal(result.break_even_cpa, null);
    assert.equal(result.break_even_cpa_cut, null);
    assert.deepEqual(result.missing, []);
    assert.equal(result.basis, BREAK_EVEN_BASIS);
  }
});

test('"I do not know" and "never asked" are the same: null, with the answer named in missing', () => {
  const unknown = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', 'unknown') } });
  assert.equal(unknown.break_even_roas, null);
  assert.equal(unknown.break_even_roas_cut, null);
  assert.deepEqual(unknown.missing, ['margin']);
  assert.equal(hasBreakEven(unknown), false);

  const neverAsked = computeBreakEven({ facts: { type: { choice: 'ecommerce' } } });
  assert.equal(neverAsked.break_even_roas, null);
  assert.deepEqual(neverAsked.missing, ['margin']);
});

test('leads: SCALE CPA is the low profit x the low close rate, CUT CPA the high profit x the high close rate', () => {
  // profit 200_1k = 200..1,000 SAR, close 2_3 = 2..3 of 10: SCALE 200 x 0.2 = 40, CUT 1,000 x 0.3 = 300.
  const facts: EconomicsFacts = {
    type: { choice: 'services' },
    profit_per_deal: factData('profit_per_deal', '200_1k'),
    close_rate: factData('close_rate', '2_3'),
  };
  const result = computeBreakEven({ facts });
  assert.equal(result.kind, 'services');
  assert.equal(result.break_even_cpa, 40);
  assert.equal(result.break_even_cpa_cut, 300);
  assert.equal(result.break_even_roas, null);
  assert.equal(result.break_even_roas_cut, null);
  assert.deepEqual(result.missing, []);
  assert.equal(result.inputs.profit_per_deal_sar, 200);
  assert.equal(result.inputs.profit_per_deal_sar_high, 1000);
  assert.equal(result.inputs.close_rate_fraction, 0.2);
  assert.equal(result.inputs.close_rate_fraction_high, 0.3);
  assert.equal(result.inputs.margin_fraction, null);
  assert.equal(result.inputs.deal_value_sar, null);

  // Every bucket: SCALE from its low edge (half of the upper one when it starts at 0), CUT from its high edge
  // (twice the lower one when it is open-ended).
  const profit: Record<string, [number, number]> = { lt50: [25, 50], '50_200': [50, 200], '200_1k': [200, 1000], '1k_5k': [1000, 5000], gt5k: [5000, 10000] };
  const close: Record<string, [number, number]> = { le1: [0.05, 0.1], '2_3': [0.2, 0.3], ge4: [0.4, 1] };
  for (const [profitChoice, [profitLow, profitHigh]] of Object.entries(profit)) {
    for (const [closeChoice, [closeLow, closeHigh]] of Object.entries(close)) {
      const bucketed = computeBreakEven({
        facts: {
          type: { choice: 'clinic' },
          profit_per_deal: factData('profit_per_deal', profitChoice),
          close_rate: factData('close_rate', closeChoice),
        },
      });
      assert.equal(bucketed.break_even_cpa, Math.round(profitLow * closeLow * 100) / 100, `${profitChoice}/${closeChoice} scale`);
      assert.equal(bucketed.break_even_cpa_cut, Math.round(profitHigh * closeHigh * 100) / 100, `${profitChoice}/${closeChoice} cut`);
      assert.ok((bucketed.break_even_cpa as number) <= (bucketed.break_even_cpa_cut as number), `${profitChoice}/${closeChoice}: CUT allows at least what SCALE needs`);
    }
  }
});

test('leads: a bigger profit bucket never gives a smaller break-even CPA, at either end', () => {
  const order = ['lt50', '50_200', '200_1k', '1k_5k', 'gt5k'];
  const economics = order.map((choice) =>
    computeBreakEven({
      facts: { type: { choice: 'local_store' }, profit_per_deal: factData('profit_per_deal', choice), close_rate: factData('close_rate', '2_3') },
    })
  );
  for (let index = 1; index < economics.length; index += 1) {
    assert.ok((economics[index].break_even_cpa as number) > (economics[index - 1].break_even_cpa as number), `${order[index]} scale`);
    assert.ok((economics[index].break_even_cpa_cut as number) > (economics[index - 1].break_even_cpa_cut as number), `${order[index]} cut`);
  }
});

test('leads: the profit per customer wins over the older deal value x margin x close rate', () => {
  const result = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', '10k_50k'),
      margin: factData('margin', '20_40'),
      profit_per_deal: factData('profit_per_deal', '50_200'),
      close_rate: factData('close_rate', '2_3'),
    },
  });
  // 50 x 0.2 = 10, not 10,000 x 0.2 x 0.2 = 400. (CUT: 200 x 0.3 = 60.)
  assert.equal(result.break_even_cpa, 10);
  assert.equal(result.break_even_cpa_cut, 60);
});

test('leads: a profit answer of «ما أدري» falls back to the older answers, and to nothing when there are none', () => {
  const older = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', '10k_50k'),
      margin: factData('margin', '20_40'),
      profit_per_deal: factData('profit_per_deal', 'unknown'),
      close_rate: factData('close_rate', '2_3'),
    },
  });
  assert.equal(older.break_even_cpa, 400);
  // CUT: 50,000 x 0.4 x 0.3 = 6,000.
  assert.equal(older.break_even_cpa_cut, 6000);

  const nothing = computeBreakEven({
    facts: {
      type: { choice: 'clinic' },
      profit_per_deal: factData('profit_per_deal', 'unknown'),
      close_rate: factData('close_rate', '2_3'),
    },
  });
  assert.equal(nothing.break_even_cpa, null);
  assert.equal(nothing.break_even_cpa_cut, null);
  assert.deepEqual(nothing.missing, ['profit_per_deal']);
});

test('leads: a profit without a close rate is not enough, and the close rate is named', () => {
  const result = computeBreakEven({ facts: { type: { choice: 'local_store' }, profit_per_deal: factData('profit_per_deal', '1k_5k') } });
  assert.equal(result.break_even_cpa, null);
  assert.deepEqual(result.missing, ['close_rate']);
  assert.equal(hasBreakEven(result), false);
});

test('leads: break-even CPA is deal value x margin x close rate for an owner who answered those earlier', () => {
  // deal 10k_50k -> 10,000 SAR, close 2_3 -> 2 of 10, margin 20_40 -> 20%: 10,000 x 0.2 x 0.2 = 400.
  const facts: EconomicsFacts = {
    type: { choice: 'services' },
    deal_value: factData('deal_value', '10k_50k'),
    close_rate: factData('close_rate', '2_3'),
    margin: factData('margin', '20_40'),
  };
  const result = computeBreakEven({ facts });
  assert.equal(result.kind, 'services');
  assert.equal(result.break_even_cpa, 400);
  assert.equal(result.break_even_cpa_cut, 6000);
  assert.equal(result.break_even_roas, null);
  assert.deepEqual(result.inputs, {
    margin_fraction: 0.2,
    margin_fraction_high: 0.4,
    deal_value_sar: 10000,
    deal_value_sar_high: 50000,
    profit_per_deal_sar: null,
    profit_per_deal_sar_high: null,
    close_rate_fraction: 0.2,
    close_rate_fraction_high: 0.3,
    aov_reported: null,
  });

  // The lowest buckets: 1,000 x 0.1 x 0.05 = 5 (CUT: 2,000 x 0.2 x 0.1 = 40).
  const low = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', 'lt2k'),
      close_rate: factData('close_rate', 'le1'),
      margin: factData('margin', 'lt20'),
    },
  });
  assert.equal(low.break_even_cpa, 5);
  assert.equal(low.break_even_cpa_cut, 40);
});

test('a services business that answered deal value and close rate but not the profit is asked for the profit', () => {
  const result = computeBreakEven({
    facts: {
      confirm: { choice: 'yes', kind: 'services' },
      deal_value: factData('deal_value', '2k_10k'),
      close_rate: factData('close_rate', 'ge4'),
    },
  });
  assert.equal(result.kind, 'services');
  assert.equal(result.break_even_cpa, null);
  assert.deepEqual(result.missing, ['profit_per_deal']);
  assert.equal(hasBreakEven(result), false);
});

test('clinic and local with nothing answered: the profit per customer and the close rate are reported missing, nothing is guessed', () => {
  for (const choice of ['clinic', 'local_store']) {
    const result = computeBreakEven({ facts: { type: { choice } } });
    assert.equal(result.break_even_cpa, null);
    assert.equal(result.break_even_roas, null);
    assert.deepEqual(result.missing, ['profit_per_deal', 'close_rate']);
  }
});

test('the reported average order is kept for information and never changes the break-even', () => {
  const withAov = computeBreakEven({
    facts: {
      type: { choice: 'ecommerce' },
      margin: factData('margin', 'gt40'),
      aov_check: factData('aov_check', 'same', { amount: 320, currency: 'SAR' }),
    },
  });
  assert.equal(withAov.inputs.aov_reported, 320);
  assert.equal(withAov.break_even_roas, 2.5);
  assert.equal(withAov.break_even_roas_cut, 1.25);
  assert.equal(withAov.break_even_cpa, null);
});

test('kind: the confirmed kind wins, then the type answer, the sector label, the answered questions, the goal', () => {
  const kind = (input: Parameters<typeof deriveEconomicsKind>[0]) => deriveEconomicsKind(input);
  assert.equal(kind({ facts: { confirm: { choice: 'yes', kind: 'clinic' }, type: { choice: 'ecommerce' } } }), 'clinic');
  // A «no» on the opener does not count as a confirmed kind.
  assert.equal(kind({ facts: { confirm: { choice: 'no', kind: 'clinic' }, type: { choice: 'ecommerce' } } }), 'ecommerce');
  assert.equal(kind({ facts: { type: { choice: 'local_store' } } }), 'local');
  assert.equal(kind({ facts: {}, sector: 'متجر إلكتروني' }), 'ecommerce');
  assert.equal(kind({ facts: {}, sector: 'عيادة أو مركز طبي' }), 'clinic');
  assert.equal(kind({ facts: {}, sector: 'شركة خدمات' }), 'services');
  assert.equal(kind({ facts: {}, sector: 'محل أو فرع' }), 'local');
  assert.equal(kind({ facts: { margin: factData('margin', 'lt20') }, sector: 'غير كذا' }), 'ecommerce');
  assert.equal(kind({ facts: { deal_value: factData('deal_value', 'lt2k') } }), 'services');
  assert.equal(kind({ facts: { profit_per_deal: factData('profit_per_deal', 'lt50') } }), 'services');
  assert.equal(kind({ facts: {}, primaryGoal: 'conversions' }), 'ecommerce');
  assert.equal(kind({ facts: {}, primaryGoal: 'leads' }), 'services');
  assert.equal(kind({ facts: {}, primaryGoal: 'traffic' }), 'general');
});

test('an unknown kind has no formula and says so', () => {
  const result = computeBreakEven({ facts: {}, sector: null, primaryGoal: null });
  assert.equal(result.kind, 'general');
  assert.deepEqual(result.missing, ['business_kind']);
  assert.equal(result.break_even_roas, null);
  assert.equal(result.break_even_cpa, null);
});

test('a CPA break-even is in riyals, so it is withheld from an account that spends another currency', () => {
  const economics = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', '10k_50k'),
      close_rate: factData('close_rate', '2_3'),
      margin: factData('margin', '20_40'),
    },
  });
  assert.equal(breakEvenForCurrency(economics, 'SAR').break_even_cpa, 400);
  assert.equal(breakEvenForCurrency(economics, null).break_even_cpa, 400);
  const usd = breakEvenForCurrency(economics, 'USD');
  assert.equal(usd.break_even_cpa, null);
  assert.equal(usd.break_even_cpa_cut, null, 'both ends of the range are withheld');
  assert.ok(usd.missing.includes('currency_sar_only'));

  // ROAS is a ratio: any currency keeps it.
  const store = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', '20_40') } });
  assert.equal(breakEvenForCurrency(store, 'AED').break_even_roas, 5);
});

test('allowable CPA: CUT is the high end (waste), SCALE the low end; only CUT may fall back to the account history', () => {
  const leads = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', '10k_50k'),
      close_rate: factData('close_rate', '2_3'),
      margin: factData('margin', '20_40'),
    },
  });
  assert.deepEqual(allowableCpaCut(leads, 90), { value: 6000, source: 'break_even_cpa' });
  assert.deepEqual(allowableCpaScale(leads), { value: 400, source: 'break_even_cpa' });

  const store = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', '20_40') } });
  assert.deepEqual(allowableCpaCut(store, 42.456), { value: 42.46, source: 'account_30d_cpa_fallback' });
  assert.equal(allowableCpaCut(store, null), null);
  assert.equal(allowableCpaCut(null, 0), null);
  // Scaling never rests on the account's own history.
  assert.equal(allowableCpaScale(store), null);
  assert.equal(allowableCpaScale(null), null);
});

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

function fakeAdmin(result: { data: any; error: any } | Error) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: any = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.then = (resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) =>
    result instanceof Error ? Promise.reject(result).then(resolve, reject) : Promise.resolve(result).then(resolve);
  return { admin: { from: (table: string) => (calls.push(['from', [table]]), builder) }, calls };
}

test('the loader reads the active onboarding facts and keeps the newest answer per key', async () => {
  const { admin, calls } = fakeAdmin({
    data: [
      { data: { setup_key: 'margin', choice: '20_40', min_per_100: 20, max_per_100: 40 }, created_at: '2026-10-14T10:00:00Z' },
      { data: { setup_key: 'margin', choice: 'lt20', min_per_100: 0, max_per_100: 20 }, created_at: '2026-10-01T10:00:00Z' },
      { data: { setup_key: 'type', choice: 'ecommerce' }, created_at: '2026-10-01T09:00:00Z' },
      { data: { setup_key: 'pain', choice: 'wasted_spend' }, created_at: '2026-10-01T08:00:00Z' },
    ],
    error: null,
  });
  const facts = await loadEconomicsFacts(admin, 'business-1');
  assert.equal(facts?.margin?.choice, '20_40');
  assert.equal(facts?.type?.choice, 'ecommerce');
  assert.equal((facts as any).pain, undefined);
  assert.deepEqual(calls[0], ['from', ['business_memory']]);
  assert.ok(calls.some(([m, a]) => m === 'eq' && a[0] === 'source' && a[1] === 'onboarding'));
  assert.ok(calls.some(([m, a]) => m === 'eq' && a[0] === 'status' && a[1] === 'active'));
  assert.ok(calls.some(([m, a]) => m === 'eq' && a[0] === 'business_id' && a[1] === 'business-1'));

  const economics = await loadEconomics(admin, { businessId: 'business-1', accountCurrency: 'SAR' });
  assert.equal(economics.break_even_roas, 5);
});

test('the loader never throws: a failed read is "nothing on record" and withholds, never invents', async () => {
  for (const result of [
    { data: null, error: { message: 'boom' } },
    new Error('network down'),
  ]) {
    const { admin } = fakeAdmin(result as any);
    const economics = await loadEconomics(admin, {
      businessId: 'business-1',
      sector: 'متجر إلكتروني',
      accountCurrency: 'SAR',
    });
    assert.equal(economics.break_even_roas, null);
    assert.equal(economics.break_even_cpa, null);
    assert.deepEqual(economics.missing, ['margin']);
  }
  const none = await loadEconomics(null, { businessId: null });
  assert.equal(none.kind, 'general');
});

test('the loader reads the profit per customer, so a clinic break-even CPA comes from profit x close rate', async () => {
  const { admin } = fakeAdmin({
    data: [
      { data: { setup_key: 'profit_per_deal', choice: '200_1k', min_sar: 200, max_sar: 1000 }, created_at: '2026-10-14T10:00:00Z' },
      { data: { setup_key: 'close_rate', choice: '2_3', min_of_10: 2, max_of_10: 3 }, created_at: '2026-10-14T09:00:00Z' },
      { data: { setup_key: 'type', choice: 'clinic' }, created_at: '2026-10-14T08:00:00Z' },
    ],
    error: null,
  });
  const facts = await loadEconomicsFacts(admin, 'business-1');
  assert.equal(facts?.profit_per_deal?.choice, '200_1k');

  const economics = await loadEconomics(admin, { businessId: 'business-1', accountCurrency: 'SAR' });
  assert.equal(economics.kind, 'clinic');
  assert.equal(economics.break_even_cpa, 40);
  assert.deepEqual(economics.missing, []);
});
