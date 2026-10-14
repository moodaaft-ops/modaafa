import { cleanUserText } from '../questions';
import { focusEntriesForGroup, focusGroupFor, matchFocusEntries } from './focus';
import {
  GROUP_NOUN,
  PLATFORM_NAME,
  campaignTotals,
  campaignsPhrase,
  cityNames,
  countPhrase,
  groupConversions,
  inCityPhrase,
  joinAnd,
  money,
  NOUNS,
  sigValue,
  trustedKind,
  withArticle,
} from './shared';
import type { AccountSignals, BusinessKind, ConversionGroup, DominantOutcome, Opener, Scenario } from './types';

/** How an outcome is said after «وشغلك على». */
const OUTCOME_PHRASE: Partial<Record<DominantOutcome, string>> = {
  purchases: 'الطلبات',
  calls: 'الاتصالات',
  forms: 'النماذج',
  bookings: 'الحجوزات',
  visits: 'الزيارات',
};

const CLINIC_TITLE = { dental: 'عيادة أسنان', derma: 'عيادة جلدية', general: 'عيادة أو مركز طبي' } as const;

/** Where a result came from, when the group says so. */
const GROUP_ORIGIN: Partial<Record<ConversionGroup, string>> = { call: ' من الإعلان', lead_form: ' من الموقع' };

const RESULT_GROUPS: ConversionGroup[] = ['call', 'lead_form', 'booking', 'contact', 'directions', 'store_visit', 'signup'];

/** «عيادة أسنان في جدة», «متجر إلكتروني على سلة», «شركة تنظيف في الرياض». Null for a kind we do not name. */
export function activityPhrase(scenario: Scenario, signals: AccountSignals | null): string | null {
  const kind = trustedKind(scenario);
  const city = inCityPhrase(signals);
  const campaigns = sigValue(signals?.campaigns) ?? [];
  switch (kind) {
    case 'ecommerce':
      return `متجر إلكتروني${scenario.platform ? ` على ${PLATFORM_NAME[scenario.platform]}` : ''}`;
    case 'clinic':
      return `${CLINIC_TITLE[scenario.specialty ?? 'general']}${city ? ` ${city}` : ''}`;
    case 'services': {
      const found = matchFocusEntries('services', campaigns.map((campaign) => campaign.name));
      return `${found.length === 1 ? `شركة ${found[0].label}` : 'شركة خدمات'}${city ? ` ${city}` : ''}`;
    }
    case 'local':
      return `محل أو فرع${city ? ` ${city}` : ''}`;
    default:
      return null;
  }
}

function resultsRow(signals: AccountSignals): string | null {
  const parts: Array<{ text: string; count: number }> = [];
  for (const group of RESULT_GROUPS) {
    const forms = GROUP_NOUN[group];
    const count = Math.round(groupConversions(signals, group));
    if (!forms || count < 1) continue;
    parts.push({ text: `${countPhrase(count, forms)}${GROUP_ORIGIN[group] ?? ''}`, count });
  }
  if (parts.length === 0) return null;
  const top = parts.sort((a, b) => b.count - a.count).slice(0, 3);
  return `آخر 30 يوم: ${joinAnd(top.map((part) => part.text))}`;
}

/** The headline for the kinds that lead with what they are. */
function kindHeadline(scenario: Scenario, signals: AccountSignals, kind: BusinessKind): string {
  const title = activityPhrase(scenario, signals) ?? '';
  const outcome = OUTCOME_PHRASE[scenario.outcome];
  return `يعني ${title}${outcome ? `، وشغلك على ${outcome}` : ''}.`;
}

/**
 * CONTRACT (part B): the first message after the read. Null when there is
 * nothing worth saying back (no read, new, dormant, no_account). It only
 * states what was read, and a number only when it came from the account.
 */
export function buildOpener(scenario: Scenario, signals: AccountSignals | null, ctx: { firstName: string | null }): Opener | null {
  if (!signals) return null;
  if (scenario.state === 'no_account' || scenario.state === 'new' || scenario.state === 'dormant') return null;
  const campaigns = sigValue(signals.campaigns);
  if (!campaigns || campaigns.length === 0) return null;

  const totals = campaignTotals(campaigns);
  const currency = signals.currency;
  const kind = trustedKind(scenario);
  const first = cleanUserText(ctx.firstName ?? '', 30);
  const greeting = first ? `هلا ${first}، ربطت حسابك وقريته.` : 'هلا، ربطت حسابك وقريته.';

  // --- what was seen
  const running = campaigns.filter((campaign) => campaign.status === 'ENABLED');
  const shown = running.length > 0 ? running : campaigns;
  const seen: string[] = [];
  let campaignRow = `${campaignsPhrase(shown)} ${running.length > 0 ? 'شغّالة' : 'موقوفة حالياً'}`;
  if (kind === 'clinic' || kind === 'services' || kind === 'local') {
    const group = focusGroupFor(scenario);
    const topics = focusEntriesForGroup(group).length
      ? matchFocusEntries(group, shown.map((campaign) => campaign.name)).slice(0, 3).map((entry) => withArticle(entry.label))
      : [];
    if (topics.length > 0) campaignRow += ` على ${joinAnd(topics)}`;
  }
  const cities = cityNames(signals);
  if (cities.length === 1) campaignRow += `، وتطلع في ${cities[0]} بس`;
  else if (cities.length === 2) campaignRow += `، وتطلع في ${joinAnd(cities)}`;
  seen.push(campaignRow);

  // What is particular to the kind, then what the tracking says.
  if (kind === 'ecommerce') {
    const merchant = sigValue(signals.merchantCenterLinked) === true;
    if (scenario.platform) {
      seen.push(`المتجر على ${PLATFORM_NAME[scenario.platform]}${merchant ? '، وربط Merchant Center شغّال' : ''}`);
    } else if (merchant) {
      seen.push('ربط Merchant Center شغّال');
    }
  } else if (kind === 'local') {
    const locations = sigValue(signals.assets)?.locations ?? 0;
    // `locations` counts linked location sets, not branches (one Business Profile set can hold many).
    if (locations > 0) seen.push('إضافة الموقع مفعّلة');
  }

  if (scenario.state === 'no_tracking') {
    seen.push('ما فيه تتبع مفعّل في الحساب');
  } else if (scenario.state === 'tracking_suspect') {
    seen.push(`فيه تتبع مفعّل، بس ما سجّل ولا نتيجة من ${countPhrase(totals.clicks, NOUNS.click)}`);
  } else if (kind === 'ecommerce') {
    if (groupConversions(signals, 'purchase') >= 1) {
      seen.push(totals.value > 0 ? 'التتبع يحسب الطلبات وقيمتها' : 'التتبع يحسب الطلبات بس بدون قيمتها');
    }
  } else {
    const results = resultsRow(signals);
    if (results) seen.push(results);
  }
  if ((kind === 'clinic' || kind === 'services') && sigValue(signals.assets)?.call === true) seen.push('إضافة الاتصال مفعّلة');
  if (seen.length < 2) seen.push(`آخر 30 يوم صرفت ${money(totals.cost, currency)}`);

  // --- the big line and the question under it
  const confident = scenario.kindConfidence === 'confident' && kind !== 'general';
  const orders = Math.round(groupConversions(signals, 'purchase'));
  let headline: string;
  let ask: string;
  if (kind === 'ecommerce' && scenario.outcome === 'purchases' && orders >= 1 && totals.cost > 0) {
    headline = `آخر 30 يوم صرفت ${money(totals.cost, currency)} وجاك منها ${countPhrase(orders, NOUNS.order)}.`;
    ask = confident ? 'صح إن اللي يهمك الطلبات من المتجر؟' : 'نكمل بكم سؤال.';
  } else if (kind !== 'general') {
    headline = kindHeadline(scenario, signals, kind);
    ask = confident ? 'صح كذا؟' : 'نكمل بكم سؤال.';
  } else {
    const results = Math.round(totals.conversions);
    headline =
      results >= 1
        ? `آخر 30 يوم صرفت ${money(totals.cost, currency)} وجاك منها ${countPhrase(results, { one: 'نتيجة وحدة', two: 'نتيجتين', few: 'نتائج', many: 'نتيجة' })}.`
        : `آخر 30 يوم صرفت ${money(totals.cost, currency)}.`;
    ask = 'أسألك كم سؤال عشان أكمل الصورة.';
  }

  return {
    greeting,
    seen: seen.slice(0, 4),
    headline,
    ask,
    proposal: confident ? { kind, outcome: scenario.outcome } : null,
  };
}
