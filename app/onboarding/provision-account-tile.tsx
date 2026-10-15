'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, MessageCircle } from 'lucide-react';
import { whatsappHelpUrl } from '@/lib/support/contact';
import type { ProvisionView } from '@/lib/provisioning/types';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
/** Quick polls for the first two minutes (the user is probably in their inbox), slow ones after, and none while the tab is hidden. */
const POLL_MS = 6000;
const FAST_WINDOW_MS = 120_000;
const SLOW_POLL_MS = 20_000;

const tileClass =
  'flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-start text-[15px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60';
const primaryClass =
  'flex h-14 w-full items-center justify-center gap-3 rounded-full bg-primary px-5 text-[16px] font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60';

function needsSameEmailNote(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return !GMAIL_DOMAINS.has(domain);
}

type PostError = 'registration' | 'invalid_email' | 'rate' | 'generic' | null;

/**
 * «افتحه لي الحين، مجاناً»: one tile that replaces the WhatsApp entries of the
 * no-account screens while account provisioning is on. It only exists where the
 * server said the feature is available (lib/provisioning/load.ts); every
 * failure path ends on the WhatsApp link the screens had before.
 *
 * States, from the row the server keeps: none → press → creating → invited
 * («افتح إيميلك واضغط قبول الدعوة») → accepted (the normal Google connect) or
 * expired / failed (WhatsApp).
 */
export function ProvisionAccountTile({ email, initial }: { email: string | null; initial: ProvisionView | null }) {
  const [view, setView] = useState<ProvisionView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const [editing, setEditing] = useState(false);
  const [emailInput, setEmailInput] = useState(email ?? '');
  const [error, setError] = useState<PostError>(null);
  const [note, setNote] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const refresh = useCallback(async (manual: boolean) => {
    try {
      const res = await fetch('/api/ads-account/provision', { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as { available?: boolean; provision?: ProvisionView | null } | null;
      if (!res.ok || !body) return;
      if (body.available === false) {
        setAvailable(false);
        return;
      }
      if (body.provision) {
        setView(body.provision);
        if (manual && body.provision.status === 'invited') {
          setNote('لسا ما وصلنا قبولك. تأكد إنك ضغطت قبول الدعوة في الإيميل، وجرّب بعد دقيقة.');
        }
      }
    } catch {
      // The next poll tries again.
    }
  }, []);

  const status = view?.status;
  useEffect(() => {
    if (status !== 'creating' && status !== 'invited') return;
    const startedAt = Date.now();
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh(false);
      timer = window.setTimeout(tick, Date.now() - startedAt < FAST_WINDOW_MS ? POLL_MS : SLOW_POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, refresh]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const changed = editing && emailInput.trim() && emailInput.trim().toLowerCase() !== (email ?? '').trim().toLowerCase();
      const res = await fetch('/api/ads-account/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed ? { email: emailInput.trim() } : {}),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; provision?: ProvisionView } | null;
      if (res.ok && body?.ok && body.provision) {
        setView(body.provision);
        return;
      }
      if (res.status === 403 && body?.error === 'registration_incomplete') setError('registration');
      else if (res.status === 400) setError('invalid_email');
      else if (res.status === 429) setError('rate');
      else setError('generic');
    } catch {
      setError('generic');
    } finally {
      setBusy(false);
    }
  }

  const shownEmail = view?.invitedEmail ?? (editing && emailInput.trim() ? emailInput.trim() : email);
  const whatsapp = (
    <a href={whatsappHelpUrl('no_ads_account', email)} target="_blank" rel="noopener noreferrer" className={tileClass}>
      <MessageCircle className="h-5 w-5 text-muted-foreground" />
      كلمنا على الواتساب ونفتحه معك
    </a>
  );

  // The server withdrew the feature (flag off, token gone): back to what the screen had before.
  if (!available) return whatsapp;

  if (view?.status === 'creating') {
    return (
      <div className={tileClass} role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        لحظات، أفتح لك الحساب…
      </div>
    );
  }

  if (view?.status === 'invited') {
    return (
      <div className="space-y-2.5" aria-live="polite">
        <div className="rounded-[16px] border border-border bg-card px-4 py-3 text-[15px] leading-7 text-foreground">
          وصلتك دعوة من قوقل على <bdi dir="ltr" className="font-semibold">{view.invitedEmail}</bdi>. افتح إيميلك واضغط قبول الدعوة، وبعدها ارجع هنا.
          {needsSameEmailNote(view.invitedEmail) && (
            <span className="mt-1 block text-[13px] text-muted-foreground">
              لازم تدخل قوقل بنفس الإيميل <bdi dir="ltr">{view.invitedEmail}</bdi>.
            </span>
          )}
        </div>
        <button type="button" onClick={() => void refresh(true)} className={tileClass}>
          <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
          قبلتها، كمّل
        </button>
        {note && (
          <p role="status" className="px-1 text-[13px] leading-6 text-muted-foreground">
            {note}
          </p>
        )}
      </div>
    );
  }

  if (view?.status === 'accepted' || view?.status === 'unlinked') {
    return (
      <div className="space-y-2.5">
        <p className="px-1 text-[15px] leading-7 text-foreground">انقبلت الدعوة وحسابك جاهز. باقي تربطه بمُضاعِف.</p>
        <a href="/api/auth/google-ads/connect" className={primaryClass}>
          اربط حسابي
        </a>
        <p className="px-1 text-[13px] leading-6 text-muted-foreground">
          في شاشة قوقل اختر نفس الإيميل <bdi dir="ltr">{view.invitedEmail}</bdi>.
        </p>
      </div>
    );
  }

  if (view?.status === 'expired' || view?.status === 'failed') {
    return (
      <div className="space-y-2.5">
        <p className="px-1 text-[15px] leading-7 text-foreground">
          {view.status === 'expired' ? 'انتهت صلاحية الدعوة.' : 'ما قدرنا نفتحه الحين.'}
        </p>
        {view.canRetry && (
          <button type="button" onClick={start} disabled={busy} className={tileClass}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
            جرّب مرة ثانية
          </button>
        )}
        {error && <ErrorLine error={error} />}
        {whatsapp}
      </div>
    );
  }

  // No request yet.
  return (
    <div className="space-y-2.5">
      <button type="button" onClick={start} disabled={busy} className={tileClass}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
        {busy ? 'أفتح لك الحساب…' : 'افتحه لي الحين، مجاناً'}
      </button>
      {error && <ErrorLine error={error} />}
      {error === 'generic' && whatsapp}
      {editing ? (
        <label className="block px-1 text-[13px] leading-6 text-muted-foreground">
          الإيميل اللي توصله الدعوة
          <input
            type="email"
            dir="ltr"
            value={emailInput}
            onChange={(event) => setEmailInput(event.target.value)}
            className="mt-1 h-11 w-full rounded-[12px] border border-border-strong bg-background px-3 text-base text-foreground"
            autoComplete="email"
          />
        </label>
      ) : (
        <p className="px-1 text-[13px] leading-6 text-muted-foreground">
          {shownEmail ? (
            <>
              الدعوة بتوصل على <bdi dir="ltr">{shownEmail}</bdi>{' '}
            </>
          ) : (
            'اكتب الإيميل اللي توصله الدعوة '
          )}
          <button type="button" onClick={() => setEditing(true)} className="font-semibold text-primary hover:underline">
            غيّره
          </button>
        </p>
      )}
    </div>
  );
}

function ErrorLine({ error }: { error: Exclude<PostError, null> }) {
  const text =
    error === 'registration'
      ? 'كمّل بيانات التسجيل (رقم الجوال) أول، وبعدها اضغط افتحه لي.'
      : error === 'invalid_email'
        ? 'الإيميل مو مضبوط، راجعه وجرّب.'
        : error === 'rate'
          ? 'كثرت المحاولات. انتظر شوي وجرّب.'
          : 'ما قدرنا نفتحه الحين. جرّب مرة ثانية، أو كلمنا على الواتساب.';
  return (
    <p role="alert" className="px-1 text-[13px] leading-6 text-danger">
      {text}
    </p>
  );
}
