import { MessageCircle } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { PageHeader } from '@/lib/ui/page-header';
import { AssistantClient } from './assistant-client';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { SubscriptionGate } from '@/lib/ui/subscription-gate';

export const metadata = {
  title: 'المساعد الذكي',
};

export default async function AssistantPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { accounts, selectedAccount, selectedCustomerId } = await getAccountWorkspace(supabase);
  const subscription = await getSubscriptionAccess(supabase, user?.id);

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
          <AssistantClient accounts={accounts} selectedCustomerId={selectedCustomerId} />
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
