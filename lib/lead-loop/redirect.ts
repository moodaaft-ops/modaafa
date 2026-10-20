import { generateRefCode, REF_DEFAULT_LENGTH, REF_MAX_LENGTH, type RandomSource } from './ref-code';
import { hasClickId, parseLeadClickParams, type LeadClickParams } from './click-ids';
import { buildWhatsappUrl } from './whatsapp';

export type LeadLinkSettings = {
  account_id: string;
  whatsapp_number: string;
  default_text: string | null;
  enabled?: boolean | null;
};

export type NewLeadClick = {
  account_id: string;
  ref_code: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_path: string | null;
  clicked_at: string;
  has_click_id: boolean;
};

/**
 * What one visit to /w/<slug> does: the row to store and where to send the
 * visitor. Pure, so the parsing is testable without a request or a database.
 * `attempt` widens the ref code after repeated collisions (4, 4, 5, 5, 6 chars).
 */
export function planLeadRedirect({
  settings,
  searchParams,
  referer,
  now,
  attempt = 0,
  random,
}: {
  settings: LeadLinkSettings;
  searchParams: URLSearchParams;
  referer?: string | null;
  now: Date;
  attempt?: number;
  random?: RandomSource;
}): { click: NewLeadClick; url: string } {
  const params: LeadClickParams = parseLeadClickParams(searchParams, referer);
  const length = Math.min(REF_DEFAULT_LENGTH + Math.floor(attempt / 2), REF_MAX_LENGTH);
  const ref = generateRefCode(length, random);
  return {
    click: {
      account_id: settings.account_id,
      ref_code: ref,
      gclid: params.gclid ?? null,
      gbraid: params.gbraid ?? null,
      wbraid: params.wbraid ?? null,
      utm_source: params.utm_source ?? null,
      utm_medium: params.utm_medium ?? null,
      utm_campaign: params.utm_campaign ?? null,
      utm_content: params.utm_content ?? null,
      utm_term: params.utm_term ?? null,
      landing_path: params.landing_path ?? null,
      clicked_at: now.toISOString(),
      has_click_id: hasClickId(params),
    },
    url: buildWhatsappUrl(settings.whatsapp_number, settings.default_text, ref),
  };
}
