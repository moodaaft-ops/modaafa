import { createServerClient } from '@/lib/supabase/server';
import { formatSAR, timeAgoAr } from '@/lib/utils';
import RunAuditButton from './run-audit-button';

const SEVERITY_COLORS = {
  critical: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  growth: 'bg-emerald-100 text-emerald-700',
};

const SEVERITY_LABELS_AR = {
  critical: 'حرجة',
  medium: 'متوسطة',
  growth: 'فرصة نمو',
};

export default async function AuditPage() {
  const supabase = createServerClient();

  const { data: audit } = await supabase
    .from('audits')
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(1)
    .single();

  const { data: recommendations } = await supabase
    .from('recommendations')
    .select('*')
    .eq('audit_id', audit?.id ?? '')
    .order('severity', { ascending: true });

  if (!audit) {
    // Check if user has a linked Google Ads account → if yes, offer to run
    // the audit; otherwise prompt to connect.
    const { data: linkedAccount } = await supabase
      .from('google_ads_accounts')
      .select('customer_id')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    return (
      <div className="p-8">
        <div className="bg-white rounded-2xl p-12 border border-ink-100 text-center">
          <h2 className="text-xl font-bold mb-2">لم يتم تشغيل فحص بعد</h2>
          {linkedAccount ? (
            <>
              <p className="text-ink-500 mb-6">
                حسابك في Google Ads مرتبط. اضغط الزر ليبدأ الذكاء الاصطناعي بفحص حسابك.
              </p>
              <RunAuditButton customerId={linkedAccount.customer_id} />
            </>
          ) : (
            <>
              <p className="text-ink-500 mb-6">
                اربط حسابك في Google Ads أولاً ليقوم الذكاء الاصطناعي بفحصه.
              </p>
              <a
                href="/api/auth/google-ads/connect"
                className="inline-block px-6 py-3 rounded-xl bg-brand-600 text-white font-medium"
              >
                ربط حساب Google Ads
              </a>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-xl border-b border-ink-100 px-8 py-4">
        <h1 className="text-xl font-bold">فحص الحساب</h1>
        <p className="text-sm text-ink-500">آخر تحديث: {timeAgoAr(audit.ran_at)}</p>
      </header>

      <div className="p-8">
        <div className="grid lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2 bg-white rounded-2xl p-8 border border-ink-100">
            <h3 className="text-xl font-bold mb-6">تقرير صحة حسابك</h3>
            <div className="flex items-center gap-8">
              <div className="relative w-48 h-48 flex-shrink-0">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#F1F5F9" strokeWidth="10" />
                  <circle
                    cx="50"
                    cy="50"
                    r="42"
                    fill="none"
                    stroke="url(#scoreGrad)"
                    strokeWidth="10"
                    strokeDasharray="264"
                    strokeDashoffset={264 - (264 * audit.health_score) / 100}
                    strokeLinecap="round"
                  />
                  <defs>
                    <linearGradient id="scoreGrad" x1="0" x2="1">
                      <stop offset="0" stopColor="#7C3AED" />
                      <stop offset="1" stopColor="#06B6D4" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-5xl font-bold">{audit.health_score}</div>
                  <div className="text-xs text-ink-500">من ١٠٠</div>
                </div>
              </div>
              <div className="flex-1">
                <div className="grid grid-cols-3 gap-3">
                  <CategoryScore label="الكلمات" value={audit.category_scores?.keywords ?? 0} />
                  <CategoryScore label="الإعلانات" value={audit.category_scores?.ad_quality ?? 0} />
                  <CategoryScore label="السلبيات" value={audit.category_scores?.negative_keywords ?? 0} />
                  <CategoryScore label="المزايدة" value={audit.category_scores?.bidding ?? 0} />
                  <CategoryScore label="الميزانية" value={audit.category_scores?.budget ?? 0} />
                  <CategoryScore label="الاستهداف" value={audit.category_scores?.targeting ?? 0} />
                </div>
              </div>
            </div>
          </div>

          <div className="bg-gradient-to-br from-red-500 to-pink-600 rounded-2xl p-6 text-white">
            <div className="text-sm opacity-90 mb-2">💸 تسريب الميزانية الشهري</div>
            <div className="text-4xl font-bold mb-2">
              {formatSAR(audit.estimated_monthly_waste ?? 0)}
            </div>
            <p className="text-sm opacity-90 mb-4">
              يتم إنفاقها على كلمات وإعلانات غير منتجة. الـ AI قادر يوقف هذا التسريب فوراً.
            </p>
            <button className="w-full py-2.5 rounded-xl bg-white text-red-600 font-semibold text-sm">
              تطبيق كل التوصيات
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
          <div className="p-6 border-b border-ink-100">
            <h3 className="font-bold">
              التوصيات ({(recommendations ?? []).length})
            </h3>
          </div>
          <div className="divide-y divide-ink-100">
            {(recommendations ?? []).map((r: any, idx: number) => (
              <div key={r.id} className="p-6 flex items-center gap-4 hover:bg-ink-50">
                <div className="w-12 h-12 rounded-xl bg-ink-100 flex items-center justify-center font-bold flex-shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold">{r.title}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${SEVERITY_COLORS[r.severity as keyof typeof SEVERITY_COLORS]}`}
                    >
                      {SEVERITY_LABELS_AR[r.severity as keyof typeof SEVERITY_LABELS_AR]}
                    </span>
                  </div>
                  <p className="text-sm text-ink-500">{r.description}</p>
                  {r.expected_impact?.delta_sar_per_month && (
                    <p className="text-xs text-emerald-600 mt-1">
                      ↑ تأثير متوقع: {formatSAR(r.expected_impact.delta_sar_per_month)}/شهر
                    </p>
                  )}
                </div>
                <button className="px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-700">
                  تطبيق
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function CategoryScore({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 80 ? 'bg-emerald-50 text-emerald-700' : value >= 60 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  return (
    <div className={`rounded-xl p-3 ${tone}`}>
      <div className="text-xs">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}
