import type { Metadata } from 'next';
import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase/server';
import { loadPrefsRow, optionalState, verifyPreferencesToken, type PrefsRow } from '@/lib/messaging/prefs';
import { OPTIONAL_CATEGORIES, type OptionalCategory } from '@/lib/lifecycle/types';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { LogoLockup } from '@/lib/ui/logo';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'تفضيلات الإيميل',
  robots: { index: false, follow: false },
};

// The signed link is the only credential and the answer depends on it.
export const dynamic = 'force-dynamic';

const SUPPORT_EMAIL = 'moodaaft@gmail.com';

const OPTIONS: Record<OptionalCategory, { title: string; hint: string }> = {
  lifecycle: {
    title: 'نصايح ومتابعة حسابك',
    hint: 'رسائل تساعدك تكمل خطواتك وتستفيد من حسابك الإعلاني.',
  },
  weekly_report: {
    title: 'ملخصك الأسبوعي',
    hint: 'أرقام حملاتك آخر أسبوع في رسالة وحدة.',
  },
  product_news: {
    title: 'أخبار مُضاعِف',
    hint: 'جديد المنصة وميزاتها، وما نرسلها كثير.',
  },
};

const TEXT = {
  heading: 'تفضيلات الإيميل',
  lead: 'اختر اللي يوصلك على إيميلك.',
  save: 'حفظ',
  stopAll: 'أوقف كل الرسائل الاختيارية',
  note: 'رسائل الفوترة والأمان تبقى توصلك لأنها تخص حسابك.',
  saved: 'تم حفظ اختيارك.',
  stopped: 'تم. أوقفنا كل الرسائل الاختيارية.',
  saveFailed: 'ما قدرنا نحفظ اختيارك. جرّب بعد شوي.',
  badLink: 'الرابط غير صالح أو ناقص. افتح آخر إيميل وصلك من مُضاعِف واضغط رابط التفضيلات.',
  loadFailed: 'صار خلل عندنا وما قدرنا نفتح تفضيلاتك. جرّب بعد شوي.',
  suppressed: `الإرسال لإيميلك موقوف عندنا. لو تبي نرجعه راسلنا على ${SUPPORT_EMAIL}.`,
  home: 'الرجوع لمُضاعِف',
} as const;

type SearchParams = { u?: string; t?: string; r?: string };

/** "ayman@example.com" becomes "ay***@example.com". */
function maskEmail(email: string | null) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-lg">
        <Link href="/" className="mb-6 flex items-center gap-3" aria-label="مُضاعِف">
          <LogoLockup height={30} />
        </Link>
        <div className="surface-card overflow-hidden">
          <div className="h-1 bg-signal" aria-hidden />
          <div className="p-6 sm:p-8">{children}</div>
        </div>
      </div>
    </main>
  );
}

function Notice({ result }: { result?: string }) {
  if (result === 'saved') return <Alert tone="success" className="mb-5">{TEXT.saved}</Alert>;
  if (result === 'stopped') return <Alert tone="success" className="mb-5">{TEXT.stopped}</Alert>;
  if (result === 'error') return <Alert tone="danger" className="mb-5">{TEXT.saveFailed}</Alert>;
  return null;
}

export default async function EmailPreferencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const u = typeof params.u === 'string' ? params.u : null;
  const t = typeof params.t === 'string' ? params.t : null;

  if (!u || !t || !verifyPreferencesToken(u, t)) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold">{TEXT.heading}</h1>
        <Alert tone="warning" className="mt-5">{TEXT.badLink}</Alert>
        <Link href="/" className={cn(buttonClasses({ variant: 'outline', size: 'md' }), 'mt-6')}>
          {TEXT.home}
        </Link>
      </Shell>
    );
  }

  let row: PrefsRow | null = null;
  try {
    const loaded = await loadPrefsRow(createAdminClient(), u);
    if (loaded.ok) row = loaded.row;
  } catch (error) {
    console.error('email preferences load failed', error);
  }

  if (!row) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold">{TEXT.heading}</h1>
        <Alert tone="danger" className="mt-5">{TEXT.loadFailed}</Alert>
      </Shell>
    );
  }

  const state = optionalState(row.email_prefs, row.messages_opt_out);
  const masked = maskEmail(row.email);

  return (
    <Shell>
      <h1 className="text-2xl font-bold">{TEXT.heading}</h1>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">
        {TEXT.lead}
        {masked && (
          <>
            {' '}
            <span dir="ltr" className="inline-block numeric">
              {masked}
            </span>
          </>
        )}
      </p>

      <div className="mt-5">
        <Notice result={params.r} />
        {row.email_suppressed_at && (
          <Alert tone="warning" className="mb-5">
            {TEXT.suppressed}
          </Alert>
        )}
      </div>

      <form method="post" action="/api/messages/preferences" className="space-y-3">
        <input type="hidden" name="u" value={u} />
        <input type="hidden" name="t" value={t} />

        <fieldset className="space-y-3">
          <legend className="sr-only">{TEXT.heading}</legend>
          {OPTIONAL_CATEGORIES.map((category) => (
            <label
              key={category}
              className="surface-card surface-interactive flex cursor-pointer items-start gap-4 p-4"
            >
              <input
                type="checkbox"
                name={category}
                defaultChecked={state[category]}
                className="mt-1 h-5 w-5 flex-shrink-0 cursor-pointer accent-[hsl(var(--primary))]"
              />
              <span className="block min-w-0">
                <span className="block text-[15px] font-semibold leading-7">{OPTIONS[category].title}</span>
                <span className="block text-sm leading-7 text-muted-foreground">{OPTIONS[category].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="pt-1 text-xs leading-6 text-muted-foreground">{TEXT.note}</p>

        <div className="flex flex-col gap-3 pt-3 sm:flex-row">
          <button type="submit" name="intent" value="save" className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'sm:flex-1')}>
            {TEXT.save}
          </button>
          <button
            type="submit"
            name="intent"
            value="stop_all"
            className={cn(buttonClasses({ variant: 'outline', size: 'lg' }), 'sm:flex-1')}
          >
            {TEXT.stopAll}
          </button>
        </div>
      </form>
    </Shell>
  );
}
