import { extractPartialFailures, type UploadResponse } from '@/lib/google-ads/click-conversions';
import { getGoogleAdsErrorCodes } from '@/lib/google-ads/client';

/**
 * Which way an offline conversion travels to Google, and when to switch.
 *
 *  legacy        Google Ads API ConversionUploadService.UploadClickConversions
 *  data_manager  Data Manager API events:ingest (lib/google-ads/data-manager.ts)
 *
 * With DATA_MANAGER_UPLOAD_ENABLED off the service never sees a channel plan and
 * behaves exactly as before (legacy only). With it on:
 *  - Data Manager is tried first when the merchant has granted the
 *    `datamanager` scope (a separate consent, lib/google-auth);
 *  - legacy is the fallback for a developer token that still has access;
 *  - a CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE answer from legacy marks it
 *    blocked (lead_loop_settings.legacy_blocked_at) so it is not tried again.
 */
export type UploadChannel = 'legacy' | 'data_manager';
export type ChannelPreference = 'auto' | 'legacy' | 'data_manager';

export const LEGACY_BLOCKED_CODE = 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE';

export function normalizePreference(value: unknown): ChannelPreference {
  return value === 'legacy' || value === 'data_manager' ? value : 'auto';
}

/** True for a thrown Google Ads REST error that carries the allowlist code (in the codes or in the message). */
export function isLegacyBlockedError(error: unknown): boolean {
  if (getGoogleAdsErrorCodes(error).includes(LEGACY_BLOCKED_CODE)) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(LEGACY_BLOCKED_CODE);
}

/** True when a 200 response reports the allowlist code as its request-level failure. */
export function responseSaysLegacyBlocked(response: UploadResponse | null | undefined): boolean {
  return extractPartialFailures(response?.partialFailureError).some((failure) => failure.code === LEGACY_BLOCKED_CODE);
}

/**
 * The channels to try, in order. An empty list means the merchant must grant
 * the Data Manager scope before anything can be sent (legacy is blocked, or
 * the operator pinned data_manager and there is no grant).
 */
export function planChannels(input: {
  dataManagerAvailable: boolean;
  preference: ChannelPreference;
  legacyBlocked: boolean;
}): UploadChannel[] {
  const { dataManagerAvailable, preference, legacyBlocked } = input;
  if (preference === 'legacy') return legacyBlocked ? [] : ['legacy'];
  if (preference === 'data_manager') return dataManagerAvailable ? ['data_manager'] : [];
  const order: UploadChannel[] = [];
  if (dataManagerAvailable) order.push('data_manager');
  if (!legacyBlocked) order.push('legacy');
  return order;
}
