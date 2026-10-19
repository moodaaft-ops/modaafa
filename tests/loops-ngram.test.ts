import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeNgrams, gramsOfTerm, type TermStat } from '../lib/loops/ngram';
import { ngramPromptBlock, fetchSearchTermStats } from '../lib/loops/ngram-source';

const term = (text: string, cost: number, clicks: number, conversions = 0, value = 0): TermStat => ({
  term: text,
  clicks,
  impressions: clicks * 10,
  cost,
  conversions,
  value,
});

test('Arabic spellings land in one gram: ة/ه, ى/ي, أ/ا and the ال prefix', () => {
  const keys = (text: string) => gramsOfTerm(text, 1).map((g) => g.key);
  assert.deepEqual(keys('الوظائف'), keys('وظائف'));
  assert.deepEqual(keys('مدرسة'), keys('مدرسه'));
  assert.deepEqual(keys('مستشفى'), keys('مستشفي'));
  assert.deepEqual(keys('أسعار'), keys('اسعار'));
});

test('a term gives 1, 2 and 3 word grams once each, and filler words alone give none', () => {
  const grams = gramsOfTerm('عيادة اسنان الرياض', 3).map((g) => g.n);
  assert.equal(grams.filter((n) => n === 1).length, 3);
  assert.equal(grams.filter((n) => n === 2).length, 2);
  assert.equal(grams.filter((n) => n === 3).length, 1);
  assert.deepEqual(gramsOfTerm('في من', 3), []);
  assert.deepEqual(gramsOfTerm('', 3), []);
});

const ALLOWABLE = { value: 50, source: 'break_even_cpa' };

test('a gram with no conversion and cost of at least 2 x the allowable CPA is flagged', () => {
  const terms = [
    term('وظائف مدرسه', 60, 8),
    term('وظائف نسائيه', 45, 6),
    term('الوظائف', 10, 2),
    term('مدرسه اهليه', 20, 4, 2, 400),
  ];
  const result = analyzeNgrams({ terms, allowableCpa: ALLOWABLE });
  assert.equal(result.waste_threshold, 100);
  const flagged = result.wasteful.map((g) => g.gram);
  assert.ok(flagged.includes('وظائف'), JSON.stringify(flagged));
  const gram = result.wasteful.find((g) => g.gram === 'وظائف')!;
  assert.equal(gram.cost, 115);
  assert.equal(gram.terms, 3);
  assert.equal(gram.conversions, 0);
  assert.equal(result.wasteful_terms_cost, 115);
});

test('below 2 x the allowable CPA, with a conversion, with one term only or with few clicks: not flagged', () => {
  const base = [term('وظائف مدرسه', 60, 8), term('وظائف نسائيه', 30, 6)];
  assert.equal(analyzeNgrams({ terms: base, allowableCpa: ALLOWABLE }).wasteful.length, 0); // 90 < 100
  const converting = [term('وظائف مدرسه', 80, 8, 1, 100), term('وظائف نسائيه', 80, 6)];
  assert.equal(analyzeNgrams({ terms: converting, allowableCpa: ALLOWABLE }).wasteful.some((g) => g.gram === 'وظائف'), false);
  const single = [term('وظائف فريده', 500, 40)];
  assert.equal(analyzeNgrams({ terms: single, allowableCpa: ALLOWABLE }).wasteful.length, 0);
  const fewClicks = [term('وظائف مدرسه', 80, 2), term('وظائف نسائيه', 80, 2)];
  assert.equal(analyzeNgrams({ terms: fewClicks, allowableCpa: ALLOWABLE }).wasteful.length, 0);
});

test('a fractional conversion is a signal, not waste', () => {
  const terms = [term('وظائف مدرسه', 80, 8, 0.4), term('وظائف نسائيه', 80, 6)];
  assert.equal(analyzeNgrams({ terms, allowableCpa: ALLOWABLE }).wasteful.some((g) => g.gram === 'وظائف'), false);
});

test('the words of the business itself are never flagged', () => {
  const terms = [term('الشايب للعطور', 150, 20), term('الشايب عطر', 150, 20)];
  const guarded = analyzeNgrams({ terms, allowableCpa: ALLOWABLE, protectedTexts: ['الشايب'] });
  assert.equal(guarded.wasteful.some((g) => g.gram.includes('الشايب')), false);
  const open = analyzeNgrams({ terms, allowableCpa: ALLOWABLE });
  assert.ok(open.wasteful.some((g) => g.gram.includes('الشايب')));
});

test('without an allowable CPA nothing is flagged and the note says why', () => {
  const result = analyzeNgrams({ terms: [term('وظائف مدرسه', 600, 80), term('وظائف نسائيه', 600, 60)], allowableCpa: null });
  assert.equal(result.note, 'no_allowable_cpa');
  assert.deepEqual(result.wasteful, []);
  assert.equal(result.waste_threshold, null);
  assert.equal(analyzeNgrams({ terms: [], allowableCpa: ALLOWABLE }).note, 'no_terms');
});

test('winners need two conversions and show cost per conversion and ROAS', () => {
  const terms = [term('عطر رجالي', 100, 20, 4, 800), term('عطر نسائي', 100, 20, 1, 100)];
  const result = analyzeNgrams({ terms, allowableCpa: ALLOWABLE });
  const winner = result.winners.find((g) => g.gram === 'عطر')!;
  assert.equal(winner.conversions, 5);
  assert.equal(winner.cpa, 40);
  assert.equal(winner.roas, 4.5);
});

test('the prompt block is compact and is null when there are no terms', () => {
  const terms = [term('وظائف مدرسه', 60, 8), term('وظائف نسائيه', 60, 6)];
  const block = ngramPromptBlock(analyzeNgrams({ terms, allowableCpa: ALLOWABLE }))!;
  assert.equal(block.wasteful[0].gram, 'وظائف');
  assert.equal(block.truncated, false);
  assert.equal(ngramPromptBlock(analyzeNgrams({ terms: [], allowableCpa: ALLOWABLE })), null);
});

test('fetchSearchTermStats maps rows and returns null when Google refuses', async () => {
  const rows = [
    { search_term_view: { search_term: ' وظائف ' }, metrics: { clicks: '5', impressions: '50', cost_micros: '12000000', conversions: 0, conversions_value: 0 } },
    { search_term_view: { search_term: '' }, metrics: { cost_micros: '1' } },
  ];
  const ok = await fetchSearchTermStats({ query: async () => rows });
  assert.equal(ok?.terms.length, 1);
  assert.equal(ok?.terms[0].cost, 12);
  assert.equal(ok?.terms[0].term, 'وظائف');
  const refused = await fetchSearchTermStats({ query: async () => { throw new Error('no'); } });
  assert.equal(refused, null);
});
