import { REF_COOKIE_MAX_AGE, partnerLink } from '@/lib/partners/config';
import type { PartnerRow, PartnerSettings, PartnerSummary } from '@/lib/partners/store';
import { COMMISSION_STATUS_AR, formatMoney, formatMoneyMap } from '@/lib/partners/format';
import { CopyLink } from './copy-link';

const dayFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', year: 'numeric' });
const day = (iso: string) => dayFormat.format(new Date(iso));
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** What a partner sees. Pure: the page loads the data, this only lays it out. */
export function PartnerView({ partner, summary, settings, appUrl }: { partner: PartnerRow; summary: PartnerSummary; settings: PartnerSettings; appUrl: string }) {
  const rate = partner.commission_rate ?? settings.default_rate;
  const months = partner.commission_months ?? settings.commission_months;
  const link = partnerLink(appUrl, partner.code);
  const inactive = partner.status !== 'active';

  return (
    <>
      <header>
        <h1 className="text-xl font-bold text-foreground">أهلاً {partner.display_name}</h1>
        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
          كل عميل يسجّل من رابطك ويدفع، تاخذ {pct(rate)} من كل دفعة يدفعها لمدة {months} شهر.
          {partner.commission_rate === null && settings.tier_rate > rate
            ? ` وإذا صار عندك أكثر من ${settings.tier_threshold} عملاء يدفعون في نفس الوقت، تصير ${pct(settings.tier_rate)}.`
            : ''}
        </p>
      </header>

      {inactive && (
        <p role="status" className="mt-5 border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6">
          حسابك {partner.status === 'paused' ? 'موقوف مؤقتاً' : 'غير مفعّل'}. التسجيلات الجديدة من رابطك ما تُحسب لين نراجعه معك.
        </p>
      )}

      <section className="mt-6 space-y-2">
        <h2 className="text-base font-bold text-foreground">رابطك</h2>
        <CopyLink link={link} />
        <p className="text-xs leading-5 text-muted-foreground">
          يشتغل لمدة {Math.round(REF_COOKIE_MAX_AGE / 86400)} يوم من أول نقرة، وآخر رابط مختصر يفتحه العميل هو اللي يُحسب. وتقدر تضيف <bdi dir="ltr" className="font-mono">?ref={partner.code}</bdi> لأي رابط من روابطنا، بس هذا ما يلغي رابط شريك ثاني فتحه العميل قبل.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-bold text-foreground">أرقامك</h2>
        <dl className="mt-3 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          <Stat label="نقرات آخر 30 يوم" value={summary.clicks30.toLocaleString('ar-SA-u-nu-latn')} />
          <Stat label="سجّلوا" value={summary.signups.toLocaleString('ar-SA-u-nu-latn')} />
          <Stat label="دفعوا" value={summary.paying.toLocaleString('ar-SA-u-nu-latn')} />
          <Stat label="دُفع لك" value={formatMoneyMap(summary.paid)} />
        </dl>
        <dl className="mt-px grid grid-cols-1 gap-px border border-t-0 border-border bg-border sm:grid-cols-3">
          <Stat label={`بانتظار فترة الضمان (${settings.hold_days} يوم)`} value={formatMoneyMap(summary.pending)} />
          <Stat label="جاهزة للصرف" value={formatMoneyMap(summary.payable)} strong />
          <Stat label="موقوفة للمراجعة" value={formatMoneyMap(summary.held)} />
        </dl>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          نصرف يدوياً إذا وصل الجاهز لك إلى الحد الأدنى ({formatMoney(settings.min_payout, 'SAR')})، ولو عميل استرجع دفعته نخصم عمولتها من الصرف.
          {Object.keys(summary.clawback).length > 0 && <> المخصوم من صرفك القادم: <bdi>{formatMoneyMap(summary.clawback)}</bdi></>}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-bold text-foreground">آخر العمولات</h2>
        {summary.recent.length === 0 ? (
          <p className="mt-3 border border-border px-4 py-5 text-sm text-muted-foreground">ما فيه عمولات للحين. تظهر هنا أول ما يدفع أول عميل من رابطك.</p>
        ) : (
          <div className="mt-3 overflow-x-auto border border-border">
            <table className="w-full min-w-[520px] text-start text-[13px]">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
                  <th className="px-3 py-2 text-start font-semibold">المبلغ</th>
                  <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                  <th className="px-3 py-2 text-start font-semibold">تصير جاهزة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.recent.map((c) => (
                  <tr key={c.invoice_key}>
                    <td className="px-3 py-2">{day(c.earned_at)}</td>
                    <td className="px-3 py-2 font-semibold">{formatMoney(c.amount, c.currency)}</td>
                    <td className="px-3 py-2">{COMMISSION_STATUS_AR[c.status] ?? c.status}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.status === 'pending' ? day(c.payable_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {summary.payouts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-bold text-foreground">الدفعات اللي وصلتك</h2>
          <ul className="mt-3 divide-y divide-border border border-border text-[13px]">
            {summary.payouts.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-3 py-2">
                <span>{day(p.created_at)}</span>
                <span className="font-semibold">{formatMoney(p.amount, p.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={strong ? 'mt-0.5 text-lg font-bold text-foreground' : 'mt-0.5 text-base font-semibold text-foreground'}>{value}</dd>
    </div>
  );
}
