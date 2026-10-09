import { MessageCircle } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { PageHeader } from '@/lib/ui/page-header';
import { AssistantClient } from './assistant-client';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';

export const metadata = {
  title: 'المساعد الذكي',
};

export default async function AssistantPage({
  searchParams,
}: {
  searchParams?: Promise<{ brief?: string; from?: string }>;
}) {
  const params = await searchParams;
  // Task 02 links new users here with ?from=onboarding as a stopgap. With the
  // chat-first flag on, that entry belongs to /start; flag off, nothing changes.
  if (isChatFirstEnabled() && params?.from === 'onboarding' && !params?.brief) redirect('/start');
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const [{ accounts, selectedAccount, selectedCustomerId }, subscription] = await Promise.all([
    getAccountWorkspace(user.id),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);
  // Prefill from a campaign-opportunity recommendation. Bounded: this lands in
  // a controlled composer the user still has to send themselves.
  const initialBrief = String(params?.brief ?? '').slice(0, 2000);

  return (
    <>
      <PageHeader
        icon={MessageCircle}
        title="المساعد الذكي"
        description="محادثة عملية مع بيانات إعلانات Google وتوصيات الحساب."
        account={
          selectedAccount
            ? { name: googleAdsAccountDisplayName(selectedAccount), customerId: selectedAccount.customer_id }
            : null
        }
      />
      <div className="p-4 sm:p-6 lg:p-8">
        {subscription.active ? (
          <AssistantClient
            accounts={accounts}
            selectedCustomerId={selectedCustomerId}
            initialBrief={initialBrief || null}
          />
        ) : (
          <SubscriptionGate
            title="فعّل المساعد الذكي بتجربة مجانية"
            description="تظل كل حسابات إعلانات Google مرتبطة وقابلة للتبديل. تبدأ التجربة لتفعيل التحليل والمحادثة المبنية على بيانات حسابك."
          />
        )}
      </div>
    </>
  );
}
