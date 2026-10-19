import { extractRefCode, generateSlug, isValidSlug } from './ref-code';
import { planLeadRedirect, type LeadLinkSettings, type NewLeadClick } from './redirect';
import { buildMarkPatch, type LeadRowForMarking, type MarkInput, type MarkPatch } from './marking';

/**
 * Database access for the lead loop. Every function takes the Supabase client
 * as an argument (service role in the routes, a fake in the tests). Nothing
 * here talks to Google.
 */
type Db = any;

export type LeadLinkRow = LeadLinkSettings & {
  slug: string;
  conversion_action_resource: string | null;
  conversion_action_checked_at: string | null;
};

const SETTINGS_COLUMNS =
  'account_id, slug, whatsapp_number, default_text, enabled, conversion_action_resource, conversion_action_checked_at';

export async function getSettingsBySlug(db: Db, slug: string): Promise<LeadLinkRow | null> {
  if (!isValidSlug(slug)) return null;
  const { data, error } = await db.from('lead_loop_settings').select(SETTINGS_COLUMNS).eq('slug', slug).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getSettingsByAccount(db: Db, accountId: string): Promise<LeadLinkRow | null> {
  const { data, error } = await db.from('lead_loop_settings').select(SETTINGS_COLUMNS).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Creates the row on first save (new slug) and updates number and text afterwards (slug never changes, so a pasted link keeps working). */
export async function saveSettings(
  db: Db,
  accountId: string,
  input: { whatsapp_number: string; default_text: string },
  options: { slug?: () => string } = {}
): Promise<LeadLinkRow> {
  const existing = await getSettingsByAccount(db, accountId);
  if (existing) {
    const { data, error } = await db
      .from('lead_loop_settings')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .select(SETTINGS_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await db
      .from('lead_loop_settings')
      .insert({ account_id: accountId, slug: (options.slug ?? generateSlug)(), ...input })
      .select(SETTINGS_COLUMNS)
      .single();
    if (!error) return data;
    if (error.code !== '23505') throw error;
    // Either the slug collided (retry with a new one) or a parallel save created the row (read it).
    const raced = await getSettingsByAccount(db, accountId);
    if (raced) return raced;
  }
  throw new Error('slug_generation_failed');
}

const MAX_REF_ATTEMPTS = 8;

/**
 * Stores one click and returns where to send the visitor. A ref code that
 * collides inside the account (unique violation) is regenerated, a little
 * longer each time.
 */
export async function recordLeadClick(
  db: Db,
  settings: LeadLinkSettings,
  request: { searchParams: URLSearchParams; referer?: string | null },
  now: Date = new Date(),
  random?: Parameters<typeof planLeadRedirect>[0]['random']
): Promise<{ url: string; click: NewLeadClick }> {
  for (let attempt = 0; attempt < MAX_REF_ATTEMPTS; attempt += 1) {
    const plan = planLeadRedirect({ settings, searchParams: request.searchParams, referer: request.referer, now, attempt, random });
    // has_click_id is for the caller; the table has no such column.
    const { has_click_id: _ignored, ...row } = plan.click;
    void _ignored;
    const { error } = await db.from('lead_clicks').insert(row);
    if (!error) return plan;
    if (error.code !== '23505') throw error;
  }
  throw new Error('ref_code_exhausted');
}

export type LeadListRow = {
  id: string;
  ref_code: string;
  clicked_at: string;
  status: string;
  marked_at: string | null;
  value_sar: number | null;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  landing_path: string | null;
  upload_status: string;
  upload_error: string | null;
  has_click_id: boolean;
};

const LIST_COLUMNS =
  'id, ref_code, clicked_at, status, marked_at, value_sar, utm_source, utm_campaign, utm_term, landing_path, upload_status, upload_error, gclid, gbraid, wbraid';

function toListRow(row: any): LeadListRow {
  const { gclid, gbraid, wbraid, ...rest } = row;
  return { ...rest, value_sar: row.value_sar === null ? null : Number(row.value_sar), has_click_id: Boolean(gclid || gbraid || wbraid) };
}

/** Leads of the last `days` days, newest first. */
export async function listRecentLeads(db: Db, accountId: string, days: number, now: Date = new Date(), limit = 200): Promise<LeadListRow[]> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const { data, error } = await db
    .from('lead_clicks')
    .select(LIST_COLUMNS)
    .eq('account_id', accountId)
    .gte('clicked_at', since)
    .order('clicked_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toListRow);
}

/** Finds a lead from whatever the merchant pasted (a code or a whole WhatsApp message). */
export async function findLeadByRefInput(db: Db, accountId: string, input: unknown): Promise<LeadListRow | null> {
  const ref = extractRefCode(input);
  if (!ref) return null;
  const { data, error } = await db
    .from('lead_clicks')
    .select(LIST_COLUMNS)
    .eq('account_id', accountId)
    .eq('ref_code', ref)
    .maybeSingle();
  if (error) throw error;
  return data ? toListRow(data) : null;
}

export type MarkResult =
  | { ok: true; patch: MarkPatch }
  | { ok: false; error: 'not_found' | 'locked_uploaded' };

/** Applies the merchant's verdict. The conditional update also refuses a row that started uploading since it was read. */
export async function markLead(db: Db, accountId: string, leadId: string, input: MarkInput, now: Date = new Date()): Promise<MarkResult> {
  const { data: row, error } = await db
    .from('lead_clicks')
    .select('id, status, upload_status, gclid, gbraid, wbraid')
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { ok: false, error: 'not_found' };

  const built = buildMarkPatch(row as LeadRowForMarking, input, now);
  if (!built.ok) return built;

  const { data: updated, error: updateError } = await db
    .from('lead_clicks')
    .update(built.patch)
    .eq('id', leadId)
    .eq('account_id', accountId)
    .not('upload_status', 'in', '(uploaded,uploading)')
    .select('id')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) return { ok: false, error: 'locked_uploaded' };
  return { ok: true, patch: built.patch };
}

export type LeadSummary = { total: number; customers: number; value_sar: number; waiting: number };

export function summarizeLeads(rows: Array<Pick<LeadListRow, 'status' | 'value_sar'>>): LeadSummary {
  let customers = 0;
  let value = 0;
  let waiting = 0;
  for (const row of rows) {
    if (row.status === 'customer') {
      customers += 1;
      value += row.value_sar ?? 0;
    }
    if (row.status === 'new') waiting += 1;
  }
  return { total: rows.length, customers, value_sar: Math.round(value * 100) / 100, waiting };
}
