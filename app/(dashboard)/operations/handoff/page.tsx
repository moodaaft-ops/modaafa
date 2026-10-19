import { notFound } from 'next/navigation';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { createAdminClient } from '@/lib/supabase/server';
import { agencyHandoffEnabled } from '@/lib/handoff/flag';
import { evaluateStoredHandoff, type HandoffRow } from '@/lib/handoff/read';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime, shortDate } from '../format';
import { HandledButton } from './handled-button';

export const metadata = { title: 'يبون فريق · مركز التشغيل' };
export const dynamic = 'force-dynamic';

export default async function HandoffPage() {
  await requireOperatorPage('/operations/handoff');
  if (!agencyHandoffEnabled()) notFound();
  const now = Date.now();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from('agency_handoffs')
    .select('account_id, reasons, spend_30d_sar, policy_flagged_ads, evaluated_at, asked_at, handled_at')
    .order('evaluated_at', { ascending: false })
    .limit(300);
  const rows = (data ?? []) as HandoffRow[];

  const accountIds = rows.map((row) => row.account_id);
  const { data: accounts } = accountIds.length
    ? await admin.from('google_ads_accounts').select('id, customer_id, customer_name, status, google_status, business_id').in('id', accountIds)
    : { data: [] as any[] };
  const accountById = new Map((accounts ?? []).map((account: any) => [account.id, account]));
  const businessIds = [...new Set((accounts ?? []).map((account: any) => account.business_id).filter(Boolean))];
  const { data: businesses } = businessIds.length
    ? await admin.from('businesses').select('id, user_id').in('id', businessIds)
    : { data: [] as any[] };
  const ownerByBusiness = new Map((businesses ?? []).map((business: any) => [business.id, business.user_id]));
  const ownerIds = [...new Set([...ownerByBusiness.values()])];
  const { data: users } = ownerIds.length
    ? await admin.from('users').select('id, email, phone').in('id', ownerIds)
    : { data: [] as any[] };
  const userById = new Map((users ?? []).map((user: any) => [user.id, user]));

  const items = await Promise.all(
    rows.map(async (row) => {
      const account: any = accountById.get(row.account_id);
      const ownerId = account ? ownerByBusiness.get(account.business_id) : null;
      const overrides = ownerId ? await readAccessOverrides(admin, ownerId, now) : { suspended: false };
      const status = typeof account?.google_status === 'string' ? account.google_status.toUpperCase() : null;
      const verdict = evaluateStoredHandoff(row, {
        suspended: Boolean(overrides.suspended),
        googleDisabled: account?.status === 'paused' || Boolean(status && !['ENABLED', 'UNKNOWN', 'UNSPECIFIED'].includes(status)),
      });
      return { row, account, owner: ownerId ? userById.get(ownerId) : null, verdict };
    })
  );
  const open = items.filter((item) => item.verdict.needed && !item.row.handled_at);
  open.sort((a, b) => Number(Boolean(b.row.asked_at)) - Number(Boolean(a.row.asked_at)));

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">يبون فريق</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">حسابات صارت أكبر من المنصة، أو أصحابها طلبوا أحد يكلمهم.</p>
      </header>
      <OpsTabs active="handoff" updatedAt={riyadhTime(now)} />
      <div className="space-y-4 px-4 pt-6 sm:px-6 lg:px-8">
        {error && (
          <p role="alert" className="border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            ما قدرنا نقرأ الجدول. غالباً الميقريشن 20261020_trust_agency_handoff ما انشغل بعد.
          </p>
        )}
        <SectionHead title="مفتوحة" note="اللي طلبوا بأنفسهم فوق." />
        {open.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">ما فيه أحد الحين.</p>
        ) : (
          <ul className="space-y-3">
            {open.map(({ row, account, owner, verdict }) => (
              <li key={row.account_id} className="border border-border p-3">
                <p className="text-sm font-semibold">
                  {account?.customer_name ?? 'حساب'} <span dir="ltr" className="text-muted-foreground">{account?.customer_id}</span>
                  {row.asked_at && <span className="ms-2 bg-signal/25 px-2 py-0.5 text-xs">طلب بنفسه {shortDate(row.asked_at)}</span>}
                </p>
                {owner?.email && <p className="text-xs text-muted-foreground" dir="ltr">{owner.email}{owner.phone ? ` · ${owner.phone}` : ''}</p>}
                <ul className="mt-2 list-disc space-y-1 ps-5 text-[13px] leading-6">
                  {verdict.reasons.map((reason) => (
                    <li key={reason.code}>{reason.text_ar}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">آخر فحص {shortDate(row.evaluated_at)}</p>
                <HandledButton accountId={row.account_id} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
