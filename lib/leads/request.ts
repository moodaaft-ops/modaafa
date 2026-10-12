import { cleanPage, cleanUtm, normalizeEmail, normalizeWhatsapp } from './contact';

export const LEAD_SOURCES = ['exit_desktop', 'exit_mobile'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type ParsedLead =
  | { ok: true; spam: false; lead: { channel: 'email' | 'whatsapp'; email: string | null; whatsapp: string | null; source: LeadSource; page: string; utm: Record<string, string> } }
  | { ok: true; spam: true }
  | { ok: false; error: 'invalid_body' | 'invalid_contact' | 'invalid_channel' };

/**
 * Validates the popup's POST body. Pure.
 *
 * `website` is a field real visitors never see. A bot that fills every input
 * fills it too, and gets the same friendly answer as a real visitor, so it has
 * nothing to learn from. `ok: true, spam: true` means "answer fine, store nothing".
 */
export function parseLeadRequest(body: unknown): ParsedLead {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const input = body as Record<string, unknown>;

  if (typeof input.website === 'string' && input.website.trim() !== '') return { ok: true, spam: true };

  const channel = input.channel;
  if (channel !== 'email' && channel !== 'whatsapp') return { ok: false, error: 'invalid_channel' };

  const email = channel === 'email' ? normalizeEmail(input.contact) : null;
  const whatsapp = channel === 'whatsapp' ? normalizeWhatsapp(input.contact) : null;
  if (channel === 'email' ? !email : !whatsapp) return { ok: false, error: 'invalid_contact' };

  const source: LeadSource = input.source === 'exit_mobile' ? 'exit_mobile' : 'exit_desktop';
  return {
    ok: true,
    spam: false,
    lead: { channel, email, whatsapp, source, page: cleanPage(input.page), utm: cleanUtm(input.utm) },
  };
}
