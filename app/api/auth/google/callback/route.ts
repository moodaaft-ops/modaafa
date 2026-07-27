import { NextRequest } from 'next/server';
import { handleGoogleLoginCallback } from '@/lib/auth/google-login-callback';

export async function GET(req: NextRequest) {
  return handleGoogleLoginCallback(req);
}
