import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_RATES, PRICING_VERSION, costUsd, priceFor } from '../lib/ai/pricing';

test('pricing version is dated', () => {
  assert.equal(PRICING_VERSION, '2026-10-12');
});

// Haiku 5.5 has a long-prompt tier, so a million-token prompt is not its base rate; it is covered below.
test('every flat-priced model prices one million tokens of each kind at its listed rate', () => {
  const rows: Array<[string, number, number, number, number]> = [
    ['claude-opus-5-5', 4, 20, 0.2, 5],
    ['claude-sonnet-5-5', 2, 10, 0.1, 2.5],
    ['claude-opus-5', 5, 25, 0.5, 6.25],
    ['claude-sonnet-5', 2, 10, 0.2, 2.5],
    ['claude-haiku-4-5', 1, 5, 0.1, 1.25],
    ['claude-opus-4-1', 15, 75, 1.5, 18.75],
    ['claude-sonnet-4-6', 3, 15, 0.3, 3.75],
    ['claude-sonnet-4-5', 3, 15, 0.3, 3.75],
    ['claude-sonnet-4', 3, 15, 0.3, 3.75],
  ];
  for (const [model, input, output, cacheRead, cacheWrite] of rows) {
    const million = 1_000_000;
    assert.deepEqual(costUsd(model, { input_tokens: million, output_tokens: 0 }), { costUsd: input, priced: true }, `${model} input`);
    assert.deepEqual(costUsd(model, { input_tokens: 0, output_tokens: million }), { costUsd: output, priced: true }, `${model} output`);
    assert.deepEqual(costUsd(model, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: million }), { costUsd: cacheRead, priced: true }, `${model} cache read`);
    assert.deepEqual(costUsd(model, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: million }), { costUsd: cacheWrite, priced: true }, `${model} cache write`);
  }
});

test('the spec example: a Sonnet 5.5 turn with tools costs about 0.045 dollars', () => {
  // 16,950 uncached input, 21,000 cache read, 900 output (jarvis spec 8.3).
  const result = costUsd('claude-sonnet-5-5', {
    input_tokens: 16_950,
    output_tokens: 900,
    cache_read_input_tokens: 21_000,
  });
  assert.deepEqual(result, { costUsd: 0.045, priced: true });
});

test('all four token kinds are summed and rounded to 6 decimals', () => {
  const result = costUsd('claude-opus-5-5', {
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 5_000,
  });
  // 40,000 + 40,000 + 4,000 + 25,000 micro-dollars.
  assert.equal(result.costUsd, 0.109);
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: 1, output_tokens: 0 }).costUsd, 0.000004);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1, output_tokens: 0 }).costUsd, 0);
});

test('missing, null, negative and non-numeric usage fields count as zero', () => {
  assert.deepEqual(costUsd('claude-opus-5-5', undefined), { costUsd: 0, priced: true });
  assert.deepEqual(costUsd('claude-opus-5-5', { input_tokens: null, output_tokens: -5, cache_read_input_tokens: Number.NaN }), {
    costUsd: 0,
    priced: true,
  });
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000 }).costUsd, 2);
});

test('longest prefix wins and date suffixes are accepted', () => {
  assert.equal(priceFor('claude-opus-5-5').matched, 'claude-opus-5-5');
  assert.equal(priceFor('claude-opus-5-5-20261012').matched, 'claude-opus-5-5');
  assert.equal(priceFor('claude-opus-5').matched, 'claude-opus-5');
  assert.equal(priceFor('claude-opus-5-20260715').matched, 'claude-opus-5');
  assert.equal(priceFor('claude-haiku-4-5-20251001').matched, 'claude-haiku-4-5');
  assert.equal(priceFor('claude-haiku-4-5-20251001').input, 1);
  assert.equal(priceFor('claude-sonnet-4-6-20260217').matched, 'claude-sonnet-4-6');
  assert.equal(priceFor('claude-sonnet-4-20250514').matched, 'claude-sonnet-4');
  assert.equal(priceFor('claude-opus-4-1-20250805').input, 15);
  assert.equal(priceFor('  CLAUDE-SONNET-5-5  ').matched, 'claude-sonnet-5-5');
});

test('a newer version that is not in the table is not silently priced as an older one', () => {
  for (const model of ['claude-opus-5-6', 'claude-sonnet-5-7-20270101', 'claude-haiku-5']) {
    const price = priceFor(model);
    assert.equal(price.priced, false, model);
    assert.equal(price.matched, null, model);
  }
});

test('Haiku 5.5 switches to the long-prompt rate above 100,000 prompt tokens', () => {
  const low = priceFor('claude-haiku-5-5', 100_000);
  assert.deepEqual([low.input, low.output, low.cacheRead, low.cacheWrite], [0.1, 0.5, 0.01, 0.125]);
  const high = priceFor('claude-haiku-5-5', 100_001);
  assert.deepEqual([high.input, high.output, high.cacheRead, high.cacheWrite], [0.5, 2.5, 0.05, 0.625]);

  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 100_000 }).costUsd, 0.01);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 150_000 }).costUsd, 0.075);
  // Low tier: each kind at 100,000 tokens (the prompt stays at the limit).
  assert.equal(costUsd('claude-haiku-5-5', { output_tokens: 100_000 }).costUsd, 0.05);
  assert.equal(costUsd('claude-haiku-5-5', { cache_read_input_tokens: 100_000 }).costUsd, 0.001);
  assert.equal(costUsd('claude-haiku-5-5', { cache_creation_input_tokens: 100_000 }).costUsd, 0.0125);
});

test('prompt size for the Haiku 5.5 tier is input + cache read + cache write, not output', () => {
  // Exactly 100,000 prompt tokens in three kinds: still the low tier.
  const atLimit = costUsd('claude-haiku-5-5', {
    input_tokens: 60_000,
    output_tokens: 0,
    cache_read_input_tokens: 30_000,
    cache_creation_input_tokens: 10_000,
  });
  // 6,000 + 300 + 1,250 micro-dollars.
  assert.equal(atLimit.costUsd, 0.00755);

  // One more cached token crosses into the long-prompt tier for the WHOLE request.
  const over = costUsd('claude-haiku-5-5', {
    input_tokens: 60_000,
    output_tokens: 0,
    cache_read_input_tokens: 30_000,
    cache_creation_input_tokens: 10_001,
  });
  // 30,000 + 1,500 + 6,250.625 micro-dollars, rounded once.
  assert.equal(over.costUsd, 0.037751);

  // A huge output alone does not move the prompt into the long tier.
  const bigOutput = costUsd('claude-haiku-5-5', { input_tokens: 1_000, output_tokens: 500_000 });
  assert.equal(bigOutput.costUsd, 0.2501);
});

test('unknown models are priced conservatively at the Opus 4.1 rate and flagged', () => {
  const price = priceFor('some-future-model');
  assert.equal(price.priced, false);
  assert.equal(price.matched, null);
  assert.deepEqual(
    [price.input, price.output, price.cacheRead, price.cacheWrite],
    [FALLBACK_RATES.input, FALLBACK_RATES.output, FALLBACK_RATES.cacheRead, FALLBACK_RATES.cacheWrite]
  );
  const opus41 = priceFor('claude-opus-4-1');
  assert.deepEqual(
    { input: opus41.input, output: opus41.output, cacheRead: opus41.cacheRead, cacheWrite: opus41.cacheWrite },
    FALLBACK_RATES
  );

  assert.deepEqual(costUsd('some-future-model', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), {
    costUsd: 90,
    priced: false,
  });
  assert.equal(costUsd(null, { input_tokens: 1_000_000 }).priced, false);
  assert.equal(costUsd('', { input_tokens: 1_000_000 }).costUsd, 15);
});
