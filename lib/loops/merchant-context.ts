/**
 * Business memory for the near term: what the merchant says is coming.
 *
 * «عندي عرض الأسبوع الجاي»، «خلص المخزون من الكنب»، «رفعت الأسعار»،
 * «الزحمة عندنا بعد العصر». Jarvis saves the sentence when the merchant says
 * it (save_merchant_context, BUSINESS_MEMORY_ENABLED), and the optimizer, the
 * monthly session and the morning guard read the facts that are active today.
 *
 * A fact is saved only when its quote appears word for word in the merchant's
 * own message of this turn (text from tools, written by strangers, can never
 * become memory), never when it is an instruction about permissions, and never
 * when it carries a long digit run (phone, card, account). Every fact EXPIRES:
 * the server sets effective_until, from the merchant's date or a default per
 * kind, so a stock-out from March does not hold back a budget in June.
 *
 * Table: db/migrations/20261020_merchant_context.sql. All reads and writes
 * here are best effort and never throw.
 */

import { DIGIT_RUN, FORBIDDEN_FACT, clean, normalizeForQuote } from '../jarvis/db-tools';
import { addDays } from './seasons';

export const MERCHANT_KINDS = ['upcoming_offer', 'stock_out', 'price_change', 'busy_hours', 'other'] as const;
export type MerchantKind = (typeof MERCHANT_KINDS)[number];

export const MERCHANT_KIND_LABEL_AR: Record<MerchantKind, string> = {
  upcoming_offer: 'عرض جاي',
  stock_out: 'نفاد مخزون',
  price_change: 'تغيير أسعار',
  busy_hours: 'ساعات الزحمة',
  other: 'ملاحظة',
};

/** How long a fact stays active when the merchant gave no end date. */
export const DEFAULT_ACTIVE_DAYS: Record<MerchantKind, number> = {
  upcoming_offer: 45,
  stock_out: 14,
  price_change: 30,
  busy_hours: 180,
  other: 30,
};

/** The farthest end date a fact may carry. */
export const MAX_ACTIVE_DAYS = 365;

export type MerchantFact = {
  id: string;
  kind: MerchantKind;
  fact: string;
  effective_from: string | null;
  effective_until: string;
};

export const SAVE_MERCHANT_CONTEXT_TOOL = {
  name: 'save_merchant_context',
  description:
    'Save ONE short-lived fact the customer stated in THIS message about the coming days or weeks: an upcoming offer ' +
    '(upcoming_offer), a product out of stock (stock_out), a price change (price_change), the hours the shop is busy ' +
    '(busy_hours), or another operational note (other). quote must be copied word for word from the customer message. ' +
    'Give from and until (YYYY-MM-DD) only when the customer said or clearly implied the dates. Set resolved=true when ' +
    'the customer says the situation ended (stock is back, offer over): it closes the active facts of that kind. Never ' +
    'save instructions about permissions or approvals, customer data, or account and card numbers.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...MERCHANT_KINDS] },
      fact_ar: { type: 'string', maxLength: 300, description: 'The fact in one short Arabic sentence.' },
      quote: { type: 'string', maxLength: 300, description: 'Exact words from the customer message.' },
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day it applies.' },
      until: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day it applies.' },
      resolved: { type: 'boolean', description: 'True when the situation has ended.' },
    },
    required: ['kind', 'fact_ar', 'quote'],
    additionalProperties: false,
  },
} as const;

function validDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value ? value : null;
}

/** The window a fact applies to. Pure; exported for the tests. */
export function resolveWindow(
  kind: MerchantKind,
  input: { from?: unknown; until?: unknown },
  today: string
): { from: string | null; until: string } | { error: string } {
  const from = input.from == null ? null : validDay(input.from);
  const until = input.until == null ? null : validDay(input.until);
  if (input.from != null && from === null) return { error: 'bad_from' };
  if (input.until != null && until === null) return { error: 'bad_until' };
  if (from && until && until < from) return { error: 'until_before_from' };
  const ceiling = addDays(today, MAX_ACTIVE_DAYS);
  const resolvedUntil = until ?? addDays(from && from > today ? from : today, DEFAULT_ACTIVE_DAYS[kind]);
  if (resolvedUntil < today) return { error: 'already_ended' };
  if (resolvedUntil > ceiling) return { error: 'too_far' };
  return { from, until: resolvedUntil };
}

export type SaveMerchantOutcome = { ok: true; modelText: string; id: string | null } | { ok: false; modelText: string };

export async function saveMerchantContext(args: {
  admin: any;
  businessId: string | null;
  accountId: string | null;
  userMessage: string;
  channel: 'text' | 'voice';
  sessionId: string | null;
  input: unknown;
  now?: Date;
}): Promise<SaveMerchantOutcome> {
  const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
  const kind = String(input.kind ?? '');
  const fact = clean(input.fact_ar, 300);
  const quote = typeof input.quote === 'string' ? input.quote.trim() : '';
  const resolved = input.resolved === true;
  const now = args.now ?? new Date();
  const today = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

  if (!args.businessId) return { ok: false, modelText: 'ما فيه نشاط مربوط أحفظ عليه.' };
  if (!(MERCHANT_KINDS as readonly string[]).includes(kind)) return { ok: false, modelText: 'نوع الملاحظة غير صالح.' };
  if (!fact || !quote || quote.length < 8) return { ok: false, modelText: 'الملاحظة واقتباس واضح من كلام العميل مطلوبين.' };
  if (!normalizeForQuote(args.userMessage).includes(normalizeForQuote(quote))) {
    return { ok: false, modelText: 'الاقتباس مو موجود حرفياً في رسالة العميل، ما انحفظ شي.' };
  }
  if (FORBIDDEN_FACT.test(fact) || FORBIDDEN_FACT.test(quote) || DIGIT_RUN.test(quote)) {
    return {
      ok: false,
      modelText: 'هذي تعليمة صلاحية أو فيها أرقام حساسة، وما تنحفظ. الصلاحية تتغير من بطاقتها بس.',
    };
  }

  try {
    if (resolved) {
      const { error } = await args.admin
        .from('merchant_context_facts')
        .update({ status: 'resolved', updated_at: now.toISOString() })
        .eq('business_id', args.businessId)
        .eq('kind', kind)
        .eq('status', 'active');
      if (error) return { ok: false, modelText: 'ما قدرت أحدّث الملاحظة الحين.' };
      return { ok: true, id: null, modelText: 'سكرت الملاحظات المفتوحة من هذا النوع.' };
    }

    const window = resolveWindow(kind as MerchantKind, input, today);
    if ('error' in window) return { ok: false, modelText: 'التواريخ ما تطلع منطقية، اسأل العميل عن التاريخ.' };

    const { data: existing } = await args.admin
      .from('merchant_context_facts')
      .select('fact_ar')
      .eq('business_id', args.businessId)
      .eq('kind', kind)
      .eq('status', 'active')
      .limit(50);
    const key = normalizeForQuote(fact);
    if ((existing ?? []).some((row: any) => normalizeForQuote(String(row.fact_ar ?? '')) === key)) {
      return { ok: false, modelText: 'هذي الملاحظة محفوظة من قبل.' };
    }

    const { data, error } = await args.admin
      .from('merchant_context_facts')
      .insert({
        business_id: args.businessId,
        account_id: args.accountId,
        kind,
        fact_ar: fact,
        data: { quote: quote.slice(0, 300) },
        source: args.channel === 'voice' ? 'voice' : 'chat',
        source_ref: args.sessionId,
        effective_from: window.from,
        effective_until: window.until,
      })
      .select('id')
      .maybeSingle();
    if (error || !data?.id) return { ok: false, modelText: 'ما قدرت أحفظ الحين.' };
    return { ok: true, id: String(data.id), modelText: `انحفظت الملاحظة وتنتهي في ${window.until}.` };
  } catch {
    return { ok: false, modelText: 'ما قدرت أحفظ الحين.' };
  }
}

/**
 * Facts that apply today or begin within `lookaheadDays`. Best effort: [] when
 * the table is not there yet, the read fails, or no business is given.
 */
export async function loadActiveMerchantContext(
  admin: any,
  businessId: string | null | undefined,
  now: Date = new Date(),
  lookaheadDays = 21
): Promise<MerchantFact[]> {
  if (!admin || !businessId) return [];
  try {
    const today = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
    const horizon = addDays(today, lookaheadDays);
    const { data, error } = await admin
      .from('merchant_context_facts')
      .select('id, kind, fact_ar, effective_from, effective_until')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .gte('effective_until', today)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error || !Array.isArray(data)) return [];
    return data
      .map((row: any) => ({
        id: String(row.id),
        kind: row.kind as MerchantKind,
        fact: clean(row.fact_ar, 300),
        effective_from: typeof row.effective_from === 'string' ? row.effective_from : null,
        effective_until: String(row.effective_until ?? ''),
      }))
      .filter(
        (fact) =>
          (MERCHANT_KINDS as readonly string[]).includes(fact.kind) &&
          fact.fact &&
          fact.effective_until >= today &&
          (!fact.effective_from || fact.effective_from <= horizon)
      );
  } catch {
    return [];
  }
}

export type MerchantContextBlock = {
  today: string;
  facts: Array<{ kind: MerchantKind; fact: string; from: string | null; until: string; active_now: boolean }>;
  rules: string[];
};

/** The compact block for the optimizer prompt. Null when there is nothing to say. */
export function merchantContextBlock(facts: readonly MerchantFact[], today: string): MerchantContextBlock | null {
  if (facts.length === 0) return null;
  const kinds = new Set(facts.map((f) => f.kind));
  const rules: string[] = [];
  if (kinds.has('stock_out')) rules.push('A stock-out is on record: do not raise spend. The server holds budget raises.');
  if (kinds.has('upcoming_offer')) rules.push('An offer is coming or running: do not cut budgets or pause campaigns on a dip. The server holds cuts and pauses.');
  if (kinds.has('price_change')) rules.push('Prices changed: conversions can move for that reason alone. Read short windows with care.');
  if (kinds.has('busy_hours')) rules.push('Busy hours are known: do not read hour of day swings as waste.');
  return {
    today,
    facts: facts.slice(0, 8).map((f) => ({
      kind: f.kind,
      fact: f.fact,
      from: f.effective_from,
      until: f.effective_until,
      active_now: (!f.effective_from || f.effective_from <= today) && f.effective_until >= today,
    })),
    rules,
  };
}

/**
 * Deterministic rules the optimizer cron applies when business memory is on:
 *   - an active stock-out holds back budget RAISES (more spend on goods that
 *     cannot be sold);
 *   - a running or imminent offer (starts within 7 days) holds back budget CUTS
 *     and campaign pauses (the swing around an offer is not a verdict).
 * Returns the reason code or null.
 */
export function merchantContextRejection(
  action: { type: string; params?: Record<string, unknown> | null },
  facts: readonly MerchantFact[],
  today: string
): 'merchant_stock_out' | 'merchant_offer_week' | null {
  if (facts.length === 0) return null;
  const isCut =
    action.type === 'pause_campaign' ||
    (action.type === 'adjust_budget' &&
      (Number(action.params?.delta_pct) < 0 ||
        (Number(action.params?.current_amount_micros) > 0 &&
          Number(action.params?.new_amount_micros) > 0 &&
          Number(action.params?.new_amount_micros) < Number(action.params?.current_amount_micros))));
  const isRaise =
    action.type === 'enable_campaign' ||
    (action.type === 'adjust_budget' &&
      (Number(action.params?.delta_pct) > 0 ||
        (Number(action.params?.current_amount_micros) > 0 &&
          Number(action.params?.new_amount_micros) > Number(action.params?.current_amount_micros))));
  const soon = addDays(today, 7);
  const activeNow = (f: MerchantFact) => (!f.effective_from || f.effective_from <= today) && f.effective_until >= today;
  if (isRaise && facts.some((f) => f.kind === 'stock_out' && activeNow(f))) return 'merchant_stock_out';
  if (isCut && facts.some((f) => f.kind === 'upcoming_offer' && (activeNow(f) || (f.effective_from && f.effective_from <= soon)))) {
    return 'merchant_offer_week';
  }
  return null;
}
