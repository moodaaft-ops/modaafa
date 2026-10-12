import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { parseLeadRequest } from '@/lib/leads/request';
import { insertLead } from '@/lib/leads/store';
import { sendLeadFollowup } from '@/lib/leads/followup';
import { exitPopupEnabled } from '@/lib/growth/owner-config';
import { rateLimitBucket } from '@/lib/leads/contact';
import { resolveClientIp } from '@/lib/security/rate-limit';

export const maxDuration = 30;

const MAX_BODY_BYTES = 2048;

/**
 * Exit-popup lead capture. Public on purpose: the visitor has no account.
 *
 * Protection, in the order it runs:
 *   1. same-origin check and a 2 KB body cap
 *   2. 5 submissions per hour per IP (an IPv6 address counts as its /64), and
 *      300 valid submissions per hour for the whole endpoint, so a flood from
 *      many IPs cannot fill the table or burn email quota, and junk requests
 *      cannot use the shared budget up
 *   3. a hidden `website` field that only bots fill
 *   4. strict validation, then a unique index so the same address is stored once
 * A repeat of an address answers exactly like a new one, so the form cannot be
 * used to find out who is already on the list.
 */
export async function POST(req: NextRequest) {
  if (!exitPopupEnabled()) return NextResponse.json({ error: 'not_available' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: 'invalid_body' }, { status: 413 });

  try {
    const perIp = await checkRateLimit({ req, scope: 'leads_ip', limit: 5, windowSeconds: 3600, identifier: rateLimitBucket(resolveClientIp(req)) });
    if (!perIp.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(perIp) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ error: 'invalid_body' }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = parseLeadRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.spam) return NextResponse.json({ ok: true, channel: 'email' });

  try {
    // Only requests that passed validation draw on the shared budget.
    const overall = await checkRateLimit({ req, scope: 'leads_all', limit: 300, windowSeconds: 3600, identifier: 'all-visitors' });
    if (!overall.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(overall) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const stored = await insertLead(parsed.lead);
  if (stored.status === 'unavailable') return NextResponse.json({ error: 'unavailable' }, { status: 503 });

  if (stored.status === 'created' && parsed.lead.channel === 'email') {
    const lead = { id: stored.id, channel: 'email', email: parsed.lead.email };
    // After the response is sent: the visitor never waits for Resend.
    after(async () => {
      try {
        await sendLeadFollowup(lead, { supabase: createAdminClient() });
      } catch (error) {
        console.error('[leads] immediate follow-up failed', error);
      }
    });
  }

  return NextResponse.json({ ok: true, channel: parsed.lead.channel });
}
