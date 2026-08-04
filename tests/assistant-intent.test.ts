import assert from 'node:assert/strict';
import test from 'node:test';
import { detectIntent } from '../lib/ai/intent';

test('asking about campaign performance does not create a campaign draft', () => {
  assert.notEqual(detectIntent('كيف أداء حملة الرياض؟'), 'campaign_build');
});

test('adding a negative keyword is classified as a keyword operation', () => {
  assert.equal(detectIntent('أضف كلمة سلبية للحملة'), 'keywords');
});

test('an explicit new campaign request is classified as campaign_build', () => {
  assert.equal(detectIntent('أنشئ حملة جديدة لمنتجي'), 'campaign_build');
});

test('asking for a monthly report does not create a campaign draft', () => {
  assert.notEqual(detectIntent('سوِّ لي تقرير شهري'), 'campaign_build');
});
