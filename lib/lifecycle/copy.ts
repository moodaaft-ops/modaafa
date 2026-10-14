/**
 * Every email مُضاعِف sends, in one file. Drafts for Ayman's review.
 *
 * How to read this file
 *   - `approved: false` means the runner never sends it. Ayman flips each one
 *     after reading it. The three `tx_` mails are already live billing mails and
 *     are not gated by `approved` (the PR review is their approval).
 *   - `build(facts)` returns the email for one person. Every number comes from
 *     `facts` (lib/lifecycle/facts.ts reads them from the database). When a
 *     number is missing the sentence that needs it is dropped, never guessed.
 *   - The renderer adds the greeting ("هلا {name}،"), the button, the signature
 *     and the footer. Text here is plain text, never HTML.
 *
 * Facts every text relies on (keep them true or change the text):
 *   - nothing changes in a campaign without the owner's approval
 *   - any approved change can be rolled back within 30 days (PLAN_COPY.trust)
 *   - the trial is 14 days with a card and cancels with one tap in the app
 *     (TRIAL_DAYS in lib/billing/checkout-policy.ts)
 *   - مُضاعِف works on Google Ads only
 *   - free help opening a Google Ads account is on WhatsApp 0541004029
 *
 * House style: Saudi neutral dialect, no em dash or en dash, Arabic comma,
 * Latin digits, no "ليس مجرد" style constructions, no invented numbers.
 */
import { PLAN_CHECKOUT_PATH } from '@/lib/plan/plan';
import { formatDateAr, formatMoney, formatNumber } from './format';
import type { Block, BuiltEmail, CopyKey, EmailCopy, EmailFacts } from './types';

export const SUPPORT_WHATSAPP_DISPLAY = '0541004029';
const TRUST_LINE = 'ولا شي يتغير في حسابك إلا باعتمادك، وتقدر ترجّع أي تعديل خلال 30 يوم.';

// ---------------------------------------------------------------------------
// Counting words. Saudi usage with Latin digits: 1 قرار واحد، 2 قرارين،
// 3 إلى 10 قرارات، 11 وفوق قرار.
// ---------------------------------------------------------------------------
type NounForms = { one: string; two: string; few: string; many: string };

function counted(n: number, forms: NounForms): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${formatNumber(n)} ${forms.few}`;
  return `${formatNumber(n)} ${forms.many}`;
}

export const decisions = (n: number) =>
  counted(n, { one: 'قرار واحد', two: 'قرارين', few: 'قرارات', many: 'قرار' });
export const days = (n: number) => counted(n, { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يوم' });
export const conversionsWord = (n: number) =>
  counted(n, { one: 'تحويل واحد', two: 'تحويلين', few: 'تحويلات', many: 'تحويل' });

/** Text written by the AI narrative can carry dashes; the house style has none. */
function clean(line: string): string {
  return line.replace(/\s*[—–]\s*/g, '، ').replace(/\s+/g, ' ').trim();
}

function money(amount: number, currency: string) {
  // formatMoney keeps two decimals under 100 (a cost per conversion of 12.5 stays 12.5).
  return formatMoney(amount, currency);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const welcome_ads_connect: EmailCopy = {
  key: 'welcome_ads_connect',
  category: 'onboarding',
  approved: false,
  build: () => ({
    // Ayman's own wording from PR #81, kept.
    subject: 'باقي خطوة وحدة على قراءة حسابك الإعلاني',
    preheader: 'اربط حساب إعلانات قوقل وخلّ مُضاعِف يقرأه',
    blocks: [
      { type: 'p', text: 'سجلت في مُضاعِف وباقي خطوة وحدة تشوف بعدها قراءة حسابك الإعلاني: ربط الحساب.' },
      {
        type: 'p',
        text: 'الربط من شاشة قوقل نفسها. اختر فيها الإيميل اللي عليه حساب الإعلانات، حتى لو كان غير الإيميل اللي سجلت فيه عندنا.',
      },
    ],
    cta: { label: 'اربط حسابك الإعلاني', path: '/onboarding' },
    ps: 'لو علقت في أي خطوة رد على هذا الإيميل.',
    signer: 'team',
  }),
};

// ---------------------------------------------------------------------------
// Journey: registered, never connected
// ---------------------------------------------------------------------------

const registered_1d: EmailCopy = {
  key: 'registered_1d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'الإيميل الصح في شاشة قوقل',
    preheader: 'نقطة صغيرة توقف الربط، وحلها سهل',
    blocks: [
      { type: 'p', text: 'سجلت في مُضاعِف وما ربطت حساب إعلانات قوقل للحين.' },
      {
        type: 'p',
        text: 'لما تضغط زر الربط، قوقل يطلب منك تختار حساب. اختر الإيميل اللي عليه حساب الإعلانات نفسه. لو اخترت إيميل ثاني بيطلع لك إن ما عندك حساب إعلانات، والمشكلة في الاختيار مو فيك.',
      },
    ],
    cta: { label: 'جرّب الربط الحين', path: '/onboarding' },
    ps: `وإذا ما عندك حساب إعلانات في قوقل أصلاً، راسلنا واتساب على ${SUPPORT_WHATSAPP_DISPLAY} ونفتحه معك ببلاش.`,
    signer: 'team',
  }),
};

const registered_3d: EmailCopy = {
  key: 'registered_3d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'وش يقدر مُضاعِف يسوي في حسابك، ووش ما يقدر',
    preheader: 'الربط يخليه يقرأ، والتعديل يمر عليك أول',
    blocks: [
      { type: 'p', text: 'فيه ناس يوقفون قبل الربط لأنهم ما يبون أحد يلعب في حملاتهم. وهذا حقك.' },
      {
        type: 'p',
        text: 'بعد الربط مُضاعِف يقرأ أرقام حسابك ويطلع لك خطة. أي تعديل يقترحه يجيك مكتوب معه سببه، وأنت اللي تعتمد أو ترفض. وأي تعديل اعتمدته ترجّعه خلال 30 يوم لو ما عجبك أثره.',
      },
      { type: 'note', text: 'وتقدر تشيل صلاحية مُضاعِف من إعدادات حساب قوقل نفسه متى ما بغيت.' },
    ],
    cta: { label: 'اربط حسابي', path: '/onboarding' },
    signer: 'team',
  }),
};

const registered_7d: EmailCopy = {
  key: 'registered_7d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'آخر رسالة مني عن الربط',
    preheader: 'بعدها ما بزعجك، وحسابك يبقى موجود',
    blocks: [
      { type: 'p', text: 'معك أيمن، صاحب مُضاعِف.' },
      { type: 'p', text: 'مر أسبوع على تسجيلك وما ربطت حسابك، وما بكرر عليك بعد هالرسالة.' },
      {
        type: 'p',
        text: 'بس ودي أعرف وش وقفك. رد على هالإيميل بكلمتين، مثلاً ما عندي حساب إعلانات، أو أي سبب ثاني. الرد يوصلني أنا.',
      },
    ],
    cta: { label: 'اربط حسابي', path: '/onboarding' },
    signer: 'ayman',
  }),
};

// ---------------------------------------------------------------------------
// Journey: connected, plan not seen
// ---------------------------------------------------------------------------

const connected_3h: EmailCopy = {
  key: 'connected_3h',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'حسابك انربط، والخطة تنتظر كم سؤال',
    preheader: 'كمّل الأسئلة ويطلع لك أول قرار في حسابك',
    blocks: [
      { type: 'p', text: 'ربطت حساب إعلانات قوقل في مُضاعِف، بس ما وصلت للخطة.' },
      {
        type: 'p',
        text: 'الأسئلة اللي بعد الربط كل وحدة بضغطة. منها يعرف مُضاعِف نوع نشاطك ووش يعتبر نجاح عندك، وبعدها تطلع خطتك وأول قرار فيها مفتوح لك.',
      },
    ],
    cta: { label: 'كمّل من وين وقفت', path: '/onboarding' },
    signer: 'team',
  }),
};

const connected_1d: EmailCopy = {
  key: 'connected_1d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'خطتك ما شفتها للحين',
    preheader: 'مُضاعِف قرأ حسابك وينتظرك تكمل',
    blocks: [
      { type: 'p', text: 'حسابك الإعلاني مربوط، والخطة ما فتحتها.' },
      {
        type: 'p',
        text: 'في آخر الأسئلة تطلع لك خطتك وأول قرار فيها، وإذا لقى مُضاعِف فلوس تروح على الفاضي في حسابك يحط لها تقدير شهري من أرقام آخر 30 يوم.',
      },
    ],
    cta: { label: 'شوف خطتي', path: '/onboarding' },
    signer: 'team',
  }),
};

// ---------------------------------------------------------------------------
// Journey: plan seen, no trial
// ---------------------------------------------------------------------------

const plan_ready_1d: EmailCopy = {
  key: 'plan_ready_1d',
  category: 'lifecycle',
  approved: false,
  requires: ['plan'],
  build: (facts) => {
    const plan = facts.plan;
    if (!plan || plan.decisionsTotal === 0) return null;
    const blocks: Block[] = [];
    const hasWaste = plan.wasteEstimate !== null && plan.wasteEstimate > 0;
    if (hasWaste) {
      blocks.push({
        type: 'stat',
        label: 'هدر شهري تقديري',
        value: money(plan.wasteEstimate as number, plan.currency),
        note: 'من أرقام آخر 30 يوم في حسابك',
      });
    }
    blocks.push({
      type: 'p',
      text: plan.firstDecisionTitle
        ? `أول قرار في خطتك مفتوح لك: ${clean(plan.firstDecisionTitle)}.`
        : 'أول قرار في خطتك مفتوح لك تشوفه بسببه كامل.',
    });
    const freeTrial = plan.trialEligible === true;
    if (plan.lockedCount > 0) {
      blocks.push({
        type: 'p',
        text: freeTrial
          ? `ومقفول فيها ${decisions(plan.lockedCount)} غيره. الخطة كلها تنفتح وتقدر تطبقها مع تجربتك المجانية 14 يوم.`
          : `ومقفول فيها ${decisions(plan.lockedCount)} غيره، وتنفتح كلها مع الاشتراك.`,
      });
    }
    blocks.push({ type: 'note', text: TRUST_LINE });
    return {
      subject: hasWaste
        ? `تقدير الهدر في حسابك: ${money(plan.wasteEstimate as number, plan.currency)} بالشهر`
        : 'خطتك جاهزة، وأول قرار فيها مفتوح لك',
      preheader: 'وأول قرار فيها مفتوح لك تشوفه الحين',
      blocks,
      cta: freeTrial
        ? { label: 'ابدأ 14 يوم مجاناً', path: PLAN_CHECKOUT_PATH }
        : { label: 'فعّل اشتراكك', path: PLAN_CHECKOUT_PATH },
      signer: 'team',
    };
  },
};

const plan_ready_3d: EmailCopy = {
  key: 'plan_ready_3d',
  category: 'lifecycle',
  approved: false,
  requires: ['plan'],
  // The whole text is about the free trial: skip anyone who cannot take it.
  build: (facts) => (facts.plan?.trialEligible !== true ? null : {
    subject: 'قبل ما تقرر عن التجربة',
    preheader: 'كيف تجرب 14 يوم وأنت ماسك كل شي بيدك',
    blocks: [
      { type: 'p', text: 'خطتك في مُضاعِف للحين مقفولة، وهذا طبيعي. محد يحط بطاقته على شي ما جربه.' },
      {
        type: 'p',
        text: 'التجربة 14 يوم مجاناً. خلالها كل قرار يجيك بسببه من أرقامك وأنت تعتمد أو ترفض، ولو ألغيت من داخل التطبيق قبل ما تخلص ما ينخصم شي.',
      },
      {
        type: 'note',
        text: 'شي لازم تعرفه قبل: مُضاعِف يشتغل على إعلانات قوقل بس. لو أغلب صرفك على سناب أو تيك توك ما بيشوفه.',
      },
    ],
    cta: { label: 'ابدأ 14 يوم مجاناً', path: PLAN_CHECKOUT_PATH },
    signer: 'team',
  }),
};

const plan_ready_7d: EmailCopy = {
  key: 'plan_ready_7d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'سؤال واحد عن خطتك',
    preheader: 'رد علي بكلمة، الرد يوصلني أنا',
    blocks: [
      { type: 'p', text: 'معك أيمن من مُضاعِف.' },
      {
        type: 'p',
        text: 'شفت خطتك قبل أسبوع وما بديت التجربة. ما راح أحاول أقنعك، بس ودي أفهم وش الناقص.',
      },
      {
        type: 'p',
        text: 'لو السعر، أو تبي أحد يكلمك قبل ما تبدأ، رد على هالإيميل وأشوف وش أقدر أسوي.',
      },
    ],
    cta: { label: 'افتح خطتي', path: '/home' },
    ps: `ولو الواتساب أسهل لك: ${SUPPORT_WHATSAPP_DISPLAY}`,
    signer: 'ayman',
  }),
};

// ---------------------------------------------------------------------------
// Journey: trialing
// ---------------------------------------------------------------------------

const trial_d1: EmailCopy = {
  key: 'trial_d1',
  category: 'lifecycle',
  approved: false,
  requires: ['trial'],
  build: (facts) => {
    const trial = facts.trial;
    if (!trial) return null;
    if (trial.approvedCount > 0) {
      return {
        subject: 'اعتمدت أول قرار، هذا اللي بعده',
        preheader: 'شوفة كل صبح تكفي',
        blocks: [
          { type: 'p', text: `في أول يوم من تجربتك اعتمدت ${decisions(trial.approvedCount)}.` },
          {
            type: 'p',
            text: 'اللي يفرق في الأيام الجاية إنك تفتح مُضاعِف كل صبح. قراءة اليوم قصيرة، والقرار اللي يحتاجك يكون فوق.',
          },
        ],
        cta: { label: 'افتح قراءة اليوم', path: '/home' },
        signer: 'team',
      };
    }
    const blocks: Block[] = [{ type: 'p', text: 'بدأت تجربتك في مُضاعِف، وللحين ما اعتمدت شي.' }];
    blocks.push({
      type: 'p',
      text:
        trial.pendingCount > 0
          ? `فيه ${decisions(trial.pendingCount)} ينتظرك الحين، وكل واحد مكتوب معه سببه من أرقام حسابك.`
          : 'مُضاعِف يقرأ حسابك وأول قرار يطلع لك في قراءة اليوم، مكتوب معه سببه من أرقام حسابك.',
    });
    blocks.push({ type: 'p', text: 'اعتمد اللي تقتنع فيه وارفض الباقي بدون حرج.' });
    return {
      subject: 'أول قرار في تجربتك ينتظرك',
      preheader: 'ولا شي يتغير إلا بضغطتك',
      blocks,
      cta: { label: 'افتح مُضاعِف', path: '/home' },
      signer: 'team',
    };
  },
};

const trial_d4: EmailCopy = {
  key: 'trial_d4',
  category: 'lifecycle',
  approved: false,
  requires: ['trial'],
  build: (facts) => {
    const trial = facts.trial;
    if (!trial) return null;
    const blocks: Block[] = [
      { type: 'stat', label: 'قرارات اعتمدتها', value: formatNumber(trial.approvedCount) },
      { type: 'stat', label: 'مفتوحة في خطتك', value: formatNumber(trial.pendingCount) },
    ];
    blocks.push({
      type: 'p',
      text:
        trial.approvedCount === 0
          ? 'للحين ما اعتمدت شي. مُضاعِف ما يحرك ولا ريال في حسابك بدون ضغطتك، فلو ما فتحته تخلص التجربة وأنت ما جربت.'
          : 'أي قرار اعتمدته ترجّعه من الرئيسية خلال 30 يوم لو ما عجبك أثره.',
    });
    if (trial.daysLeft !== null && trial.daysLeft > 0) {
      blocks.push({ type: 'note', text: `باقي على تجربتك ${days(trial.daysLeft)}.` });
    }
    return {
      subject:
        trial.approvedCount === 0
          ? 'تجربتك ماشية وما اعتمدت ولا قرار'
          : `اعتمدت ${decisions(trial.approvedCount)} في تجربتك`,
      preheader:
        trial.pendingCount > 0 ? `و${decisions(trial.pendingCount)} ينتظرك الحين` : 'وهذي وين وصلت',
      blocks,
      cta: { label: 'افتح قرارات اليوم', path: '/home' },
      signer: 'team',
    };
  },
};

const trial_d9: EmailCopy = {
  key: 'trial_d9',
  category: 'lifecycle',
  approved: false,
  requires: ['trial'],
  build: (facts) => {
    const trial = facts.trial;
    if (!trial) return null;
    const left = trial.daysLeft !== null && trial.daysLeft > 0 ? days(trial.daysLeft) : null;
    const blocks: Block[] = [
      {
        type: 'p',
        text: left
          ? `باقي على تجربتك ${left}، وبعدها يبدأ الاشتراك تلقائياً لو ما ألغيت.`
          : 'تجربتك قربت تخلص، وبعدها يبدأ الاشتراك تلقائياً لو ما ألغيت.',
      },
      {
        type: 'p',
        text:
          trial.approvedCount > 0
            ? `خلال التجربة اعتمدت ${decisions(trial.approvedCount)}، وأثرها يبان في ملخصك الأسبوعي.`
            : 'ما اعتمدت أي قرار للحين، يعني التجربة ما أعطتك شي تحكم عليه. جرّب قرار واحد على الأقل قبل ما تقرر.',
      },
      { type: 'note', text: 'ولو قررت ما تكمل، الإلغاء بضغطة من صفحة الاشتراك، وقبل نهاية التجربة ما ينخصم شي.' },
    ];
    return {
      subject: 'قبل ما تقرر تكمل أو توقف',
      preheader: left ? `باقي ${left}، وهذي حصيلة تجربتك` : 'هذي حصيلة تجربتك',
      blocks,
      cta: trial.approvedCount > 0 ? { label: 'افتح مُضاعِف', path: '/home' } : { label: 'جرّب قرار واحد', path: '/home' },
      signer: 'team',
    };
  },
};

// ---------------------------------------------------------------------------
// Journey: trial ended without a payment
// ---------------------------------------------------------------------------

const trial_lapsed_2d: EmailCopy = {
  key: 'trial_lapsed_2d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'تجربتك خلصت، وخطتك محفوظة',
    preheader: 'لو رجعت تكمل من نفس المكان',
    blocks: [
      { type: 'p', text: 'خلصت تجربتك في مُضاعِف وما كملت الاشتراك.' },
      { type: 'p', text: 'حسابك الإعلاني باقي مربوط وخطتك محفوظة، فلو رجعت ما تبدأ من الصفر.' },
      { type: 'p', text: 'ولو فيه شي ما ضبط معك في التجربة، رد على هالإيميل وقل لنا. نبي نعرفه.' },
    ],
    cta: { label: 'رجّعني لخطتي', path: '/home' },
    signer: 'team',
  }),
};

const trial_lapsed_14d: EmailCopy = {
  key: 'trial_lapsed_14d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'مين يراجع حملاتك هالأيام؟',
    preheader: 'سؤال واحد بعد أسبوعين من تجربتك',
    blocks: [
      { type: 'p', text: 'معك أيمن. مر أسبوعين من آخر تجربة لك في مُضاعِف.' },
      {
        type: 'p',
        text: 'حملاتك على الأغلب للحين شغالة وتصرف كل يوم. لو عندك أحد يراجعها يومياً، ممتاز وما يحتاج ترد. ولو لا، مُضاعِف يرجع يقرأها ويطلع لك قرار اليوم من أول ما تشترك.',
      },
    ],
    cta: { label: 'افتح خطتي', path: '/home' },
    signer: 'ayman',
  }),
};

// ---------------------------------------------------------------------------
// Journey: paid at least once, then cancelled
// ---------------------------------------------------------------------------

const canceled_1d: EmailCopy = {
  key: 'canceled_1d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'اشتراكك في مُضاعِف توقف',
    preheader: 'سؤال واحد من أيمن، والرد يوصلني أنا',
    blocks: [
      { type: 'p', text: 'معك أيمن. اشتراكك في مُضاعِف توقف.' },
      {
        type: 'p',
        text: 'لو كان هذا قرارك، ودي أعرف السبب بكلمتين، لأن ردك يحدد وش نصلح أول. رد على هالإيميل مباشرة، وما بحاول أرجعك بخصم.',
      },
      { type: 'p', text: 'ولو توقف بسبب البطاقة وأنت ما تدري، ترجع تفعّله من صفحة الاشتراك.' },
    ],
    ps: 'ولو حبيت ترجع يوم، حسابك وخطتك محفوظين.',
    signer: 'ayman',
  }),
};

const canceled_30d: EmailCopy = {
  key: 'canceled_30d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    // Mentions the chat experience shipped on 13 to 14 Oct 2026. Re-read before approving if the product changed.
    subject: 'مُضاعِف تغيّر من آخر مرة',
    preheader: 'صار محادثة وحدة تسأله فيها بكلامك',
    blocks: [
      { type: 'p', text: 'من وقت ما ألغيت اشتراكك، مُضاعِف تغيّر.' },
      {
        type: 'p',
        text: 'بدل اللوحة والأقسام صار محادثة وحدة: يبدأ معك كل يوم بقراءة حسابك وقراراتها، وتسأله بكلامك ويرد من أرقامك.',
      },
      { type: 'note', text: TRUST_LINE },
    ],
    cta: { label: 'شوف وش تغيّر', path: '/home' },
    signer: 'team',
  }),
};

// ---------------------------------------------------------------------------
// Journey: payment failing
// ---------------------------------------------------------------------------

const past_due_3d: EmailCopy = {
  key: 'past_due_3d',
  category: 'lifecycle',
  approved: false,
  build: () => ({
    subject: 'اشتراكك موقوف، والسبب البطاقة',
    preheader: 'آخر دفعة ما مرت، وحملاتك في قوقل ما تأثرت',
    blocks: [
      { type: 'p', text: 'آخر دفعة لاشتراكك في مُضاعِف ما مرت، فوقف الاشتراك.' },
      {
        type: 'p',
        text: 'يعني ما توصلك قراءة اليوم ولا القرارات لين تتحدث البطاقة. حملاتك نفسها في قوقل ما تتأثر، تبقى شغالة زي ما هي.',
      },
      {
        type: 'note',
        text: 'أحياناً البنك يرفض العملية لأنها دولية. يتحل بمكالمة للبنك أو ببطاقة ثانية.',
      },
    ],
    cta: { label: 'حدّث بطاقتك وكمّل', path: '/billing' },
    signer: 'team',
  }),
};

// ---------------------------------------------------------------------------
// Recurring: weekly report (trialing and active subscribers)
// ---------------------------------------------------------------------------

const weekly_report: EmailCopy = {
  key: 'weekly_report',
  category: 'weekly_report',
  approved: false,
  requires: ['weekly'],
  build: (facts) => {
    const week = facts.weekly;
    if (!week) return null;
    const hasNumbers = week.spend !== null || week.conversions !== null;
    if (!hasNumbers && week.highlights.length === 0) return null;

    const blocks: Block[] = [];
    if (week.spend !== null) {
      blocks.push({
        type: 'stat',
        label: 'الصرف',
        value: money(week.spend, week.currency),
        note: week.prevSpend !== null ? `الأسبوع اللي قبله ${money(week.prevSpend, week.currency)}` : undefined,
      });
    }
    if (week.conversions !== null) {
      blocks.push({
        type: 'stat',
        label: 'التحويلات',
        value: formatNumber(Math.round(week.conversions)),
        note:
          week.prevConversions !== null
            ? `الأسبوع اللي قبله ${formatNumber(Math.round(week.prevConversions))}`
            : undefined,
      });
    }
    if (week.costPerConversion !== null && week.conversions !== null && week.conversions > 0) {
      blocks.push({ type: 'stat', label: 'تكلفة التحويل', value: money(week.costPerConversion, week.currency) });
    }
    const highlights = week.highlights.map(clean).filter(Boolean).slice(0, 3);
    if (highlights.length > 0) {
      blocks.push({ type: 'p', text: 'اللي لاحظه مُضاعِف هالأسبوع:' });
      blocks.push({ type: 'list', items: highlights });
    }
    if (week.pendingCount > 0) {
      blocks.push({ type: 'p', text: `فيه ${decisions(week.pendingCount)} ينتظرك في مُضاعِف.` });
    }
    blocks.push({
      type: 'note',
      text: `الأرقام من حساب إعلانات قوقل حقك، من ${formatDateAr(week.periodStart, { year: false })} إلى ${formatDateAr(week.periodEnd, { year: false })}.`,
    });

    const conv = week.conversions !== null ? Math.round(week.conversions) : null;
    return {
      subject:
        conv !== null && week.spend !== null
          ? `أسبوعك في إعلانات قوقل: ${conversionsWord(conv)} بـ ${money(week.spend, week.currency)}`
          : 'ملخص أسبوعك في إعلانات قوقل',
      preheader: week.pendingCount > 0 ? `و${decisions(week.pendingCount)} ينتظرك` : 'ووش تغيّر عن الأسبوع اللي قبله',
      blocks,
      cta: week.pendingCount > 0 ? { label: 'افتح القرارات', path: '/home' } : { label: 'افتح مُضاعِف', path: '/home' },
      signer: 'team',
    };
  },
};

// ---------------------------------------------------------------------------
// Transactional (sent from the Stripe webhook; already live, not gated)
// ---------------------------------------------------------------------------

const tx_subscription_welcome: EmailCopy = {
  key: 'tx_subscription_welcome',
  category: 'transactional',
  approved: true,
  build: (facts) => {
    const trialEndsAt = facts.billing?.trialEndsAt ?? null;
    if (trialEndsAt) {
      return {
        subject: 'تجربتك في مُضاعِف بدأت',
        preheader: 'المحادثة والقرارات انفتحت لك',
        blocks: [
          { type: 'p', text: 'تفعّلت تجربتك المجانية 14 يوم.' },
          {
            type: 'p',
            text: 'المحادثة مع مُضاعِف انفتحت، والقرارات اللي كانت مقفولة في خطتك صارت قدامك. كل قرار يجيك بسببه، وما يتنفذ إلا لما تعتمده.',
          },
          {
            type: 'note',
            text: `التجربة تنتهي ${formatDateAr(trialEndsAt)}. لو ألغيت من صفحة الاشتراك قبلها ما ينخصم شي.`,
          },
        ],
        cta: { label: 'افتح مُضاعِف', path: '/home' },
        signer: 'team',
      };
    }
    return {
      subject: 'اشتراكك في مُضاعِف تفعّل',
      preheader: 'المحادثة والقرارات مفتوحة لك',
      blocks: [
        { type: 'p', text: 'تفعّل اشتراكك في مُضاعِف.' },
        {
          type: 'p',
          text: 'المحادثة مع مُضاعِف مفتوحة، وكل قرار يجيك بسببه من أرقام حسابك وما يتنفذ إلا لما تعتمده.',
        },
        { type: 'note', text: 'تلغي متى ما بغيت بضغطة من صفحة الاشتراك.' },
      ],
      cta: { label: 'افتح مُضاعِف', path: '/home' },
      signer: 'team',
    };
  },
};

const tx_trial_ending: EmailCopy = {
  key: 'tx_trial_ending',
  category: 'transactional',
  approved: true,
  requires: ['billing'],
  build: (facts) => {
    const endsAt = facts.billing?.trialEndsAt ?? null;
    const date = endsAt ? formatDateAr(endsAt) : null;
    const plan = facts.billing?.planName ? ` على باقة ${facts.billing.planName}` : '';
    return {
      subject: date ? `تجربتك في مُضاعِف تنتهي ${date}` : 'تجربتك في مُضاعِف قربت تنتهي',
      preheader: 'لو بتكمل ما تحتاج تسوي شي',
      blocks: [
        {
          type: 'p',
          text: date
            ? `تجربتك المجانية تنتهي ${date}، وبعدها يبدأ الاشتراك تلقائياً${plan}.`
            : `تجربتك المجانية تنتهي خلال أيام، وبعدها يبدأ الاشتراك تلقائياً${plan}.`,
        },
        { type: 'p', text: 'لو بتكمل ما تحتاج تسوي شي.' },
        { type: 'note', text: 'ولو قررت توقف، ألغِ من صفحة الاشتراك قبل التاريخ وما ينخصم شي.' },
      ],
      cta: { label: 'إدارة الاشتراك', path: '/billing' },
      signer: 'team',
    };
  },
};

const tx_payment_failed: EmailCopy = {
  key: 'tx_payment_failed',
  category: 'transactional',
  approved: true,
  build: () => ({
    subject: 'دفعة اشتراكك في مُضاعِف ما مرت',
    preheader: 'حدّث البطاقة عشان ما توقف القرارات',
    blocks: [
      { type: 'p', text: 'حاولنا نجدد اشتراكك والدفعة ما مرت.' },
      {
        type: 'p',
        text: 'حدّث بطاقتك من صفحة الاشتراك عشان ما توقف قراءة اليوم والقرارات. حملاتك نفسها في قوقل ما تتأثر.',
      },
      { type: 'note', text: 'أحياناً البنك يرفض العملية لأنها دولية، ويتحل بمكالمة للبنك أو ببطاقة ثانية.' },
    ],
    cta: { label: 'حدّث بطاقتك', path: '/billing' },
    signer: 'team',
  }),
};

// ---------------------------------------------------------------------------
// Broadcasts (config/email-broadcasts.ts)
// ---------------------------------------------------------------------------

const broadcast_chat_relaunch: EmailCopy = {
  key: 'broadcast_chat_relaunch',
  category: 'product_news',
  approved: false,
  build: () => ({
    subject: 'مُضاعِف صار محادثة',
    preheader: 'تربط حسابك وتسأله بكلامك، والباقي عليه',
    blocks: [
      { type: 'p', text: 'معك أيمن من مُضاعِف. سجلت عندنا قبل وما ربطت حسابك.' },
      {
        type: 'p',
        text: 'وقتها كان مُضاعِف لوحة مليانة أرقام وأقسام، وبصراحة كانت معقدة. الحين صار محادثة وحدة: تربط حساب إعلانات قوقل، يسألك كم سؤال كل واحد بضغطة، ويطلع لك خطة أول قرار فيها مفتوح لك.',
      },
      { type: 'note', text: TRUST_LINE },
    ],
    cta: { label: 'جرّب الشكل الجديد', path: '/onboarding' },
    ps: `وإذا ما عندك حساب إعلانات في قوقل، راسلني واتساب ${SUPPORT_WHATSAPP_DISPLAY} ونفتحه معك ببلاش.`,
    signer: 'ayman',
  }),
};

export const EMAIL_COPY: Record<CopyKey, EmailCopy> = {
  welcome_ads_connect,
  registered_1d,
  registered_3d,
  registered_7d,
  connected_3h,
  connected_1d,
  plan_ready_1d,
  plan_ready_3d,
  plan_ready_7d,
  trial_d1,
  trial_d4,
  trial_d9,
  trial_lapsed_2d,
  trial_lapsed_14d,
  canceled_1d,
  canceled_30d,
  past_due_3d,
  weekly_report,
  tx_subscription_welcome,
  tx_trial_ending,
  tx_payment_failed,
  broadcast_chat_relaunch,
};

/** Preview helper for tests and the operator: every copy built with the given facts. */
export function buildAll(facts: EmailFacts): Array<{ key: CopyKey; email: BuiltEmail | null }> {
  return (Object.keys(EMAIL_COPY) as CopyKey[]).map((key) => ({ key, email: EMAIL_COPY[key].build(facts) }));
}
