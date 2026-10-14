'use client';

import { useRouter } from 'next/navigation';
import type { ChatQuickAction } from '@/lib/chat-first/contracts';
import { StartClient } from '../start/start-client';

/**
 * /home is one conversation with «مُضاعِف», like ChatGPT. A fresh visit opens
 * with the day's briefing as his first message; `?c=` reopens a past chat.
 * When a new conversation gets its first saved message the server components
 * refresh, so it shows up in the sidebar without reloading the page.
 */
export function HomeThread({
  customerId,
  voiceEnabled,
  restoreSessionId,
  intro,
  introActions,
  currency,
}: {
  customerId: string;
  voiceEnabled: boolean;
  restoreSessionId: string | null;
  intro: React.ReactNode;
  introActions?: ChatQuickAction[];
  /** The selected account's currency, for amounts in cards saved before they carried their own. */
  currency?: string | null;
}) {
  const router = useRouter();
  return (
    <StartClient
      customerId={customerId}
      notice={null}
      voiceEnabled={voiceEnabled}
      returnPath="/home"
      variant="thread"
      fresh={!restoreSessionId}
      restoreSessionId={restoreSessionId}
      intro={intro}
      introActions={introActions}
      currency={currency}
      onSessionStarted={() => router.refresh()}
    />
  );
}
