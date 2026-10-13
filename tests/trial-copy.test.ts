import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CARD_TRIAL_USED_MESSAGE,
  TRIAL_STARTER_LIMITS_NOTE,
  trialIneligibleNotice,
} from '../lib/billing/trial-copy';
import { auditAccessMessage } from '../lib/billing/free-audit';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Em dash, en dash, figure dash, horizontal bar, minus sign, and a hyphen used as a dash between words. */
const DASHES = /[‒–—―−]|\s-\s/;

test('the trial copy is exactly the agreed wording', () => {
  assert.equal(CARD_TRIAL_USED_MESSAGE, 'هالبطاقة استخدمت التجربة المجانية قبل، تقدر تشترك مباشرة.');
  assert.equal(TRIAL_STARTER_LIMITS_NOTE, 'خلال التجربة تشتغل بحدود باقة البداية، والحدود الكاملة تبدأ من أول دفعة.');
  assert.equal(trialIneligibleNotice('ads_account_used'), 'حساب الإعلانات هذا أخذ تجربته المجانية قبل، فالاشتراك يبدأ مباشرة.');
  assert.equal(trialIneligibleNotice('disposable_email'), 'التجربة المجانية تحتاج إيميل دائم، تقدر تشترك مباشرة.');
});

test('only the reasons that need explaining get a notice', () => {
  assert.equal(trialIneligibleNotice('already_used'), null, 'the pages keep their own wording for a used trial');
  assert.equal(trialIneligibleNotice(null), null);
  assert.equal(trialIneligibleNotice(undefined), null);
});

test('new copy has no em or en dashes and uses the Arabic comma', () => {
  const copy = [
    CARD_TRIAL_USED_MESSAGE,
    TRIAL_STARTER_LIMITS_NOTE,
    trialIneligibleNotice('ads_account_used')!,
    trialIneligibleNotice('disposable_email')!,
    auditAccessMessage('free_accounts_exhausted')!,
  ];
  for (const text of copy) {
    assert.doesNotMatch(text, DASHES, text);
    assert.ok(!text.includes(','), `Latin comma in: ${text}`);
  }
});

test('the billing page maps card_trial_used and shows the notices where the trial is offered', () => {
  const src = read('app/(dashboard)/billing/page.tsx');
  assert.match(src, /card_trial_used: CARD_TRIAL_USED_MESSAGE/);
  assert.match(src, /trialIneligibleNotice\(checkout\.trialIneligibleReason\)/);
  assert.match(src, /\{TRIAL_STARTER_LIMITS_NOTE\}/);
});

test('the onboarding trial page maps card_trial_used, the notices and the Starter-limits line', () => {
  const src = read('app/onboarding/trial/page.tsx');
  assert.match(src, /card_trial_used: CARD_TRIAL_USED_MESSAGE/);
  assert.match(src, /trialIneligibleNotice\(checkout\.trialIneligibleReason\)/);
  assert.match(src, /\{TRIAL_STARTER_LIMITS_NOTE\}/);
});

test('the card-guard redirect code is the one both pages map', () => {
  assert.match(read('app/api/billing/checkout/complete/route.ts'), /'card_trial_used'/);
});
