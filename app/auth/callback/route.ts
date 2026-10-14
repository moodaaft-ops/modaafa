import { createOAuthCallbackHandler } from '@/lib/auth/oauth-callback-handler';
import { createServerClient } from '@/lib/supabase/server';

export const GET = createOAuthCallbackHandler({ createSupabase: createServerClient });
