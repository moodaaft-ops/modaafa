import { MessagesSquare } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';
import { PageHeader } from '@/lib/ui/page-header';
import { StartClient } from './start-client';

export const metadata = { title: 'ابدأ بمحادثة' };

export default async function StartPage({
  searchParams,
}: {
  searchParams?: Promise<{ approved?: string; executed?: string; error?: string }>;
}) {
  if (!isChatFirstEnabled()) notFound();
  const params = await searchParams;
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  const { selectedAccount, selectedCustomerId } = await getAccountWorkspace(user.id);

  const notice = params?.executed
    ? 'executed'
    : params?.approved
      ? 'approved'
      : params?.error
        ? `error:${String(params.error).slice(0, 40)}`
        : null;

  return (
    <>
      <PageHeader
        icon={MessagesSquare}
        title="ابدأ بمحادثة"
        description="اسألني عن حسابك الإعلاني بكلامك العادي."
        account={
          selectedAccount
            ? { name: googleAdsAccountDisplayName(selectedAccount), customerId: selectedAccount.customer_id }
            : null
        }
      />
      <div className="p-3 sm:p-6 lg:p-8">
        <StartClient customerId={selectedCustomerId} notice={notice} />
      </div>
    </>
  );
}
