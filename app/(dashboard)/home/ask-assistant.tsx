'use client';

import { MessageCircle } from 'lucide-react';
import { ASSISTANT } from '@/lib/assistant/persona';
import { cn } from '@/lib/utils';
import { ASK_ASSISTANT_EVENT, type AskAssistantDetail } from '../start/start-client';

/** A button anywhere on /home that puts a question to «مُضاعِف» in the chat. */
export function AskAssistant({
  text,
  label,
  recommendationId,
  children,
  className,
}: {
  text: string;
  label?: string;
  recommendationId?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent<AskAssistantDetail>(ASK_ASSISTANT_EVENT, { detail: { text, label, recommendationId } })
        )
      }
      className={cn(
        'inline-flex min-h-10 items-center gap-1.5 px-1 text-[13.5px] font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
        className
      )}
    >
      {children ?? (
        <>
          <MessageCircle className="h-4 w-4" />
          اسأل {ASSISTANT.name} عنها
        </>
      )}
    </button>
  );
}
