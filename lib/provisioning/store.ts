import { createAdminClient } from '@/lib/supabase/server';
import { PROVISION_COLUMNS, type ProvisionRow, type ProvisionStatus } from './types';

/**
 * Persistence of ads_account_provisions, behind a small interface so the
 * service logic (service.ts) is tested against an in-memory copy.
 * Every write goes through the service role; the browser can only read its row.
 */

export type ProvisionPatch = Partial<
  Pick<
    ProvisionRow,
    | 'status'
    | 'customer_id'
    | 'error_code'
    | 'invited_email'
    | 'account_name'
    | 'invited_at'
    | 'accepted_at'
    | 'unlinked_at'
    | 'last_checked_at'
  >
>;

export interface ProvisionStore {
  get(userId: string): Promise<ProvisionRow | null>;
  /** Insert a fresh `creating` row. `conflict` means the user already has one (the unique key). */
  insert(input: { userId: string; invitedEmail: string; accountName: string }): Promise<{ row: ProvisionRow } | { conflict: true }>;
  /**
   * failed → creating, atomically: only the caller whose update matches the row
   * as it was read wins. Returns null when somebody else got there first.
   */
  claimRetry(row: ProvisionRow, patch: ProvisionPatch): Promise<ProvisionRow | null>;
  /**
   * Write `patch`. With `expectStatus` the write happens only while the row still
   * has that status; if somebody moved it meanwhile, nothing is written and the
   * row as it is now is returned (a stale copy never overwrites a newer state).
   */
  update(id: string, patch: ProvisionPatch, expectStatus?: ProvisionStatus): Promise<ProvisionRow>;
  /**
   * Take the right to look at Google for this row now: sets last_checked_at only if
   * it is still what `row` says, so concurrent polls make one Google read, not many.
   */
  claimCheck(row: ProvisionRow, nowIso: string): Promise<boolean>;
  /** Every customer id some row already owns. */
  claimedCustomerIds(): Promise<Set<string>>;
  /** Open rows, least recently checked first. */
  listOpen(statuses: ProvisionStatus[], limit: number): Promise<ProvisionRow[]>;
  /** `creating` rows nobody finished before `cutoffIso`: marked failed so the user can retry. */
  failStale(cutoffIso: string): Promise<number>;
  recent(limit: number): Promise<ProvisionRow[]>;
}

type AdminClient = ReturnType<typeof createAdminClient>;

const TABLE = 'ads_account_provisions';

export function supabaseProvisionStore(admin: AdminClient, now: () => Date = () => new Date()): ProvisionStore {
  const stamp = () => now().toISOString();

  return {
    async get(userId) {
      const { data, error } = await admin.from(TABLE).select(PROVISION_COLUMNS).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return (data as ProvisionRow | null) ?? null;
    },

    async insert({ userId, invitedEmail, accountName }) {
      const { data, error } = await admin
        .from(TABLE)
        .insert({ user_id: userId, invited_email: invitedEmail, account_name: accountName, status: 'creating', updated_at: stamp() })
        .select(PROVISION_COLUMNS)
        .single();
      if (error) {
        if ((error as { code?: string }).code === '23505') return { conflict: true };
        throw error;
      }
      return { row: data as ProvisionRow };
    },

    async claimRetry(row, patch) {
      const { data, error } = await admin
        .from(TABLE)
        .update({ ...patch, status: 'creating', attempts: row.attempts + 1, updated_at: stamp() })
        .eq('id', row.id)
        .eq('status', 'failed')
        .eq('attempts', row.attempts)
        .select(PROVISION_COLUMNS);
      if (error) throw error;
      return ((data as ProvisionRow[] | null) ?? [])[0] ?? null;
    },

    async update(id, patch, expectStatus) {
      if (!expectStatus) {
        const { data, error } = await admin
          .from(TABLE)
          .update({ ...patch, updated_at: stamp() })
          .eq('id', id)
          .select(PROVISION_COLUMNS)
          .single();
        if (error) throw error;
        return data as ProvisionRow;
      }
      const { data, error } = await admin
        .from(TABLE)
        .update({ ...patch, updated_at: stamp() })
        .eq('id', id)
        .eq('status', expectStatus)
        .select(PROVISION_COLUMNS);
      if (error) throw error;
      const written = ((data as ProvisionRow[] | null) ?? [])[0];
      if (written) return written;
      const current = await admin.from(TABLE).select(PROVISION_COLUMNS).eq('id', id).single();
      if (current.error) throw current.error;
      return current.data as ProvisionRow;
    },

    async claimCheck(row, nowIso) {
      let query = admin.from(TABLE).update({ last_checked_at: nowIso, updated_at: stamp() }).eq('id', row.id).eq('status', row.status);
      query = row.last_checked_at ? query.eq('last_checked_at', row.last_checked_at) : query.is('last_checked_at', null);
      const { data, error } = await query.select('id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async claimedCustomerIds() {
      const { data, error } = await admin.from(TABLE).select('customer_id').not('customer_id', 'is', null);
      if (error) throw error;
      return new Set(((data as Array<{ customer_id: string | null }> | null) ?? []).map((row) => row.customer_id).filter((id): id is string => Boolean(id)));
    },

    async listOpen(statuses, limit) {
      const { data, error } = await admin
        .from(TABLE)
        .select(PROVISION_COLUMNS)
        .in('status', statuses)
        .order('last_checked_at', { ascending: true, nullsFirst: true })
        .limit(limit);
      if (error) throw error;
      return (data as ProvisionRow[] | null) ?? [];
    },

    async failStale(cutoffIso) {
      const unconfirmed = await admin
        .from(TABLE)
        .update({ status: 'failed', error_code: 'CREATE_UNCONFIRMED', updated_at: stamp() })
        .eq('status', 'creating')
        .is('customer_id', null)
        .lt('updated_at', cutoffIso)
        .select('id');
      if (unconfirmed.error) throw unconfirmed.error;
      const unsent = await admin
        .from(TABLE)
        .update({ status: 'failed', error_code: 'INVITE_NOT_SENT', updated_at: stamp() })
        .eq('status', 'creating')
        .not('customer_id', 'is', null)
        .lt('updated_at', cutoffIso)
        .select('id');
      if (unsent.error) throw unsent.error;
      return (unconfirmed.data?.length ?? 0) + (unsent.data?.length ?? 0);
    },

    async recent(limit) {
      const { data, error } = await admin.from(TABLE).select(PROVISION_COLUMNS).order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return (data as ProvisionRow[] | null) ?? [];
    },
  };
}
