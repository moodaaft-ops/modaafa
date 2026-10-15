import {
  ProvisioningError,
  checkInvite,
  createClientAccount,
  findUnclaimedAccount,
  inviteAdmin,
  provisioningErrorCode,
  unlinkClient,
  type InviteState,
  type ProvisioningContext,
} from '@/lib/google-ads/provisioning';
import type { ProvisionPatch, ProvisionStore } from './store';
import type { ProvisionRow } from './types';

/**
 * The state machine of «افتحه لي» (plan 121, sections 2.4 and 2.5), on top of
 * the Google calls (lib/google-ads/provisioning.ts) and the row store.
 *
 * creating → invited → accepted → unlinked, with failed and expired as exits.
 * The row is written BEFORE Google is asked (the unique user_id is the lock), the
 * account id is written the moment Google returns it, and a create that may have
 * half-happened is never repeated blindly: see CREATE_UNCONFIRMED below.
 */

export type ProvisionDeps = {
  store: ProvisionStore;
  ads: ProvisioningContext;
  /** PROVISIONING_UNLINK_AFTER_ACCEPT. Off until the live test proves Google allows it. */
  unlinkAfterAccept: boolean;
  now?: () => Date;
};

/** A `creating` row nobody finished in this long is marked failed so the user can retry. */
export const STALE_CREATING_MS = 10 * 60 * 1000;
/** Google invitations expire after 30 days; an email Google no longer lists after 31 is treated as expired. */
export const INVITE_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
/** A user polling the status triggers a Google read at most this often. */
export const USER_CHECK_INTERVAL_MS = 30_000;

/** The account name: the part of the email before the @ (policy of 11 Oct 2026). */
export function accountNameFromEmail(email: string) {
  const local = email.trim().split('@')[0] ?? '';
  const clean = local.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return clean || 'عميل مُضاعِف';
}

/** A lowercase email Google can invite, or null. Deliberately plain: no quotes, commas or brackets. */
export function validateInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(email) ? email : null;
}

function clock(deps: ProvisionDeps) {
  return (deps.now ?? (() => new Date()))();
}

export type StartResult =
  | { ok: true; row: ProvisionRow; created: boolean }
  | { ok: false; reason: 'bad_email' };

/**
 * Start (or resume) the one account a user may have.
 * - no row: insert it, then create and invite;
 * - a row in any state except `failed`: return it untouched, nothing is created;
 * - a `failed` row: claim it and go again. The email may change only while no
 *   account exists yet; once Google made the account, a retry only re-invites
 *   the email already on the row (nobody can aim a second invitation at an
 *   existing account by passing another email).
 */
export async function startProvision(
  deps: ProvisionDeps,
  user: { id: string; email: string | null },
  requestedEmail?: unknown
): Promise<StartResult> {
  const { store } = deps;
  const asked = requestedEmail !== undefined && requestedEmail !== null && requestedEmail !== '';
  const existing = await store.get(user.id);

  if (existing && existing.status !== 'failed') return { ok: true, row: existing, created: false };

  if (existing) {
    let patch: ProvisionPatch = {};
    if (!existing.customer_id && asked) {
      const email = validateInviteEmail(requestedEmail);
      if (!email) return { ok: false, reason: 'bad_email' };
      patch = { invited_email: email, account_name: accountNameFromEmail(email) };
    }
    const claimed = await store.claimRetry(existing, patch);
    if (!claimed) {
      // Another request took the retry; show what it is doing.
      return { ok: true, row: (await store.get(user.id)) ?? existing, created: false };
    }
    return { ok: true, row: await runCreation(deps, claimed), created: false };
  }

  const email = validateInviteEmail(asked ? requestedEmail : user.email);
  if (!email) return { ok: false, reason: 'bad_email' };

  const inserted = await store.insert({ userId: user.id, invitedEmail: email, accountName: accountNameFromEmail(email) });
  if ('conflict' in inserted) {
    const winner = await store.get(user.id);
    if (!winner) throw new Error('provision_conflict_without_row');
    return { ok: true, row: winner, created: false };
  }
  return { ok: true, row: await runCreation(deps, inserted.row), created: true };
}

async function fail(deps: ProvisionDeps, row: ProvisionRow, code: string) {
  return deps.store.update(row.id, { status: 'failed', error_code: code, last_checked_at: clock(deps).toISOString() });
}

/**
 * From a claimed `creating` row to `invited`. Failures leave a `failed` row
 * with the Google error code; the account id, once known, is already saved.
 *
 * CREATE_UNCONFIRMED: the create request may have reached Google (timeout, 5xx,
 * no id in the answer). The next attempt first looks for an unclaimed, untouched
 * account with this exact name and adopts it, instead of creating a second one.
 */
async function runCreation(deps: ProvisionDeps, start: ProvisionRow): Promise<ProvisionRow> {
  const { store, ads } = deps;
  let row = start;
  const hadAccount = Boolean(row.customer_id);
  let customerId = row.customer_id;

  if (!customerId) {
    if (row.error_code === 'CREATE_UNCONFIRMED') {
      try {
        customerId = await findUnclaimedAccount(ads, row.account_name, await store.claimedCustomerIds());
      } catch {
        // Could not look. Keep the marker so the next attempt looks again.
        return fail(deps, row, 'CREATE_UNCONFIRMED');
      }
    }

    if (!customerId) {
      try {
        customerId = (await createClientAccount(ads, row.account_name)).customerId;
      } catch (error) {
        const ambiguous = error instanceof ProvisioningError && error.ambiguous;
        return fail(deps, row, ambiguous ? 'CREATE_UNCONFIRMED' : provisioningErrorCode(error));
      }
    }

    try {
      row = await store.update(row.id, { customer_id: customerId });
    } catch {
      // The account exists but we could not write its id (database fault, or the
      // id already belongs to another row). Treat it like an unconfirmed create.
      return fail(deps, row, 'CREATE_UNCONFIRMED');
    }
  }

  // A retry may find the invitation already out (the first request timed out
  // after Google took it) or even accepted. Look before sending a second one.
  let state: InviteState = 'unknown';
  if (hadAccount) {
    try {
      state = await checkInvite(ads, customerId, row.invited_email);
    } catch {
      state = 'unknown';
    }
  }

  const nowIso = clock(deps).toISOString();
  if (state === 'accepted') {
    return store.update(row.id, { status: 'accepted', accepted_at: nowIso, invited_at: row.invited_at ?? nowIso, error_code: null, last_checked_at: nowIso });
  }
  if (state === 'pending') {
    return store.update(row.id, { status: 'invited', invited_at: row.invited_at ?? nowIso, error_code: null, last_checked_at: nowIso });
  }

  try {
    await inviteAdmin(ads, customerId, row.invited_email);
  } catch (error) {
    return fail(deps, row, provisioningErrorCode(error));
  }
  return store.update(row.id, { status: 'invited', invited_at: nowIso, error_code: null, last_checked_at: nowIso });
}

/**
 * One look at Google for an open row: invited → accepted / expired, and an
 * accepted row is released when the flag allows. Google errors are written on
 * the row (error_code) and never change its status; the next look tries again.
 */
export async function refreshProvision(deps: ProvisionDeps, start: ProvisionRow): Promise<ProvisionRow> {
  const { store, ads } = deps;
  let row = start;
  const nowIso = clock(deps).toISOString();

  if (row.status === 'invited' && row.customer_id) {
    let state: InviteState;
    try {
      state = await checkInvite(ads, row.customer_id, row.invited_email);
    } catch (error) {
      return store.update(row.id, { last_checked_at: nowIso, error_code: provisioningErrorCode(error) });
    }

    if (state === 'accepted') {
      row = await store.update(row.id, { status: 'accepted', accepted_at: nowIso, last_checked_at: nowIso, error_code: null });
    } else if (state === 'expired' || state === 'declined') {
      return store.update(row.id, {
        status: 'expired',
        error_code: state === 'declined' ? 'INVITE_DECLINED' : 'INVITE_EXPIRED',
        last_checked_at: nowIso,
      });
    } else {
      const age = clock(deps).getTime() - Date.parse(row.invited_at ?? row.created_at);
      if (state === 'unknown' && age > INVITE_MAX_AGE_MS) {
        return store.update(row.id, { status: 'expired', error_code: 'INVITE_AGE', last_checked_at: nowIso });
      }
      return store.update(row.id, { last_checked_at: nowIso, error_code: state === 'unknown' ? 'INVITE_NOT_VISIBLE' : null });
    }
  }

  if (row.status === 'accepted') return maybeUnlink(deps, row);
  return row;
}

/** Re-checks acceptance live, then releases the account. Does nothing unless PROVISIONING_UNLINK_AFTER_ACCEPT is on. */
async function maybeUnlink(deps: ProvisionDeps, row: ProvisionRow): Promise<ProvisionRow> {
  if (!deps.unlinkAfterAccept || !row.customer_id) return row;
  const { store, ads } = deps;
  const nowIso = clock(deps).toISOString();
  try {
    // The stored status could be stale; never release an account on its word alone.
    if ((await checkInvite(ads, row.customer_id, row.invited_email)) !== 'accepted') {
      return store.update(row.id, { last_checked_at: nowIso, error_code: 'UNLINK_NOT_ACCEPTED' });
    }
    await unlinkClient(ads, row.customer_id);
  } catch (error) {
    return store.update(row.id, { last_checked_at: nowIso, error_code: provisioningErrorCode(error) });
  }
  return store.update(row.id, { status: 'unlinked', unlinked_at: nowIso, last_checked_at: nowIso, error_code: null });
}

/** The status poll of a signed-in user: looks at Google only if the last look is older than 30 seconds. */
export async function refreshIfStale(deps: ProvisionDeps, row: ProvisionRow): Promise<ProvisionRow> {
  if (row.status !== 'invited' && !(row.status === 'accepted' && deps.unlinkAfterAccept)) return row;
  const last = row.last_checked_at ? Date.parse(row.last_checked_at) : 0;
  if (clock(deps).getTime() - last < USER_CHECK_INTERVAL_MS) return row;
  return refreshProvision(deps, row);
}

export type SweepSummary = {
  staleFailed: number;
  checked: number;
  accepted: number;
  expired: number;
  unlinked: number;
  errors: number;
  timedOut: boolean;
};

/** The hourly job (and the operator's «افحص الحين»): finish stale rows, then look at the open ones. */
export async function sweepProvisions(
  deps: ProvisionDeps,
  options: { limit?: number; budgetMs?: number; concurrency?: number } = {}
): Promise<SweepSummary> {
  const { limit = 200, budgetMs = 240_000, concurrency = 4 } = options;
  const started = Date.now();
  const summary: SweepSummary = { staleFailed: 0, checked: 0, accepted: 0, expired: 0, unlinked: 0, errors: 0, timedOut: false };

  summary.staleFailed = await deps.store.failStale(new Date(clock(deps).getTime() - STALE_CREATING_MS).toISOString());

  const rows = await deps.store.listOpen(deps.unlinkAfterAccept ? ['invited', 'accepted'] : ['invited'], limit);
  for (let index = 0; index < rows.length; index += concurrency) {
    if (Date.now() - started > budgetMs) {
      summary.timedOut = true;
      break;
    }
    await Promise.all(
      rows.slice(index, index + concurrency).map(async (row) => {
        try {
          const next = await refreshProvision(deps, row);
          summary.checked += 1;
          if (row.status === 'invited' && (next.status === 'accepted' || next.status === 'unlinked')) summary.accepted += 1;
          if (next.status === 'expired') summary.expired += 1;
          if (next.status === 'unlinked') summary.unlinked += 1;
        } catch (error) {
          summary.errors += 1;
          console.error('provisioning sweep: row failed', row.id, error instanceof Error ? error.message : 'unknown');
        }
      })
    );
  }
  return summary;
}
