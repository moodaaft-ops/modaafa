'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { buttonClasses } from '@/lib/ui/button';

/**
 * Two-step submit for any call that changes the live Google Ads account.
 *
 * The first button only opens a panel that restates the change in two lines.
 * The form that actually posts exists only inside that panel, so the live call
 * can never be sent from the first click. Double-submit protection stays with
 * PendingSubmitButton; idempotency stays with the endpoint.
 */
export function ConfirmSubmit({
  action,
  fields,
  triggerLabel,
  title,
  lines,
  confirmLabel,
  pendingLabel,
  triggerVariant = 'primary',
}: {
  action: string;
  fields: Record<string, string>;
  triggerLabel: string;
  title: string;
  lines: [string, string];
  confirmLabel: string;
  pendingLabel: string;
  triggerVariant?: 'primary' | 'outline';
}) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const headingRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    } else if (wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="true"
        className={buttonClasses({ variant: triggerVariant, size: 'sm' })}
      >
        {triggerLabel}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
      className="w-full border border-foreground bg-card p-4"
    >
      <div
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-sm font-semibold text-foreground outline-none"
      >
        <span className="status-square bg-signal" aria-hidden />
        {title}
      </div>
      <p className="mt-2 text-sm leading-7 text-foreground">{lines[0]}</p>
      <p className="text-xs leading-6 text-muted-foreground">{lines[1]}</p>
      <form action={action} method="post" className="mt-3 flex flex-wrap gap-2">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <PendingSubmitButton pendingLabel={pendingLabel} className={buttonClasses({ variant: 'primary', size: 'sm' })}>
          {confirmLabel}
        </PendingSubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          رجوع
        </button>
      </form>
    </div>
  );
}
