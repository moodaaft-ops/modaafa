import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILDER_MINIMUM_ROUND_BUDGET_MS,
  BUILDER_MINIMUM_RETRY_BUDGET_MS,
  hasBuilderRoundBudget,
  hasBuilderRetryBudget,
  isRetryableBuilderError,
  shouldRefundBuilderUsage,
} from '../lib/ai/builder-agent';

test('the campaign builder starts a round when the full time budget remains', () => {
  const now = 1_000_000;
  assert.equal(
    hasBuilderRoundBudget({
      deadlineAt: now + BUILDER_MINIMUM_ROUND_BUDGET_MS,
      now: () => now,
    }),
    true
  );
});

test('the campaign builder stops before a round that would overrun the request deadline', () => {
  const now = 1_000_000;
  assert.equal(
    hasBuilderRoundBudget({
      deadlineAt: now + BUILDER_MINIMUM_ROUND_BUDGET_MS - 1,
      now: () => now,
    }),
    false
  );
});

test('the campaign builder remains backwards compatible without a deadline', () => {
  assert.equal(hasBuilderRoundBudget(), true);
});

test('the campaign builder retries transient provider errors only while time remains', () => {
  const now = 1_000_000;
  assert.equal(isRetryableBuilderError({ status: 429 }), true);
  assert.equal(isRetryableBuilderError({ status: 529 }), true);
  assert.equal(isRetryableBuilderError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableBuilderError({ status: 400 }), false);
  assert.equal(
    hasBuilderRetryBudget({
      deadlineAt: now + BUILDER_MINIMUM_RETRY_BUDGET_MS - 1,
      now: () => now,
    }),
    false
  );
});

test('a placeholder builder result is not charged as a completed AI campaign', () => {
  assert.equal(
    shouldRefundBuilderUsage({
      draft_campaign: { needs_ai_enrichment: true },
      summary_ar: 'مسودة أولية',
      next_steps_ar: [],
      tool_trace: [],
    }),
    true
  );
  assert.equal(
    shouldRefundBuilderUsage({
      draft_campaign: { name: 'حملة مكتملة' },
      summary_ar: 'تم',
      next_steps_ar: [],
      tool_trace: [],
    }),
    false
  );
});

test('the builder route refunds a persisted placeholder before returning usage', () => {
  const route = readFileSync(resolve('app/api/chat/builder/route.ts'), 'utf8');
  const persistence = route.indexOf(".from('chat_messages').insert");
  const fallbackCheck = route.indexOf('shouldRefundBuilderUsage(result)');
  const response = route.indexOf('return NextResponse.json({', fallbackCheck);

  assert.ok(persistence >= 0);
  assert.ok(fallbackCheck > persistence);
  assert.ok(response > fallbackCheck);
  assert.match(route, /Math\.min\(usage\.limit, usage\.remaining \+ 1\)/);
});
