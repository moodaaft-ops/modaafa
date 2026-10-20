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
import {
  buildIngestRequest,
  consentFromEnv,
  DataManagerError,
  ISOLATE_LIMIT,
  interpretIngestResponse,
  isDataManagerAccessError,
  isDataManagerInvalidRequest,
  type DataManagerConsent,
  type DataManagerSender,
} from '@/lib/google-ads/data-manager';
import {
  isLegacyBlockedError,
  LEGACY_BLOCKED_CODE,
  planChannels,
  responseSaysLegacyBlocked,
  type ChannelPreference,
  type UploadChannel,
} from './transports';

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
 *
 * Channels (DATA_MANAGER_UPLOAD_ENABLED): without `channels` the only way out is
 * the legacy transport, exactly as before. With it the Data Manager API goes
 * first and legacy is the fallback; see ./transports.ts for the switching rules.
 */
type Db = any;

export const MAX_UPLOAD_ATTEMPTS = 8;
/** Google accepts a click for 90 days; stop one day early to stay clear of the edge. */
export const CLICK_MAX_AGE_DAYS = 89;
const DAY_MS = 86_400_000;

export type UploadChannels = {
  /** The merchant has a Data Manager grant (a stored, active `datamanager` refresh token). */
  dataManagerAvailable: boolean;
  /** Mints the sender (access token) lazily; a throw counts as an access failure of that channel. */
  makeDataManagerSender: () => Promise<DataManagerSender>;
  preference?: ChannelPreference;
  /** lead_loop_settings.legacy_blocked_at is set. */
  legacyBlocked?: boolean;
  consent?: DataManagerConsent;
};

export type UploadSummary = {
  status: 'ok' | 'nothing_to_upload' | 'no_conversion_action' | 'request_failed' | 'needs_data_manager_grant';
  /** Present only when channels were in play. */
  channel?: UploadChannel;
  /** The legacy API refused this run with the allowlist error. */
  legacyBlocked?: boolean;
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
  channels,
  now = new Date(),
  limit = UPLOAD_MAX_BATCH,
}: {
  db: Db;
  account: { id: string; customerId: string; loginCustomerId?: string | null; timeZone?: string | null };
  settings: { conversion_action_resource: string | null };
  transport: ClickConversionTransport;
  /** GAQL lookup of "مُضاعِف | زبون فعلي"; only called while the resource is not stored yet. */
  findConversionAction: () => Promise<FoundLeadAction | null>;
  /** Only passed while DATA_MANAGER_UPLOAD_ENABLED is on. */
  channels?: UploadChannels;
  now?: Date;
  limit?: number;
}): Promise<UploadSummary> {
  // Agency shadow accounts never get an upload (SHADOW_MODE_ENABLED; no lookup when it is off).
  if (await isShadowAccount(account.id, { admin: () => db })) return { status: 'nothing_to_upload', ...EMPTY };
  // Which channels may be tried is decided before any lead is claimed, so a
  // merchant who must grant the Data Manager scope loses nothing and nothing is held.
  const order: UploadChannel[] = channels
    ? planChannels({
        dataManagerAvailable: channels.dataManagerAvailable,
        preference: channels.preference ?? 'auto',
        legacyBlocked: channels.legacyBlocked === true,
      })
    : ['legacy'];
  if (order.length === 0) return { status: 'needs_data_manager_grant', ...EMPTY };

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

  let channelExtras: Record<string, unknown> | null = null;
  if (built.leadIds.length > 0) {
    let outcomes: RowOutcome[] | null = null;
    let requestId: string | null = null;
    let sawLegacyBlocked = false;
    let lastError: unknown = null;
    const leadsToSend = sendable.filter((lead) => built.leadIds.includes(lead.id));

    for (const channel of order) {
      try {
        if (channel === 'legacy') {
          const response = await transport({
            customerId: account.customerId,
            loginCustomerId: account.loginCustomerId,
            body: built.body,
          });
          if (channels && responseSaysLegacyBlocked(response)) {
            throw Object.assign(new Error(LEGACY_BLOCKED_CODE), { code: LEGACY_BLOCKED_CODE });
          }
          outcomes = interpretUploadResponse(response, built.leadIds);
        } else {
          const sent = await sendViaDataManager({
            channels: channels!,
            account,
            resource: resource!,
            leads: leadsToSend,
          });
          outcomes = sent.outcomes;
          requestId = sent.requestId;
        }
        if (channels) summary.channel = channel;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (channel === 'legacy' && channels && isLegacyBlockedError(error)) {
          sawLegacyBlocked = true;
          summary.legacyBlocked = true;
          continue;
        }
        if (channel === 'data_manager' && isDataManagerAccessError(error)) continue;
        break;
      }
    }

    if (!outcomes) {
      const reasonError = lastError ?? new Error('No upload channel is available');
      // Nothing can be sent until the merchant grants (or re-grants) the Data Manager scope.
      const needsGrant = Boolean(channels) && (isLegacyBlockedError(reasonError) || isDataManagerAccessError(reasonError));
      const message = needsGrant ? `${isLegacyBlockedError(reasonError) ? LEGACY_BLOCKED_CODE : 'DATA_MANAGER_ACCESS'}: grant the Data Manager scope` : describe(reasonError);
      summary.status = needsGrant ? 'needs_data_manager_grant' : 'request_failed';
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

    if (channels && (sawLegacyBlocked || summary.channel)) {
      await recordChannelState(db, account.id, { legacyBlocked: sawLegacyBlocked, channel: summary.channel ?? null, now });
    }
    if (requestId) channelExtras = { channel: 'data_manager', request_id: requestId };
    else if (summary.channel) channelExtras = { channel: summary.channel };

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

  if (logs.length > 0) {
    // The channel columns exist only after the channel migration; they are written only while channels are in play.
    const sent = new Set(built.leadIds);
    const rows = channelExtras
      ? logs.map((row) => (sent.has(String(row.lead_click_id)) ? { ...row, ...channelExtras } : row))
      : logs;
    await db.from('lead_conversion_uploads').insert(rows);
  }
  return summary;
}

/**
 * Data Manager ingest for the leads that survived the build. A whole-request
 * refusal as invalid (400) is isolated: up to ISOLATE_LIMIT rows are re-sent one
 * by one so a single unreadable click id cannot hold back the others; the rest
 * wait for the next run. Access errors (401/403) and everything else propagate
 * to the channel loop.
 */
async function sendViaDataManager({
  channels,
  account,
  resource,
  leads,
}: {
  channels: UploadChannels;
  account: { customerId: string; loginCustomerId?: string | null; timeZone?: string | null };
  resource: string;
  leads: UploadableLead[];
}): Promise<{ outcomes: RowOutcome[]; requestId: string | null }> {
  const buildFor = (subset: UploadableLead[]) =>
    buildIngestRequest(subset, {
      customerId: account.customerId,
      loginCustomerId: account.loginCustomerId,
      conversionAction: resource,
      timeZone: account.timeZone,
      consent: channels.consent === undefined ? consentFromEnv() : channels.consent,
    });

  const built = buildFor(leads);
  if ('error' in built) {
    return {
      requestId: null,
      outcomes: leads.map((lead): RowOutcome => ({ leadId: lead.id, outcome: 'failed', code: built.error.toUpperCase(), message: 'Request could not be built' })),
    };
  }
  const sender = await channels.makeDataManagerSender().catch((error) => {
    throw isDataManagerAccessError(error)
      ? error
      : new DataManagerError(401, 'UNAUTHENTICATED', `Data Manager token could not be minted: ${error instanceof Error ? error.message : String(error)}`);
  });

  try {
    const response = await sender(built.request);
    return { outcomes: interpretIngestResponse(response, built.leadIds), requestId: response?.requestId ?? null };
  } catch (error) {
    if (!isDataManagerInvalidRequest(error) || built.leadIds.length <= 1) {
      if (isDataManagerInvalidRequest(error)) {
        return {
          requestId: null,
          outcomes: built.leadIds.map((leadId): RowOutcome => ({ leadId, outcome: 'failed', code: 'INVALID_ARGUMENT', message: describe(error).slice(0, 300) })),
        };
      }
      throw error;
    }
    const outcomes: RowOutcome[] = [];
    for (const [index, leadId] of built.leadIds.entries()) {
      if (index >= ISOLATE_LIMIT) {
        outcomes.push({ leadId, outcome: 'retry', code: 'BATCH_REFUSED', message: 'Waiting for the bad row in the batch to be isolated' });
        continue;
      }
      const one = buildFor(leads.filter((lead) => lead.id === leadId));
      if ('error' in one) {
        outcomes.push({ leadId, outcome: 'failed', code: one.error.toUpperCase(), message: 'Request could not be built' });
        continue;
      }
      try {
        await sender(one.request);
        outcomes.push({ leadId, outcome: 'uploaded' });
      } catch (rowError) {
        if (isDataManagerInvalidRequest(rowError)) {
          outcomes.push({ leadId, outcome: 'failed', code: 'INVALID_ARGUMENT', message: describe(rowError).slice(0, 300) });
        } else if (isDataManagerAccessError(rowError)) {
          throw rowError;
        } else {
          outcomes.push({ leadId, outcome: 'retry', code: 'TRANSIENT_ERROR', message: describe(rowError).slice(0, 300) });
        }
      }
    }
    return { outcomes, requestId: null };
  }
}

/** Remembers what worked (best effort: the columns come with the channel migration). */
async function recordChannelState(
  db: Db,
  accountId: string,
  state: { legacyBlocked: boolean; channel: UploadChannel | null; now: Date }
) {
  const patch: Record<string, unknown> = {};
  if (state.legacyBlocked) patch.legacy_blocked_at = state.now.toISOString();
  if (state.channel) patch.last_upload_channel = state.channel;
  if (Object.keys(patch).length === 0) return;
  try {
    await db.from('lead_loop_settings').update(patch).eq('account_id', accountId);
  } catch {
    // The upload itself is already recorded; a missed note only costs one more legacy attempt.
  }
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
