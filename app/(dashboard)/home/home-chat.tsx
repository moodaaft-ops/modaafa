'use client';

import { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { ASSISTANT } from '@/lib/assistant/persona';
import { AssistantAvatar } from '@/lib/ui/assistant-avatar';
import { cn } from '@/lib/utils';
import { StartClient } from '../start/start-client';

/**
 * «زياد» on the home screen. One chat instance for both layouts so the
 * conversation never forks: on wide screens it is the panel beside the
 * briefing; on a phone it waits behind a bar at the bottom and opens full
 * screen when tapped (or when a card asks him something).
 */
export function HomeChat({ customerId, voiceEnabled }: { customerId: string | null; voiceEnabled: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia('(min-width: 1024px)');
    if (wide.matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <aside
        aria-label={`المحادثة مع ${ASSISTANT.name}`}
        className={cn(
          'lg:sticky lg:top-0 lg:flex lg:h-full lg:border-s lg:border-border',
          open ? 'fixed inset-0 z-50 flex bg-background' : 'hidden'
        )}
      >
        <StartClient
          customerId={customerId}
          notice={null}
          voiceEnabled={voiceEnabled}
          returnPath="/home"
          variant="embedded"
          onClose={open ? () => setOpen(false) : undefined}
          onAsked={() => {
            // Wide screens already show the chat beside the cards.
            if (!window.matchMedia('(min-width: 1024px)').matches) setOpen(true);
          }}
        />
      </aside>

      {!open && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-3 pt-2.5 lg:hidden"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 10px)' }}
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-12 w-full items-center gap-2.5 border border-border-strong bg-card px-3 text-start text-[15px] text-muted-foreground"
          >
            <AssistantAvatar size={28} framed={false} />
            <span className="flex-1">اكتب لـ{ASSISTANT.name} أو اسأله…</span>
            {voiceEnabled && <AudioLines className="h-4 w-4 text-foreground" aria-hidden />}
          </button>
        </div>
      )}
    </>
  );
}
