import type { PartnerSettings } from '@/lib/partners/store';
import { formatMoney } from '@/lib/partners/format';
import { refereeGiftLabel } from '@/lib/partners/config';

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** The offer and the terms, in plain words. Shared by the public page and the join step. */
export function Offer({ settings }: { settings: PartnerSettings | null }) {
  const rate = settings?.default_rate ?? null;
  const months = settings?.commission_months ?? null;
  return (
    <>
      <section>
        <h2 className="text-base font-bold text-foreground">وش تاخذ</h2>
        {settings && rate !== null && months !== null ? (
          <ul className="mt-3 space-y-2 text-sm leading-7 text-foreground">
            <li>
              <strong>{pct(rate)}</strong> من كل دفعة يدفعها العميل اللي جبته، لمدة <strong>{months} شهر</strong> من أول دفعة. لو العميل دفع 1000 ريال في شهر، لك {Math.round(rate * 1000)} ريال.
            </li>
            <li>
              لو صار عندك أكثر من {settings.tier_threshold} عملاء يدفعون في نفس الوقت، تصير نسبتك <strong>{pct(settings.tier_rate)}</strong>.
            </li>
            <li>
              العمولة تحسب على اللي اندفع فعلاً، مو على التسجيل ولا التجربة. وتصير جاهزة للصرف بعد {settings.hold_days} يوم من الدفعة.
            </li>
            {refereeGiftLabel() && (
              <li>
                العميل اللي يسجّل برابطك ياخذ <strong>{refereeGiftLabel()}</strong>، وهذا يسهّل عليك الإقناع.
              </li>
            )}
            <li>نصرف لك يدوياً لما يوصل الجاهز عندك {formatMoney(settings.min_payout, 'SAR')}.</li>
          </ul>
        ) : (
          <p className="mt-3 text-sm leading-7 text-muted-foreground">العمولة نسبة من كل دفعة يدفعها العميل اللي جبته، وتتحدد أرقامها داخل حسابك بعد الانضمام.</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-bold text-foreground">الشروط</h2>
        <ul className="mt-3 list-disc space-y-2 ps-5 text-sm leading-7 text-foreground">
          <li>لا توعد أحد بنتائج ولا أرقام من إعلاناته. نحن نفسنا ما نوعد.</li>
          <li>لا تقدّم نفسك كموظف عندنا.</li>
          <li>ممنوع المزايدة على كلمة مُضاعِف أو modaafa في إعلانات قوقل.</li>
          <li>أنت مسؤول عن نظامية إعلانك في بلدك، ومنها الإفصاح إنه إعلان.</li>
          <li>العميل اللي يسجّل بنفسه بإيميلك أو جوالك أو بطاقتك ما تنحسب لك عمولته، ولو عميل استرجع دفعته نخصم عمولتها من صرفك.</li>
          <li>نقدر نوقف أي شريك ونلغي عمولاته المعلّقة لو خالف الشروط أو لو لقينا تلاعب.</li>
        </ul>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          البرنامج جديد والصرف يدوي، فالتحويل ياخذ وقت وما هو فوري.
        </p>
      </section>
    </>
  );
}
