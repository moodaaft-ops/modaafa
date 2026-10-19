import { normalizePartnerCode } from './config';
import { findPartnerForUser, type PartnerRow } from './store';

type Db = any;

/** Words a partner may not take as a code: ours, or ones that read as official. */
const RESERVED = /(modaafa|mudaafa|moda3fa|muda3fa|mdaafa|admin|support|official|operations|team|staff|billing|stripe|google)/i;

export type JoinInput = {
  displayName: unknown;
  phone: unknown;
  code?: unknown;
  acceptTerms: unknown;
};

export type JoinResult =
  | { ok: true; created: boolean; code: string }
  | { ok: false; error: 'terms_required' | 'bad_name' | 'bad_phone' | 'bad_code' | 'reserved_code' | 'code_taken' | 'email_required' | 'email_taken' | 'unavailable' };

/** A phone number kept as digits with an optional leading plus, or null when it cannot be one. */
export function cleanPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[\s()\-.]/g, '');
  return /^\+?\d{8,15}$/.test(digits) ? digits : null;
}

/** Lower-case ASCII slug from the part of the email before the @, or '' when nothing usable is left. */
export function slugFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const slug = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return slug.length >= 3 ? slug : '';
}

function randomTail(length: number, random: () => number): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

/** Codes to try, in order: the email-based one, then the same with a short random tail, then fully random. */
export function candidateCodes(email: string, random: () => number = Math.random): string[] {
  const base = slugFromEmail(email);
  const list: string[] = [];
  if (base && !RESERVED.test(base)) list.push(base);
  for (let i = 0; i < 4; i++) {
    const code = `${base && !RESERVED.test(base) ? base : 'p'}-${randomTail(4, random)}`;
    list.push(code);
  }
  return list.map((c) => normalizePartnerCode(c)).filter((c): c is string => c !== null);
}

/**
 * Lets a signed-in user join the programme on their own. They are active at once,
 * with the standard terms (a per-partner rate can only be set by an operator).
 * The money safeguards do not depend on who is trusted: the 30-day hold, the
 * fraud checks at sign-up, and a manual payout that an operator reviews.
 * Safe to call twice: a second call returns the partner that already exists.
 */
export async function joinPartnerProgram(
  db: Db,
  user: { id: string; email: string | null },
  input: JoinInput,
  random: () => number = Math.random,
): Promise<JoinResult> {
  if (input.acceptTerms !== true) return { ok: false, error: 'terms_required' };
  const email = user.email?.trim().toLowerCase() ?? '';
  if (!email) return { ok: false, error: 'email_required' };
  const name = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (name.length < 2 || name.length > 80) return { ok: false, error: 'bad_name' };
  const phone = cleanPhone(input.phone);
  if (!phone) return { ok: false, error: 'bad_phone' };

  const existing = await findPartnerForUser(db, user);
  if (existing) return { ok: true, created: false, code: existing.code };

  let codes: string[];
  const wanted = typeof input.code === 'string' ? input.code.trim() : '';
  if (wanted) {
    const code = normalizePartnerCode(wanted);
    if (!code) return { ok: false, error: 'bad_code' };
    if (RESERVED.test(code)) return { ok: false, error: 'reserved_code' };
    codes = [code];
  } else {
    codes = candidateCodes(email, random);
  }

  for (const code of codes) {
    const { error } = await db.from('partners').insert({
      user_id: user.id, code, display_name: name, email, phone, status: 'active',
    });
    if (!error) return { ok: true, created: true, code };
    if ((error as { code?: string }).code !== '23505') throw new Error('partners: join failed', { cause: error });
    // A duplicate: did this same user win a race, is the code taken, or is the email someone else's?
    const mine: PartnerRow | null = await findPartnerForUser(db, user);
    if (mine) return { ok: true, created: false, code: mine.code };
    const { data: taken } = await db.from('partners').select('id').eq('code', code).maybeSingle();
    if (taken) {
      if (wanted) return { ok: false, error: 'code_taken' };
      continue;
    }
    return { ok: false, error: 'email_taken' };
  }
  return { ok: false, error: 'unavailable' };
}
