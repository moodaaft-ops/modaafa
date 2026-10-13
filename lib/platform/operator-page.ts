import { notFound, redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';

/**
 * Every operations page calls this first. A non-operator gets a plain 404, the
 * same as a page that does not exist. Pages check for themselves rather than
 * relying on a shared layout, because a layout is not re-run on client-side
 * navigation between sibling pages.
 */
export async function requireOperatorPage(next: string) {
  const { user } = await getRequestAuthContext();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!isOperatorUser(user)) notFound();
  return user;
}

/** Saudi mobile numbers in any common shape → wa.me digits. Null when unusable. */
export function whatsappNumber(phone?: string | null) {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('05') && digits.length === 10) digits = `966${digits.slice(1)}`;
  else if (digits.startsWith('5') && digits.length === 9) digits = `966${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

export function contactHref(profile: { phone: string | null; email: string }, text: string) {
  const number = whatsappNumber(profile.phone);
  if (number) return { kind: 'whatsapp' as const, href: `https://wa.me/${number}?text=${encodeURIComponent(text)}` };
  if (profile.email) return { kind: 'email' as const, href: `mailto:${profile.email}?subject=${encodeURIComponent('مُضاعِف')}&body=${encodeURIComponent(text)}` };
  return null;
}
