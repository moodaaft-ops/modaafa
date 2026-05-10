import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import BusinessForm from './business-form';

export default async function OnboardingBusinessPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // If business already exists, move to next step
  const { data: existing } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();

  if (existing) redirect('/onboarding/connect');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-xl bg-white rounded-3xl shadow-xl p-8 md:p-10">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">معلومات نشاطك التجاري</h1>
          <p className="text-ink-500 text-sm">خطوة سريعة قبل ما نربط حسابك</p>
        </div>

        {searchParams.error === 'no_business' && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            لازم تكمل بيانات نشاطك التجاري أولاً قبل ربط Google Ads.
          </div>
        )}

        <BusinessForm />
      </div>
    </div>
  );
}
