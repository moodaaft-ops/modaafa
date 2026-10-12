/**
 * What /operations/leads shows: visitors who left their contact in the exit
 * popup, and first-login users flagged as agency leads. Server only.
 *
 * Both tables arrive with migrations Ayman runs himself (20261014_visitor_leads
 * and 20261014_user_onboarding_answers). Before that, each loader reports
 * "unavailable" and the page says which file is missing instead of failing.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { GROWTH_OWNER_CONFIG, type GrowthOwnerConfig } from '@/lib/growth/owner-config';
import { isAgencyLead } from '@/lib/growth/onboarding-answers';
import { LEAD_FOLLOWUP } from '@/config/lead-followup';

const LIST_LIMIT = 200;

export type LeadView = {
  id: string;
  channel: 'email' | 'whatsapp';
  contact: string;
  source: string;
  createdAt: string;
  followupStatus: string;
  followupReason: string | null;
  whatsappStatus: string;
  contactedAt: string | null;
  contactedBy: string | null;
  optedOut: boolean;
  alreadyUser: boolean;
};

export type AgencyLeadView = {
  userId: string;
  email: string;
  name: string | null;
  phone: string | null;
  createdAt: string;
  businessType: string;
  spendBand: string;
  accountManager: string;
};

export type LeadsDataset = {
  leads: LeadView[];
  leadsUnavailable: boolean;
  agency: AgencyLeadView[];
  agencyUnavailable: boolean;
  answeredCount: number;
};

/** Pure: turns raw rows into the view the page renders. */
export function buildLeadViews(rows: any[], registeredEmails: ReadonlySet<string>): LeadView[] {
  return rows.map((row) => {
    const email = typeof row.email === 'string' ? row.email : null;
    return {
      id: row.id,
      channel: row.channel,
      contact: email ?? (row.whatsapp as string),
      source: row.source,
      createdAt: row.created_at,
      followupStatus: row.followup_status,
      followupReason: row.followup_reason ?? null,
      whatsappStatus: row.whatsapp_status,
      contactedAt: row.contacted_at ?? null,
      contactedBy: row.contacted_by ?? null,
      optedOut: Boolean(row.messages_opt_out),
      alreadyUser: Boolean(email && registeredEmails.has(email)),
    };
  });
}

/** Pure: which answered users are agency leads under the owner's rule. */
export function buildAgencyViews(
  answers: any[],
  users: ReadonlyMap<string, any>,
  config: Pick<GrowthOwnerConfig, 'agencyLeadMinSpendBand' | 'agencyLeadManagers'> = GROWTH_OWNER_CONFIG
): AgencyLeadView[] {
  const out: AgencyLeadView[] = [];
  for (const row of answers) {
    if (row.skipped) continue;
    if (!isAgencyLead({ spendBand: row.spend_band, accountManager: row.account_manager }, config)) continue;
    const user = users.get(row.user_id);
    if (!user?.email) continue;
    out.push({
      userId: row.user_id,
      email: user.email,
      name: user.name ?? null,
      phone: user.phone ?? null,
      createdAt: user.created_at ?? row.created_at,
      businessType: row.business_type,
      spendBand: row.spend_band,
      accountManager: row.account_manager,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const IN_CHUNK = 100;

/** `.in()` puts every value in the URL, so a long list is read in slices. Returns null when any slice fails. */
async function selectIn(admin: any, columns: string, column: string, values: string[]): Promise<any[] | null> {
  const rows: any[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const res = await admin.from('users').select(columns).in(column, values.slice(i, i + IN_CHUNK));
    if (res.error) return null;
    rows.push(...(res.data ?? []));
  }
  return rows;
}

export async function loadLeadsDataset(deps: { client?: any; config?: GrowthOwnerConfig } = {}): Promise<LeadsDataset> {
  const admin = deps.client ?? createAdminClient();
  const config = deps.config ?? GROWTH_OWNER_CONFIG;
  const dataset: LeadsDataset = { leads: [], leadsUnavailable: false, agency: [], agencyUnavailable: false, answeredCount: 0 };

  const leadsRes = await admin
    .from('visitor_leads')
    .select(
      'id, channel, email, whatsapp, source, created_at, followup_status, followup_reason, whatsapp_status, contacted_at, contacted_by, messages_opt_out'
    )
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (leadsRes.error) {
    dataset.leadsUnavailable = true;
  } else {
    const rows = leadsRes.data ?? [];
    const emails = rows.map((row: any) => row.email).filter(Boolean) as string[];
    let registered = new Set<string>();
    if (emails.length > 0) {
      const found = await selectIn(admin, 'email', 'email', emails);
      if (found) registered = new Set(found.map((u: any) => String(u.email).toLowerCase()));
    }
    dataset.leads = buildLeadViews(rows, registered);
  }

  const answersRes = await admin
    .from('user_onboarding_answers')
    .select('user_id, business_type, spend_band, account_manager, skipped, created_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (answersRes.error) {
    dataset.agencyUnavailable = true;
  } else {
    const rows = answersRes.data ?? [];
    dataset.answeredCount = rows.filter((row: any) => !row.skipped).length;
    const candidates = rows.filter((row: any) => !row.skipped);
    const ids = candidates.map((row: any) => row.user_id);
    if (ids.length > 0) {
      const found = await selectIn(admin, 'id, email, name, phone, created_at', 'id', ids);
      if (!found) dataset.agencyUnavailable = true;
      else dataset.agency = buildAgencyViews(candidates, new Map<string, any>(found.map((u: any) => [u.id, u])), config);
    }
  }

  return dataset;
}

export function leadWhatsappText(sampleReportUrl: string | null) {
  const link = sampleReportUrl?.trim();
  return link ? `${LEAD_FOLLOWUP.whatsappText}\n${link}` : LEAD_FOLLOWUP.whatsappText;
}

export const FOLLOWUP_STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار الإرسال',
  sending: 'قيد الإرسال',
  sent: 'انرسل',
  failed: 'فشل الإرسال',
  skipped: 'ما انرسل',
};
