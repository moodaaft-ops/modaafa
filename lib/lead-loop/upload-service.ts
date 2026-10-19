import { isShadowAccount } from '../shadow/guard';
import {
  buildUploadClickConversionsRequest,
  interpretUploadResponse,
  type ClickConversionTransport,
  type RowOutcome,
  type UploadableLead,
  UPLOAD_MAX_BATCH,
} from '@/lib/google-ads/click-conversions';
import { getGoogleAdsErrorCodes } from '@/lib/google-ads/client';
import type { FoundLeadAction } from '@/lib/measurement/conversion-actions';

/**
 * Sends the leads the merchant marked "صار زبون" to Google as offline click
 * conversions. Rules:
 *  - the claim is one SQL statement (claim_lead_uploads), so overlapping runs
 *    never send the same lead twice;
 *  - order_id is the lead id, so a lead sent twice is a DUPLICATE_ORDER_ID that
 *    we record as done, never a second conversion;
 *  - partial_failure is on and every row gets its own recorded result;
 *  - a failure of the whole request leaves the leads waiting (attempts are not
 *    burned by a problem that is not theirs) and is reported to the caller.
 */
type Db = any;

export const MAX_UPLOAD_ATTEMPTS = 8;
/** Google accepts a click for 90 days; stop one day early to stay clear of the edge. */
export const CLICK_MAX_AGE_DAYS = 89;
const DAY_MS = 86_400_000;

export type UploadSummary = {
  status: 'ok' | 'nothing_to_upload' | 'no_conversion_action' | 'request_failed';
  claimed: number;
  uploaded: number;
  duplicates: number;
  retried: number;
  failed: number;
  skipped: number;
  error?: string;
};

const EMPTY: Omit<UploadSummary, 'status'> = { claimed: 0, uploaded: 0, duplicates: 0, retried: 0, failed: 0, skipped: 0 };

export async function uploadLeadConversions({
  db,
  account,
  settings,
  transport,
  findConversionAction,
  now = new Date(),
  limit = UPLOAD_MAX_BATCH,
}: {
  db: Db;
  account: { id: string; customerId: string; loginCustomerId?: string | null; timeZone?: string | null };
  settings: { conversion_action_resource: string | null };
  transport: ClickConversionTransport;
  /** GAQL lookup of "مُضاعِف | زبون فعلي"; only called while the resource is not stored yet. */
  findConversionAction: () => Promise<FoundLeadAction | null>;
  now?: Date;
  limit?: number;
}): Promise<UploadSummary> {
  // Agency shadow accounts never get an upload (SHADOW_MODE_ENABLED; no lookup when it is off).
  if (await isShadowAccount(account.id, { admin: () => db })) return { status: 'nothing_to_upload', ...EMPTY };
  let resource = settings.conversion_action_resource;
  if (!resource) {
    const found = await findConversionAction();
    if (!found || found.status !== 'ENABLED') return { status: 'no_conversion_action', ...EMPTY };
    resource = found.resourceName;
    await db
      .from('lead_loop_settings')
      .update({ conversion_action_resource: resource, conversion_action_checked_at: now.toISOString() })
      .eq('account_id', account.id);
  }

  const { data: claimedRows, error: claimError } = await db.rpc('claim_lead_uploads', {
    p_account_id: account.id,
    p_limit: Math.min(limit, UPLOAD_MAX_BATCH),
    p_max_attempts: MAX_UPLOAD_ATTEMPTS,
  });
  if (claimError) throw claimError;
  const claimed: Array<UploadableLead & { upload_attempts: number }> = (claimedRows ?? []).map((row: any) => ({
    ...row,
    value_sar: row.value_sar === null || row.value_sar === undefined ? null : Number(row.value_sar),
  }));
  if (claimed.length === 0) return { status: 'nothing_to_upload', ...EMPTY };

  const summary: UploadSummary = { status: 'ok', ...EMPTY, claimed: claimed.length };
  const attemptsOf = new Map(claimed.map((lead) => [lead.id, lead.upload_attempts]));
  const logs: Array<Record<string, unknown>> = [];

  // Clicks Google would refuse anyway never leave the building.
  const cutoff = now.getTime() - CLICK_MAX_AGE_DAYS * DAY_MS;
  const sendable = claimed.filter((lead) => {
    const clicked = new Date(lead.clicked_at).getTime();
    if (Number.isFinite(clicked) && clicked < cutoff) {
      summary.failed += 1;
      logs.push(log(account.id, lead.id, attemptsOf.get(lead.id)!, 'failed', 'CLICK_EXPIRED', 'Click is older than the 90 day upload window'));
      return false;
    }
    return true;
  });
  const expiredIds = claimed.filter((lead) => !sendable.includes(lead)).map((lead) => lead.id);
  if (expiredIds.length > 0) {
    await db
      .from('lead_clicks')
      .update({ upload_status: 'failed', upload_error: 'click_expired' })
      .in('id', expiredIds)
      .eq('account_id', account.id);
  }

  const built = buildUploadClickConversionsRequest(sendable, {
    conversionAction: resource,
    timeZone: account.timeZone,
    jobId: undefined,
  });
  for (const skipped of built.skipped) {
    summary.skipped += 1;
    await db
      .from('lead_clicks')
      .update({ upload_status: 'skipped', upload_error: skipped.reason })
      .eq('id', skipped.leadId)
      .eq('account_id', account.id);
    logs.push(log(account.id, skipped.leadId, attemptsOf.get(skipped.leadId)!, 'failed', skipped.reason.toUpperCase(), 'Could not be built'));
  }

  if (built.leadIds.length > 0) {
    let outcomes: RowOutcome[] | null = null;
    try {
      const response = await transport({
        customerId: account.customerId,
        loginCustomerId: account.loginCustomerId,
        body: built.body,
      });
      outcomes = interpretUploadResponse(response, built.leadIds);
    } catch (error) {
      const message = describe(error);
      summary.status = 'request_failed';
      summary.error = message;
      // The leads were not at fault: put them back untouched and say why.
      await db
        .from('lead_clicks')
        .update({ upload_status: 'pending', upload_claimed_at: null, upload_error: message.slice(0, 200) })
        .in('id', built.leadIds)
        .eq('account_id', account.id)
        .eq('upload_status', 'uploading');
      for (const id of built.leadIds) {
        logs.push(log(account.id, id, attemptsOf.get(id)! + 1, 'request_failed', 'REQUEST_FAILED', message));
      }
    }

    if (outcomes) {
      const doneIds: string[] = [];
      const writes: Array<PromiseLike<unknown>> = [];
      for (const outcome of outcomes) {
        const attempt = (attemptsOf.get(outcome.leadId) ?? 0) + 1;
        if (outcome.outcome === 'uploaded' || outcome.outcome === 'duplicate') {
          doneIds.push(outcome.leadId);
          if (outcome.outcome === 'uploaded') summary.uploaded += 1;
          else summary.duplicates += 1;
          logs.push(log(account.id, outcome.leadId, attempt, outcome.outcome, 'code' in outcome ? outcome.code : null, null));
        } else if (outcome.outcome === 'retry') {
          summary.retried += 1;
          logs.push(log(account.id, outcome.leadId, attempt, 'retry', outcome.code, outcome.message));
          writes.push(
            db
              .from('lead_clicks')
              .update({ upload_status: 'pending', upload_claimed_at: null, upload_attempts: attempt, upload_error: outcome.code })
              .eq('id', outcome.leadId)
              .eq('account_id', account.id)
          );
        } else {
          summary.failed += 1;
          logs.push(log(account.id, outcome.leadId, attempt, 'failed', outcome.code, outcome.message));
          writes.push(
            db
              .from('lead_clicks')
              .update({ upload_status: 'failed', upload_attempts: attempt, upload_error: outcome.code })
              .eq('id', outcome.leadId)
              .eq('account_id', account.id)
          );
        }
      }
      if (doneIds.length > 0) {
        writes.push(
          db
            .from('lead_clicks')
            .update({ upload_status: 'uploaded', uploaded_at: now.toISOString(), upload_error: null, upload_claimed_at: null })
            .in('id', doneIds)
            .eq('account_id', account.id)
        );
      }
      await Promise.all(writes);
    }
  }

  if (logs.length > 0) await db.from('lead_conversion_uploads').insert(logs);
  return summary;
}

function log(
  accountId: string,
  leadId: string,
  attempt: number,
  outcome: string,
  code: string | null,
  message: string | null
) {
  return {
    account_id: accountId,
    lead_click_id: leadId,
    attempt,
    outcome,
    error_code: code,
    error_message: message ? message.slice(0, 300) : null,
  };
}

function describe(error: unknown) {
  const codes = getGoogleAdsErrorCodes(error);
  const message = error instanceof Error ? error.message : String(error);
  return codes.length > 0 ? `${codes.join(',')}: ${message}` : message;
}
