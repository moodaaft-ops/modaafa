import { notFound, redirect } from 'next/navigation';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { requireAppUrl } from '@/lib/platform/env';
import { partnersEnabled } from '@/lib/partners/config';
import { findPartnerForUser, partnerSummary, readPartnerSettings, type PartnerSettings, type PartnerSummary } from '@/lib/partners/store';
import { PartnerView } from './partner-view';

export const metadata = { title: 'برنامج الشركاء · مُضاعِف', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';


export default async function PartnerPage() {
  // The programme is invisible until it is switched on.
  if (!partnersEnabled()) notFound();
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=%2Fpartners');

  let partner: Awaited<ReturnType<typeof findPartnerForUser>> = null;
  let summary: PartnerSummary | null = null;
  let settings: PartnerSettings | null = null;
  let failed = false;
  try {
    const db = createAdminClient();
    partner = await findPartnerForUser(db, { id: user.id, email: user.email ?? null });
    if (partner) [summary, settings] = await Promise.all([partnerSummary(db, partner.id), readPartnerSettings(db)]);
  } catch (error) {
    console.error('[partners] page failed', error instanceof Error ? error.message : 'unknown');
    failed = true;
  }

  if (failed) {
    return (
      <Shell>
        <p role="alert" className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-6">
          تعذر تحميل صفحتك الحين. أعد المحاولة بعد شوي.
        </p>
      </Shell>
    );
  }
  if (!partner || !summary || !settings) {
    return (
      <Shell>
        <h1 className="text-xl font-bold text-foreground">برنامج الشركاء</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          ما لقينا حساب شريك على هذا الإيميل ({user.email}). إذا وصلتك دعوة، سجّل الدخول بنفس الإيميل اللي أرسلنا عليه الدعوة.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <PartnerView partner={partner} summary={summary} settings={settings} appUrl={requireAppUrl()} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[860px] px-4 pb-20 pt-8 sm:px-6 sm:pt-12">{children}</main>;
}
