import { formatAccountLocal, wallClockMs } from './time';

/**
 * Bidding data exclusions: tell Smart Bidding to ignore a window in which
 * conversion tracking was broken, so it does not learn from missing numbers.
 *
 * Google Ads API: BiddingDataExclusionService.MutateBiddingDataExclusions
 * (REST customers/{id}/biddingDataExclusions:mutate). Fields used: name
 * (required, unique), scope (CAMPAIGN | CHANNEL; CUSTOMER is read-only),
 * campaigns (scope CAMPAIGN, max 2000) or advertising_channel_types (scope
 * CHANNEL), start_date_time and end_date_time ("yyyy-MM-dd HH:mm:ss" in the
 * account's time zone), devices (optional). The start must be in the past, the
 * end may be in the past or the future. Max 500 active exclusions per account.
 * Created in client accounts only. The guide says exclusions are for outages
 * and major issues and that heavy use hurts Smart Bidding, hence the caps here.
 */
export const DATA_EXCLUSION_OPERATION = 'add_data_exclusion';
export const MAX_EXCLUSION_DAYS = 14;
export const MAX_EXCLUSIONS_PER_30_DAYS = 3;
export const MAX_EXCLUSION_CAMPAIGNS = 50;
export const DATA_EXCLUSION_CHANNELS = ['SEARCH', 'SHOPPING', 'PERFORMANCE_MAX', 'DISPLAY', 'VIDEO', 'DEMAND_GEN'] as const;
export const DATA_EXCLUSION_DEVICES = ['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV'] as const;

export type DataExclusionParams = {
  name: string;
  description?: string;
  scope: 'CAMPAIGN' | 'CHANNEL';
  campaigns?: string[];
  advertising_channel_types?: string[];
  start_date_time: string;
  end_date_time: string;
  devices?: string[];
};

export type DataExclusionError =
  | 'name_invalid'
  | 'scope_invalid'
  | 'campaigns_invalid'
  | 'channels_invalid'
  | 'devices_invalid'
  | 'date_format_invalid'
  | 'start_not_in_past'
  | 'end_before_start'
  | 'window_too_long';

export function dataExclusionName(startDate: string, endDate: string) {
  return `مُضاعِف | تتبع مكسور | ${startDate} إلى ${endDate}`;
}

const NAME_MAX = 200;

/**
 * Pure validation shared by the executable-action boundary, the guardrail and
 * the proposal builder, so the three can never disagree about what is allowed.
 * `now` and `timeZone` decide whether the start is in the past; without
 * `now` that single check is skipped (Google re-checks it on validateOnly).
 */
export function validateDataExclusionParams(
  input: unknown,
  options: { customerId?: string | null; now?: Date; timeZone?: string | null } = {}
): { ok: true; value: DataExclusionParams } | { ok: false; code: DataExclusionError } {
  const p = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || name.length > NAME_MAX) return { ok: false, code: 'name_invalid' };

  const scope = p.scope;
  if (scope !== 'CAMPAIGN' && scope !== 'CHANNEL') return { ok: false, code: 'scope_invalid' };

  let campaigns: string[] | undefined;
  let channels: string[] | undefined;
  if (scope === 'CAMPAIGN') {
    const list = Array.isArray(p.campaigns) ? p.campaigns : [];
    const customer = options.customerId ? options.customerId.replace(/\D/g, '') : '\\d+';
    const pattern = new RegExp(`^customers/${customer}/campaigns/\\d+$`);
    if (
      list.length === 0 ||
      list.length > MAX_EXCLUSION_CAMPAIGNS ||
      !list.every((item) => typeof item === 'string' && pattern.test(item))
    ) {
      return { ok: false, code: 'campaigns_invalid' };
    }
    campaigns = [...new Set(list as string[])];
  } else {
    const list = Array.isArray(p.advertising_channel_types) ? p.advertising_channel_types : [];
    if (
      list.length === 0 ||
      !list.every((item) => typeof item === 'string' && (DATA_EXCLUSION_CHANNELS as readonly string[]).includes(item))
    ) {
      return { ok: false, code: 'channels_invalid' };
    }
    channels = [...new Set(list as string[])];
  }

  let devices: string[] | undefined;
  if (p.devices !== undefined) {
    const list = Array.isArray(p.devices) ? p.devices : [];
    if (!list.every((item) => typeof item === 'string' && (DATA_EXCLUSION_DEVICES as readonly string[]).includes(item))) {
      return { ok: false, code: 'devices_invalid' };
    }
    devices = list.length > 0 ? [...new Set(list as string[])] : undefined;
  }

  const start = typeof p.start_date_time === 'string' ? p.start_date_time : '';
  const end = typeof p.end_date_time === 'string' ? p.end_date_time : '';
  const startMs = wallClockMs(start);
  const endMs = wallClockMs(end);
  if (startMs === null || endMs === null) return { ok: false, code: 'date_format_invalid' };
  if (endMs <= startMs) return { ok: false, code: 'end_before_start' };
  if (endMs - startMs > MAX_EXCLUSION_DAYS * 86_400_000) return { ok: false, code: 'window_too_long' };
  if (options.now) {
    const nowMs = wallClockMs(formatAccountLocal(options.now, options.timeZone));
    if (nowMs === null || startMs >= nowMs) return { ok: false, code: 'start_not_in_past' };
  }

  const value: DataExclusionParams = {
    name,
    scope,
    start_date_time: start,
    end_date_time: end,
    ...(typeof p.description === 'string' && p.description.trim()
      ? { description: p.description.trim().slice(0, 200) }
      : {}),
    ...(campaigns ? { campaigns } : {}),
    ...(channels ? { advertising_channel_types: channels } : {}),
    ...(devices ? { devices } : {}),
  };
  return { ok: true, value };
}

/** The `create` body of one BiddingDataExclusionOperation (snake_case; the REST client camelizes). */
export function buildDataExclusionCreate(params: DataExclusionParams) {
  return {
    name: params.name,
    ...(params.description ? { description: params.description } : {}),
    scope: params.scope,
    ...(params.scope === 'CAMPAIGN' ? { campaigns: params.campaigns } : { advertising_channel_types: params.advertising_channel_types }),
    ...(params.devices ? { devices: params.devices } : {}),
    start_date_time: params.start_date_time,
    end_date_time: params.end_date_time,
  };
}
