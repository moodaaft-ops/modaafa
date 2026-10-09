import type {
  ChatCard,
  ChatIntent,
  ChatQuickAction,
  ChatRecommendation,
  ChatState,
  ChatTurn,
} from './contracts';
import type { Understanding } from './understand';

const AR_DIGITS = /[٠-٩]/g;
function normalize(text: string) {
  return text
    .replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .toLowerCase()
    .trim();
}

const CONNECT = /(اربط|ربط|وصل|توصيل|اضيف حساب|حساب جوجل|حسابي|connect|link)/;
const AUDIT = /(افحص|فحص|شيك|راجع|حلل|تحليل|قيم|audit|check)/;
const RERUN = /(اعد|عيد|مره ثانيه|مرة ثانية|من جديد|حدث|rerun|again)/;
const RESULT = /(وش (طلع|النتيجه|وضع)|النتيجه|نتيجه|وضع|وضعي|كيف حسابي|كيف الحساب|ملخص|result|status)/;
const RECOMMEND = /(توصي|اقتراح|وش اسوي|ايش اسوي|وش افعل|ابدا|الخطوه|حسن|تحسين|اصلح|يوفر|هدر)/;
const APPLY = /(طبق|نفذ|فعل التوصي|وافق|apply|execute|approve)/;
const EXPLAIN = /(ليش|لماذا|وش يعني|ايش يعني|اشرح|فهمني|وضحلي|وضح لي|ما معنى|why|explain)/;
const BULK = /(كل |الكل|جميع|كلها|كلهم|all)/;
/** A bare yes is never an approval: approval is a button on a previewed change. */
const BARE_CONFIRM = /^(اوافق|وافقت|موافق|نعم|ايوه|اي|اكيد|تمام|نفذ|نفذها|طبق|طبقها|ok|yes)[ .!؟?]*$/;

export function classify(message: string): ChatIntent {
  const m = normalize(message);
  if (!m) return 'ambiguous';
  // Apply wins over everything: a state change must be explicit.
  if (APPLY.test(m)) return 'apply';
  if (EXPLAIN.test(m)) return 'explain';
  if (RERUN.test(m) && AUDIT.test(m)) return 'rerun';
  if (AUDIT.test(m)) return 'run_audit';
  if (RECOMMEND.test(m)) return 'recommend';
  if (RESULT.test(m)) return 'show_result';
  if (CONNECT.test(m)) return 'connect';
  return 'ambiguous';
}

function money(value: number | null) {
  if (value == null) return null;
  return `${Math.round(value).toLocaleString('en-US')} دولار`;
}

function auditCard(state: ChatState): ChatCard | null {
  const a = state.latestAudit;
  if (!a) return null;
  return {
    kind: 'audit_result',
    healthScore: a.healthScore,
    findingsCount: a.findingsCount,
    estimatedMonthlyWaste: a.estimatedMonthlyWaste,
    ranAt: a.ranAt,
  };
}

function recCard(r: ChatRecommendation): ChatCard {
  return {
    kind: 'recommendation',
    id: r.id,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
  };
}

function pendingRecs(state: ChatState) {
  const order = { critical: 0, medium: 1, growth: 2 } as const;
  return state.recommendations
    .filter((r) => r.status === 'pending' || r.status === 'approved')
    .sort((a, b) => (order[a.severity ?? 'growth'] ?? 2) - (order[b.severity ?? 'growth'] ?? 2));
}

const DASH: ChatQuickAction = {
  label: 'افتح لوحة التفاصيل',
  action: { type: 'open_dashboard', href: '/dashboard' },
};

const NO_ACCOUNT: ChatTurn = {
  intent: 'connect',
  reply:
    'ما عندي حساب إعلانات مربوط معك للحين، فما أقدر أقول لك شيء عن أداءك. اربط حساب Google Ads وأفحصه لك مجاناً ونطلع بالنتيجة بكلام بسيط.',
  cards: [],
  actions: [{ label: 'اربط حساب Google Ads', action: { type: 'connect_account', href: '/onboarding' } }],
};

/**
 * Pure turn planner. It decides what to say and which buttons to offer; it
 * never mutates anything. Every state change is a button the user presses,
 * executed by the existing guarded routes.
 */
export function planTurn(message: string, state: ChatState, understood?: Understanding | null): ChatTurn {
  const intent: ChatIntent =
    understood && understood.intent !== 'ambiguous' ? understood.intent : classify(message);
  const pickIndex = understood?.recommendationIndex ?? 0;

  // Guidance needs no account: it is general marketing help, answered once and
  // followed by the honest next step.
  if (intent === 'guidance' && understood?.answer) {
    const linked = state.accountLinked && state.customerId;
    return {
      intent,
      reply: understood.answer,
      cards: [],
      actions: linked
        ? [{ label: 'وش وضع حسابي؟', action: { type: 'say', text: 'وش وضع حسابي' } }, DASH]
        : [{ label: 'اربط حساب Google Ads', action: { type: 'connect_account', href: '/onboarding' } }],
    };
  }

  if (!state.accountLinked || !state.customerId) {
    // Even "apply" without an account is answered with the truth, not a result.
    return { ...NO_ACCOUNT, intent: intent === 'ambiguous' ? 'connect' : intent };
  }

  const account = state.accountName ? `حساب «${state.accountName}»` : 'حسابك';
  const exhausted = !state.subscriptionActive && state.freeAudit === 'exhausted';
  const runAudit: ChatQuickAction = exhausted
    ? { label: 'فعّل الاشتراك لفحص جديد', action: { type: 'subscribe', href: '/billing' } }
    : state.freeAudit === 'in_progress'
      ? { label: 'شيّك على النتيجة', action: { type: 'say', text: 'وش وضع حسابي' } }
      : {
          label: state.latestAudit ? 'أعد الفحص' : 'ابدأ الفحص المجاني',
          action: { type: 'run_audit', customerId: state.customerId },
        };

  if (intent === 'connect') {
    return {
      intent,
      reply: `${account} مربوط وجاهز. تبي أفحصه لك الحين؟`,
      cards: [],
      actions: [runAudit, DASH],
    };
  }

  if (intent === 'run_audit' || intent === 'rerun') {
    if (exhausted) {
      return {
        intent,
        reply: `خلصت الفحوصات المجانية لـ${account}، وهذي آخر نتيجة عندنا. القراءة والشرح تبقى مجانية، والفحص الجديد يحتاج اشتراك.`,
        cards: state.latestAudit ? [auditCard(state)!] : [],
        actions: [runAudit, DASH],
      };
    }
    if (state.freeAudit === 'in_progress') {
      return {
        intent,
        reply: `فيه فحص شغال الحين على ${account}. انتظر دقائق وأعرض لك النتيجة.`,
        cards: [],
        actions: [runAudit],
      };
    }
    if (intent === 'run_audit' && state.latestAudit) {
      const card = auditCard(state)!;
      return {
        intent,
        reply: `سبق وفحصنا ${account}، وهذي آخر نتيجة. لو تبي فحص جديد اضغط «أعد الفحص»، وإعادة واحدة لكل حساب مجانية.`,
        cards: [card],
        actions: [runAudit, DASH],
      };
    }
    return {
      intent,
      reply: `تمام، بفحص ${account} كامل وأرجع لك بنتيجة مفهومة. ياخذ دقائق قليلة وتقدر تلغي في أي لحظة.`,
      cards: [],
      actions: [runAudit],
    };
  }

  if (!state.latestAudit) {
    // Result / recommend / apply / ambiguous all hit the same honest wall.
    return {
      intent: intent === 'ambiguous' ? 'run_audit' : intent,
      reply: `ما فيه فحص لـ${account} للحين، فما عندي نتائج أعرضها لك ولا أبي أخترع أرقام. أول خطوة نفحصه، وهو مجاني.`,
      cards: [],
      actions: [runAudit],
    };
  }

  const result = auditCard(state)!;
  const pending = pendingRecs(state);

  if (intent === 'show_result') {
    const a = state.latestAudit;
    const waste = money(a.estimatedMonthlyWaste);
    const lines = [
      a.healthScore != null ? `صحة الحساب ${a.healthScore} من 100.` : 'ما طلعت درجة صحة لهذا الفحص.',
      `لقينا ${a.findingsCount} ملاحظة.`,
      waste ? `التقدير ان الهدر الشهري قرابة ${waste}.` : 'ما قدرنا نقدّر الهدر بدقة من البيانات المتوفرة.',
    ];
    return {
      intent,
      reply: `${lines.join(' ')} ${pending.length ? 'جهزت لك توصيات، تبي أول واحدة؟' : 'ما فيه توصيات معلقة الحين.'}`,
      cards: [result],
      actions: pending.length
        ? [{ label: 'وريني أهم توصية', action: { type: 'show_recommendation', recommendationId: pending[0].id } }, DASH]
        : [runAudit, DASH],
    };
  }

  if (intent === 'recommend') {
    if (!pending.length) {
      return {
        intent,
        reply: 'الفحص الأخير ما طلع منه توصيات تنتظر قرارك. لو غيّرت شيء في الحساب أعد الفحص.',
        cards: [result],
        actions: [runAudit, DASH],
      };
    }
    const top = pending[0];
    return {
      intent,
      reply: `أهم خطوة الحين: «${top.title}». هذي معاينة فقط، ما تغيّر شيء في حسابك قبل ما توافق.`,
      cards: [recCard(top)],
      actions: [
        { label: 'أبي أطبقها', action: { type: 'request_apply', recommendationId: top.id } },
        DASH,
      ],
    };
  }

  if (intent === 'explain') {
    const target = pending[pickIndex] ?? pending[0];
    const a = state.latestAudit;
    const reply =
      understood?.answer ??
      (target
        ? `«${target.title}»: ${target.description?.trim() || 'التفاصيل الكاملة في لوحة التفاصيل.'} هذا شرح للقراءة فقط، ما تغيّر شيء في حسابك.`
        : `صحة الحساب ${a?.healthScore ?? 'غير محسوبة'} من 100 و${a?.findingsCount ?? 0} ملاحظة. ما عندي توصية معلقة أشرحها الحين.`);
    return {
      intent,
      reply,
      cards: target ? [recCard(target)] : [result],
      actions: target
        ? [{ label: 'أبي أطبقها', action: { type: 'request_apply', recommendationId: target.id } }, DASH]
        : [runAudit, DASH],
    };
  }

  if (intent === 'apply') {
    // "نفذ كل شي": one change per confirmation, never a bulk run.
    if (BULK.test(normalize(message)) && pending.length > 1) {
      return {
        ...planApply(state, pending[0]),
        reply:
          'أنفذ توصية وحدة كل مرة وبمعاينة قبلها، عشان ما يتغير حسابك بشي ما شفته. نبدأ بأهم وحدة:',
      };
    }
    const target = pending[pickIndex] ?? pending[0];
    if (!target) {
      return {
        intent,
        reply: 'ما عندي توصية جاهزة للتطبيق. أعرض لك آخر نتيجة وتشوف وش نسوي.',
        cards: [result],
        actions: [runAudit, DASH],
      };
    }
    const planned = planApply(state, target);
    if (BARE_CONFIRM.test(normalize(message))) {
      return {
        ...planned,
        reply: `الموافقة عندي بالزر مو بالكلام، حماية لحسابك. ${planned.reply}`,
      };
    }
    return planned;
  }

  // Ambiguous: ask, do nothing, offer the three real paths.
  return {
    intent: 'ambiguous',
    reply: 'ما فهمت وش تقصد بالضبط، وما أبي أسوي شيء بحسابك على التخمين. وش تفضل؟',
    cards: [],
    actions: [
      { label: 'وش وضع حسابي؟', action: { type: 'say', text: 'وش وضع حسابي' } },
      { label: 'وش أحسن خطوة؟', action: { type: 'say', text: 'وش التوصيات' } },
      runAudit,
    ],
  };
}

/** Apply gate shared by chat text and the request_apply button. */
export function planApply(state: ChatState, rec: ChatRecommendation): ChatTurn {
  if (!state.subscriptionActive) {
    return {
      intent: 'apply',
      reply:
        'التطبيق على حسابك يحتاج اشتراك فعّال، أما الفحص والمعاينة فتبقى مجانية. فعّل الاشتراك وأرجع لنفس التوصية.',
      cards: [recCard(rec), { kind: 'subscription_required', reason: 'subscription_required' }],
      actions: [{ label: 'فعّل الاشتراك', action: { type: 'subscribe', href: '/billing' } }, DASH],
    };
  }
  if (!rec.executable) {
    return {
      intent: 'apply',
      reply:
        'هذي التوصية تحتاج مراجعة يدوية منك، ما أقدر أنفذها تلقائياً. افتح لوحة التفاصيل وسوّها بإيدك.',
      cards: [recCard(rec)],
      actions: [DASH],
    };
  }
  if (rec.status === 'approved') {
    return {
      intent: 'apply',
      reply: 'وافقت عليها قبل. آخر ضغطة وتنفذ على حسابك فعلياً.',
      cards: [approvalCard(rec)],
      actions: [{ label: 'نفّذ الحين', action: { type: 'execute', recommendationId: rec.id } }],
    };
  }
  return {
    intent: 'apply',
    reply: 'قبل التنفيذ لازم توافق على التغيير. هذا اللي بيصير بالضبط:',
    cards: [approvalCard(rec)],
    actions: [{ label: 'أوافق على التغيير', action: { type: 'approve', recommendationId: rec.id } }],
  };
}

function approvalCard(rec: ChatRecommendation): ChatCard {
  return {
    kind: 'approval',
    recommendationId: rec.id,
    title: rec.title,
    changes: [rec.description?.trim() || 'التغيير موصوف في تفاصيل التوصية بلوحة التفاصيل.'],
  };
}
