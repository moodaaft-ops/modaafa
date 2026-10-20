import { parseDataManagerError } from '../google-ads/data-manager';
import { createHash } from 'node:crypto';
import { toLatinDigits } from '../ads/validators';

/**
 * Customer Match: normalising and hashing a merchant's customer list.
 *
 * Normalization, SHA-256 hashing and Data Manager request construction. The real
 * transport is injected by the approval executor after it resolves the merchant's
 * separate Data Manager OAuth grant. Generic callers default to NO_TRANSPORT.
 * Raw email and phone values never enter a queued approval payload.
 *
 * Policy (Google's Customer Match policy, stated here, never decided here):
 * eligibility depends on the advertiser account's history and spend, and Google
 * checks it at upload. Per google-ads-titan video-demandgen-mastery.md 22.4:
 * direct targeting and bid adjustments need a clean record of 90 days and
 * over 50,000 USD lifetime spend, while observation and exclusion are open to
 * all; the sources conflict on exclusion, so connect a list first and see. We do
 * NOT guess eligibility through the API. Saudi PDPL (in force since 14 Sep 2024)
 * needs the customer's consent for direct marketing: the merchant confirms it.
 */

export const CUSTOMER_MATCH_MIN_MEMBERS = 100;
export const CUSTOMER_MATCH_MAX_MEMBERS = 100_000;
export const INGEST_CHUNK_SIZE = 10_000;

export const CUSTOMER_MATCH_POLICY_AR = [
  'أهلية القوائم تحددها قوقل وقت الرفع حسب تاريخ حسابك وصرفه، ونحن ما نخمّنها',
  'الاستهداف المباشر بالقوائم يحتاج حساب نظيف وصرف سابق كبير. الاستبعاد والمراقبة أسهل',
  'لازم تأكد إن عملاءك وافقوا على التسويق المباشر (نظام حماية البيانات الشخصية) وإن سياسة الخصوصية عندك تذكر مشاركة البيانات',
  `قوقل ما تشغّل القائمة قبل ${CUSTOMER_MATCH_MIN_MEMBERS} عضو`,
] as const;

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim().toLowerCase();
  const match = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(text);
  if (!match) return null;
  let [, local, domain] = match;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

/**
 * E.164 phone. Saudi mobiles from «05XXXXXXXX», «5XXXXXXXX», «9665…», «009665…», «+9665…».
 * A number that already carries another country code («+971…», «00971…») is kept if it is 8 to 15 digits.
 * Landlines and anything else return null: Customer Match matches on mobiles.
 */
export function normalizePhoneE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const latin = toLatinDigits(raw).trim();
  const hadPlus = latin.startsWith('+');
  let digits = latin.replace(/\D/g, '');
  if (!digits) return null;
  let international = hadPlus;
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!international) {
    if (digits.length === 10 && digits.startsWith('05')) return `+966${digits.slice(1)}`;
    if (digits.length === 9 && digits.startsWith('5')) return `+966${digits}`;
    if (digits.startsWith('966')) international = true;
    else return null;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('966')) return /^9665\d{8}$/.test(digits) ? `+${digits}` : null;
  return `+${digits}`;
}

export type CustomerRow = { email?: unknown; phone?: unknown };

export type HashedMember = { email_sha256?: string; phone_sha256?: string };

export type PreparedMembers = {
  members: HashedMember[];
  total_rows: number;
  usable: number;
  dropped: { no_identifier: number; duplicate: number };
  invalid: { email: number; phone: number };
  meets_minimum: boolean;
};

export function prepareCustomerMatchMembers(rows: readonly CustomerRow[]): PreparedMembers {
  const members: HashedMember[] = [];
  const seen = new Set<string>();
  const result: PreparedMembers = {
    members,
    total_rows: rows.length,
    usable: 0,
    dropped: { no_identifier: 0, duplicate: 0 },
    invalid: { email: 0, phone: 0 },
    meets_minimum: false,
  };
  for (const row of rows) {
    const rawEmail = row?.email;
    const rawPhone = row?.phone;
    const email = normalizeEmail(rawEmail);
    const phone = normalizePhoneE164(rawPhone);
    if (rawEmail && !email) result.invalid.email += 1;
    if (rawPhone && !phone) result.invalid.phone += 1;
    if (!email && !phone) {
      result.dropped.no_identifier += 1;
      continue;
    }
    const member: HashedMember = {
      ...(email ? { email_sha256: sha256Hex(email) } : {}),
      ...(phone ? { phone_sha256: sha256Hex(phone) } : {}),
    };
    const key = `${member.email_sha256 ?? ''}|${member.phone_sha256 ?? ''}`;
    if (seen.has(key)) {
      result.dropped.duplicate += 1;
      continue;
    }
    seen.add(key);
    if (members.length < CUSTOMER_MATCH_MAX_MEMBERS) members.push(member);
  }
  result.usable = members.length;
  result.meets_minimum = members.length >= CUSTOMER_MATCH_MIN_MEMBERS;
  return result;
}

// ---------------------------------------------------------------------------
// Data Manager request (draft shape, not verified live) and transport
// ---------------------------------------------------------------------------

export type IngestRequest = {
  destinations: Array<{
    operatingAccount: { accountType: 'GOOGLE_ADS'; accountId: string };
    loginAccount?: { accountType: 'GOOGLE_ADS'; accountId: string };
    productDestinationId: string;
  }>;
  audienceMembers: Array<{ userData: { userIdentifiers: Array<{ emailAddress: string } | { phoneNumber: string }> } }>;
  consent: { adUserData: 'CONSENT_GRANTED'; adPersonalization: 'CONSENT_GRANTED' };
  encoding: 'HEX';
  termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' };
  validateOnly?: boolean;
};

export type IngestOptions = {
  customerId: string;
  loginCustomerId?: string | null;
  /** The numeric id of the CRM based user list (the last part of customers/<id>/userLists/<id>). */
  userListId: string;
  /** The merchant confirmed their customers' consent. Required: we never assume it. */
  consentConfirmed: boolean;
  /** The merchant accepted Google's Customer Match terms in their account. Required. */
  termsConfirmed: boolean;
  validateOnly?: boolean;
};

export class CustomerMatchRefusedError extends Error {
  constructor(readonly code: 'consent_not_confirmed' | 'terms_not_confirmed' | 'too_few_members' | 'bad_ids') {
    super(code);
    this.name = 'CustomerMatchRefusedError';
  }
}

export class CustomerMatchNotConfiguredError extends Error {
  constructor() {
    super('customer_match_transport_not_configured');
    this.name = 'CustomerMatchNotConfiguredError';
  }
}

export function buildIngestRequests(members: readonly HashedMember[], options: IngestOptions): IngestRequest[] {
  if (!options.consentConfirmed) throw new CustomerMatchRefusedError('consent_not_confirmed');
  if (!options.termsConfirmed) throw new CustomerMatchRefusedError('terms_not_confirmed');
  if (members.length < CUSTOMER_MATCH_MIN_MEMBERS) throw new CustomerMatchRefusedError('too_few_members');
  const customerId = options.customerId.replace(/\D/g, '');
  const login = options.loginCustomerId?.replace(/\D/g, '') || null;
  if (!customerId || !/^\d+$/.test(options.userListId)) throw new CustomerMatchRefusedError('bad_ids');

  for (const m of members) {
    if (!m || Object.keys(m).some((k) => !['email_sha256', 'phone_sha256'].includes(k)) ||
      (!m.email_sha256 && !m.phone_sha256) || [m.email_sha256, m.phone_sha256].some((v) => v !== undefined && !/^[0-9a-f]{64}$/.test(v))) {
      throw new CustomerMatchRefusedError('bad_ids');
    }
  }
  const requests: IngestRequest[] = [];
  for (let i = 0; i < members.length; i += INGEST_CHUNK_SIZE) {
    requests.push({
      destinations: [
        {
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
          ...(login ? { loginAccount: { accountType: 'GOOGLE_ADS' as const, accountId: login } } : {}),
          productDestinationId: options.userListId,
        },
      ],
      audienceMembers: members.slice(i, i + INGEST_CHUNK_SIZE).map((m) => ({
        userData: {
          userIdentifiers: [
            ...(m.email_sha256 ? [{ emailAddress: m.email_sha256 }] : []),
            ...(m.phone_sha256 ? [{ phoneNumber: m.phone_sha256 }] : []),
          ],
        },
      })),
      consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
      encoding: 'HEX',
      termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
      ...(options.validateOnly ? { validateOnly: true } : {}),
    });
  }
  return requests;
}

export interface CustomerMatchTransport {
  ingest(request: IngestRequest): Promise<{ requestId?: string }>;
  status?(requestId: string): Promise<string[]>;
}

/** Some chunks were accepted. A whole-card retry must stay locked for reconciliation. */
export class PartialAudienceUploadError extends Error {
  constructor(readonly acceptedRequestIds: string[], cause?: unknown) {
    super(`Customer Match upload requires reconciliation before retry; accepted requests: ${acceptedRequestIds.join(',') || 'unknown'}`, { cause });
    this.name = 'PartialAudienceUploadError';
  }
}

/** The default: no transport, no upload. */
export const NO_TRANSPORT: CustomerMatchTransport = {
  async ingest() {
    throw new CustomerMatchNotConfiguredError();
  },
};

export async function uploadCustomerMatch(
  members: readonly HashedMember[],
  options: IngestOptions,
  transport: CustomerMatchTransport = NO_TRANSPORT
): Promise<{ requests: number; request_ids: string[] }> {
  const requests = buildIngestRequests(members, options);
  const ids: string[] = [];
  for (const request of requests) {
    try {
      const response = await transport.ingest(request);
      if (response?.requestId) ids.push(response.requestId);
      else if (!options.validateOnly) throw new PartialAudienceUploadError(ids);
    } catch (error) {
      if (!options.validateOnly && ids.length) throw new PartialAudienceUploadError(ids, error);
      throw error;
    }
  }
  return { requests: requests.length, request_ids: ids };
}

/** Official audienceMembers:ingest transport. No raw identifiers and no automatic retries. */
export function customerMatchTransport(accessToken: string, fetchImpl: typeof fetch = fetch): CustomerMatchTransport {
  return { async ingest(request) {
    const response = await fetchImpl('https://datamanager.googleapis.com/v1/audienceMembers:ingest', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw parseDataManagerError(response.status, data);
    return { requestId: data.requestId };
  }, async status(requestId) {
    const url = new URL('https://datamanager.googleapis.com/v1/requestStatus:retrieve');
    url.searchParams.set('requestId', requestId);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('customer_match_status_unavailable');
    const data = await response.json();
    return (data.requestStatusPerDestination ?? []).map((row: any) => String(row.requestStatus ?? 'REQUEST_STATUS_UNKNOWN'));
  } };
}
