import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import SelectAccountForm from './select-form';

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams: { session?: string };
}) {
  const sessionId = searchParams.session;
  if (!sessionId) redirect('/onboarding/connect?error=missing_params');

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: pending } = await supabase
    .from('pending_oauth_sessions')
    .select('accessible_customer_ids, expires_at, user_id')
    .eq('id', sessionId)
    .single();

  if (!pending || pending.user_id !== user.id) {
    redirect('/onboarding/connect?error=state_mismatch');
  }
  if (new Date(pending.expires_at) < new Date()) {
    redirect('/onboarding/connect?error=state_mismatch');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-xl bg-white rounded-3xl shadow-xl p-8 md:p-10">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">اختر حساب Google Ads</h1>
          <p className="text-ink-500 text-sm">
            وجدنا {pending.accessible_customer_ids.length} حساب مرتبط — اختر اللي تبي تربطه بـ مُضاعِف
          </p>
        </div>

        <SelectAccountForm
          sessionId={sessionId}
          customerIds={pending.accessible_customer_ids}
        />
      </div>
    </div>
  );
}
