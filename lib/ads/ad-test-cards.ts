import { actionFingerprint } from '../ai/action-fingerprint';
import type { AdTestResult } from './ad-test';

/**
 * A finished ad test (a winner at 90% confidence with enough impressions,
 * days and conversions, and a winner CPA inside the break-even) becomes ONE
 * approval card: pause the losing ad. Nothing is deleted. The base `pause_ad`
 * rollback (restore the previous status) applies as it is, so the card is
 * reversible with the usual undo.
 *
 * Never autopilot: the row says `ad_test_manual_only`. Needs healthy
 * conversion tracking, because the verdict rests on conversion counts.
 */

export type LoserPauseCard = {
  fingerprint: string;
  action: {
    type: 'pause_ad';
    target_id: string;
    params: Record<string, never>;
    reason_ar: string;
    reason_en: string;
    expected_impact: { metric: string; delta_pct: number; delta_sar_per_month: number };
  };
  evidence: { ad_group: string; winner: string; loser: string; confidence: number | null; lift_pct: number | null; days_compared: number };
};

export const LOSER_CARD_TITLE_AR = 'وقّف النسخة الخسرانة';

export function loserPauseFingerprint(accountId: string, loserAd: string) {
  return actionFingerprint(accountId, { type: 'pause_ad', target_id: loserAd, params: {} });
}

function adGroupAdOf(customerId: string, resource: string): boolean {
  return new RegExp(`^customers/${customerId}/adGroupAds/\\d+~\\d+$`).test(resource);
}

export async function buildLoserPauseCards(args: {
  accountId: string;
  customerId: string;
  tests: readonly AdTestResult[] | null;
  trackingStatus: string | null | undefined;
  hasBlocking(fingerprint: string): Promise<boolean>;
  /** At most this many cards per run. */
  max?: number;
}): Promise<{ cards: LoserPauseCard[]; skipped: Array<{ what: string; why: string }> }> {
  const cards: LoserPauseCard[] = [];
  const skipped: Array<{ what: string; why: string }> = [];
  if (!args.tests) return { cards, skipped };
  if (args.trackingStatus !== 'healthy') {
    if (args.tests.some((t) => t.verdict.status === 'winner')) skipped.push({ what: 'pause_ad', why: 'tracking_not_healthy' });
    return { cards, skipped };
  }
  const max = args.max ?? 2;
  for (const test of args.tests) {
    if (cards.length >= max) break;
    const v = test.verdict;
    if (v.status !== 'winner' || !v.winner || !v.loser || v.winner === v.loser) continue;
    if (!adGroupAdOf(args.customerId, v.loser) || !adGroupAdOf(args.customerId, v.winner)) {
      skipped.push({ what: 'pause_ad', why: 'bad_resource' });
      continue;
    }
    const fingerprint = loserPauseFingerprint(args.accountId, v.loser);
    if (await args.hasBlocking(fingerprint)) {
      skipped.push({ what: 'pause_ad', why: 'card_exists' });
      continue;
    }
    cards.push({
      fingerprint,
      action: {
        type: 'pause_ad',
        target_id: v.loser,
        params: {},
        reason_ar: `اختبار الإعلانات في "${test.ad_group_name}" طلع له فايز. ${v.note_ar}`,
        reason_en: `Ad test winner found in ${test.ad_group_name}: pause the losing ad`,
        expected_impact: { metric: 'conversion_rate', delta_pct: 0, delta_sar_per_month: 0 },
      },
      evidence: {
        ad_group: test.ad_group,
        winner: v.winner,
        loser: v.loser,
        confidence: v.confidence,
        lift_pct: v.lift_pct,
        days_compared: v.days_compared,
      },
    });
  }
  return { cards, skipped };
}

export function loserCardToRow(card: LoserPauseCard) {
  return {
    category: 'ads',
    severity: 'growth',
    title: LOSER_CARD_TITLE_AR,
    description: card.action.reason_ar,
    expected_impact: card.action.expected_impact,
    action_payload: {
      operation: 'pause_ad',
      target_id: card.action.target_id,
      params: {},
      confidence: card.evidence.confidence,
      evidence: { kind: 'ad_test', ...card.evidence },
      source: 'optimizer_cron',
      autopilot: { outcome: 'queue', code: 'ad_test_manual_only' },
    },
  };
}

export async function queueLoserPauseCards(supabase: any, accountId: string, cards: readonly LoserPauseCard[]): Promise<number> {
  let created = 0;
  for (const card of cards) {
    const { error } = await supabase
      .from('recommendations')
      .insert({ account_id: accountId, fingerprint: card.fingerprint, ...loserCardToRow(card), status: 'pending' });
    if (!error) created += 1;
    else if (error.code !== '23505') throw error;
  }
  return created;
}
