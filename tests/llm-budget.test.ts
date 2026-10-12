import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetCapsFor,
  evaluateBudget,
  llmBudgetState,
  utcDayStart,
  utcMonthStart,
} from '../lib/ai/usage';

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);

test('subscriber caps are 10% of the plan price in SAR converted at 3.75, day cap is month / 15', () => {
  const starter = budgetCapsFor({ plan: 'starter', subscriptionActive: true });
  assert.equal(starter.monthSar, 50);
  close(starter.monthUsd, 50 / 3.75);
  close(starter.dayUsd, 50 / 3.75 / 15);

  const growth = budgetCapsFor({ plan: 'growth', subscriptionActive: true });
  assert.equal(growth.monthSar, 120);
  close(growth.monthUsd, 32);
  close(growth.dayUsd, 32 / 15);

  const pro = budgetCapsFor({ plan: 'pro', subscriptionActive: true });
  assert.equal(pro.monthSar, 250);
  close(pro.monthUsd, 250 / 3.75);
  close(pro.dayUsd, 250 / 3.75 / 15);
});

test('an active subscription with an unknown plan uses the starter caps', () => {
  const starter = budgetCapsFor({ plan: 'starter', subscriptionActive: true });
  assert.deepEqual(budgetCapsFor({ plan: null, subscriptionActive: true }), starter);
  assert.deepEqual(budgetCapsFor({ subscriptionActive: true }), starter);
});

test('non-subscribers get 2 SAR a day and a month cap of 30 such days, whatever plan is passed', () => {
  const caps = budgetCapsFor({ plan: null, subscriptionActive: false });
  assert.equal(caps.daySar, 2);
  assert.equal(caps.monthSar, 60);
  close(caps.dayUsd, 2 / 3.75);
  close(caps.monthUsd, (2 / 3.75) * 30);
  assert.deepEqual(budgetCapsFor({ plan: 'pro', subscriptionActive: false }), caps);
});

const caps = { monthUsd: 10, dayUsd: 1 };

test('below 70% of both caps the level is ok', () => {
  const result = evaluateBudget({ monthSpentUsd: 6.99, daySpentUsd: 0.69, caps });
  assert.equal(result.level, 'ok');
  assert.equal(result.limitedBy, null);
  assert.equal(evaluateBudget({ monthSpentUsd: 0, daySpentUsd: 0, caps }).level, 'ok');
});

test('from 70% of either cap the level is degraded', () => {
  const month = evaluateBudget({ monthSpentUsd: 7, daySpentUsd: 0, caps });
  assert.equal(month.level, 'degraded');
  assert.equal(month.limitedBy, 'month');
  const day = evaluateBudget({ monthSpentUsd: 0, daySpentUsd: 0.7, caps });
  assert.equal(day.level, 'degraded');
  assert.equal(day.limitedBy, 'day');
  assert.equal(evaluateBudget({ monthSpentUsd: 9.99, daySpentUsd: 0.99, caps }).level, 'degraded');
});

test('at or above either cap the level is exhausted, and exhausted beats degraded', () => {
  assert.deepEqual(
    [
      evaluateBudget({ monthSpentUsd: 10, daySpentUsd: 0, caps }).level,
      evaluateBudget({ monthSpentUsd: 10, daySpentUsd: 0, caps }).limitedBy,
    ],
    ['exhausted', 'month']
  );
  assert.deepEqual(
    [
      evaluateBudget({ monthSpentUsd: 0, daySpentUsd: 1, caps }).level,
      evaluateBudget({ monthSpentUsd: 0, daySpentUsd: 1, caps }).limitedBy,
    ],
    ['exhausted', 'day']
  );
  // Day exhausted while the month is only degraded.
  const mixed = evaluateBudget({ monthSpentUsd: 8, daySpentUsd: 1.2, caps });
  assert.equal(mixed.level, 'exhausted');
  assert.equal(mixed.limitedBy, 'day');
  assert.equal(evaluateBudget({ monthSpentUsd: 25, daySpentUsd: 0, caps }).level, 'exhausted');
});

test('ratios are reported for the UI', () => {
  const result = evaluateBudget({ monthSpentUsd: 5, daySpentUsd: 0.25, caps });
  close(result.monthRatio, 0.5);
  close(result.dayRatio, 0.25);
});

test('month and day windows are UTC calendar boundaries', () => {
  const now = new Date('2026-10-12T23:59:59Z');
  assert.equal(utcMonthStart(now).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(utcDayStart(now).toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(utcMonthStart(new Date('2026-12-31T23:59:00Z')).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(utcDayStart(new Date('2027-01-01T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('llmBudgetState reads month and day spend with the right windows and evaluates them', async () => {
  const calls: Array<{ userId: string; since: string }> = [];
  const state = await llmBudgetState(
    { userId: 'u1', plan: 'starter', subscriptionActive: true, isOperator: false, now: new Date('2026-10-12T15:30:00Z') },
    {
      readSpendSince: async (userId, since) => {
        calls.push({ userId, since: since.toISOString() });
        return since.getUTCDate() === 1 ? 10 : 0.2;
      },
    }
  );
  assert.deepEqual(
    calls.map((call) => call.since).sort(),
    ['2026-10-01T00:00:00.000Z', '2026-10-12T00:00:00.000Z']
  );
  assert.ok(calls.every((call) => call.userId === 'u1'));
  assert.equal(state.monthSpentUsd, 10);
  assert.equal(state.daySpentUsd, 0.2);
  // 10 USD is 75% of the 13.33 USD starter month cap.
  assert.equal(state.level, 'degraded');
  assert.equal(state.unknown, false);
  assert.equal(state.operator, false);
  assert.equal(state.caps.monthSar, 50);
});

test('operators are always ok and their spend is never read', async () => {
  const state = await llmBudgetState(
    { userId: 'op', plan: 'pro', subscriptionActive: true, isOperator: true },
    {
      readSpendSince: async () => {
        throw new Error('operators must not be metered');
      },
    }
  );
  assert.equal(state.level, 'ok');
  assert.equal(state.operator, true);
  assert.equal(state.unknown, false);
});

test('a failed spend read fails open: level ok with unknown set', async () => {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const state = await llmBudgetState(
      { userId: 'u2', subscriptionActive: false, isOperator: false },
      {
        readSpendSince: async () => {
          throw new Error('postgres is down');
        },
      }
    );
    assert.equal(state.level, 'ok');
    assert.equal(state.unknown, true);
    assert.equal(logged.length, 1);
    assert.ok(!JSON.stringify(logged).includes('postgres is down'), 'the error message is not logged');
  } finally {
    console.error = original;
  }
});
