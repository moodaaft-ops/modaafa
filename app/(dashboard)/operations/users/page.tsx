import Link from 'next/link';
import { requireOperatorPage } from '@/lib/platform/operator-page';
import { loadOperatorDataset } from '@/lib/platform/operator-data';
import {
  ACCESS_LABELS,
  STAGES,
  STAGE_LABELS,
  STAGE_NEXT_STEP,
  buildCustomerProfiles,
  type AccessState,
  type CustomerProfile,
  type CustomerStage,
} from '@/lib/platform/operator-insights';
import { sanitizeOperatorSearch } from '@/lib/platform/operator-users';
import { planLabel } from '@/lib/ui/labels';
import { cn, formatNumberAr, timeAgoAr } from '@/lib/utils';
import { AccessChip, MigrationNotice, OpsTabs, StageTrack } from '../ops-ui';
import { riyadhTime, shortDate } from '../format';

export const metadata = { title: 'العملاء · مركز التشغيل' };
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;
const ACCESS_FILTERS: Array<AccessState> = ['trialing', 'active', 'past_due', 'comp', 'trial_ended', 'canceled', 'suspended', 'none'];
const SORTS = {
  new: 'الأحدث تسجيلاً',
  seen: 'آخر نشاط',
  trial: 'أقرب نهاية تجربة',
} as const;
type SortKey = keyof typeof SORTS;

type Params = { q?: string; stage?: string; access?: string; sort?: string };

function buildHref(current: Params, patch: Partial<Params>) {
  const next = { ...current, ...patch };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `/operations/users?${text}` : '/operations/users';
}

const time = (value: string | null | undefined) => {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

function sortProfiles(rows: CustomerProfile[], sort: SortKey) {
  const copy = [...rows];
  if (sort === 'seen') return copy.sort((a, b) => (time(b.lastSeenAt) ?? 0) - (time(a.lastSeenAt) ?? 0));
  if (sort === 'trial') {
    return copy.sort((a, b) => {
      const at = a.access === 'trialing' ? time(a.subscription?.trialEndsAt) : null;
      const bt = b.access === 'trialing' ? time(b.subscription?.trialEndsAt) : null;
      if (at === null && bt === null) return (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0);
      if (at === null) return 1;
      if (bt === null) return -1;
      return at - bt;
    });
  }
  return copy.sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0));
}

function renewalText(profile: CustomerProfile) {
  if (profile.access === 'trialing' && profile.subscription?.trialEndsAt) return `تنتهي ${shortDate(profile.subscription.trialEndsAt)}`;
  if (profile.access === 'comp') return profile.overrides.grant?.expiresAt ? `لين ${shortDate(profile.overrides.grant.expiresAt)}` : 'بدون نهاية';
  if ((profile.access === 'active' || profile.access === 'past_due') && profile.subscription?.currentPeriodEnd)
    return `يتجدد ${shortDate(profile.subscription.currentPeriodEnd)}`;
  return '—';
}

export default async function OperationsCustomersPage({ searchParams }: { searchParams?: Promise<Params> }) {
  await requireOperatorPage('/operations/users');
  const params = (await searchParams) ?? {};
  const search = sanitizeOperatorSearch(params.q).toLowerCase();
  const stage = (STAGES as readonly string[]).includes(params.stage ?? '') ? (params.stage as CustomerStage) : null;
  const access = (ACCESS_FILTERS as string[]).includes(params.access ?? '') ? (params.access as AccessState) : null;
  const sort: SortKey = params.sort === 'seen' || params.sort === 'trial' ? params.sort : 'new';
  const current: Params = { q: search || undefined, stage: stage ?? undefined, access: access ?? undefined, sort: sort === 'new' ? undefined : sort };

  const now = Date.now();
  const data = await loadOperatorDataset(now);
  const customers = buildCustomerProfiles(data, now).filter((profile) => !profile.isOperator);

  const stageCounts = new Map<CustomerStage, number>();
  for (const profile of customers) stageCounts.set(profile.stage, (stageCounts.get(profile.stage) ?? 0) + 1);
  const accessCounts = new Map<AccessState, number>();
  for (const profile of customers) accessCounts.set(profile.access, (accessCounts.get(profile.access) ?? 0) + 1);

  const filtered = sortProfiles(
    customers.filter((profile) => {
      if (stage && profile.stage !== stage) return false;
      if (access && profile.access !== access) return false;
      if (search) {
        const haystack = `${profile.email} ${profile.name ?? ''} ${profile.businessName ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    }),
    sort
  );
  const shown = filtered.slice(0, LIST_LIMIT);

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">مركز التشغيل</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{formatNumberAr(customers.length)} عميل مسجّل</p>
      </header>
      <OpsTabs active="customers" updatedAt={riyadhTime(now)} />

      <div className="space-y-5 px-4 pt-5 sm:px-6 lg:px-8">
        <MigrationNotice missing={data.unavailable} />

        <form method="get" role="search" className="flex flex-wrap items-center gap-2">
          {stage && <input type="hidden" name="stage" value={stage} />}
          {access && <input type="hidden" name="access" value={access} />}
          {sort !== 'new' && <input type="hidden" name="sort" value={sort} />}
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="إيميل أو اسم أو نشاط"
            aria-label="ابحث عن عميل"
            className="h-10 w-full max-w-xs border border-border-strong bg-background px-3 text-base text-foreground sm:text-sm"
          />
          <button type="submit" className="h-10 bg-foreground px-4 text-sm font-semibold text-background">
            بحث
          </button>
          {(search || stage || access || sort !== 'new') && (
            <Link href="/operations/users" className="h-10 px-2 text-sm leading-10 text-muted-foreground underline underline-offset-4">
              مسح الفلاتر
            </Link>
          )}
        </form>

        <div>
          <div className="mb-2 text-xs font-semibold text-muted-foreground">واقفين عند</div>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip href={buildHref(current, { stage: undefined })} active={!stage} label="كل المراحل" count={customers.length} />
            {STAGES.map((key) => (
              <FilterChip
                key={key}
                href={buildHref(current, { stage: key })}
                active={stage === key}
                label={STAGE_LABELS[key]}
                count={stageCounts.get(key) ?? 0}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">الاشتراك</div>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip href={buildHref(current, { access: undefined })} active={!access} label="الكل" />
              {ACCESS_FILTERS.filter((key) => (accessCounts.get(key) ?? 0) > 0 || access === key).map((key) => (
                <FilterChip
                  key={key}
                  href={buildHref(current, { access: key })}
                  active={access === key}
                  label={ACCESS_LABELS[key]}
                  count={accessCounts.get(key) ?? 0}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">ترتيب:</span>
            {(Object.keys(SORTS) as SortKey[]).map((key) => (
              <Link
                key={key}
                href={buildHref(current, { sort: key === 'new' ? undefined : key })}
                aria-current={sort === key ? 'true' : undefined}
                className={cn('px-2 py-1 font-semibold', sort === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
              >
                {SORTS[key]}
              </Link>
            ))}
          </div>
        </div>

        {stage && stage !== 'paying' && (
          <p className="border-s-4 border-signal bg-signal/10 px-4 py-2.5 text-sm text-foreground">
            هذولا {STAGE_NEXT_STEP[stage]}.
          </p>
        )}

        <p className="text-sm text-muted-foreground">
          {formatNumberAr(filtered.length)} نتيجة
          {filtered.length > LIST_LIMIT && ` · نعرض أول ${formatNumberAr(LIST_LIMIT)}`}
        </p>

        {shown.length === 0 ? (
          <p className="border border-border px-4 py-8 text-center text-sm text-muted-foreground">ما فيه عميل بهالفلاتر.</p>
        ) : (
          <>
            {/* Phones: one block per customer. */}
            <ul className="divide-y divide-border border-y border-border md:hidden">
              {shown.map((profile) => (
                <li key={profile.id}>
                  <Link href={`/operations/users/${profile.id}`} className="block py-3 active:bg-surface">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground" dir="ltr">
                          {profile.email}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{profile.businessName ?? 'ما عبّى النشاط'}</div>
                      </div>
                      <AccessChip access={profile.access} label={ACCESS_LABELS[profile.access]} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <StageTrack milestones={profile.milestones} stage={profile.stage} />
                      <span className="text-xs text-muted-foreground">
                        {profile.lastSeenAt ? `آخر نشاط ${timeAgoAr(profile.lastSeenAt)}` : `سجّل ${timeAgoAr(profile.createdAt ?? new Date())}`}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Wider screens: a table you can scan across. */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="border-y border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2.5 pe-3 text-start font-medium">العميل</th>
                    <th className="px-3 py-2.5 text-start font-medium">وين وصل</th>
                    <th className="px-3 py-2.5 text-start font-medium">الاشتراك</th>
                    <th className="px-3 py-2.5 text-start font-medium">الموعد</th>
                    <th className="px-3 py-2.5 text-end font-medium">حسابات</th>
                    <th className="px-3 py-2.5 text-end font-medium">استخدام 7 أيام</th>
                    <th className="px-3 py-2.5 text-start font-medium">آخر نشاط</th>
                    <th className="py-2.5 ps-3 text-start font-medium">سجّل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((profile) => (
                    <tr key={profile.id} className="group hover:bg-surface">
                      <td className="max-w-[16rem] py-3 pe-3">
                        <Link href={`/operations/users/${profile.id}`} className="block">
                          <span className="block truncate font-semibold text-foreground group-hover:underline" dir="ltr">
                            {profile.email}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {profile.businessName ?? 'ما عبّى النشاط'}
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        <StageTrack milestones={profile.milestones} stage={profile.stage} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <AccessChip access={profile.access} label={ACCESS_LABELS[profile.access]} />
                          {(profile.subscription?.plan || profile.overrides.grant) && (
                            <span className="text-xs text-muted-foreground">
                              {planLabel(profile.overrides.grant?.plan ?? profile.subscription?.plan ?? null)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{renewalText(profile)}</td>
                      <td className="px-3 py-3 text-end numeric">
                        {formatNumberAr(profile.accounts.active)}
                        {profile.accounts.total > profile.accounts.active && (
                          <span className="text-xs text-muted-foreground"> / {formatNumberAr(profile.accounts.total)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-end numeric">{formatNumberAr(profile.usage7d)}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {profile.lastSeenAt ? timeAgoAr(profile.lastSeenAt) : 'ما دخل'}
                      </td>
                      <td className="py-3 ps-3 text-xs text-muted-foreground">{shortDate(profile.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FilterChip({ href, active, label, count }: { href: string; active: boolean; label: string; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 border px-2.5 text-xs font-semibold transition-colors',
        active ? 'border-foreground bg-foreground text-background' : 'border-border-strong text-foreground hover:border-foreground'
      )}
    >
      {label}
      {count !== undefined && <span className={cn('numeric', active ? 'text-background/70' : 'text-muted-foreground')}>{formatNumberAr(count)}</span>}
    </Link>
  );
}
