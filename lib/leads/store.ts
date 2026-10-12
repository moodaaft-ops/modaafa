import { createAdminClient } from '@/lib/supabase/server';
import type { ParsedLead } from './request';
import { emailKey } from './contact';

type LeadInput = Extract<ParsedLead, { ok: true; spam: false }>['lead'];

export type InsertLeadResult =
  | { status: 'created'; id: string }
  | { status: 'duplicate' }
  | { status: 'unavailable' };

const UNIQUE_VIOLATION = '23505';

/**
 * Stores one lead (db/migrations/20261014_visitor_leads.sql). The same email or
 * number twice is "duplicate", not an error: the caller answers the visitor
 * identically either way, so the form cannot be used to check who is on the list.
 */
export async function insertLead(lead: LeadInput, deps: { client?: any } = {}): Promise<InsertLeadResult> {
  try {
    const client = deps.client ?? createAdminClient();
    const { data, error } = await client
      .from('visitor_leads')
      .insert({
        channel: lead.channel,
        email: lead.email,
        email_key: lead.email ? emailKey(lead.email) : null,
        whatsapp: lead.whatsapp,
        source: lead.source,
        page: lead.page,
        utm: lead.utm,
      })
      .select('id')
      .single();
    if (!error && data?.id) return { status: 'created', id: data.id as string };
    if (error?.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
    console.error('[leads] insert failed', error?.code, error?.message);
    return { status: 'unavailable' };
  } catch (error) {
    console.error('[leads] insert threw', error);
    return { status: 'unavailable' };
  }
}
