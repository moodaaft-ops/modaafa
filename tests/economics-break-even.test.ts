import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BREAK_EVEN_BASIS,
  allowableCpa,
  breakEvenForCurrency,
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

test('the bucket edge is the one worse for the client: the lower edge, or half the upper when it starts at 0', () => {
  assert.equal(conservativeEdge(0, 20), 10);
  assert.equal(conservativeEdge(20, 40), 20);
  assert.equal(conservativeEdge(40, null), 40);
  assert.equal(conservativeEdge(0, 1), 0.5);
  assert.equal(conservativeEdge(4, 10), 4);
  assert.equal(conservativeEdge(null, null), null);
  assert.equal(conservativeEdge(undefined, undefined), null);
  assert.equal(conservativeEdge(0, 0), null);
});

test('e-commerce: break-even ROAS is 1 over the margin, and a lower margin means a higher break-even', () => {
  const expected: Record<string, number> = { lt20: 10, '20_40': 5, gt40: 2.5 };
  for (const [choice, roas] of Object.entries(expected)) {
    const result = computeBreakEven({
      facts: { type: { choice: 'ecommerce' }, margin: factData('margin', choice) },
    });
    assert.equal(result.kind, 'ecommerce');
    assert.equal(result.break_even_roas, roas, choice);
    assert.equal(result.break_even_cpa, null);
    assert.deepEqual(result.missing, []);
    assert.equal(result.basis, BREAK_EVEN_BASIS);
  }
});

test('"I do not know" and "never asked" are the same: null, with the answer named in missing', () => {
  const unknown = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', 'unknown') } });
  assert.equal(unknown.break_even_roas, null);
  assert.deepEqual(unknown.missing, ['margin']);
  assert.equal(hasBreakEven(unknown), false);

  const neverAsked = computeBreakEven({ facts: { type: { choice: 'ecommerce' } } });
  assert.equal(neverAsked.break_even_roas, null);
  assert.deepEqual(neverAsked.missing, ['margin']);
});

test('leads: break-even CPA is profit per customer x close rate, from the conservative edges', () => {
  // profit 200_1k -> 200 SAR, close 2_3 -> 2 of 10: 200 x 0.2 = 40.
  const facts: EconomicsFacts = {
    type: { choice: 'services' },
    profit_per_deal: factData('profit_per_deal', '200_1k'),
    close_rate: factData('close_rate', '2_3'),
  };
  const result = computeBreakEven({ facts });
  assert.equal(result.kind, 'services');
  assert.equal(result.break_even_cpa, 40);
  assert.equal(result.break_even_roas, null);
  assert.deepEqual(result.missing, []);
  assert.equal(result.inputs.profit_per_deal_sar, 200);
  assert.equal(result.inputs.close_rate_fraction, 0.2);
  assert.equal(result.inputs.margin_fraction, null);
  assert.equal(result.inputs.deal_value_sar, null);

  // Every bucket takes its worse edge: the lower edge, or half of the upper one when the bucket starts at 0.
  const profit: Record<string, number> = { lt50: 25, '50_200': 50, '200_1k': 200, '1k_5k': 1000, gt5k: 5000 };
  const close: Record<string, number> = { le1: 0.05, '2_3': 0.2, ge4: 0.4 };
  for (const [profitChoice, profitSar] of Object.entries(profit)) {
    for (const [closeChoice, fraction] of Object.entries(close)) {
      const bucketed = computeBreakEven({
        facts: {
          type: { choice: 'clinic' },
          profit_per_deal: factData('profit_per_deal', profitChoice),
          close_rate: factData('close_rate', closeChoice),
        },
      });
      assert.equal(bucketed.break_even_cpa, Math.round(profitSar * fraction * 100) / 100, `${profitChoice}/${closeChoice}`);
    }
  }
});

test('leads: a bigger profit bucket never gives a smaller break-even CPA, and a smaller one never a bigger one', () => {
  const order = ['lt50', '50_200', '200_1k', '1k_5k', 'gt5k'];
  const cpas = order.map(
    (choice) =>
      computeBreakEven({
        facts: { type: { choice: 'local_store' }, profit_per_deal: factData('profit_per_deal', choice), close_rate: factData('close_rate', '2_3') },
      }).break_even_cpa as number
  );
  for (let index = 1; index < cpas.length; index += 1) assert.ok(cpas[index] > cpas[index - 1], order[index]);
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
  // 50 x 0.2 = 10, not 10,000 x 0.2 x 0.2 = 400.
  assert.equal(result.break_even_cpa, 10);
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

  const nothing = computeBreakEven({
    facts: {
      type: { choice: 'clinic' },
      profit_per_deal: factData('profit_per_deal', 'unknown'),
      close_rate: factData('close_rate', '2_3'),
    },
  });
  assert.equal(nothing.break_even_cpa, null);
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
  assert.equal(result.break_even_roas, null);
  assert.deepEqual(result.inputs, {
    margin_fraction: 0.2,
    deal_value_sar: 10000,
    profit_per_deal_sar: null,
    close_rate_fraction: 0.2,
    aov_reported: null,
  });

  // The lowest buckets: 1,000 x 0.1 x 0.05 = 5.
  const low = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', 'lt2k'),
      close_rate: factData('close_rate', 'le1'),
      margin: factData('margin', 'lt20'),
    },
  });
  assert.equal(low.break_even_cpa, 5);
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
  assert.ok(usd.missing.includes('currency_sar_only'));

  // ROAS is a ratio: any currency keeps it.
  const store = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', '20_40') } });
  assert.equal(breakEvenForCurrency(store, 'AED').break_even_roas, 5);
});

test('allowable CPA: the client break-even when known, otherwise the account 30-day CPA labeled as a fallback', () => {
  const leads = computeBreakEven({
    facts: {
      type: { choice: 'services' },
      deal_value: factData('deal_value', '10k_50k'),
      close_rate: factData('close_rate', '2_3'),
      margin: factData('margin', '20_40'),
    },
  });
  assert.deepEqual(allowableCpa(leads, 90), { value: 400, source: 'break_even_cpa' });

  const store = computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: factData('margin', '20_40') } });
  assert.deepEqual(allowableCpa(store, 42.456), { value: 42.46, source: 'account_30d_cpa_fallback' });
  assert.equal(allowableCpa(store, null), null);
  assert.equal(allowableCpa(null, 0), null);
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
