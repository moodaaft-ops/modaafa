import { MessagesSquare } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';
import { PageHeader } from '@/lib/ui/page-header';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import { StartClient } from './start-client';
import { isSimpleExperience } from '@/lib/setup/mode';
import { homeTargetFrom } from '@/lib/setup/routes';

export const metadata = { title: 'ابدأ بمحادثة' };

export default async function StartPage({
  searchParams,
}: {
  searchParams?: Promise<{ approved?: string; executed?: string; updated?: string; reverted?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login');
  if (!isChatFirstEnabled(process.env, user.email)) notFound();
  // The chat now lives beside the day's decisions on /home.
  if (isSimpleExperience(process.env, user.email)) redirect(homeTargetFrom(params as Record<string, string | undefined>));
  const { selectedAccount, selectedCustomerId } = await getAccountWorkspace(user.id);

  const notice = params?.executed
    ? 'executed'
    : params?.approved
      ? 'approved'
      : params?.updated
        ? 'updated'
        : params?.reverted
          ? 'reverted'
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
        <StartClient customerId={selectedCustomerId} notice={notice} voiceEnabled={readVoiceConfig().enabled} />
      </div>
    </>
  );
}
