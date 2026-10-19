import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELIGIOUS_DATES,
  addDays,
  compareWindows,
  daysBetween,
  religiousDatesFromIcu,
  riyadhDay,
  seasonContext,
  seasonRejection,
  seasonsForYear,
  whiteFriday,
} from '../lib/loops/seasons';
import {
  anyOptimizerLoopEnabled,
  isBusinessMemoryEnabled,
  isMonthlyReviewEnabled,
  isNgramEnabled,
  isOutcomeMemoryEnabled,
  isSeasonsEnabled,
} from '../lib/loops/flags';

test('every loop flag is off unless it is exactly "true"', () => {
  const fns = [isNgramEnabled, isOutcomeMemoryEnabled, isSeasonsEnabled, isBusinessMemoryEnabled, isMonthlyReviewEnabled];
  for (const fn of fns) {
    assert.equal(fn({}), false);
    assert.equal(fn({ NGRAM_ENABLED: '1', OUTCOME_MEMORY_ENABLED: 'yes', SEASONS_ENABLED: 'on', BUSINESS_MEMORY_ENABLED: '1', MONTHLY_REVIEW_ENABLED: '' }), false);
  }
  assert.equal(isNgramEnabled({ NGRAM_ENABLED: 'true' }), true);
  assert.equal(isOutcomeMemoryEnabled({ OUTCOME_MEMORY_ENABLED: ' TRUE ' }), true);
  assert.equal(isSeasonsEnabled({ SEASONS_ENABLED: 'true' }), true);
  assert.equal(isBusinessMemoryEnabled({ BUSINESS_MEMORY_ENABLED: 'true' }), true);
  assert.equal(isMonthlyReviewEnabled({ MONTHLY_REVIEW_ENABLED: 'true' }), true);
  assert.equal(anyOptimizerLoopEnabled({}), false);
  assert.equal(anyOptimizerLoopEnabled({ SEASONS_ENABLED: 'true' }), true);
});

test('the date table for 2026 to 2028 matches the Umm al-Qura calendar of the runtime', () => {
  for (const year of [2026, 2027, 2028]) {
    const icu = religiousDatesFromIcu(year);
    if (!icu) continue; // a Node build without full ICU cannot cross-check
    assert.deepEqual(icu, RELIGIOUS_DATES[year], String(year));
  }
});

test('Ramadan, Eid al-Fitr and Eid al-Adha dates of 2026', () => {
  const byId = Object.fromEntries(seasonsForYear(2026).map((s) => [s.id, s]));
  assert.equal(byId.ramadan.start, '2026-02-18');
  assert.equal(byId.ramadan.end, '2026-03-19');
  assert.equal(byId.eid_al_fitr.end, '2026-03-23');
  assert.equal(byId.eid_al_adha.end, '2026-05-30');
});

test('fixed national dates and white Friday', () => {
  const byId = Object.fromEntries(seasonsForYear(2026).map((s) => [s.id, s]));
  assert.equal(byId.national_day.end, '2026-09-24');
  assert.ok(byId.national_day.start <= '2026-09-23' && '2026-09-23' <= byId.national_day.end);
  assert.ok(byId.founding_day.start <= '2026-02-22' && '2026-02-22' <= byId.founding_day.end);
  assert.equal(whiteFriday(2026), '2026-11-27');
  assert.equal(whiteFriday(2027), '2027-11-26');
  assert.equal(whiteFriday(2028), '2028-11-24');
  assert.equal(new Date(`${whiteFriday(2028)}T00:00:00Z`).getUTCDay(), 5);
  assert.ok(byId.back_to_school.approximate);
});

test('date helpers work on calendar days in Riyadh time', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  // 22:00 UTC is already the next day in Riyadh (UTC+3).
  assert.equal(riyadhDay(new Date('2026-10-18T22:00:00Z')), '2026-10-19');
});

test('a week inside a season is not judged against a normal week', () => {
  const inRamadan = seasonContext('2026-03-01');
  assert.equal(inRamadan.judgement_unreliable, true);
  assert.ok(inRamadan.active.some((s) => s.id === 'ramadan'));
  assert.ok(inRamadan.caution_ar);
  // A few days after a season is still bent by it.
  assert.equal(seasonContext('2026-03-27').judgement_unreliable, true);
  const plain = seasonContext('2026-07-15');
  assert.equal(plain.judgement_unreliable, false);
  assert.equal(plain.caution_ar, null);
  const cmp = compareWindows({ from: '2026-02-25', to: '2026-03-03' }, { from: '2026-02-04', to: '2026-02-10' });
  assert.equal(cmp.fair, false);
  assert.ok(cmp.reason_ar);
});

test('a season ahead gives a preparation hint only inside its prep window', () => {
  const early = seasonContext('2026-09-01', 120);
  assert.equal(early.upcoming.find((u) => u.id === 'white_friday')?.in_prep_window, false);
  const prep = seasonContext('2026-10-30', 60);
  const wf = prep.upcoming.find((u) => u.id === 'white_friday');
  assert.equal(wf?.in_prep_window, true);
  assert.ok(prep.prep_budget_hint_ar);
  assert.doesNotMatch(prep.prep_budget_hint_ar!, /[—–]/);
});

test('season rejection holds budget cuts and pauses, never raises or keyword work', () => {
  const ctx = { judgement_unreliable: true };
  assert.equal(seasonRejection({ type: 'pause_campaign' }, ctx), 'season_week');
  assert.equal(seasonRejection({ type: 'adjust_budget', params: { delta_pct: -20 } }, ctx), 'season_week');
  assert.equal(seasonRejection({ type: 'adjust_budget', params: { current_amount_micros: 100, new_amount_micros: 80 } }, ctx), 'season_week');
  assert.equal(seasonRejection({ type: 'adjust_budget', params: { delta_pct: 15 } }, ctx), null);
  assert.equal(seasonRejection({ type: 'add_negative_keyword' }, ctx), null);
  assert.equal(seasonRejection({ type: 'pause_campaign' }, { judgement_unreliable: false }), null);
  assert.equal(seasonRejection({ type: 'pause_campaign' }, null), null);
});
