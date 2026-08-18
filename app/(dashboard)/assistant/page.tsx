import { MessageCircle } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { PageHeader } from '@/lib/ui/page-header';
import { AssistantClient } from './assistant-client';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';

export const metadata = {
  title: 'المساعد الذكي',
};

export default async function AssistantPage({
  searchParams,
}: {
  searchParams?: Promise<{ brief?: string }>;
}) {
  const params = await searchParams;
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
