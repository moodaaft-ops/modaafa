import { requireOperatorPage } from '@/lib/platform/operator-page';
import { createAdminClient } from '@/lib/supabase/server';
import { countActiveClients, type ActiveClients } from '@/lib/google-ads/provisioning';
import { loadProvisioningContext, readProvisioningTokenStatus, type ProvisioningTokenStatus } from '@/lib/provisioning/credentials';
import {
  PROVISIONING_ACCOUNT_CEILING,
  PROVISIONING_WARN_AT,
  provisioningMccId,
  unlinkAfterAcceptEnabled,
} from '@/lib/provisioning/flag';
import { supabaseProvisionStore } from '@/lib/provisioning/store';
import type { ProvisionRow, ProvisionStatus } from '@/lib/provisioning/types';
import { cn, formatNumberAr } from '@/lib/utils';
import { OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime, shortDate } from '../format';
import { CheckNowButton } from './check-button';

export const metadata = { title: 'فتح الحسابات · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  mcc_not_set: 'رقم المدير ما انضبط. أضف PROVISIONING_MCC_ID في Vercel (10 أرقام) وأعد النشر.',
  mcc_not_visible: 'التوكن اللي ربطته ما يشوف حساب المدير هذا. ادخل بإيميل قوقل اللي يملك الـMCC.',
  not_a_manager: 'الرقم هذا مو حساب مدير. لازم يكون الـMCC اللي فتحته للمسجلين.',
  verify_failed: 'ما قدرنا نتحقق من حساب المدير عند قوقل. جرّب مرة ثانية.',
  under_agency: 'حساب المدير هذا تابع لحساب الوكالة 756-114-1000. لازم يكون مستقل، افصله عن الوكالة وجرّب.',
  oauth_failed: 'ما اكتمل الربط مع قوقل. اضغط «اربط حساب المدير» من جديد وكمّل الموافقة للنهاية.',
  save_failed: 'تحقق الربط بس ما انحفظ التوكن. غالباً الميقريشن ما انشغل بعد.',
  state_unavailable: 'ما قدرنا نخزّن حالة الأمان. أعد المحاولة بعد قليل.',
  state_user_mismatch: 'بدأت الربط بمستخدم ثاني على هذا المتصفح. سجّل بالمستخدم الصحيح وأعد.',
  too_many_requests: 'كثرت المحاولات. انتظر دقيقة وأعد.',
  security_service_unavailable: 'تعذر التحقق الآمن الحين. أعد المحاولة بعد قليل.',
  oauth_config_missing: 'إعداد قوقل OAuth ناقص من جهتنا.',
  not_operator: 'هذا الربط للمشغّلين فقط.',
};

const STATUS_LABEL: Record<ProvisionStatus, string> = {
  creating: 'قيد الفتح',
  invited: 'بانتظار القبول',
  accepted: 'قُبلت',
  unlinked: 'انفكت عن المدير',
  expired: 'انتهت الدعوة',
  failed: 'فشل',
};

const STATUS_TONE: Record<ProvisionStatus, string> = {
  creating: 'text-foreground ring-border-strong bg-muted',
  invited: 'text-foreground ring-border-strong bg-signal/25',
  accepted: 'text-success ring-success/30 bg-success/10',
  unlinked: 'text-success ring-success/30 bg-success/10',
  expired: 'text-muted-foreground ring-border bg-muted',
  failed: 'text-danger ring-danger/30 bg-danger/10',
};

function dashed(id: string | null) {
  if (!id) return '—';
  const digits = id.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : id;
}

const FLAG_LABEL: Record<string, string> = { true: 'مفتوحة للكل', operators: 'للمشغّلين فقط' };

export default async function ProvisioningPage({ searchParams }: { searchParams?: Promise<{ error?: string; connected?: string }> }) {
  await requireOperatorPage('/operations/provisioning');
  const now = Date.now();
  const params = await searchParams;
  const errorText = params?.error ? (ERRORS[params.error] ?? 'صار خطأ في الربط.') : null;

  const mccId = provisioningMccId();
  const mode = process.env.ACCOUNT_PROVISIONING ?? '';
  const flagText = FLAG_LABEL[mode] ?? 'مطفية';

  let token: ProvisioningTokenStatus | null = null;
  let rows: ProvisionRow[] = [];
  let missingMigration = false;
  let counts: ActiveClients | null = null;
  let countFailed = false;

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  if (admin) {
    try {
      token = await readProvisioningTokenStatus(admin);
      rows = await supabaseProvisionStore(admin).recent(30);
    } catch {
      missingMigration = true;
    }
    if (token?.connected) {
      try {
        const ads = await loadProvisioningContext(admin);
        counts = ads ? await countActiveClients(ads) : null;
      } catch {
        countFailed = true;
      }
    }
  }

  const active = counts?.active ?? null;
  const tone = active === null ? '' : active >= PROVISIONING_ACCOUNT_CEILING ? 'bg-danger' : active >= PROVISIONING_WARN_AT ? 'bg-warning' : 'bg-foreground';

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">فتح الحسابات</h1>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          زر «افتحه لي» داخل المنصة: ننشئ حساب إعلانات للمسجّل تحت حساب مدير خاص، وندعو إيميله، ونتابع لين يقبل. للمالك فقط.
        </p>
      </header>
      <OpsTabs active="provisioning" updatedAt={riyadhTime(now)} />

      <div className="space-y-6 px-4 pt-6 sm:px-6 lg:px-8">
        {params?.connected === '1' && (
          <p role="status" className="border border-success/40 bg-success/10 px-4 py-3 text-[13px] leading-6 text-foreground">
            انربط حساب المدير وتحققنا إنه يشوف الـMCC كمدير.
          </p>
        )}
        {errorText && (
          <p role="alert" className="border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] leading-6 text-foreground">
            {errorText}
          </p>
        )}
        {missingMigration && (
          <p className="border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6 text-foreground">
            <span className="font-semibold">ميقريشن فتح الحسابات ما انشغل بعد.</span> شغّل{' '}
            <code className="break-all font-mono text-xs" dir="ltr">
              db/migrations/20261015_account_provisioning.sql
            </code>{' '}
            على Supabase، وبعدها ارجع هنا واربط حساب المدير.
          </p>
        )}

        <section className="space-y-3">
          <SectionHead title="الإعداد" note="كل شي هنا يقرأ من Vercel وSupabase، وما تغيّره من الصفحة." />
          <dl className="grid gap-px border border-border bg-border sm:grid-cols-2">
            <div className="bg-background px-4 py-3">
              <dt className="text-xs text-muted-foreground">الميزة (ACCOUNT_PROVISIONING)</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">{flagText}</dd>
            </div>
            <div className="bg-background px-4 py-3">
              <dt className="text-xs text-muted-foreground">حساب المدير (PROVISIONING_MCC_ID)</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground numeric" dir="ltr">
                {mccId ? dashed(mccId) : <span dir="rtl">ما انضبط</span>}
              </dd>
            </div>
            <div className="bg-background px-4 py-3">
              <dt className="text-xs text-muted-foreground">التوكن</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">
                {token?.connected
                  ? `متصل · ${shortDate(token.connectedAt)}`
                  : token?.storedMccId
                    ? 'محفوظ لمدير ثاني، أعد الربط'
                    : 'غير متصل'}
              </dd>
            </div>
            <div className="bg-background px-4 py-3">
              <dt className="text-xs text-muted-foreground">فك الحساب بعد القبول (PROVISIONING_UNLINK_AFTER_ACCEPT)</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">{unlinkAfterAcceptEnabled() ? 'شغّال' : 'متوقف'}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            {mccId ? (
              <a
                href="/api/operations/provisioning/connect"
                className="inline-flex h-10 items-center border border-border-strong px-4 text-sm font-semibold text-foreground transition-colors hover:border-foreground hover:bg-surface"
              >
                {token?.connected ? 'أعد ربط حساب المدير' : 'اربط حساب المدير'}
              </a>
            ) : (
              <p className="text-[13px] text-muted-foreground">اضبط PROVISIONING_MCC_ID أول، وبعدها يظهر زر الربط.</p>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <SectionHead
            title="الحسابات تحت المدير"
            note={`السقف ${formatNumberAr(PROVISIONING_ACCOUNT_CEILING)} حساب نشط لأن المدير بدون صرف. التنبيه من ${formatNumberAr(PROVISIONING_WARN_AT)}.`}
          />
          {!token?.connected ? (
            <p className="border border-border px-4 py-5 text-sm text-muted-foreground">اربط حساب المدير عشان يظهر العدد.</p>
          ) : countFailed || active === null ? (
            <p className="border border-border px-4 py-5 text-sm text-muted-foreground">تعذر قراءة العدد من قوقل. جرّب «افحص الحين» أو أعد تحميل الصفحة.</p>
          ) : (
            <div className="border border-border px-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                <span className="numeric">{formatNumberAr(active)}</span> من <span className="numeric">{formatNumberAr(PROVISIONING_ACCOUNT_CEILING)}</span>
              </p>
              <div className="mt-2 h-2 w-full bg-muted" role="img" aria-label={`${active} من ${PROVISIONING_ACCOUNT_CEILING}`}>
                <div className={cn('h-2', tone)} style={{ width: `${Math.min(100, (active / PROVISIONING_ACCOUNT_CEILING) * 100)}%` }} />
              </div>
              {active >= PROVISIONING_WARN_AT && (
                <p className="mt-2 text-[13px] leading-6 text-foreground">
                  {active >= PROVISIONING_ACCOUNT_CEILING
                    ? 'وصلنا السقف: قوقل ما تنشئ حساب جديد لين يفضى مكان. فعّل فك الحسابات المقبولة أو الغِ المعلقة من واجهة قوقل.'
                    : 'قربنا من السقف. فعّل فك الحسابات المقبولة أو نظّف الدعوات المعلقة قبل ما يمتلئ.'}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <SectionHead title="آخر الطلبات" aside={<CheckNowButton />} note="آخر 30 طلب. الفحص التلقائي كل ساعة." />
          {rows.length === 0 ? (
            <p className="border border-border px-4 py-5 text-sm text-muted-foreground">ما فيه طلبات للحين.</p>
          ) : (
            <div className="overflow-x-auto border border-border">
              <table className="w-full min-w-[640px] text-start text-[13px]">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
                    <th className="px-3 py-2 text-start font-semibold">الإيميل</th>
                    <th className="px-3 py-2 text-start font-semibold">الحساب</th>
                    <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                    <th className="px-3 py-2 text-start font-semibold">آخر فحص</th>
                    <th className="px-3 py-2 text-start font-semibold">الخطأ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-3 py-2">{shortDate(row.created_at)}</td>
                      <td className="px-3 py-2" dir="ltr">
                        {row.invited_email}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 numeric" dir="ltr">
                        {dashed(row.customer_id)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex whitespace-nowrap px-2 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset', STATUS_TONE[row.status])}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{row.last_checked_at ? riyadhTime(row.last_checked_at) : '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs" dir="ltr">
                        {row.error_code ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
