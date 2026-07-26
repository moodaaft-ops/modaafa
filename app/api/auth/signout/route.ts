import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { clearModaafaCookies } from '@/lib/auth/session-cookies';

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  await supabase.auth.signOut();

  // Signing out must also drop every cookie this app owns. Leaving
  // `gads_oauth_state` behind allowed a pending Google Ads consent started by
  // the previous user to be completed against the next user's session; leaving
  // `modaafa_selected_customer_id` behind carried one user's default account
  // selection into another session on the same browser.
  return clearModaafaCookies(NextResponse.redirect(new URL('/login', req.url), 303));
}
