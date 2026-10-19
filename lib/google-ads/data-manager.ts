import {
  pickClickId,
  UPLOAD_MAX_BATCH,
  type RowOutcome,
  type UploadableLead,
} from './click-conversions';
import { formatAccountLocal, formatOffset } from '@/lib/measurement/time';

/**
 * Offline conversions through the Data Manager API (events:ingest).
 *
 * Why: from 15 June 2026 a developer token that sent no offline conversion
 * upload between 17 Dec 2025 and 15 Jun 2026 can no longer call
 * ConversionUploadService.UploadClickConversions; the call answers
 * CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE and Google points to the Data
 * Manager API (Google Ads API deprecations page, "Access restriction, Offline
 * conversions"). The restriction is by developer token, not by merchant
 * account, so it is all or nothing for this platform.
 *
 * Wire format (developers.google.com/data-manager/api, "Send events" for
 * Google Ads offline conversions and the events.ingest reference):
 *   POST https://datamanager.googleapis.com/v1/events:ingest
 *   { destinations:[{ operatingAccount:{accountType:'GOOGLE_ADS',accountId},
 *                     loginAccount?:{...}, productDestinationId:<conversion action id> }],
 *     events:[{ adIdentifiers:{gclid|gbraid|wbraid}, conversionValue?, currency?,
 *               eventTimestamp (RFC 3339 with offset), transactionId, eventSource,
 *               userData? }],
 *     consent?:{adUserData,adPersonalization}, encoding?:'HEX'|'BASE64', validateOnly? }
 *   OAuth scope https://www.googleapis.com/auth/datamanager. At most 2000 events per request.
 *   The conversion action must be of type UPLOAD_CLICKS. transactionId de-duplicates.
 *
 * NOT verified live: the exact wire name of the user identifier members
 * (userData.userIdentifiers[].emailAddress / phoneNumber), whether
 * eventSource OTHER is accepted for WhatsApp leads (WEB is the documented
 * sample value and is what is sent), and the shape of per-event errors. The
 * ingest is asynchronous: a 200 means "accepted", the per-event verdict
 * arrives later in Google's diagnostics, so accepted rows are recorded as
 * uploaded with the requestId kept in the log.
 */

export const DATA_MANAGER_INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';
export const DATA_MANAGER_REQUEST_TIMEOUT_MS = 20_000;
/** Same small batch as the legacy path: one bad row stays cheap to isolate. */
export const DATA_MANAGER_MAX_BATCH = UPLOAD_MAX_BATCH;
/** When a whole batch is refused as invalid, at most this many rows are re-sent one by one to find the bad ones. */
export const ISOLATE_LIMIT = 20;

export type DataManagerConsent = 'granted' | 'denied' | null;

export type DataManagerEvent = {
  adIdentifiers: { gclid?: string; gbraid?: string; wbraid?: string };
  conversionValue?: number;
  currency?: string;
  eventTimestamp: string;
  transactionId: string;
  eventSource: 'WEB';
  userData?: { userIdentifiers: Array<{ emailAddress?: string; phoneNumber?: string }> };
};

export type DataManagerRequest = {
  destinations: Array<{
    operatingAccount: { accountType: 'GOOGLE_ADS'; accountId: string };
    loginAccount?: { accountType: 'GOOGLE_ADS'; accountId: string };
    productDestinationId: string;
  }>;
  events: DataManagerEvent[];
  encoding?: 'HEX';
  consent?: { adUserData: string; adPersonalization: string };
  validateOnly?: boolean;
};

/** A lead as the Data Manager path sees it: the legacy fields plus already-hashed identifiers, only when the platform has them. */
export type DataManagerLead = UploadableLead & {
  /** Lower-case hex SHA-256 of the normalized email, if the merchant's CRM provided one. */
  email_sha256?: string | null;
  /** Lower-case hex SHA-256 of the E.164 phone number, if provided. */
  phone_sha256?: string | null;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** `customers/123/conversionActions/456` to `456`. Null for anything else. */
export function conversionActionId(resource: string): string | null {
  const match = /^customers\/\d+\/conversionActions\/(\d+)$/.exec(resource);
  return match ? match[1] : null;
}

/** RFC 3339 with the account's own offset: `2026-10-19T21:05:00+03:00`. */
export function formatEventTimestamp(date: Date, timeZone: string | null | undefined): string {
  return `${formatAccountLocal(date, timeZone).replace(' ', 'T')}${formatOffset(date, timeZone)}`;
}

export function consentFromEnv(env: Record<string, string | undefined> = process.env): DataManagerConsent {
  const value = env.DATA_MANAGER_CONSENT?.trim().toLowerCase();
  return value === 'granted' || value === 'denied' ? value : null;
}

export function buildEvent(
  lead: DataManagerLead,
  options: { timeZone?: string | null }
): DataManagerEvent | null {
  const clickId = pickClickId(lead);
  if (!clickId) return null;
  const marked = new Date(lead.marked_at).getTime();
  const clicked = new Date(lead.clicked_at).getTime();
  if (!Number.isFinite(marked)) return null;
  // A conversion can never precede its click.
  const when = new Date(Number.isFinite(clicked) ? Math.max(marked, clicked + 1000) : marked);

  const event: DataManagerEvent = {
    adIdentifiers: { [clickId.field]: clickId.value },
    eventTimestamp: formatEventTimestamp(when, options.timeZone),
    // The lead id is the transaction id: the same lead sent twice is one conversion.
    transactionId: lead.id,
    eventSource: 'WEB',
  };
  if (lead.value_sar !== null && lead.value_sar > 0) {
    event.conversionValue = lead.value_sar;
    event.currency = 'SAR';
  }
  const identifiers: Array<{ emailAddress?: string; phoneNumber?: string }> = [];
  if (lead.email_sha256 && SHA256_HEX.test(lead.email_sha256)) identifiers.push({ emailAddress: lead.email_sha256 });
  if (lead.phone_sha256 && SHA256_HEX.test(lead.phone_sha256)) identifiers.push({ phoneNumber: lead.phone_sha256 });
  if (identifiers.length > 0) event.userData = { userIdentifiers: identifiers };
  return event;
}

export type BuiltDataManagerUpload = {
  request: DataManagerRequest;
  /** index in request.events -> lead id */
  leadIds: string[];
  skipped: Array<{ leadId: string; reason: 'no_click_id' | 'bad_date' }>;
};

export function buildIngestRequest(
  leads: DataManagerLead[],
  options: {
    customerId: string;
    loginCustomerId?: string | null;
    conversionAction: string;
    timeZone?: string | null;
    consent?: DataManagerConsent;
    validateOnly?: boolean;
  }
): BuiltDataManagerUpload | { error: 'invalid_conversion_action' | 'invalid_customer' } {
  const actionId = conversionActionId(options.conversionAction);
  if (!actionId) return { error: 'invalid_conversion_action' };
  const customerId = digitsOf(options.customerId);
  if (!customerId) return { error: 'invalid_customer' };

  const events: DataManagerEvent[] = [];
  const leadIds: string[] = [];
  const skipped: BuiltDataManagerUpload['skipped'] = [];
  for (const lead of leads.slice(0, DATA_MANAGER_MAX_BATCH)) {
    const event = buildEvent(lead, { timeZone: options.timeZone });
    if (!event) {
      skipped.push({ leadId: lead.id, reason: pickClickId(lead) ? 'bad_date' : 'no_click_id' });
      continue;
    }
    events.push(event);
    leadIds.push(lead.id);
  }

  const destination: DataManagerRequest['destinations'][number] = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
    productDestinationId: actionId,
  };
  const login = options.loginCustomerId ? digitsOf(options.loginCustomerId) : '';
  if (login) destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: login };

  const request: DataManagerRequest = { destinations: [destination], events };
  // The encoding only matters for user identifiers; say it only when some are present.
  if (events.some((event) => event.userData)) request.encoding = 'HEX';
  if (options.consent === 'granted') request.consent = { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' };
  else if (options.consent === 'denied') request.consent = { adUserData: 'CONSENT_DENIED', adPersonalization: 'CONSENT_DENIED' };
  if (options.validateOnly) request.validateOnly = true;
  return { request, leadIds, skipped };
}

// ---------------------------------------------------------------------------
// Errors and responses
// ---------------------------------------------------------------------------

export class DataManagerError extends Error {
  constructor(
    readonly status: number,
    readonly googleStatus: string | null,
    message: string,
    readonly reasons: string[] = []
  ) {
    super([googleStatus, message].filter(Boolean).join(': '));
    this.name = 'DataManagerError';
  }
}

/** 401/403, or PERMISSION_DENIED / UNAUTHENTICATED: the grant or the project cannot use the API. */
export function isDataManagerAccessError(error: unknown): boolean {
  if (!(error instanceof DataManagerError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  return error.googleStatus === 'PERMISSION_DENIED' || error.googleStatus === 'UNAUTHENTICATED';
}

/** The whole request was refused as malformed: one bad row can be the cause. */
export function isDataManagerInvalidRequest(error: unknown): boolean {
  return error instanceof DataManagerError && (error.status === 400 || error.googleStatus === 'INVALID_ARGUMENT');
}

export function isDataManagerTransient(error: unknown): boolean {
  if (error instanceof DataManagerError) {
    return error.status === 429 || error.status >= 500 || error.googleStatus === 'RESOURCE_EXHAUSTED' || error.googleStatus === 'UNAVAILABLE';
  }
  const name = (error as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export type IngestResponse = {
  requestId?: string;
  fieldWarnings?: Array<{ fieldPath?: string; reason?: string; message?: string }>;
};

/** Every event in an accepted request is reported as uploaded; Google's diagnostics follow later. */
export function interpretIngestResponse(response: IngestResponse | null | undefined, leadIds: string[]): RowOutcome[] {
  void response;
  return leadIds.map((leadId): RowOutcome => ({ leadId, outcome: 'uploaded' }));
}

/** Error body of a Google API: `{ error: { code, status, message, details: [{ reason }] } }`. */
export function parseDataManagerError(status: number, body: any): DataManagerError {
  const error = body?.error ?? {};
  const details: any[] = Array.isArray(error.details) ? error.details : [];
  const reasons = details.map((d) => (typeof d?.reason === 'string' ? d.reason : null)).filter((r): r is string => Boolean(r));
  return new DataManagerError(
    status,
    typeof error.status === 'string' ? error.status : null,
    String(error.message ?? 'Data Manager request failed').slice(0, 300),
    reasons
  );
}

export type DataManagerSender = (request: DataManagerRequest) => Promise<IngestResponse>;

/** Calls events:ingest with an access token that carries the datamanager scope. No retries: the service decides. */
export function dataManagerSender(accessToken: string, fetchImpl: typeof fetch = fetch): DataManagerSender {
  return async (request) => {
    const response = await fetchImpl(DATA_MANAGER_INGEST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DATA_MANAGER_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!response.ok) throw new DataManagerError(response.status, null, text.slice(0, 300).trim());
        throw new DataManagerError(response.status, null, 'Unreadable Data Manager response body');
      }
    }
    if (!response.ok) throw parseDataManagerError(response.status, data);
    return data as IngestResponse;
  };
}
