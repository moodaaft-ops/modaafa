import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Lock } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { buttonClasses } from '@/lib/ui/button';
import { severityLabel } from '@/lib/ui/labels';
import { cn, formatCurrency } from '@/lib/utils';
import {
  impactLabel,
  monthlyImpact,
  pickFirstOpportunities,
  recommendationsCountLabel,
  type OpportunityRow,
} from '@/lib/onboarding/first-opportunities';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { FirstAuditRunner } from './first-audit-runner';

export const metadata = {
  title: 'أول فرص في حسابك',
};

const severitySquare: Record<string, string> = {
  critical: 'bg-danger',
  medium: 'bg-signal',
  growth: 'bg-muted-foreground',
};

export default async function FirstAuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ subscribed?: string }>;
}) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/first-audit');

  const { accounts, business, selectedAccount } = await getAccountWorkspace(user.id);
  if (!business) redirect('/onboarding/business');
  if (accounts.length === 0 || !selectedAccount) redirect('/onboarding/connect');
  if (accounts.length > 1 && !business.selected_google_ads_customer_id) redirect('/onboarding/choose');

  const accountName = googleAdsAccountDisplayName(selectedAccount);
  const access = await getSubscriptionAccess(supabase, user.id, user.email);

  const { data: audit } = await supabase
    .from('audits')
    .select('id, ran_at')
    .eq('account_id', selectedAccount.id)
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let recommendations: OpportunityRow[] = [];
  if (audit) {
    const { data } = await supabase
      .from('recommendations')
      .select('id, title, severity, expected_impact')
      .eq('audit_id', audit.id)
      .eq('status', 'pending')
      .limit(50);
    recommendations = (data ?? []) as OpportunityRow[];
  }
  const top = pickFirstOpportunities(recommendations);

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {/* Stripe's onboarding success redirect lands here instead of the
            dashboard, so the Subscribe conversion moves with it. A live
            subscription is required so a hand-typed param reports nothing. */}
        {params?.subscribed === '1' && access.active && access.status !== 'internal' && (
          <TikTokPixel conversion={{ event: 'Subscribe', userId: user.id }} />
        )}

        <div className="mb-6">
          <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">أول فرص في حسابك</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            الحساب: <span className="font-semibold text-foreground">{accountName}</span>
          </p>
        </div>

        {!audit && !access.active && (
          <section className="surface-card p-5 sm:p-6">
            <p className="text-[14px] font-semibold text-foreground">الفحص الأول جاهز ينطلق</p>
            <p className="mt-1 text-[13px] leading-7 text-muted-foreground">
              نفحص الحملات والكلمات والإعلانات ونطلع لك التوصيات مرتبة حسب أثرها. الفحص يشتغل داخل التجربة.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
              <button
                type="button"
                disabled
                className={buttonClasses({ variant: 'outline' })}
                aria-describedby="first-audit-locked"
              >
                <Lock className="h-4 w-4" />
                تحتاج التجربة
              </button>
              <Link href="/onboarding/trial" className={buttonClasses({ variant: 'primary' })}>
                ابدأ تجربتك
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <Link href="/dashboard" className={buttonClasses({ variant: 'ghost' })}>
                لوحة التحكم
              </Link>
            </div>
            <p id="first-audit-locked" className="sr-only">
              تشغيل الفحص يحتاج تجربة أو اشتراكاً فعالاً
            </p>
          </section>
        )}

        {!audit && access.active && (
          <FirstAuditRunner customerId={selectedAccount.customer_id} />
        )}

        {audit && (
          <section className="surface-card p-5 sm:p-6">
            {top.length === 0 ? (
              <>
                <p className="text-[14px] font-semibold text-foreground">ما لقينا شي يحتاج قرارك الحين</p>
                <p className="mt-1 text-[13px] leading-7 text-muted-foreground">
                  الفحص اكتمل وما طلع منه توصية معلقة. تقدر تعيد الفحص من صفحة الفحص متى ما بغيت.
                </p>
              </>
            ) : (
              <>
                <p className="text-[13px] text-muted-foreground">
                  طلع الفحص {recommendationsCountLabel(recommendations.length)}. هذي أهمها:
                </p>
                <ol className="mt-4 space-y-3">
                  {top.map((row) => {
                    const label = impactLabel(row);
                    return (
                      <li key={row.id} className="border border-border bg-background-elevated px-4 py-3">
                        <div className="flex items-start gap-2.5">
                          <span
                            className={cn('status-square mt-2 flex-shrink-0', severitySquare[row.severity ?? ''] ?? 'bg-muted-foreground')}
                            aria-hidden
                          />
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold leading-7 text-foreground">{row.title}</p>
                            <p className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-muted-foreground">
                              <span>{severityLabel(row.severity)}</span>
                              {label && (
                                <span>
                                  {label}:{' '}
                                  <span className="numeric font-semibold text-foreground">
                                    {formatCurrency(monthlyImpact(row), selectedAccount.currency_code)}
                                  </span>
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
              {top.length > 0 && (
                <Link href="/audit" className={buttonClasses({ variant: 'primary' })}>
                  راجع كل التوصيات
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              )}
              <Link
                href="/dashboard"
                className={buttonClasses({ variant: top.length > 0 ? 'ghost' : 'primary' })}
              >
                لوحة التحكم
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
