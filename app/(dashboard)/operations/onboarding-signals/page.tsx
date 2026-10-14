import { requireOperatorPage } from '@/lib/platform/operator-page';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { createAdminClient } from '@/lib/supabase/server';
import { classifyScenario } from '@/lib/setup/adaptive/scenario';
import { loadStoredSignals } from '@/lib/setup/adaptive/signals-store';
import type { Scenario } from '@/lib/setup/adaptive/types';
import { formatNumberAr } from '@/lib/utils';
import { OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime } from '../format';
import { SignalsPanel, type SignalsView } from './signals-panel';

export const metadata = { title: 'قراءة الحساب · مركز التشغيل' };
export const dynamic = 'force-dynamic';

/** A page of accounts, not all of them: every one carries its last stored read. */
const VISIBLE_ACCOUNTS = 20;

/** 123-456-7890 for a 10 digit id; anything else as it is. */
function dashed(customerId: string) {
  const digits = customerId.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : customerId;
}

export default async function OnboardingSignalsPage({ searchParams }: { searchParams?: Promise<{ q?: string }> }) {
  const user = await requireOperatorPage('/operations/onboarding-signals');
  const now = Date.now();
  const params = await searchParams;
  const query = (params?.q ?? '').trim().slice(0, 60);
  const { accounts } = await getAccountWorkspace(user.id);

  const digits = query.replace(/\D/g, '');
  const matching = query
    ? accounts.filter(
        (account) =>
          (digits.length > 0 && account.customer_id.replace(/\D/g, '').includes(digits)) ||
          (account.customer_name ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : accounts;
  const visible = matching.slice(0, VISIBLE_ACCOUNTS);

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  // The newest stored read per account, so the page opens with what is already known.
  const views = await Promise.all(
    visible.map(async (account): Promise<SignalsView | null> => {
      if (!admin) return null;
      const signals = await loadStoredSignals(admin, account.id);
      if (!signals) return null;
      let scenario: Scenario | null = null;
      try {
        scenario = classifyScenario({ signals, linkedAccounts: accounts.length, connectNoAccount: false, answered: {} });
      } catch {
        scenario = null;
      }
      return { signals, scenario, saved: true };
    })
  );

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">قراءة الحساب</h1>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          نفس القراءة اللي يسويها مُضاعِف لحساب العميل قبل ما يسأله. اضغط «اقرأ الحساب» على أي حساب من حساباتك وشوف كل
          إشارة، هل انقرت أو فشلت وليش، وبعدها وش يفهم منها المسار. للمالك فقط.
        </p>
      </header>
      <OpsTabs active="signals" updatedAt={riyadhTime(now)} />

      <div className="space-y-6 px-4 pt-6 sm:px-6 lg:px-8">
        <SectionHead
          title="حساباتك المربوطة"
          note="القراءة تتجاهل المحفوظ وتقرأ من قوقل مباشرة، وتحفظ النتيجة. ما تكلّف شي من الذكاء الاصطناعي."
          aside={<span className="text-sm font-semibold numeric text-foreground">{formatNumberAr(accounts.length)}</span>}
        />

        {accounts.length > VISIBLE_ACCOUNTS && (
          <form method="get" className="flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="رقم الحساب أو اسمه"
              aria-label="دوّر على حساب"
              className="h-10 min-w-0 flex-1 border border-border-strong bg-background px-3 text-base sm:text-sm"
            />
            <button type="submit" className="h-10 shrink-0 bg-foreground px-4 text-sm font-semibold text-background">
              دوّر
            </button>
          </form>
        )}

        {accounts.length === 0 ? (
          <p className="border border-border px-4 py-6 text-sm leading-6 text-muted-foreground">
            ما عندك حساب إعلانات مربوط. اربط حساب من الإعدادات وبعدها ارجع هنا.
          </p>
        ) : matching.length === 0 ? (
          <p className="border border-border px-4 py-6 text-sm leading-6 text-muted-foreground">ما لقيت حساب بهذا الرقم أو الاسم.</p>
        ) : (
          <div className="space-y-4">
            {visible.map((account, index) => (
              <SignalsPanel
                key={account.id}
                accountId={account.id}
                name={account.customer_name?.trim() || 'حساب بدون اسم'}
                customerId={dashed(account.customer_id)}
                initial={views[index]}
              />
            ))}
            {matching.length > visible.length && (
              <p className="text-[13px] leading-6 text-muted-foreground">
                المعروض أول {formatNumberAr(visible.length)} من {formatNumberAr(matching.length)}. استخدم البحث فوق عشان تجيب غيرها.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
