import assert from 'node:assert/strict';
import test from 'node:test';
import { autopilotDecisionDisplayDetails } from '../lib/autopilot/display';

test('decision details read the nested action payload written by the ledger', () => {
  assert.deepEqual(
    autopilotDecisionDisplayDetails({
      type: 'add_negative_keyword',
      params: {
        campaign_resource: 'customers/123/campaigns/456',
        campaign_name: 'بحث الرياض',
        keyword_text: 'وظائف مجانية',
        match_type: 'EXACT',
      },
    }),
    {
      keyword: 'وظائف مجانية',
      campaign: 'بحث الرياض',
      matchType: 'EXACT',
    }
  );
});

test('older snapshots fall back to the campaign id without throwing', () => {
  assert.deepEqual(
    autopilotDecisionDisplayDetails({
      params: {
        campaign_resource: 'customers/123/campaigns/789',
        keyword_text: 'بحث غير مرتبط',
      },
    }),
    {
      keyword: 'بحث غير مرتبط',
      campaign: 'الحملة 789',
      matchType: null,
    }
  );
});
