import assert from 'node:assert/strict';
import test from 'node:test';
import { FAQ_CATEGORIES, FAQ_ITEMS, faqAnswerText } from '../lib/faq/data';
import { itemMatches, normalizeArabic } from '../lib/faq/search';
import { PLAN_PRICES_SAR } from '../lib/seo/site';
import { PLAN_LIMITS } from '../lib/billing/entitlements';
import { FIRST_CAMPAIGN_LAUNCH_PRICE_SAR } from '../lib/lifecycle/copy';

const everyText = FAQ_ITEMS.flatMap((item) => [item.q, ...item.a, ...(item.alsoCalled ?? [])]);

test('every question has a unique anchor id and a real answer', () => {
  const ids = FAQ_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  for (const item of FAQ_ITEMS) {
    assert.match(item.id, /^[a-z0-9-]+$/, `${item.id} must be a plain ascii anchor`);
    assert.ok(item.q.trim().length >= 8, `${item.id} question too short`);
    assert.ok(item.a.length >= 1 && item.a.every((p) => p.trim().length >= 20), `${item.id} answer too short`);
    assert.ok(faqAnswerText(item).length > 0);
  }
  for (const category of FAQ_CATEGORIES) {
    assert.ok(category.items.length > 0, `${category.id} is empty`);
  }
});

test('no long or medium dash, no Latin comma next to Arabic, no odd whitespace', () => {
  for (const text of everyText) {
    assert.ok(!/[—–]/.test(text), `dash in: ${text}`);
    assert.ok(!/[؀-ۿ],|,[؀-ۿ ]/.test(text), `Latin comma in Arabic text: ${text}`);
    assert.ok(!/[​-‏‪-‮ ﻿]/.test(text), `hidden character in: ${text}`);
  }
});

test('never says "before tax" (owner decision 18 Oct 2026: no tax is added)', () => {
  for (const text of everyText) {
    assert.ok(!/قبل\s+(ال)?ضريب/.test(text), `tax wording in: ${text}`);
  }
});

test('the three plan prices in the answers match the plan constants', () => {
  const price = FAQ_ITEMS.find((item) => item.id === 'subscription-price');
  assert.ok(price);
  const text = faqAnswerText(price);
  for (const plan of PLAN_PRICES_SAR) {
    assert.ok(text.includes(plan.monthly.toLocaleString('en-US')), `${plan.key} price missing from the answer`);
  }
});

test('no phone, email, link-in-text or client name leaks into the answers', () => {
  for (const text of everyText) {
    assert.ok(!/@/.test(text), `at-sign in: ${text}`);
    assert.ok(!/\b05\d{8}\b|\+?9665\d{8}/.test(text), `phone number in: ${text}`);
    assert.ok(!/https?:\/\//.test(text), `url in: ${text}`);
  }
});

test('banned AI-sounding phrases are not in the text', () => {
  const banned = [
    'ليس مجرد',
    'لا يتعلق الأمر',
    'بالإضافة إلى ذلك',
    'علاوة على ذلك',
    'من الجدير بالذكر',
    'في عالم اليوم',
    'رحلتك نحو',
    'خذها للمستوى التالي',
    'لا تفوت الفرصة',
    'حلول متكاملة',
    'باختصار',
  ];
  for (const text of everyText) {
    for (const phrase of banned) assert.ok(!text.includes(phrase), `"${phrase}" in: ${text}`);
  }
});

test('search ignores hamza, taa marbuta, tashkeel and extra spaces', () => {
  assert.equal(normalizeArabic('  إعلانات  مجاناً؟ '), normalizeArabic('اعلانات مجانا'));
  const noAccount = FAQ_ITEMS.find((item) => item.id === 'no-ads-account');
  assert.ok(noAccount);
  assert.ok(itemMatches(noAccount, 'ما عندي حساب'));
  assert.ok(itemMatches(noAccount, 'افتح لي حساب'));
  assert.ok(!itemMatches(noAccount, 'العراق'));
  assert.ok(itemMatches(noAccount, ''), 'empty query shows everything');
});

test('the questions people type most are all findable', () => {
  const find = (word: string) => FAQ_ITEMS.filter((item) => itemMatches(item, word)).map((item) => item.id);
  assert.ok(find('العراق').includes('which-countries'));
  assert.ok(find('بكم').includes('subscription-price'));
  assert.ok(find('تطبيق').includes('is-there-app'));
  assert.ok(find('الغاء').includes('cancel-refund'));
  assert.ok(find('هوتميل').includes('which-email'));
  assert.ok(find('تيك توك').includes('other-platforms'));
});

test('plan limits and launch numbers in the answers match the code', () => {
  const limits = FAQ_ITEMS.find((item) => item.id === 'plan-limits-meaning');
  assert.ok(limits);
  const text = faqAnswerText(limits);
  const { starter, growth, pro } = PLAN_LIMITS;
  assert.ok(text.includes(`البداية ${starter.assistant.limit} محادثة و${starter.manual_sync.limit} مزامنات و${starter.execute_action.limit} تنفيذات`));
  assert.ok(text.includes(`النمو ${growth.assistant.limit} و${growth.manual_sync.limit} و${growth.execute_action.limit}`));
  assert.ok(text.includes(`الاحتراف ${pro.assistant.limit} و${pro.manual_sync.limit} و${pro.execute_action.limit}`));
  const launch = FAQ_ITEMS.find((item) => item.id === 'no-spend-account');
  assert.ok(launch);
  const launchText = faqAnswerText(launch);
  assert.ok(launchText.includes(`${FIRST_CAMPAIGN_LAUNCH_PRICE_SAR} ريال`));
});

test('the problems customers wrote about in October are findable', () => {
  const find = (word: string) => FAQ_ITEMS.filter((item) => itemMatches(item, word)).map((item) => item.id);
  assert.ok(find('ما عندي موقع').includes('website-or-store'));
  assert.ok(find('الدعوة ما وصلت').includes('invitation-not-received'));
  assert.ok(find('لا يوجد حساب اعلاني').includes('connect-no-ads-account'));
  assert.ok(find('نشاط دفع مريب').includes('google-account-suspended'));
  assert.ok(find('وين زر التراجع').includes('undo-change'));
  assert.ok(find('20 محادثة').includes('plan-limits-meaning'));
  assert.ok(find('مو الحين').includes('after-approve'));
});
