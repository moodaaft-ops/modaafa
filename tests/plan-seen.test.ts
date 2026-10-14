import assert from 'node:assert/strict';
import test from 'node:test';
import { planScreenShown } from '../lib/lifecycle/facts/plan-seen';

type State = Parameters<typeof planScreenShown>[0];

const plan = (kind: 'ready' | 'no_decisions' | 'no_audit') => ({ kind }) as unknown as State['plan'];
const base = (overrides: Partial<State> = {}): State => ({
  stage: 'done',
  subscriptionActive: false,
  plan: plan('ready'),
  ...overrides,
});

test('the plan card is on its way once the questions are done and there is something to show', () => {
  assert.equal(planScreenShown(base()), true);
  assert.equal(planScreenShown(base({ plan: plan('no_decisions') })), true); // an audit with nothing to decide still shows its summary
});

test('nothing was analysed, so nothing was viewed', () => {
  assert.equal(planScreenShown(base({ plan: plan('no_audit') })), false);
  assert.equal(planScreenShown(base({ plan: null })), false);
});

test('before the questions are done, and for someone who already has access, there is no plan card', () => {
  for (const stage of ['connect', 'connecting', 'choose', 'questions', 'finishing'] as const) {
    assert.equal(planScreenShown(base({ stage })), false, stage);
  }
  assert.equal(planScreenShown(base({ subscriptionActive: true })), false);
});

test('the adaptive first-campaign ending replaces the plan card, but only when it has a campaign to show', () => {
  const ending = (firstCampaign: unknown) =>
    ({ ending: 'first_campaign', firstCampaign }) as unknown as NonNullable<State['adaptive']>;
  assert.equal(planScreenShown(base({ adaptive: ending({ name: 'x' }) })), false);
  assert.equal(planScreenShown(base({ adaptive: ending(null) })), true);
  assert.equal(planScreenShown(base({ adaptive: null })), true);
});
