'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';

/**
 * Submit button that shows a spinner and blocks a second click.
 *
 * `useFormStatus().pending` alone is NOT enough here: React only takes over a
 * submission — and therefore only reports `pending` — when the form's `action`
 * is a function (a Server Action). Every form in this app posts to a string
 * URL, so `pending` was permanently `false`: the spinner never appeared, the
 * button never disabled, and `pendingLabel` was dead string data. A user who
 * clicked "تشغيل الفحص" saw nothing happen for up to five minutes and clicked
 * again — firing repeat audits, repeat syncs, and for the optimizer, repeat
 * live Google Ads mutations.
 *
 * The local `submitted` flag covers the string-action case. These forms cause
 * a real browser navigation, so the flag dies with the page on success; the
 * `pageshow` listener covers the bfcache case where the user hits Back and
 * React replays the retained state, and the timeout is a failsafe for a
 * submission the browser never starts.
 */
export function PendingSubmitButton({
  children,
  pendingLabel = 'جاري التحميل...',
  className = '',
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const [submitted, setSubmitted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const form = buttonRef.current?.form;
    if (!form) return;

    // Wait until the native submit event has finished before disabling the
    // submitter. Disabling it inside `onClick` can cancel a normal string-URL
    // form submission in Chromium, leaving the UI stuck on the pending label
    // without ever sending the request.
    const markSubmitted = (event: SubmitEvent) => {
      if (event.defaultPrevented) return;
      window.setTimeout(() => setSubmitted(true), 0);
    };

    form.addEventListener('submit', markSubmitted);
    return () => form.removeEventListener('submit', markSubmitted);
  }, []);

  useEffect(() => {
    if (!submitted) return;

    const reset = () => setSubmitted(false);
    window.addEventListener('pageshow', reset);
    // Failsafe: if the navigation never starts (blocked popup, offline,
    // server unreachable) the button must not stay disabled forever.
    const timer = window.setTimeout(reset, 45_000);

    return () => {
      window.removeEventListener('pageshow', reset);
      window.clearTimeout(timer);
    };
  }, [submitted]);

  const busy = pending || submitted;

  return (
    <button
      ref={buttonRef}
      type="submit"
      disabled={busy || disabled}
      aria-busy={busy}
      className={`${className} inline-flex items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-70`}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {busy ? pendingLabel : children}
    </button>
  );
}
