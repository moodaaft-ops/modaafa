import { normalizeKeywordText } from '../ai/execution-preflight';
import { holdsTargetLock, isStalePendingRecommendation } from '../recommendations/staleness';

export const AUTOPILOT_FAILED_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type AutopilotRecommendationState = {
  id: string;
  status: string;
  created_at?: string | null;
};

const PERMANENTLY_BLOCKING_STATUSES = [
  'pending',
  'approved',
  'executing',
  'applied',
  'dismissed',
] as const;

/**
 * Respect live/applied/user-dismissed decisions indefinitely. A technical
 * failure may be retried only after a quiet period, and malformed timestamps
 * fail closed rather than creating a duplicate Google Ads mutation.
 */
export function blocksAutopilotFingerprint(
  row: AutopilotRecommendationState | null | undefined,
  now = Date.now()
) {
  if (!row) return false;
  if (PERMANENTLY_BLOCKING_STATUSES.includes(row.status as any)) return true;
  if (row.status !== 'failed') return false;

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : Number.NaN;
  if (!Number.isFinite(createdAt)) return true;
  return now - createdAt < AUTOPILOT_FAILED_RETRY_COOLDOWN_MS;
}

/**
 * Find a recommendation that makes this fingerprint unsafe to create again.
 * The split queries ensure an older applied/dismissed row cannot be hidden by
 * a newer failed retry.
 */
export async function findBlockingAutopilotRecommendation(
  supabase: any,
  accountId: string,
  fingerprint: string,
  now = Date.now()
): Promise<AutopilotRecommendationState | null> {
  const { data: permanent, error: permanentError } = await supabase
    .from('recommendations')
    .select('id, status, created_at')
    .eq('account_id', accountId)
    .eq('fingerprint', fingerprint)
    .in('status', [...PERMANENTLY_BLOCKING_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (permanentError) throw permanentError;
  if (permanent) return permanent;

  const { data: failed, error: failedError } = await supabase
    .from('recommendations')
    .select('id, status, created_at')
    .eq('account_id', accountId)
    .eq('fingerprint', fingerprint)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (failedError) throw failedError;

  return blocksAutopilotFingerprint(failed, now) ? failed : null;
}

// ---------------------------------------------------------------------------
// Queue-time dedupe by TARGET, not only by fingerprint
//
// The fingerprint includes the match type, so «عيادة اسنان» as EXACT and as
// PHRASE in one ad group are two fingerprints and two pending cards for the
// same decision. Live data showed about 16% of the pending rows were such
// duplicates, and one ad group carried 8 pending keyword additions. Before the
// cron queues a recommendation it now looks at what is already waiting for the
// owner (or about to run) on the same target.
// ---------------------------------------------------------------------------

/** At most this many keyword additions wait for the owner in one ad group. */
export const MAX_PENDING_ADD_KEYWORDS_PER_AD_GROUP = 3;

/** Statuses that still count as "already on the owner's table" for the dedupe. */
const ACTIVE_STATUSES = ['pending', 'approved', 'executing'] as const;

/** The columns the dedupe reads from `recommendations`. */
export type ActiveRecommendationRow = {
  id: string;
  status: string;
  created_at?: string | null;
  /** When the approval handler claimed the row; a claim older than a day is a crashed run. */
  execution_started_at?: string | null;
  action_payload?: any;
};

export type DedupeCode =
  | 'duplicate_keyword_pending'
  | 'duplicate_negative_pending'
  | 'duplicate_budget_pending'
  | 'duplicate_bid_pending'
  | 'ad_group_keyword_cap'
  | 'pending_unreadable';

export type DedupeVerdict =
  | { skip: false }
  | { skip: true; code: DedupeCode; reason_ar: string; recommendation_id: string | null };

const DEDUPE_REASONS_AR: Record<DedupeCode, string> = {
  duplicate_keyword_pending: 'عندك توصية معلّقة بنفس الكلمة في نفس المجموعة الإعلانية، فما كررناها.',
  duplicate_negative_pending: 'عندك توصية معلّقة بنفس الكلمة السلبية في نفس الحملة، فما كررناها.',
  duplicate_budget_pending: 'عندك توصية معلّقة على نفس الميزانية، فما كررناها.',
  duplicate_bid_pending: 'عندك توصية معلّقة على نفس المجموعة الإعلانية، فما كررناها.',
  ad_group_keyword_cap: `في هذه المجموعة الإعلانية ${MAX_PENDING_ADD_KEYWORDS_PER_AD_GROUP} كلمات تنتظر قرارك، فما أضفنا أكثر.`,
  pending_unreadable: 'تعذّرت قراءة التوصيات المعلّقة، فأجّلنا هذا القرار للجولة الجاية بدل ما نكرره.',
};

type DedupeAction = { type: string; target_id?: string | null; params?: Record<string, unknown> | null };

const text = (value: unknown) => String(value ?? '').trim();

/** Comparison key for a keyword or a negative: Arabic spelling variants and spacing never make two terms different. */
export function dedupeTermKey(value: unknown): string {
  return normalizeKeywordText(text(value));
}

/** Rows this run added to the pool before they had an id carry a `run:` placeholder, never a real id. */
const RUN_ROW_PREFIX = 'run:';

function skip(code: DedupeCode, recommendationId: string | null): DedupeVerdict {
  const real = recommendationId && !recommendationId.startsWith(RUN_ROW_PREFIX) ? recommendationId : null;
  return { skip: true, code, reason_ar: DEDUPE_REASONS_AR[code], recommendation_id: real };
}

function payloadOf(row: ActiveRecommendationRow) {
  const payload = row.action_payload ?? {};
  return {
    operation: text(payload.operation),
    params: (payload.params ?? {}) as Record<string, unknown>,
  };
}

/** Operations whose queue-time check needs the list of waiting recommendations. */
export function dedupeAppliesTo(actionType: string): boolean {
  return (
    actionType === 'add_keyword' ||
    actionType === 'add_negative_keyword' ||
    actionType === 'adjust_budget' ||
    actionType === 'shift_budget_pair' ||
    actionType === 'adjust_bid'
  );
}

/**
 * Would queueing this action duplicate a recommendation that is already waiting?
 *
 * - add_keyword: same ad group and same normalized keyword, whatever the match
 *   type; and no more than 3 PENDING additions in one ad group.
 * - add_negative_keyword: same campaign and same normalized term (a pending
 *   negative batch that contains the term counts).
 * - adjust_budget: same budget. adjust_bid: same ad group.
 *
 * A row that can no longer be acted on is ignored (it neither blocks nor counts
 * toward the cap): a pending row older than 14 days, whoever queued it, an
 * approved row older than 7 days and a row stuck in `executing` for more than
 * 24 hours (see holdsTargetLock in lib/recommendations/staleness.ts).
 * `pool` null means the waiting recommendations could not be read: the actions
 * this check covers are skipped for this run rather than risk a duplicate.
 */
export function findPendingDuplicate(
  pool: readonly ActiveRecommendationRow[] | null,
  action: DedupeAction,
  nowMs: number = Date.now()
): DedupeVerdict {
  if (!dedupeAppliesTo(action.type)) return { skip: false };
  if (!pool) return skip('pending_unreadable', null);

  const params = (action.params ?? {}) as Record<string, unknown>;
  const active = pool.filter(
    (row) => (ACTIVE_STATUSES as readonly string[]).includes(row.status) && holdsTargetLock(row, nowMs)
  );

  if (action.type === 'add_keyword') {
    const adGroup = text(params.ad_group_resource);
    const term = dedupeTermKey(params.keyword_text);
    if (!adGroup || !term) return { skip: false };
    let waiting = 0;
    for (const row of active) {
      const { operation, params: rowParams } = payloadOf(row);
      if (operation !== 'add_keyword' || text(rowParams.ad_group_resource) !== adGroup) continue;
      if (dedupeTermKey(rowParams.keyword_text) === term) return skip('duplicate_keyword_pending', row.id);
      if (row.status === 'pending') waiting += 1;
    }
    if (waiting >= MAX_PENDING_ADD_KEYWORDS_PER_AD_GROUP) return skip('ad_group_keyword_cap', null);
    return { skip: false };
  }

  if (action.type === 'add_negative_keyword') {
    const campaign = text(params.campaign_resource);
    const term = dedupeTermKey(params.keyword_text);
    if (!campaign || !term) return { skip: false };
    for (const row of active) {
      const { operation, params: rowParams } = payloadOf(row);
      if (text(rowParams.campaign_resource) !== campaign) continue;
      if (operation === 'add_negative_keyword' && dedupeTermKey(rowParams.keyword_text) === term) {
        return skip('duplicate_negative_pending', row.id);
      }
      if (
        operation === 'add_negative_keywords_batch' &&
        Array.isArray(rowParams.keywords) &&
        rowParams.keywords.some((keyword) => dedupeTermKey(keyword) === term)
      ) {
        return skip('duplicate_negative_pending', row.id);
      }
    }
    return { skip: false };
  }

  if (action.type === 'adjust_budget') {
    const budget = text(params.budget_resource);
    if (!budget) return { skip: false };
    const match = active.find((row) => {
      const { operation, params: rowParams } = payloadOf(row);
      return (
        (operation === 'adjust_budget' && text(rowParams.budget_resource) === budget) ||
        (operation === 'shift_budget_pair' &&
          (text(rowParams.from_budget_resource) === budget || text(rowParams.to_budget_resource) === budget))
      );
    });
    return match ? skip('duplicate_budget_pending', match.id) : { skip: false };
  }

  if ((action.type as string) === 'shift_budget_pair') {
    const budgets = [text(params.from_budget_resource), text(params.to_budget_resource)].filter(Boolean);
    if (budgets.length === 0) return { skip: false };
    const match = active.find((row) => {
      const { operation, params: rowParams } = payloadOf(row);
      if (operation === 'adjust_budget') return budgets.includes(text(rowParams.budget_resource));
      return (
        operation === 'shift_budget_pair' &&
        (budgets.includes(text(rowParams.from_budget_resource)) || budgets.includes(text(rowParams.to_budget_resource)))
      );
    });
    return match ? skip('duplicate_budget_pending', match.id) : { skip: false };
  }

  // adjust_bid
  const adGroup = text(params.ad_group_resource);
  if (!adGroup) return { skip: false };
  const match = active.find((row) => {
    const { operation, params: rowParams } = payloadOf(row);
    return operation === 'adjust_bid' && text(rowParams.ad_group_resource) === adGroup;
  });
  return match ? skip('duplicate_bid_pending', match.id) : { skip: false };
}

/**
 * Everything of this account that is waiting for the owner or about to run.
 * Null when it cannot be read (the caller then fails closed for the covered
 * actions). Newest first, so a long tail of old rows is what a limit cuts.
 */
export async function loadActiveRecommendationPool(
  supabase: any,
  accountId: string,
  limit = 500
): Promise<ActiveRecommendationRow[] | null> {
  const { data, error } = await supabase
    .from('recommendations')
    .select('id, status, created_at, execution_started_at, action_payload')
    .eq('account_id', accountId)
    .in('status', [...ACTIVE_STATUSES])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !Array.isArray(data)) return null;
  return data as ActiveRecommendationRow[];
}

/**
 * Put a recommendation this run just queued (or executed) into the pool, so a
 * second proposal for the same target later in the same run is skipped too.
 */
export function rememberRecommendation(
  pool: ActiveRecommendationRow[] | null,
  action: DedupeAction,
  input: { id: string | null; status?: 'pending' | 'executing'; source?: string; nowMs?: number }
): void {
  if (!pool) return;
  pool.push({
    id: input.id ?? `${RUN_ROW_PREFIX}${pool.length}`,
    status: input.status ?? 'pending',
    created_at: new Date(input.nowMs ?? Date.now()).toISOString(),
    action_payload: {
      operation: action.type,
      target_id: action.target_id ?? null,
      params: action.params ?? {},
      source: input.source ?? 'optimizer_cron',
    },
  });
}

/** What a renewal rewrites: the same change, said again with tonight's numbers. */
export type RenewalFields = {
  category: string;
  severity: string;
  title: string;
  description: string;
  expected_impact: unknown;
  action_payload: Record<string, unknown>;
};

/**
 * The optimizer proposed again a change whose fingerprint is held by a pending
 * row older than 14 days. The unique index on (account_id, fingerprint) stops a
 * second insert and the old row is hidden from every list as stale, so the
 * proposal would vanish. Renew the old row in place: fresh text, payload and
 * `created_at`, still pending.
 *
 * Only a pending optimizer row is touched, and the update is conditioned on the
 * row still being pending, so an owner who approves it at this very moment
 * wins. Returns whether a row was renewed.
 */
export async function renewStalePendingRecommendation(
  supabase: any,
  recommendationId: string,
  fields: RenewalFields,
  nowMs: number = Date.now()
): Promise<boolean> {
  const { data: current, error } = await supabase
    .from('recommendations')
    .select('id, status, created_at, action_payload')
    .eq('id', recommendationId)
    .maybeSingle();
  if (error || !current) return false;
  if (!isStalePendingRecommendation(current, nowMs)) return false;

  const renewedAt = new Date(nowMs).toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('recommendations')
    .update({
      category: fields.category,
      severity: fields.severity,
      title: fields.title,
      description: fields.description,
      expected_impact: fields.expected_impact,
      action_payload: {
        ...fields.action_payload,
        renewed_from_created_at: current.created_at ?? null,
        renewed_at: renewedAt,
      },
      created_at: renewedAt,
    })
    .eq('id', recommendationId)
    .eq('status', 'pending')
    .select('id');
  if (updateError || !Array.isArray(updated)) return false;
  return updated.length > 0;
}
