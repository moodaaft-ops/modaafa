import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { grantStatuses } from '@/lib/google-auth/store';
import { buildConnectionsView, connectionsReads, type StoreRow } from '@/lib/settings/connections';
import { CARD, CalmHeading, CalmNote, StatusWord, pill } from '../calm-page';
import { cn } from '@/lib/utils';

/**
 * Store connections and the extra Google permissions. Renders nothing while
 * every related flag is off. Reads are best effort: a failure shows the rows
 * as not connected rather than breaking Settings.
 */
export async function ConnectionsSection({
  userId,
  params,
}: {
  userId: string;
  params: { extra?: string; feature?: string; store?: string; platform?: string } | undefined;
}) {
  // Every related flag off: no query at all (the tables may not exist yet).
  const reads = connectionsReads();
  if (!reads.grants && !reads.stores) return null;
  let grants = null;
  let stores: StoreRow[] = [];
  if (reads.grants) {
    try {
      grants = await grantStatuses(createAdminClient(), userId);
    } catch {
      grants = null;
    }
  }
  if (reads.stores) {
    try {
      const supabase = await createServerClient();
      const { data } = await supabase.from('store_connections').select('platform, external_store_id, status, last_error');
      stores = (data ?? []) as StoreRow[];
    } catch {
      stores = [];
    }
  }
  const view = buildConnectionsView({ params, grants, stores });
  if (!view.show) return null;

  const tone = (s: string) => (s === 'active' || s === 'connected' ? 'success' : s === 'none' ? 'neutral' : 'warning');

  return (
    <section className="mt-10" aria-labelledby="connections-title">
      <CalmHeading id="connections-title" title="الربط الإضافي" hint="كل ربط بموافقة مستقلة، وتقدر تسحبها من حساب قوقل أو من المتجر." className="mb-3" />
      {view.notice && (
        <div className="mb-3">
          <CalmNote tone={view.notice.tone}>{view.notice.text}</CalmNote>
        </div>
      )}
      <ul className={cn(CARD, 'divide-y divide-border/70 overflow-hidden')}>
        {view.stores.map((s) => (
          <li key={s.platform} className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[16px] font-semibold leading-7">متجر {s.name}</span>
                <StatusWord tone={tone(s.status)}>{s.label}</StatusWord>
              </div>
              <p className="text-[13.5px] leading-6 text-muted-foreground">
                نقارن مبيعات المتجر الفعلية بما تسجله قوقل، وما نغير شي في متجرك.
                {s.detail && <span className="numeric" dir="ltr"> · {s.detail}</span>}
              </p>
            </div>
            {s.needsShop ? (
              <form action={s.actionHref} method="get" className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  name="shop"
                  dir="ltr"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="my-store.myshopify.com"
                  aria-label="عنوان متجر شوبيفاي"
                  className="h-10 w-full rounded-full border border-border bg-background px-4 text-[14px] sm:w-64"
                />
                <button type="submit" className={cn(pill.quietSm, 'self-start')}>
                  {s.actionLabel}
                </button>
              </form>
            ) : (
              <a href={s.actionHref} className={cn(pill.quietSm, 'self-start sm:self-center')}>
                {s.actionLabel}
              </a>
            )}
          </li>
        ))}
        {view.google.map((g) => (
          <li key={g.feature} className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[16px] font-semibold leading-7">{g.title}</span>
                <StatusWord tone={tone(g.status)}>{g.label}</StatusWord>
              </div>
              <p className="text-[13.5px] leading-6 text-muted-foreground">{g.body}</p>
            </div>
            {g.actionHref && (
              <a href={g.actionHref} className={cn(pill.quietSm, 'self-start sm:self-center')}>
                {g.actionLabel}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
