import assert from 'node:assert/strict';
import test from 'node:test';
import { EXIT_COPY } from '../lib/growth/exit-copy';
import { FULL_MANAGEMENT_COPY, FULL_MANAGEMENT_URL, fullManagementHref } from '../lib/growth/full-management';
import { ACCOUNT_MANAGERS, BUSINESS_TYPES, SPEND_BANDS } from '../lib/growth/onboarding-answers';
import { WELCOME_COPY, WELCOME_QUESTIONS_COPY } from '../lib/welcome/copy';
import { LEAD_FOLLOWUP } from '../config/lead-followup';
import { GROWTH_OWNER_CONFIG } from '../lib/growth/owner-config';

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

const BANNED = [
  'ليس مجرد', 'لا يتعلق الأمر', 'يُعتبر من أبرز', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر',
  'في عالم اليوم', 'في ظل التطور', 'رحلتك نحو', 'عالم التسويق', 'خذها للمستوى التالي', 'لا تفوت الفرصة',
  'حلول متكاملة', 'مصمم خصيصاً', 'سواء كنت', 'باختصار', 'في النهاية', 'هل تعاني', 'جودة عالية',
];

const sets: Record<string, string[]> = {
  exit: strings(EXIT_COPY),
  welcomeQuestions: [
    ...strings(WELCOME_QUESTIONS_COPY),
    WELCOME_QUESTIONS_COPY.progressLabel(1, 2),
    WELCOME_QUESTIONS_COPY.progressLabel(2, 2),
  ],
  welcomeMain: strings(WELCOME_COPY),
  fullManagement: strings(FULL_MANAGEMENT_COPY),
  leadEmail: strings(LEAD_FOLLOWUP),
  options: [...BUSINESS_TYPES, ...SPEND_BANDS, ...ACCOUNT_MANAGERS].map((o) => o.label),
};

for (const [name, texts] of Object.entries(sets)) {
  test(`${name}: house writing rules`, () => {
    assert.ok(texts.length > 0);
    for (const text of texts) {
      assert.doesNotMatch(text, /[—–]/, `dash in: ${text}`);
      if (/[؀-ۿ]/.test(text)) assert.doesNotMatch(text, /,/, `Latin comma in: ${text}`);
      assert.doesNotMatch(text, /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00A0\u2007\u202F]/, `hidden or odd space in: ${text}`);
      for (const phrase of BANNED) assert.ok(!text.includes(phrase), `"${phrase}" in: ${text}`);
    }
  });
}

test('the connect screen is called «الخطوة الأخيرة قبل فحصك»', () => {
  assert.equal(WELCOME_COPY.headline, 'الخطوة الأخيرة قبل فحصك');
});

test('every question explains why it is asked, and says the audit does not change', () => {
  const why = [WELCOME_QUESTIONS_COPY.businessType.why, WELCOME_QUESTIONS_COPY.spend.why, WELCOME_QUESTIONS_COPY.manager.why];
  for (const line of why) assert.ok(line.length > 15);
  assert.match(WELCOME_QUESTIONS_COPY.intro, /ما تغيّر نتيجة الفحص/);
  // The page is honest that a team member may reach out.
  assert.match(WELCOME_QUESTIONS_COPY.disclosure, /ممكن يتواصل معك فريق مُضاعفة/);
  assert.match(WELCOME_QUESTIONS_COPY.disclosure, /تقدر ترفض/);
});

test('the full-management link goes to modaafa.com and says where the click came from', () => {
  const url = new URL(fullManagementHref('audit_result'));
  assert.equal(url.origin, FULL_MANAGEMENT_URL);
  assert.equal(url.searchParams.get('utm_source'), 'platform');
  assert.equal(url.searchParams.get('utm_medium'), 'audit_result');
  assert.equal(FULL_MANAGEMENT_COPY.button, 'خل فريق مضاعفة يديرها عنك');
});

test('shipped state: every owner value is empty, so nothing half-finished is visible', () => {
  assert.equal(GROWTH_OWNER_CONFIG.sampleReportUrl, null);
  assert.equal(GROWTH_OWNER_CONFIG.agencyLeadMinSpendBand, null);
  assert.equal(LEAD_FOLLOWUP.approved, false);
});

test('spend bands do not use a Latin comma inside Arabic labels', () => {
  for (const band of SPEND_BANDS) assert.doesNotMatch(band.label, /,/);
});
