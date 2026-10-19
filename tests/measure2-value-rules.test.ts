import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutableAction } from '../lib/ai/executable-action';
import { prepareExtendedAction } from '../lib/ai/extended-actions/preflight';
import { buildMutateOperations, buildRollbackOperations, finalizeExtendedRollback } from '../lib/ai/extended-actions/execute';
import { readbackExtendedAction } from '../lib/ai/extended-actions/readback';
import { extendedPreviewRows } from '../lib/ai/extended-actions/preview';
import { validateExtendedPayload } from '../lib/ai/extended-actions/validate';
import { isExtendedOperation } from '../lib/ai/extended-actions/types';
import { EXTENDED_OPERATION_LABELS_AR } from '../lib/ai/operation-labels';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import type { OptimizerAction } from '../lib/ai/optimizer-agent';
import { findSetFor, parseRule, parseSet, readValueRuleSets } from '../lib/value-rules/reader';
import { cleanMultiplier } from '../lib/value-rules/validate';
import { getValueRulesTool } from '../lib/jarvis/tools/get-value-rules';

const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/555`;
const RULE = `customers/${CID}/conversionValueRules/9`;
const SET = `customers/${CID}/conversionValueRuleSets/4`;
const LIST = `customers/${CID}/userLists/77`;
const deps = {
  async filterNegativeKeywordBatch() { return { keep: [], dropped: [] }; },
  async readSevenDayMetrics() { return null; },
  normalizeKeywordText: (v: string) => v,
};

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.EXTENDED_ACTIONS_ENABLED;
  if (value === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
  else process.env.EXTENDED_ACTIONS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
    else process.env.EXTENDED_ACTIONS_ENABLED = old;
  }
}

type Opts = { bidding?: string; rules?: any[]; sets?: any[]; userLists?: string[]; enabledCampaigns?: any[] };
function fakeCustomer(options: Opts = {}) {
  const mutations: any[] = [];
  return {
    mutations,
    credentials: { customer_id: CID },
    async query(gaql: string) {
      if (/FROM conversion_value_rule_set/.test(gaql)) return options.sets ?? [];
      if (/FROM conversion_value_rule\b/.test(gaql)) {
        const m = /resource_name = '([^']+)'/.exec(gaql);
        const rules = options.rules ?? [];
        return m ? rules.filter((r) => r.conversionValueRule.resourceName === m[1]) : rules;
      }
      if (/FROM user_list/.test(gaql)) return (options.userLists ?? []).map((name) => ({ userList: { resourceName: name } }));
      if (/FROM campaign\s+WHERE campaign\.resource_name/.test(gaql)) {
        return [{ campaign: { status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: options.bidding ?? 'TARGET_ROAS' } }];
      }
      if (/FROM campaign\s+WHERE campaign\.status = 'ENABLED'/.test(gaql)) {
        return options.enabledCampaigns ?? [{ campaign: { biddingStrategyType: options.bidding ?? 'TARGET_ROAS' } }];
      }
      return [];
    },
    async mutateOperations(ops: any[], opts?: any) {
      mutations.push({ ops, opts });
      return { results: ops.map((_, i) => ({ resourceName: `customers/${CID}/${i < ops.length - 1 ? 'conversionValueRules' : 'conversionValueRuleSets'}/${100 + i}` })) };
    },
  } as any;
}

const act = (type: string, params: Record<string, unknown>, target = ''): OptimizerAction =>
  ({ type, target_id: target, params, reason_ar: 'x', reason_en: 'x' }) as OptimizerAction;

const ruleRow = (over: Record<string, unknown> = {}) => ({
  conversionValueRule: {
    resourceName: RULE,
    status: 'ENABLED',
    action: { operation: 'MULTIPLY', value: 1.3 },
    deviceCondition: { deviceTypes: ['DESKTOP'] },
    ...over,
  },
});
const setRow = (over: Record<string, unknown> = {}) => ({
  conversionValueRuleSet: {
    resourceName: SET,
    attachmentType: 'CUSTOMER',
    dimensions: ['DEVICE'],
    conversionValueRules: [RULE],
    status: 'ENABLED',
    ...over,
  },
});

const createParams = {
  attachment: 'customer',
  dimension: 'DEVICE',
  rules: [{ label: 'الكمبيوتر', multiplier: 1.3, device_types: ['DESKTOP'] }, { multiplier: 0.8, device_types: ['MOBILE'] }],
};

test('the two value rule operations are extended operations, labelled in Arabic, and need the extended flag', () => {
  for (const op of ['create_value_rule_set', 'update_value_rule']) {
    assert.equal(isExtendedOperation(op), true);
    assert.ok(EXTENDED_OPERATION_LABELS_AR[op]);
    assert.ok(!/[—–]/.test(EXTENDED_OPERATION_LABELS_AR[op]));
  }
  const rec = { title: 't', description: 'd' };
  const payload = { operation: 'create_value_rule_set', target_id: '', params: createParams };
  assert.equal(withFlag(undefined, () => buildExecutableAction(payload, rec, CID)), null);
  assert.equal(withFlag('true', () => buildExecutableAction(payload, rec, CID))?.type, 'create_value_rule_set');
});

test('multiplier: 0.5 to 2, never 1, two decimals', () => {
  assert.equal(cleanMultiplier(1.3), 1.3);
  assert.equal(cleanMultiplier('0.5'), 0.5);
  assert.equal(cleanMultiplier(2), 2);
  assert.equal(cleanMultiplier(1), null);
  assert.equal(cleanMultiplier(0.4), null);
  assert.equal(cleanMultiplier(2.5), null);
  assert.equal(cleanMultiplier(''), null);
  assert.equal(cleanMultiplier(1.2345), 1.23);
});

test('create validation: dimension, scope, overlap and resource ownership', () => {
  const v = (params: Record<string, unknown>) => {
    const r = validateExtendedPayload('create_value_rule_set' as any, '', params, CID);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(v(createParams), 'ok');
  assert.equal(v({ ...createParams, attachment: 'campaign' }), 'campaign_invalid');
  assert.equal(v({ ...createParams, attachment: 'campaign', campaign_resource: CAMPAIGN }), 'ok');
  assert.equal(v({ ...createParams, attachment: 'campaign', campaign_resource: 'customers/999/campaigns/1' }), 'campaign_invalid');
  assert.equal(v({ ...createParams, campaign_resource: CAMPAIGN }), 'campaign_not_allowed');
  assert.equal(v({ ...createParams, dimension: 'ITINERARY' }), 'dimension_invalid');
  assert.equal(v({ ...createParams, rules: [] }), 'rules_invalid');
  assert.equal(v({ ...createParams, rules: Array.from({ length: 6 }, () => createParams.rules[0]) }), 'rules_invalid');
  assert.equal(v({ ...createParams, rules: [{ multiplier: 1, device_types: ['DESKTOP'] }] }), 'rule_invalid');
  assert.equal(v({ ...createParams, rules: [{ multiplier: 1.2, device_types: ['TV'] }] }), 'rule_invalid');
  assert.equal(v({ ...createParams, rules: [{ multiplier: 1.2, device_types: ['DESKTOP'] }, { multiplier: 0.9, device_types: ['DESKTOP', 'MOBILE'] }] }), 'rules_overlap');
  // geo
  const geo = { attachment: 'customer', dimension: 'GEO_LOCATION', rules: [{ multiplier: 1.4, geo_target_constants: ['geoTargetConstants/1012045'] }] };
  assert.equal(v(geo), 'ok');
  assert.equal(v({ ...geo, rules: [{ multiplier: 1.4, geo_target_constants: ['Riyadh'] }] }), 'rule_invalid');
  assert.equal(v({ ...geo, rules: [{ multiplier: 1.4, geo_target_constants: ['geoTargetConstants/1'], geo_match_type: 'EVERYWHERE' }] }), 'rule_invalid');
  // audience: lists must live under the account
  const aud = { attachment: 'customer', dimension: 'AUDIENCE', rules: [{ multiplier: 1.5, user_lists: [LIST] }] };
  assert.equal(v(aud), 'ok');
  assert.equal(v({ ...aud, rules: [{ multiplier: 1.5, user_lists: ['customers/999/userLists/1'] }] }), 'rule_invalid');
  // a rule of the wrong kind for the dimension
  assert.equal(v({ ...aud, dimension: 'DEVICE' }), 'rule_invalid');
});

test('update validation: a rule of this account and at least one change', () => {
  const v = (params: Record<string, unknown>, target = '') => {
    const r = validateExtendedPayload('update_value_rule' as any, target, params, CID);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(v({ rule_resource: RULE, multiplier: 1.1 }), 'ok');
  assert.equal(v({ rule_resource: RULE, status: 'PAUSED' }), 'ok');
  assert.equal(v({}, RULE), 'update_empty');
  assert.equal(v({ rule_resource: 'customers/999/conversionValueRules/1', multiplier: 1.1 }), 'rule_invalid');
  assert.equal(v({ rule_resource: RULE, multiplier: 3 }), 'multiplier_invalid');
  assert.equal(v({ rule_resource: RULE, status: 'REMOVED' }), 'status_invalid');
});

test('reader parses rules and sets in camelCase and snake_case and finds the set of a slot', async () => {
  const rule = parseRule(ruleRow())!;
  assert.equal(rule.condition, 'device');
  assert.deepEqual(rule.device_types, ['DESKTOP']);
  const snake = parseRule({ conversion_value_rule: { resource_name: RULE, status: 'PAUSED', action: { operation: 'ADD', value: '5' }, geo_location_condition: { geo_target_constants: ['geoTargetConstants/1'] } } })!;
  assert.equal(snake.condition, 'geo');
  assert.equal(snake.value, 5);
  assert.equal(parseRule({}), null);
  assert.equal(parseSet(setRow())!.dimensions[0], 'DEVICE');
  const sets = await readValueRuleSets(fakeCustomer({ rules: [ruleRow()], sets: [setRow()] }));
  assert.equal(sets[0].rules.length, 1);
  assert.ok(findSetFor(sets, { attachment: 'customer', dimension: 'DEVICE' }));
  assert.equal(findSetFor(sets, { attachment: 'customer', dimension: 'GEO_LOCATION' }), null);
  assert.equal(findSetFor(sets, { attachment: 'campaign', campaign_resource: CAMPAIGN, dimension: 'DEVICE' }), null);
});

test('create preflight refuses a scope that already has a set and an account that does not bid on value', async () => {
  const valid = validateExtendedPayload('create_value_rule_set' as any, '', createParams, CID);
  assert.ok(valid.ok);
  if (!valid.ok) return;
  const action = act('create_value_rule_set', valid.params);
  await assert.rejects(
    prepareExtendedAction(action, fakeCustomer({ rules: [ruleRow()], sets: [setRow()] }), deps),
    /rule_set_exists/
  );
  await assert.rejects(
    prepareExtendedAction(action, fakeCustomer({ enabledCampaigns: [{ campaign: { biddingStrategyType: 'MAXIMIZE_CONVERSIONS' } }] }), deps),
    /no_value_bidding/
  );
  const camp = validateExtendedPayload('create_value_rule_set' as any, '', { ...createParams, attachment: 'campaign', campaign_resource: CAMPAIGN }, CID);
  assert.ok(camp.ok);
  if (!camp.ok) return;
  await assert.rejects(prepareExtendedAction(act('create_value_rule_set', camp.params, CAMPAIGN), fakeCustomer({ bidding: 'MANUAL_CPC' }), deps), /no_value_bidding/);
});

test('create: rules first, then the set, in one request; rollback pauses the created rules and stays inside the account', async () => {
  const valid = validateExtendedPayload('create_value_rule_set' as any, '', createParams, CID);
  assert.ok(valid.ok);
  if (!valid.ok) return;
  const customer = fakeCustomer();
  const prepared = await prepareExtendedAction(act('create_value_rule_set', valid.params), customer, deps);
  const ops = buildMutateOperations(prepared.action, customer) as any[];
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0].conversion_value_rule_operation.create.action, { operation: 'MULTIPLY', value: 1.3 });
  assert.deepEqual(ops[0].conversion_value_rule_operation.create.device_condition, { device_types: ['DESKTOP'] });
  assert.equal(ops[0].conversion_value_rule_operation.create.status, 'ENABLED');
  const setCreate = ops[2].conversion_value_rule_set_operation.create;
  assert.deepEqual(setCreate.conversion_value_rules, [ops[0].conversion_value_rule_operation.create.resource_name, ops[1].conversion_value_rule_operation.create.resource_name]);
  assert.deepEqual(setCreate.dimensions, ['DEVICE']);
  assert.equal(setCreate.attachment_type, 'CUSTOMER');
  assert.equal('campaign' in setCreate, false);

  const result = await customer.mutateOperations(ops);
  const finalized = finalizeExtendedRollback(prepared.rollbackPayload, result) as any;
  assert.equal(finalized.reversible, true);
  assert.equal(finalized.pause_rules.length, 2);
  const back = buildRollbackOperations(finalized) as any[];
  assert.deepEqual(back.map((o) => o.conversion_value_rule_operation.update.status), ['PAUSED', 'PAUSED']);
  assert.equal(rollbackResourcesScoped(finalized, CID), true);
  assert.equal(rollbackResourcesScoped({ ...finalized, pause_rules: ['customers/999/conversionValueRules/1'] }, CID), false);
  // a name that was not part of the original change is refused
  assert.throws(() => buildRollbackOperations({ ...finalized, pause_rules: [`customers/${CID}/conversionValueRules/555`] }), /not part of the original change/);
  // results that cannot be mapped make the change non-reversible instead of guessing
  const lost = finalizeExtendedRollback(prepared.rollbackPayload, { results: [] }) as any;
  assert.equal(lost.reversible, false);
});

test('campaign-level set carries the campaign', async () => {
  const camp = validateExtendedPayload('create_value_rule_set' as any, '', { ...createParams, attachment: 'campaign', campaign_resource: CAMPAIGN }, CID);
  assert.ok(camp.ok);
  if (!camp.ok) return;
  const customer = fakeCustomer();
  const prepared = await prepareExtendedAction(act('create_value_rule_set', camp.params, CAMPAIGN), customer, deps);
  const ops = buildMutateOperations(prepared.action, customer) as any[];
  const set = ops[ops.length - 1].conversion_value_rule_set_operation.create;
  assert.equal(set.attachment_type, 'CAMPAIGN');
  assert.equal(set.campaign, CAMPAIGN);
  assert.deepEqual((prepared.rollbackPayload as any).touched_resources, [CAMPAIGN]);
});

test('audience rules need audiences that exist in the account', async () => {
  const aud = validateExtendedPayload('create_value_rule_set' as any, '', { attachment: 'customer', dimension: 'AUDIENCE', rules: [{ multiplier: 1.4, user_lists: [LIST] }] }, CID);
  assert.ok(aud.ok);
  if (!aud.ok) return;
  await assert.rejects(prepareExtendedAction(act('create_value_rule_set', aud.params), fakeCustomer({ userLists: [] }), deps), /user_list_not_found/);
  const prepared = await prepareExtendedAction(act('create_value_rule_set', aud.params), fakeCustomer({ userLists: [LIST] }), deps);
  const [first] = buildMutateOperations(prepared.action, fakeCustomer()) as any[];
  assert.deepEqual(first.conversion_value_rule_operation.create.audience_condition, { user_lists: [LIST] });
});

test('update: reads the rule, builds a masked update, and rolls back to the previous multiplier and status', async () => {
  const customer = fakeCustomer({ rules: [ruleRow()], sets: [setRow()] });
  const valid = validateExtendedPayload('update_value_rule' as any, RULE, { rule_resource: RULE, multiplier: 1.1, status: 'PAUSED' }, CID);
  assert.ok(valid.ok);
  if (!valid.ok) return;
  const prepared = await prepareExtendedAction(act('update_value_rule', valid.params, RULE), customer, deps);
  const [op] = buildMutateOperations(prepared.action, customer) as any[];
  assert.deepEqual(op.conversion_value_rule_operation.update.action, { operation: 'MULTIPLY', value: 1.1 });
  assert.equal(op.conversion_value_rule_operation.update.status, 'PAUSED');
  const mask = op.conversion_value_rule_operation.update_mask;
  assert.match(String(mask), /action\.value/);
  assert.match(String(mask), /status/);
  const [back] = buildRollbackOperations(prepared.rollbackPayload) as any[];
  assert.equal(back.conversion_value_rule_operation.update.action.value, 1.3);
  assert.equal(back.conversion_value_rule_operation.update.status, 'ENABLED');
  assert.equal(rollbackResourcesScoped(prepared.rollbackPayload, CID), true);
});

test('update refuses: a rule that is not MULTIPLY, no change, a rule outside any set, a missing rule', async () => {
  const run = (rules: any[], sets: any[], params: Record<string, unknown>) => {
    const valid = validateExtendedPayload('update_value_rule' as any, RULE, { rule_resource: RULE, ...params }, CID);
    assert.ok(valid.ok);
    return prepareExtendedAction(act('update_value_rule', (valid as any).params, RULE), fakeCustomer({ rules, sets }), deps);
  };
  await assert.rejects(run([ruleRow({ action: { operation: 'ADD', value: 5 } })], [setRow()], { multiplier: 1.2 }), /rule_not_multiply/);
  await assert.rejects(run([ruleRow()], [setRow()], { multiplier: 1.3 }), /no_change/);
  await assert.rejects(run([ruleRow()], [], { multiplier: 1.2 }), /rule_not_in_set/);
  await assert.rejects(run([], [setRow()], { multiplier: 1.2 }), /rule_not_found/);
});

test('readback verifies a created set and a rule update, and reports a mismatch', async () => {
  const valid = validateExtendedPayload('create_value_rule_set' as any, '', createParams, CID);
  assert.ok(valid.ok);
  if (!valid.ok) return;
  const prepared = await prepareExtendedAction(act('create_value_rule_set', valid.params), fakeCustomer(), deps);
  const twoRules = [ruleRow(), ruleRow({ resourceName: `customers/${CID}/conversionValueRules/10`, action: { operation: 'MULTIPLY', value: 0.8 }, deviceCondition: { deviceTypes: ['MOBILE'] } })];
  const live = fakeCustomer({ rules: twoRules, sets: [setRow({ conversionValueRules: twoRules.map((r) => r.conversionValueRule.resourceName) })] });
  assert.equal((await readbackExtendedAction(prepared.action, live)).status, 'verified');
  assert.equal((await readbackExtendedAction(prepared.action, fakeCustomer())).status, 'mismatch');
  const failing = { query: async () => { throw new Error('boom'); } };
  assert.equal((await readbackExtendedAction(prepared.action, failing)).status, 'unavailable');
});

test('preview rows are Arabic, name the effect on bidding, and carry no dashes', () => {
  const rows = extendedPreviewRows('create_value_rule_set', createParams as any);
  const text = rows.map((r) => `${r.label} ${r.value}`).join(' ');
  assert.match(text, /الكمبيوتر/);
  assert.match(text, /أعلى 30%/);
  assert.match(text, /أقل 20%/);
  assert.ok(!/[—–]/.test(text));
  const upd = extendedPreviewRows('update_value_rule', { rule_resource: RULE, multiplier: 1.1, resolved: { previous_multiplier: 1.3 } });
  assert.ok(upd.some((r) => r.value.includes('أعلى 10%')));
});

test('Jarvis get_value_rules summarises sets without resource names', async () => {
  const customer = fakeCustomer({ rules: [ruleRow()], sets: [setRow()] });
  const result = await getValueRulesTool.run({}, { customer, accountId: 'a', customerId: CID, currencyCode: 'SAR', business: null, now: new Date() } as any);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(!JSON.stringify(result.summary).includes('customers/'));
  assert.equal((result.summary.sets as any[])[0].dimension, 'DEVICE');
  assert.equal(result.rows[0].data.resource_name, SET);
});
