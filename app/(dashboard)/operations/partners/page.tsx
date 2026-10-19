import { requireOperatorPage } from '@/lib/platform/operator-page';
import { createAdminClient } from '@/lib/supabase/server';
import { partnersEnabled, refereeGiftPromoCode } from '@/lib/partners/config';
import { listHeldCommissions, listPartners, readPartnerSettings, type HeldCommission, type PartnerListRow, type PartnerSettings } from '@/lib/partners/store';
import { formatMoney, formatMoneyMap } from '@/lib/partners/format';
import { OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime, shortDate } from '../format';
import { CreatePartnerForm, HeldActions, PartnerRowActions } from './partner-actions';

export const metadata = { title: 'الشركاء · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const STATUS_AR: Record<string, string> = { invited: 'مدعو', active: 'نشط', paused: 'موقوف', banned: 'محظور' };
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default async function PartnersOpsPage() {
  await requireOperatorPage('/operations/partners');
  const now = Date.now();
  let partners: PartnerListRow[] = [];
  let held: HeldCommission[] = [];
  let settings: PartnerSettings | null = null;
  let missingMigration = false;
  try {
    const db = createAdminClient();
    [partners, held, settings] = await Promise.all([listPartners(db), listHeldCommissions(db), readPartnerSettings(db)]);
  } catch {
    missingMigration = true;
  }

  const enabled = partnersEnabled();
  const gift = refereeGiftPromoCode();

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">الشركاء</h1>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          من يشارك المنصة وياخذ عمولة على كل دفعة. العمولة تنحسب من الدفعة الفعلية بعد الضريبة، والصرف يدوي من هنا.
        </p>
      </header>
      <OpsTabs active="partners" updatedAt={riyadhTime(now)} />

      <div className="space-y-6 px-4 pt-6 sm:px-6 lg:px-8">
        {missingMigration && (
          <p className="border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6 text-foreground">
            <span className="font-semibold">ميقريشن الشركاء ما انشغل بعد.</span> شغّل{' '}
            <code className="break-all font-mono text-xs" dir="ltr">db/migrations/20261019_partner_program.sql</code>{' '}
            على Supabase وارجع.
          </p>
        )}

        <section className="space-y-3">
          <SectionHead title="الإعداد" note="الأرقام تُقرأ من جدول partner_settings في Supabase، تعدّلها بسطر UPDATE." />
          <dl className="grid gap-px border border-border bg-border sm:grid-cols-2">
            <Item label="البرنامج (PARTNERS_ENABLED)" value={enabled ? 'شغّال' : 'مطفي. ما يُحسب شي ولا يظهر للشركاء'} />
            <Item label="هدية العميل (PARTNER_REFEREE_PROMO_CODE)" value={gift ? `الكود ${gift}` : 'ما انضبط. العميل ما ياخذ خصم'} />
            {settings && (
              <>
                <Item label="النسبة" value={`${pct(settings.default_rate)}، وتصير ${pct(settings.tier_rate)} فوق ${settings.tier_threshold} عملاء يدفعون`} />
                <Item label="المدة وفترة الضمان" value={`${settings.commission_months} شهر، والضمان ${settings.hold_days} يوم`} />
                <Item label="أقل صرف" value={formatMoney(settings.min_payout, 'SAR')} />
                <Item label="الإيقاف التلقائي" value={`أكثر من ${settings.velocity_cap} أول دفعات بأسبوع تُوقف للمراجعة`} />
              </>
            )}
          </dl>
        </section>

        <section className="space-y-3">
          <SectionHead title="شريك جديد" note="الشريك يسجّل في المنصة بنفس الإيميل، وبعدها يشوف صفحته على /partners." />
          <CreatePartnerForm />
        </section>

        {held.length > 0 && (
          <section className="space-y-3">
            <SectionHead title="عمولات موقوفة" note="وقفها النظام تلقائياً: نفس الإيميل أو الجوال، نفس البطاقة، أو دفعات كثيرة بأسبوع. اعتمدها أو ألغها." />
            <div className="overflow-x-auto border border-border">
              <table className="w-full min-w-[640px] text-start text-[13px]">
                <thead className="bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-start font-semibold">الشريك</th>
                    <th className="px-3 py-2 text-start font-semibold">المبلغ</th>
                    <th className="px-3 py-2 text-start font-semibold">السبب</th>
                    <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {held.map((h) => (
                    <tr key={h.id}>
                      <td className="px-3 py-2 font-mono" dir="ltr">{h.partner_code}</td>
                      <td className="px-3 py-2 font-semibold">{formatMoney(h.amount, h.currency)}</td>
                      <td className="px-3 py-2 text-muted-foreground" dir="ltr">{h.note ?? '—'}</td>
                      <td className="px-3 py-2">{shortDate(h.earned_at)}</td>
                      <td className="px-3 py-2"><HeldActions commissionId={h.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="space-y-3">
          <SectionHead title="الشركاء" note="النقرات آخر 30 يوم. الجاهز للصرف يعني خلصت فترة الضمان." />
          {partners.length === 0 ? (
            <p className="border border-border px-4 py-5 text-sm text-muted-foreground">ما فيه شركاء للحين.</p>
          ) : (
            <ul className="divide-y divide-border border border-border">
              {partners.map((p) => (
                <li key={p.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[1.2fr_2fr_1.6fr]">
                  <div>
                    <p className="text-sm font-bold text-foreground">{p.display_name}</p>
                    <p className="font-mono text-xs text-muted-foreground" dir="ltr">/r/{p.code}</p>
                    <p className="text-xs text-muted-foreground" dir="ltr">{p.email}</p>
                    <p className="mt-1 text-xs font-semibold text-foreground">
                      {STATUS_AR[p.status] ?? p.status}
                      {p.commission_rate !== null && ` · نسبة خاصة ${pct(p.commission_rate)}`}
                      {p.held_count > 0 && ` · ${p.held_count} موقوفة`}
                    </p>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-[13px]">
                    <Num label="نقرات" value={p.clicks} />
                    <Num label="سجّلوا" value={p.signups} />
                    <Num label="دفعوا" value={p.paying} />
                    <div className="col-span-3">
                      <dt className="text-xs text-muted-foreground">جاهز للصرف</dt>
                      <dd className="font-semibold text-foreground">{formatMoneyMap(p.payable)}</dd>
                      {Object.keys(p.owed_clawback).length > 0 && (
                        <dd className="text-xs text-danger">يُخصم منه استرجاع: {formatMoneyMap(p.owed_clawback)}</dd>
                      )}
                    </div>
                  </dl>
                  <PartnerRowActions partnerId={p.id} status={p.status} expectedNet={expectedNet(p)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** Per currency: what is payable minus what is owed back, the figure the payout is checked against. */
function expectedNet(p: PartnerListRow) {
  const out: Record<string, number> = {};
  for (const [cur, gross] of Object.entries(p.payable)) out[cur] = Math.round((gross - (p.owed_clawback[cur] ?? 0)) * 100) / 100;
  return out;
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function Num({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground numeric">{value.toLocaleString('ar-SA-u-nu-latn')}</dd>
    </div>
  );
}
