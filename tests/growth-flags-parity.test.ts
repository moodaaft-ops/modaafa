import assert from 'node:assert/strict';
import test from 'node:test';
import {
  demandGenEnabled, audiencesEnabled, experimentsEnabled, imageAssetsEnabled, GROWTH_OPERATIONS,
  growthOperationEnabled, isGrowthOperation, isGrowthRollback, GROWTH_LABELS_AR,
} from '../lib/growth/flags';
import { buildGrowthAction, prepareGrowthAction, finalizeGrowthRollback, GROWTH_RESULT_ROLLBACK } from '../lib/growth/registry';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { finalizeRollbackPayload } from '../lib/ai/execution-result';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { operationLabelAr } from '../lib/ai/operation-labels';
import { growthPreviewRows } from '../lib/growth/preview';
import { growthCardRow } from '../lib/growth/card';
import { runGrowthAction } from '../lib/growth/action';
import { CID, P } from './growth-fixtures';

const FLAGS = ['DEMAND_GEN_ENABLED', 'AUDIENCES_ENABLED', 'EXPERIMENTS_ENABLED', 'IMAGE_ASSETS_ENABLED'] as const;

function withFlags<T>(values: Partial<Record<(typeof FLAGS)[number], string>>, fn: () => T): T {
  const previous = FLAGS.map((f) => process.env[f]);
  for (const f of FLAGS) delete process.env[f];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  try {
    return fn();
  } finally {
    FLAGS.forEach((f, i) => (previous[i] === undefined ? delete process.env[f] : (process.env[f] = previous[i])));
  }
}

const rec = { title: 't', description: 'd' };
const payloads: Record<string, any> = {
  create_user_list: { operation: 'create_user_list', target_id: '', params: { kind: 'website_visitors', name: 'n', url_contains: 'shop.example.com', lookback_days: 30 } },
  attach_audience: { operation: 'attach_audience', target_id: '', params: { ad_group_resource: `${P}/adGroups/1`, user_list_resource: `${P}/userLists/2` } },
  end_experiment: { operation: 'end_experiment', target_id: '', params: { experiment_resource: `${P}/experiments/3` } },
  promote_experiment: { operation: 'promote_experiment', target_id: '', params: { experiment_resource: `${P}/experiments/3`, metric: 'conversion_rate' } },
  create_image_assets: {
    operation: 'create_image_assets', target_id: '',
    params: { images: [{ url: 'https://shop.example.com/a.png', sha256: 'a'.repeat(64), width: 1200, height: 628, bytes: 1000, slot: 'marketing' }] },
  },
};

test('every flag is off unless exactly "true"', () => {
  withFlags({}, () => {
    assert.deepEqual([demandGenEnabled(), audiencesEnabled(), experimentsEnabled(), imageAssetsEnabled()], [false, false, false, false]);
  });
  for (const v of ['TRUE', '1', 'yes', ' true', 'false', '']) {
    assert.equal(demandGenEnabled({ DEMAND_GEN_ENABLED: v }), false, v);
  }
  assert.equal(demandGenEnabled({ DEMAND_GEN_ENABLED: 'true' }), true);
});

test('with all four flags off, no growth operation builds an action (manual review, as before)', () => {
  withFlags({}, () => {
    for (const op of GROWTH_OPERATIONS) {
      assert.equal(growthOperationEnabled(op), false);
      const payload = payloads[op] ?? { operation: op, target_id: '', params: {} };
      assert.equal(buildExecutableAction(payload, rec, CID), null, op);
      assert.equal(buildGrowthAction(payload, rec, CID), null, op);
    }
  });
});

test('flag on builds a scoped action; the account id is injected and cross-account ids are refused', () => {
  withFlags({ AUDIENCES_ENABLED: 'true', DEMAND_GEN_ENABLED: 'true', EXPERIMENTS_ENABLED: 'true', IMAGE_ASSETS_ENABLED: 'true' }, () => {
    for (const op of Object.keys(payloads)) {
      const action = buildExecutableAction(payloads[op], rec, CID);
      assert.ok(action, op);
      assert.equal(action!.type, op);
      assert.equal((action!.params as any).customer_id, CID);
    }
    const other = { ...payloads.end_experiment, params: { experiment_resource: 'customers/999/experiments/3' } };
    assert.equal(buildExecutableAction(other, rec, CID), null);
    assert.equal(buildExecutableAction(payloads.end_experiment, rec, null), null, 'no account id, no action');
  });
});

test('each flag gates only its own operations; attach_audience needs both audiences and demand gen', () => {
  withFlags({ AUDIENCES_ENABLED: 'true' }, () => {
    assert.equal(growthOperationEnabled('create_user_list'), true);
    assert.equal(growthOperationEnabled('attach_audience'), false);
    assert.equal(growthOperationEnabled('create_experiment'), false);
    assert.equal(growthOperationEnabled('create_image_assets'), false);
  });
  withFlags({ AUDIENCES_ENABLED: 'true', DEMAND_GEN_ENABLED: 'true' }, () => {
    assert.equal(growthOperationEnabled('attach_audience'), true);
  });
  withFlags({ EXPERIMENTS_ENABLED: 'true' }, () => {
    assert.deepEqual(['create_experiment', 'end_experiment', 'promote_experiment'].map((o) => growthOperationEnabled(o)), [true, true, true]);
  });
});

test('a flag turned off after approval stops the action at the executor', async () => {
  await withFlags({}, async () => {
    await assert.rejects(() => runGrowthAction('end_experiment', { experiment_resource: `${P}/experiments/3`, customer_id: CID }, {}), /disabled/);
  });
});

test('prepare gives a result-filled rollback placeholder, and finalize swaps in the real descriptor', () => {
  withFlags({ EXPERIMENTS_ENABLED: 'true' }, () => {
    const action = buildGrowthAction(payloads.end_experiment, rec, CID)!;
    const prepared = prepareGrowthAction(action);
    assert.equal(prepared.rollbackPayload.action_type, GROWTH_RESULT_ROLLBACK);
    const descriptor = { reversible: true, action_type: 'growth_end_experiment', experiment_resource: `${P}/experiments/3`, resource_names: [`${P}/experiments/3`] };
    assert.deepEqual(finalizeRollbackPayload(prepared.rollbackPayload, { rollback_payload: descriptor }), descriptor);
    assert.deepEqual(finalizeGrowthRollback({}, {}), { reversible: false, resource_names: [], note: 'created_resources_unavailable' });
  });
});

test('rollback scope: growth descriptors are checked against the selected account', () => {
  const d = { reversible: true, action_type: 'growth_close_user_list', user_list_resource: `${P}/userLists/1`, resource_names: [`${P}/userLists/1`] };
  assert.equal(isGrowthRollback(d), true);
  assert.equal(isGrowthRollback({ action_type: 'remove_launched_campaign' }), false);
  assert.equal(rollbackResourcesScoped(d, CID), true);
  assert.equal(rollbackResourcesScoped(d, '999'), false);
  assert.equal(rollbackResourcesScoped({ ...d, resource_names: [`${P}/userLists/1`, 'customers/999/userLists/2'] }, CID), false);
});

test('labels and previews exist for every operation, in Arabic without dashes or Latin commas', () => {
  for (const op of GROWTH_OPERATIONS) {
    assert.ok(isGrowthOperation(op));
    assert.ok(operationLabelAr(op), op);
    assert.ok(GROWTH_LABELS_AR[op].length > 3);
    assert.ok(!/[-–—]/.test(GROWTH_LABELS_AR[op]));
    assert.ok(!GROWTH_LABELS_AR[op].includes(','));
  }
  for (const op of Object.keys(payloads)) assert.ok(growthPreviewRows(op, payloads[op].params).length > 0, op);
  assert.deepEqual(growthPreviewRows('unknown', {}), []);
});

test('cards: stable fingerprint per identical action, pending status, no dashes in the title', () => {
  const a = growthCardRow('acc1', 'end_experiment', payloads.end_experiment.params, 'وصف');
  const b = growthCardRow('acc1', 'end_experiment', payloads.end_experiment.params, 'وصف مختلف');
  const c = growthCardRow('acc1', 'end_experiment', { experiment_resource: `${P}/experiments/4` }, 'وصف');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.equal(a.status, 'pending');
  assert.ok(!/[-–—]/.test(a.title));
});
