import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getRequestAuthContext, createAdminClient } from '@/lib/supabase/server';
import { isRegistrationComplete } from '@/lib/registration/gate';
import { REGISTRATION_CONSENT_TEXT } from '@/lib/registration/consent';
import { CompleteForm } from './complete-form';
import { pageMetadata } from '@/lib/seo/site';

export const metadata: Metadata = pageMetadata({
  title: 'أكمل بياناتك',
  path: '/register/complete',
  description: 'أكمل بيانات حسابك في مُضاعِف لتبدأ ربط حساب إعلانات جوجل.',
  noIndex: true,
});

export default async function CompleteRegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/register/finish');

  if (await isRegistrationComplete(createAdminClient(), user.id)) redirect('/welcome');

  const { error } = await searchParams;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : '';

  return (
    <CompleteForm
      email={user.email ?? ''}
      initialName={fullName}
      initialError={error === 'phone_taken' ? 'phone_taken' : error ? 'failed' : ''}
      consentText={REGISTRATION_CONSENT_TEXT}
    />
  );
}
