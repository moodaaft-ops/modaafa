import { googleAdsRest } from './client';
import { DEFAULT_ACCOUNT_TIME_ZONE, formatAccountLocal, formatOffset } from '@/lib/measurement/time';

/**
 * Offline click conversions: the "صار زبون" the merchant marks in the lead
 * inbox, sent to Google so Smart Bidding learns on real customers.
 *
 * REST: POST customers/{id}:uploadClickConversions on the API version
 * `client.ts` is configured with (GOOGLE_ADS_API_VERSION, default v22).
 * Request fields (camelCase on the wire): conversions[], partialFailure,
 * validateOnly, jobId. ClickConversion fields used: gclid | gbraid | wbraid
 * (exactly one), conversionAction, conversionDateTime ("yyyy-mm-dd hh:mm:ss+|-hh:mm"),
 * conversionValue, currencyCode, orderId. Source: Google Ads API guide
 * "Manage offline click conversions" and the UploadClickConversions reference.
 *
 * NOT verified live (see docs/mb-upgrade/measurement.md): Google is moving
 * offline imports for developer tokens without recent usage to the Data
 * Manager API; the transport below is injectable so that path can replace it.
 */

/** The API accepts up to 2000 per request; a small batch keeps one bad row cheap to retry. */
export const UPLOAD_MAX_BATCH = 200;
export { DEFAULT_ACCOUNT_TIME_ZONE };

export type UploadableLead = {
  id: string;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  clicked_at: string;
  marked_at: string;
  value_sar: number | null;
};

export type ClickConversionPayload = {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  conversionAction: string;
  conversionDateTime: string;
  conversionValue?: number;
  currencyCode?: string;
  orderId: string;
};

export type UploadClickConversionsBody = {
  conversions: ClickConversionPayload[];
  partialFailure: true;
  validateOnly?: true;
  jobId?: string;
};

/** gclid wins over gbraid over wbraid; the API wants one identifier per conversion, never a mix. */
export function pickClickId(lead: Pick<UploadableLead, 'gclid' | 'gbraid' | 'wbraid'>) {
  if (lead.gclid) return { field: 'gclid' as const, value: lead.gclid };
  if (lead.gbraid) return { field: 'gbraid' as const, value: lead.gbraid };
  if (lead.wbraid) return { field: 'wbraid' as const, value: lead.wbraid };
  return null;
}

/** "2026-10-19 21:05:00+03:00" in the account's own time zone. */
export function formatConversionDateTime(date: Date, timeZone: string | null | undefined): string {
  return `${formatAccountLocal(date, timeZone)}${formatOffset(date, timeZone)}`;
}

export function buildClickConversion(
  lead: UploadableLead,
  options: { conversionAction: string; timeZone?: string | null }
): ClickConversionPayload | null {
  const clickId = pickClickId(lead);
  if (!clickId) return null;

  // A conversion can never precede its click, or Google rejects it.
  const marked = new Date(lead.marked_at).getTime();
  const clicked = new Date(lead.clicked_at).getTime();
  if (!Number.isFinite(marked)) return null;
  const when = new Date(Number.isFinite(clicked) ? Math.max(marked, clicked + 1000) : marked);

  const payload: ClickConversionPayload = {
    [clickId.field]: clickId.value,
    conversionAction: options.conversionAction,
    conversionDateTime: formatConversionDateTime(when, options.timeZone),
    // The lead id is the order id: re-sending the same lead is a DUPLICATE_ORDER_ID, never a second conversion.
    orderId: lead.id,
  } as ClickConversionPayload;
  if (lead.value_sar !== null && lead.value_sar > 0) {
    payload.conversionValue = lead.value_sar;
    payload.currencyCode = 'SAR';
  }
  return payload;
}

export type BuiltUpload = {
  body: UploadClickConversionsBody;
  /** index in body.conversions -> lead id */
  leadIds: string[];
  /** leads that could not be built (no click id, bad date) */
  skipped: Array<{ leadId: string; reason: 'no_click_id' | 'bad_date' }>;
};

export function buildUploadClickConversionsRequest(
  leads: UploadableLead[],
  options: { conversionAction: string; timeZone?: string | null; validateOnly?: boolean; jobId?: string }
): BuiltUpload {
  const conversions: ClickConversionPayload[] = [];
  const leadIds: string[] = [];
  const skipped: BuiltUpload['skipped'] = [];
  for (const lead of leads.slice(0, UPLOAD_MAX_BATCH)) {
    const payload = buildClickConversion(lead, options);
    if (!payload) {
      skipped.push({ leadId: lead.id, reason: pickClickId(lead) ? 'bad_date' : 'no_click_id' });
      continue;
    }
    conversions.push(payload);
    leadIds.push(lead.id);
  }
  const body: UploadClickConversionsBody = {
    conversions,
    partialFailure: true,
    ...(options.validateOnly ? { validateOnly: true as const } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
  };
  return { body, leadIds, skipped };
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

export type RowOutcome =
  | { leadId: string; outcome: 'uploaded' }
  /** Same order id already accepted earlier: the lead is on Google, count it as done. */
  | { leadId: string; outcome: 'duplicate'; code: string }
  /** Worth another try later (too recent, transient). */
  | { leadId: string; outcome: 'retry'; code: string; message: string }
  /** Will never succeed (expired click, unreadable id). */
  | { leadId: string; outcome: 'failed'; code: string; message: string };

export const DUPLICATE_CODES = new Set(['DUPLICATE_ORDER_ID']);
export const RETRYABLE_CODES = new Set([
  'TOO_RECENT_CLICK',
  'TOO_RECENT_CONVERSION_ACTION',
  'TOO_RECENT_EVENT',
  'INTERNAL_ERROR',
  'TRANSIENT_ERROR',
  'RESOURCE_EXHAUSTED',
  'EMPTY_RESULT',
]);
export const PERMANENT_CODES = new Set([
  'EXPIRED_EVENT',
  'EVENT_NOT_FOUND',
  'UNPARSEABLE_GCLID',
  'INVALID_CONVERSION_ACTION_TYPE',
  'CONVERSION_PRECEDES_EVENT',
  'CONVERSION_NOT_FOUND',
  'INVALID_CUSTOMER_FOR_CLICK',
  'CLICK_MISSING_CONVERSION_LABEL',
  'INVALID_USER_IDENTIFIER',
  'CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS',
  'ORDER_ID_CONTAINS_PII',
]);

type FailureEntry = { index: number | null; code: string; message: string };

function toIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Pulls every per-row failure out of partialFailureError.details[].errors[]. */
export function extractPartialFailures(partialFailureError: any): FailureEntry[] {
  if (!partialFailureError) return [];
  const out: FailureEntry[] = [];
  const details: any[] = Array.isArray(partialFailureError.details) ? partialFailureError.details : [];
  for (const detail of details) {
    const errors: any[] = Array.isArray(detail?.errors) ? detail.errors : [];
    for (const error of errors) {
      const codeObject = error?.errorCode ?? error?.error_code ?? {};
      const code = String(Object.values(codeObject).find((value) => typeof value === 'string') ?? 'UNKNOWN');
      const path: any[] = error?.location?.fieldPathElements ?? error?.location?.field_path_elements ?? [];
      const element = path.find((item) => (item?.fieldName ?? item?.field_name) === 'conversions');
      out.push({
        index: toIndex(element?.index),
        code,
        message: String(error?.message ?? '').slice(0, 300),
      });
    }
  }
  return out;
}

export type UploadResponse = {
  results?: Array<Record<string, unknown>>;
  partialFailureError?: any;
  jobId?: string | number;
};

/**
 * One outcome per lead that was in the request. An error without an index
 * (a request-level partial failure) applies to every row that has no result
 * of its own, so nothing is ever reported as uploaded on the strength of silence.
 */
export function interpretUploadResponse(
  response: UploadResponse | null | undefined,
  leadIds: string[],
  options: { validateOnly?: boolean } = {}
): RowOutcome[] {
  const failures = extractPartialFailures(response?.partialFailureError);
  const byIndex = new Map<number, FailureEntry>();
  let general: FailureEntry | null = null;
  for (const failure of failures) {
    if (failure.index === null) general = general ?? failure;
    else if (!byIndex.has(failure.index)) byIndex.set(failure.index, failure);
  }
  const results = Array.isArray(response?.results) ? response!.results! : [];

  return leadIds.map((leadId, index): RowOutcome => {
    const failure = byIndex.get(index);
    if (failure) return classify(leadId, failure);

    const result = results[index];
    const hasResult = Boolean(result && Object.keys(result).length > 0);
    if (hasResult) return { leadId, outcome: 'uploaded' };
    if (general) return classify(leadId, general);
    if (options.validateOnly) return { leadId, outcome: 'uploaded' };
    // No error for this row and no result either: do not claim success.
    return { leadId, outcome: 'retry', code: 'EMPTY_RESULT', message: 'No result for this conversion in the response' };
  });
}

function classify(leadId: string, failure: FailureEntry): RowOutcome {
  if (DUPLICATE_CODES.has(failure.code)) return { leadId, outcome: 'duplicate', code: failure.code };
  if (PERMANENT_CODES.has(failure.code)) {
    return { leadId, outcome: 'failed', code: failure.code, message: failure.message };
  }
  // RETRYABLE and unknown codes both retry; the service caps the attempts.
  return { leadId, outcome: 'retry', code: failure.code, message: failure.message };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type ClickConversionTransport = (args: {
  customerId: string;
  loginCustomerId?: string | null;
  body: UploadClickConversionsBody;
}) => Promise<UploadResponse>;

/** Google Ads API transport. maxAttempts 1: a retried upload would be fine (order_id) but must be decided by the service, not the HTTP layer. */
export function googleAdsClickConversionTransport(refreshToken: string): ClickConversionTransport {
  return ({ customerId, loginCustomerId, body }) =>
    googleAdsRest<UploadResponse>({
      refreshToken,
      path: `/customers/${customerId.replace(/\D/g, '')}:uploadClickConversions`,
      method: 'POST',
      loginCustomerId,
      body,
      maxAttempts: 1,
    });
}
