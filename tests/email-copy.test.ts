import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_COPY, buildAll, decisions, days } from '../lib/lifecycle/copy';
import { COPY_KEYS, EMPTY_FACTS, type EmailCopy, type EmailFacts } from '../lib/lifecycle/types';
import { SUPPORT_WHATSAPP_NUMBER } from '../lib/support/contact';

const RICH: EmailFacts = {
  firstName: 'سارة',
  businessName: 'مشغل سارة',
  plan: { decisionsTotal: 6, lockedCount: 5, firstDecisionTitle: 'وقّف حملة الرياض العامة', wasteEstimate: 1240.4, currency: 'SAR', trialEligible: true },
  trial: { startedAt: '2026-10-10T09:00:00Z', endsAt: '2026-10-24T09:00:00Z', daysLeft: 9, approvedCount: 3, pendingCount: 2, rolledBackCount: 1, adsSpend30: 2310, track: 'a', cancelScheduled: false },
  weekly: {
    periodStart: '2026-10-04T00:00:00Z',
    periodEnd: '2026-10-10T00:00:00Z',
    currency: 'SAR',
    spend: 2310,
    conversions: 47,
    costPerConversion: 49.15,
    prevSpend: 2500,
    prevConversions: 39,
    highlights: ['حملة الرياض — أعلى تكلفة', 'الكلمات العامة صرفت بدون تحويل'],
    pendingCount: 1,
  },
  billing: { planName: 'النمو', trialEndsAt: '2026-10-24T09:00:00Z' },
};

const ZERO_TRIAL: EmailFacts = {
  ...RICH,
  trial: { ...RICH.trial!, approvedCount: 0, pendingCount: 0, daysLeft: null, rolledBackCount: 0 },
};

/** Track B: the linked accounts spent under 300 SAR in 30 days. */
const TRACK_B: EmailFacts = {
  ...RICH,
  email: 'sara@example.test',
  trial: { ...RICH.trial!, approvedCount: 0, pendingCount: 0, rolledBackCount: 0, adsSpend30: 40, track: 'b' },
};

function allText(facts: EmailFacts): string[] {
  const out: string[] = [];
  for (const { email } of buildAll(facts)) {
    if (!email) continue;
    out.push(email.subject, email.preheader, email.ps ?? '', email.cta?.label ?? '', email.externalCta?.label ?? '');
    for (const block of email.blocks) {
      if (block.type === 'list') out.push(...block.items);
      else if (block.type === 'stat') out.push(block.label, block.value, block.note ?? '');
      else out.push(block.text);
    }
  }
  return out;
}

test('every copy key has exactly one entry with a matching key', () => {
  assert.deepEqual(Object.keys(EMAIL_COPY).sort(), [...COPY_KEYS].sort());
  for (const key of COPY_KEYS) assert.equal(EMAIL_COPY[key].key, key);
});

// Ayman approved the first four on 14 Oct 2026 (review page) and the trial journey texts on 26 Oct 2026
// (trial_d1 with its track B variant, trial_d4 with its track B variant, trial_d7, trial_d9 and trial_card_ready).
// Anything else waits for him.
const APPROVED_BY_AYMAN = new Set([
  'welcome_ads_connect',
  'registered_1d',
  'plan_ready_1d',
  'weekly_report',
  'trial_d1',
  'trial_d4',
  'trial_d7',
  'trial_d9',
  'trial_card_ready',
]);

test('only the live billing mails and the texts Ayman approved are approved', () => {
  for (const key of COPY_KEYS) {
    const approved = EMAIL_COPY[key].approved;
    assert.equal(approved, key.startsWith('tx_') || APPROVED_BY_AYMAN.has(key), key);
  }
});

test('house style: no em or en dash, no Latin comma, no stock AI phrases, in any variant', () => {
  const banned = ['ليس مجرد', 'لا تفوت', 'المستوى التالي', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'رحلتك', 'حلول متكاملة', 'هل تعاني', 'في النهاية', 'باختصار'];
  for (const facts of [RICH, ZERO_TRIAL, TRACK_B, EMPTY_FACTS]) {
    for (const line of allText(facts)) {
      assert.doesNotMatch(line, /[—–]/, line);
      // A comma between digits is a thousands separator (1,240), not punctuation.
      const punctuation = line.replace(/(\d),(\d)/g, '$1$2');
      assert.doesNotMatch(punctuation, /[؀-ۿ][^\n]*,|,[^\n]*[؀-ۿ]/, line);
      for (const phrase of banned) assert.ok(!line.includes(phrase), `${phrase} in: ${line}`);
    }
  }
});

test('subjects and preheaders stay short enough for a phone inbox', () => {
  for (const facts of [RICH, ZERO_TRIAL, TRACK_B, EMPTY_FACTS]) {
    for (const { key, email } of buildAll(facts)) {
      if (!email) continue;
      assert.ok(email.subject.length <= 70, `${key} subject ${email.subject.length}`);
      assert.ok(email.preheader.length <= 90, `${key} preheader`);
      if (email.cta) assert.ok(email.cta.path.startsWith('/') && !email.cta.path.startsWith('//'), key);
    }
  }
});

test('copies that need facts return null without them instead of guessing', () => {
  for (const key of ['plan_ready_1d', 'trial_d1', 'trial_d4', 'trial_d7', 'trial_d9', 'trial_card_ready', 'weekly_report'] as const) {
    assert.equal(EMAIL_COPY[key].build(EMPTY_FACTS), null, key);
  }
  assert.equal(EMAIL_COPY.plan_ready_1d.build({ ...RICH, plan: { ...RICH.plan!, decisionsTotal: 0 } }), null);
});

test('numbers come from the facts, in Latin digits', () => {
  const plan = EMAIL_COPY.plan_ready_1d.build(RICH)!;
  assert.match(plan.subject, /1,240/);
  assert.ok(plan.blocks.some((b) => b.type === 'p' && b.text.includes('5 قرارات غيره')));
  const noWaste = EMAIL_COPY.plan_ready_1d.build({ ...RICH, plan: { ...RICH.plan!, wasteEstimate: null } })!;
  assert.ok(!noWaste.blocks.some((b) => b.type === 'stat'));
  assert.doesNotMatch(noWaste.subject, /[0-9]/);

  const weekly = EMAIL_COPY.weekly_report.build(RICH)!;
  assert.match(weekly.subject, /47 تحويل/);
  const list = weekly.blocks.find((b) => b.type === 'list');
  assert.ok(list && list.type === 'list' && list.items[0] === 'حملة الرياض، أعلى تكلفة');
});

const textOf = (email: NonNullable<ReturnType<EmailCopy['build']>>) =>
  [email.subject, email.preheader, email.cta?.label ?? '', email.externalCta?.label ?? '', email.ps ?? '']
    .concat(email.blocks.map((b) => ('text' in b ? b.text : b.type === 'list' ? b.items.join(' ') : `${b.label} ${b.value}`)))
    .join('\n');

test('trial_d1, track A: search terms, and the waiting decisions only when there are some', () => {
  const email = EMAIL_COPY.trial_d1.build(RICH)!;
  assert.equal(email.subject, 'الكلمة اللي اخترتها غير اللي تدفع عليها');
  const text = textOf(email);
  assert.match(text, /مصطلحات البحث/);
  assert.match(text, /عندك قرارين ينتظرك، كل واحد معه سببه من أرقامك/);
  assert.match(text, /اعتمد اللي تقتنع فيه واترك الباقي/);
  assert.deepEqual(email.cta, { label: 'شوف قرار اليوم', path: '/home' });
  assert.equal(email.externalCta, undefined);

  const none = EMAIL_COPY.trial_d1.build(ZERO_TRIAL)!;
  assert.match(textOf(none), /ما طلع قرار اليوم، وهذا يصير لما الحساب ما فيه شي يستاهل يتغير. بكرة نقرأه من جديد/);
  assert.doesNotMatch(textOf(none), /ينتظرك|اعتمد اللي/);
  // An unknown track (the spend could not be settled) gets the track A text, never the B one.
  const unknown = EMAIL_COPY.trial_d1.build({ ...RICH, trial: { ...RICH.trial!, track: null } })!;
  assert.equal(unknown.subject, email.subject);
});

test('trial_d1, track B: the launch offer, with a WhatsApp button that carries the person email', () => {
  const email = EMAIL_COPY.trial_d1.build(TRACK_B)!;
  assert.equal(email.subject, 'حسابك للحين ما يصرف، وهذا اللي نقدر نسويه');
  const text = textOf(email);
  assert.match(text, /للحين ما فيه حملات تصرف/);
  assert.match(text, /«خطة أول حملة»/);
  assert.match(text, /بـ750 ريال مرة وحدة/);
  assert.match(text, /الـ750 تشمل اختيار الكلمات اللي يبحث فيها عميلك، وكتابة الإعلانات، وضبط المدينة وأوقات الظهور، وتركيب تتبع الاتصال والواتساب، ومراجعة الحملة أول أسبوع/);
  assert.match(text, /من 100 إلى 150 ريال باليوم لنشاط محلي/);
  assert.match(text, /ما نضمن عدد عملاء، نضمن إن الحملة مبنية صح/);
  assert.equal(email.cta, undefined);
  assert.equal(email.externalCta?.label, 'اطلب الإطلاق');
  const url = new URL(email.externalCta!.url);
  assert.equal(url.origin + url.pathname, `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`);
  assert.match(url.searchParams.get('text')!, /sara@example\.test/);
  assert.match(url.searchParams.get('text')!, /750/);
  // No email on the facts: the message is still valid, it just has no email line.
  const noEmail = EMAIL_COPY.trial_d1.build({ ...TRACK_B, email: null })!;
  assert.doesNotMatch(new URL(noEmail.externalCta!.url).searchParams.get('text')!, /ايميلي/);
});

test('trial_d4: track A explains the daily budget, track B says start small and repeats the 750 offer', () => {
  const a = EMAIL_COPY.trial_d4.build(RICH)!;
  assert.equal(a.subject, 'ميزانيتك اليومية مو سقف');
  const aText = textOf(a);
  assert.match(aText, /لو حاط 100 ريال باليوم، قوقل يحق له يصرف لين 200 في يوم واحد/);
  assert.match(aText, /ما يحرك ميزانيتك أكثر من 20% بالمرة، ولا يرجع يلمسها قبل 7 أيام، وأي تعديل ترجّعه خلال 30 يوم/);
  assert.match(aText, /اعتمدت لين الحين 3 قرارات\. باقي على تجربتك 9 أيام\./);
  // Zero approvals and no end date: those sentences are dropped, not worded around.
  const bare = textOf(EMAIL_COPY.trial_d4.build(ZERO_TRIAL)!);
  assert.doesNotMatch(bare, /اعتمدت لين الحين|باقي على تجربتك/);

  const b = EMAIL_COPY.trial_d4.build(TRACK_B)!;
  assert.equal(b.subject, 'أول حملة: ابدأ صغير وواضح');
  const bText = textOf(b);
  assert.match(bText, /من 100 إلى 150 ريال باليوم/);
  assert.match(bText, /حملة بحث وحدة على الخدمة اللي الناس يبحثون عنها فعلاً/);
  assert.match(bText, /750 ريال مرة وحدة/);
  assert.doesNotMatch(bText, /ميزانيتك اليومية مو سقف/);
  assert.equal(b.externalCta?.label, 'اطلب الإطلاق');
});

test('trial_d7: why no daily change, and what happened in the account only when there is something to say', () => {
  const email = EMAIL_COPY.trial_d7.build(RICH)!;
  assert.equal(email.subject, 'ليش مُضاعِف ما يغيّر شي كل يوم');
  const text = textOf(email);
  assert.match(text, /اللمس اليومي/);
  assert.match(text, /مو كسل، هذا قرار/);
  assert.match(text, /نص التجربة راح، وهذا اللي صار في حسابك: اعتمدت 3 قرارات، ورجّعت قرار واحد\./);
  assert.deepEqual(email.cta, { label: 'شوف حسابك', path: '/home' });
  // Nothing rolled back: that half of the sentence is dropped. Nothing approved: the sentence is.
  assert.match(textOf(EMAIL_COPY.trial_d7.build({ ...RICH, trial: { ...RICH.trial!, rolledBackCount: 0 } })!), /اعتمدت 3 قرارات\.$/m);
  assert.match(textOf(EMAIL_COPY.trial_d7.build({ ...RICH, trial: { ...RICH.trial!, rolledBackCount: null } })!), /اعتمدت 3 قرارات\.$/m);
  assert.doesNotMatch(textOf(EMAIL_COPY.trial_d7.build(ZERO_TRIAL)!), /نص التجربة راح/);
});

test('trial_d9: days left, what was approved, the tracking tip and the way to cancel; sentences without data are dropped', () => {
  const email = EMAIL_COPY.trial_d9.build(RICH)!;
  assert.equal(email.subject, 'قبل ما تقرر');
  const text = textOf(email);
  assert.match(text, /باقي 9 أيام وبعدها يبدأ الاشتراك\./);
  assert.match(text, /في تجربتك اعتمدت 3 قرارات\./);
  assert.match(text, /شيك إن التحويل في حسابك يحسب طلب أو اتصال حقيقي مو زيارة صفحة\. لو التحويل غلط، كل قرار يطلع غلط/);
  assert.match(text, /الإلغاء بضغطة من صفحة الاشتراك، وقبل نهاية التجربة ما ينخصم شي/);
  assert.doesNotMatch(text, /أكبر صرف/, 'the biggest wasted spend clause needs a figure the platform does not hold');
  assert.equal(email.cta?.label, 'افتح مُضاعِف');

  const zero = EMAIL_COPY.trial_d9.build(ZERO_TRIAL)!;
  assert.doesNotMatch(textOf(zero), /باقي .* وبعدها يبدأ الاشتراك/, 'no end date, no days sentence');
  assert.equal(zero.cta?.label, 'جرّب قرار واحد');
  // Track B has no decisions to try: no nudge to approve one.
  const b = EMAIL_COPY.trial_d9.build(TRACK_B)!;
  assert.doesNotMatch(textOf(b), /جرّب قرار/);
  assert.equal(b.cta?.label, 'افتح مُضاعِف');
});

test('trial_card_ready: a billing notice with the first charge date, never built for a cancelled trial', () => {
  const copy = EMAIL_COPY.trial_card_ready;
  assert.equal(copy.category, 'transactional');
  assert.deepEqual(copy.requires, ['trial', 'billing', 'cancel_state']);
  const email = copy.build(RICH)!;
  assert.equal(email.subject, 'خطوة صغيرة قبل أول دفعة');
  const text = textOf(email);
  assert.match(text, /أول دفعة يوم 24 أكتوبر 2026\./);
  assert.match(text, /بعض البنوك ترفض العملية أول مرة لأنها دولية، وتنحل قبل لا تصير/);
  assert.match(text, /فعّل الشراء الدولي من تطبيق بنكك، أو حدّث البطاقة من صفحة الاشتراك/);
  assert.match(text, /ألغِ قبل التاريخ وما ينخصم شي/);
  assert.deepEqual(email.cta, { label: 'صفحة الاشتراك', path: '/billing' });

  assert.equal(copy.build({ ...RICH, trial: { ...RICH.trial!, cancelScheduled: true } }), null);
  // No end date anywhere: the date sentence goes, the advice stays.
  const undated = copy.build({ ...RICH, billing: null, trial: { ...RICH.trial!, endsAt: null } })!;
  assert.doesNotMatch(textOf(undated), /أول دفعة يوم/);
  assert.match(textOf(undated), /ألغِ قبل نهاية التجربة/);
});

test('counting words follow Saudi usage', () => {
  assert.equal(decisions(1), 'قرار واحد');
  assert.equal(decisions(2), 'قرارين');
  assert.equal(decisions(7), '7 قرارات');
  assert.equal(decisions(14), '14 قرار');
  assert.equal(days(10), '10 أيام');
  assert.equal(days(11), '11 يوم');
});

test('no free trial is promised to someone who cannot take one', () => {
  for (const trialEligible of [false, null, undefined]) {
    const facts = { ...RICH, plan: { ...RICH.plan!, trialEligible } };
    const email = EMAIL_COPY.plan_ready_1d.build(facts)!;
    const text = [email.subject, email.preheader, email.cta?.label ?? '', ...email.blocks.map((b) => ('text' in b ? b.text : ''))].join(' ');
    assert.doesNotMatch(text, /مجان|14 يوم/, String(trialEligible));
    assert.equal(email.cta?.label, 'فعّل اشتراكك');
    assert.equal(EMAIL_COPY.plan_ready_3d.build(facts), null);
  }
  assert.ok(EMAIL_COPY.plan_ready_3d.build(RICH));
});

test('the cancel mail does not assume the person chose to cancel', () => {
  const email = EMAIL_COPY.canceled_1d.build(RICH)!;
  const text = [email.subject, ...email.blocks.map((b) => ('text' in b ? b.text : ''))].join(' ');
  assert.doesNotMatch(text, /ألغيت/);
});
