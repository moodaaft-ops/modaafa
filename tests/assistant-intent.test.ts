import assert from 'node:assert/strict';
import test from 'node:test';
import { detectIntent } from '../lib/ai/intent';

test('asking about campaign performance does not create a campaign draft', () => {
  assert.notEqual(detectIntent('كيف أداء حملة الرياض؟'), 'campaign_build');
});

test('an Arabic how-to question without punctuation does not create a draft', () => {
  assert.notEqual(detectIntent('كيف أنشئ حملة'), 'campaign_build');
});

test('adding a negative keyword is classified as a keyword operation', () => {
  assert.equal(detectIntent('أضف كلمة سلبية للحملة'), 'keywords');
});

test('an explicit new campaign request is classified as campaign_build', () => {
  assert.equal(detectIntent('أنشئ حملة جديدة لمنتجي'), 'campaign_build');
});

test('asking for a monthly report does not create a campaign draft', () => {
  assert.equal(detectIntent('سوِّ لي تقرير شهري'), 'report');
});

test('performance analysis is classified separately from campaign creation', () => {
  assert.equal(detectIntent('حلل أداء الحملات آخر 7 أيام'), 'performance');
});

test('period comparison is classified as comparison', () => {
  assert.equal(detectIntent('قارن الأداء هذا الأسبوع بالشهر'), 'comparison');
});

test('a conversion decline is classified as troubleshooting', () => {
  assert.equal(detectIntent('فيه هبوط في التحويلات'), 'troubleshooting');
});

test('Saudi phrasing for a declining metric is classified as troubleshooting', () => {
  assert.equal(detectIntent('ليش التحويلات نازلة؟'), 'troubleshooting');
});

test('a growth plan is classified as strategy', () => {
  assert.equal(detectIntent('اعطني استراتيجية نمو للحساب'), 'strategy');
});
