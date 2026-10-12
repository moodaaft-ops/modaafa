'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EXIT_COPY as copy } from '@/lib/growth/exit-copy';
import {
  FlickDetector,
  PHONE_IDLE_MS,
  desktopMayOpen,
  leftThroughTop,
  phoneIdleMayOpen,
} from '@/lib/leads/exit-triggers';

const SEEN_KEY = 'mz_exit_seen_v1';
type Mode = 'modal' | 'bar';
type Channel = 'email' | 'whatsapp';
type Status = 'idle' | 'sending' | 'done';

function readSeen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private window: the popup may come back on the next visit. Acceptable.
  }
}

function utmFromLocation() {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Exit popup for the landing page.
 *
 * Desktop: a dialog when the mouse leaves through the top of the window.
 * Phone: a bottom bar after a quick flick back up the page, or after 40
 * seconds of reading. It never covers the whole screen, so it cannot trip
 * Google's rules on intrusive mobile interstitials. Shown to a visitor once
 * ever (localStorage); if storage is blocked it may show again next visit.
 *
 * Rendered only when the server says it is enabled (a real sample report link
 * and an approved follow-up text), so it is invisible until Ayman fills both.
 */
export function ExitIntent({ enabled }: { enabled: boolean }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = useRef(false);

  const open = useCallback((next: Mode) => {
    if (shown.current || readSeen()) return;
    shown.current = true;
    markSeen();
    setMode(next);
  }, []);

  useEffect(() => {
    if (!enabled || readSeen()) return;
    const startedAt = Date.now();
    const phone = window.matchMedia('(pointer: coarse), (max-width: 1023px)').matches;
    const cleanups: Array<() => void> = [];

    if (!phone) {
      const onOut = (event: MouseEvent) => {
        if (leftThroughTop(event) && desktopMayOpen(Date.now() - startedAt)) open('modal');
      };
      document.addEventListener('mouseout', onOut);
      cleanups.push(() => document.removeEventListener('mouseout', onOut));
    } else {
      const flick = new FlickDetector();
      const onScroll = () => {
        const doc = document.documentElement;
        if (flick.push({ y: window.scrollY, t: Date.now(), viewportHeight: window.innerHeight, documentHeight: doc.scrollHeight })) {
          open('bar');
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      const idle = window.setTimeout(() => {
        if (phoneIdleMayOpen(Date.now() - startedAt, flick.maxDepth)) open('bar');
      }, PHONE_IDLE_MS + 200);
      cleanups.push(() => {
        window.removeEventListener('scroll', onScroll);
        window.clearTimeout(idle);
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [enabled, open]);

  if (!enabled || !mode) return null;

  const close = () => {
    setMode(null);
    setExpanded(false);
  };

  return mode === 'modal' ? <ExitDialog onClose={close} /> : <ExitBar expanded={expanded} onExpand={() => setExpanded(true)} onClose={close} />;
}

function useLeadForm(source: 'exit_desktop' | 'exit_mobile') {
  const [channel, setChannel] = useState<Channel>('email');
  const [value, setValue] = useState('');
  const [trap, setTrap] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (status === 'sending') return;
    setError(null);
    if (!value.trim()) {
      setError(channel === 'email' ? copy.errors.invalid_email : copy.errors.invalid_whatsapp);
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel,
          contact: value,
          website: trap,
          source,
          page: window.location.pathname,
          utm: utmFromLocation(),
        }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus('idle');
      if (data.error === 'invalid_contact') setError(channel === 'email' ? copy.errors.invalid_email : copy.errors.invalid_whatsapp);
      else if (res.status === 429) setError(copy.errors.too_many_requests);
      else setError(copy.errors.unavailable);
    } catch {
      setStatus('idle');
      setError(copy.errors.unavailable);
    }
  }

  return { channel, setChannel, value, setValue, trap, setTrap, status, error, submit };
}

function LeadFields({ form, autoFocus }: { form: ReturnType<typeof useLeadForm>; autoFocus?: boolean }) {
  const { channel, setChannel, value, setValue, trap, setTrap, status, error, submit } = form;
  const inputId = `exit-contact-${channel}`;

  if (status === 'done') {
    return (
      <p role="status" className="text-[15px] font-semibold leading-8 text-brand-navy">
        {channel === 'email' ? copy.doneEmail : copy.doneWhatsapp}
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div role="radiogroup" className="flex gap-2" aria-label="طريقة الإرسال">
        {(['email', 'whatsapp'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={channel === key}
            onClick={() => {
              setChannel(key);
              setValue('');
            }}
            className={cn(
              'h-11 flex-1 border text-[14px] font-semibold',
              channel === key ? 'border-brand-navy bg-brand-navy text-brand-paper' : 'border-brand-navy/30 text-brand-navy'
            )}
          >
            {key === 'email' ? copy.channelEmail : copy.channelWhatsapp}
          </button>
        ))}
      </div>

      <label htmlFor={inputId} className="mt-4 block text-[13px] font-semibold text-brand-navy">
        {channel === 'email' ? copy.emailLabel : copy.whatsappLabel}
      </label>
      <input
        id={inputId}
        dir="ltr"
        autoFocus={autoFocus}
        type={channel === 'email' ? 'email' : 'tel'}
        inputMode={channel === 'email' ? 'email' : 'tel'}
        autoComplete={channel === 'email' ? 'email' : 'tel'}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={channel === 'email' ? copy.emailPlaceholder : copy.whatsappPlaceholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'exit-error' : undefined}
        className="mt-1.5 h-12 w-full border border-brand-navy/40 bg-white px-3 text-start text-[16px] text-brand-navy"
      />

      {/* Honeypot: invisible to people, tempting to bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        value={trap}
        onChange={(event) => setTrap(event.target.value)}
        className="absolute -start-[9999px] h-0 w-0 opacity-0"
      />

      <p id="exit-error" role="alert" className="mt-2 min-h-5 text-[13px] leading-5 text-brand-navy">
        {error}
      </p>

      <button
        type="submit"
        disabled={status === 'sending'}
        className="mt-2 flex h-12 w-full items-center justify-center gap-2 bg-brand-navy text-[15px] font-bold text-brand-paper disabled:opacity-70"
      >
        {status === 'sending' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {status === 'sending' ? copy.sending : copy.submit}
      </button>
      <p className="mt-3 text-[12px] leading-6 text-brand-navy/70">{copy.consent}</p>
    </form>
  );
}

function ExitDialog({ onClose }: { onClose: () => void }) {
  const form = useLeadForm('exit_desktop');
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([tabindex="-1"]), a[href]');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-brand-navy/60 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-title"
        className="relative w-full max-w-md border border-brand-navy bg-brand-paper p-6 text-brand-navy"
      >
        <button type="button" onClick={onClose} aria-label={copy.close} className="absolute end-3 top-3 flex h-10 w-10 items-center justify-center text-brand-navy">
          <X className="h-5 w-5" aria-hidden />
        </button>
        <h2 id="exit-title" className="pe-8 text-[22px] font-bold leading-9">
          {copy.title}
        </h2>
        <p className="mt-2 text-[15px] leading-8 text-brand-navy/80">{copy.body}</p>
        <div className="relative mt-5">
          <LeadFields form={form} autoFocus />
        </div>
        {form.status !== 'done' && (
          <button type="button" onClick={onClose} className="mt-2 flex min-h-11 w-full items-center justify-center text-[13px] font-semibold text-brand-navy underline underline-offset-4">
            {copy.dismiss}
          </button>
        )}
      </div>
    </div>
  );
}

function ExitBar({ expanded, onExpand, onClose }: { expanded: boolean; onExpand: () => void; onClose: () => void }) {
  const form = useLeadForm('exit_mobile');
  return (
    <div
      role="region"
      aria-label={copy.barTitle}
      className="fixed inset-x-0 bottom-0 z-[60] max-h-[85vh] overflow-y-auto border-t border-brand-navy bg-brand-paper px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-brand-navy"
    >
      <div className="mx-auto max-w-md">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[15px] font-bold leading-7">{expanded ? copy.title : copy.barTitle}</p>
          <button type="button" onClick={onClose} aria-label={copy.close} className="-me-2 -mt-1 flex h-11 w-11 flex-shrink-0 items-center justify-center">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {expanded ? (
          <div className="relative mt-2">
            <LeadFields form={form} />
          </div>
        ) : (
          <button type="button" onClick={onExpand} className="mt-2 flex h-12 w-full items-center justify-center bg-brand-navy text-[15px] font-bold text-brand-paper">
            {copy.barOpen}
          </button>
        )}
      </div>
    </div>
  );
}
