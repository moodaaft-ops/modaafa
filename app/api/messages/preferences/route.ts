import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { updatePrefs, verifyPreferencesToken } from '@/lib/messaging/prefs';
import { OPTIONAL_CATEGORIES, type OptionalCategory } from '@/lib/lifecycle/types';

/**
 * Saves the choices made on /email-preferences.
 *
 * Only POST changes anything (a GET to this URL does nothing), and the signed
 * link fields u and t from the form are the credential. The answer is always a
 * 303 back to the page so a refresh never re-posts: r=saved, r=stopped, r=error.
 * A link that does not verify goes to the page without credentials, which
 * explains that the link is not valid.
 */
export const dynamic = 'force-dynamic';

function back(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { location: `/email-preferences${query ? `?${query}` : ''}`, 'cache-control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return back({});
  }
  const u = form.get('u');
  const t = form.get('t');
  if (typeof u !== 'string' || typeof t !== 'string' || !verifyPreferencesToken(u, t)) return back({});

  const intent = form.get('intent');
  const choices: Partial<Record<OptionalCategory, boolean>> = {};
  for (const category of OPTIONAL_CATEGORIES) choices[category] = form.get(category) !== null;

  try {
    const result = await updatePrefs(
      createAdminClient(),
      u,
      intent === 'stop_all' ? { stopAll: true } : { choices }
    );
    if (!result.ok) return back({ u, t, r: 'error' });
    return back({ u, t, r: intent === 'stop_all' ? 'stopped' : 'saved' });
  } catch (error) {
    console.error('email preferences save failed', error);
    return back({ u, t, r: 'error' });
  }
}
