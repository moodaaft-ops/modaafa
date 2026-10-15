import { GoogleAdsRestError } from '../../lib/google-ads/client';
import type { AdsRequest, AdsTransport, ProvisioningContext } from '../../lib/google-ads/provisioning';
import type { ProvisionPatch, ProvisionStore } from '../../lib/provisioning/store';
import type { ProvisionRow, ProvisionStatus } from '../../lib/provisioning/types';

/** The dedicated manager id used by every provisioning test (never the agency's 7561141000). */
export const TEST_MCC = '1234567890';

type FakeAccount = {
  id: string;
  name: string;
  status: 'ENABLED' | 'CANCELED';
  access: string[];
  invitations: Array<{ email: string; status: 'PENDING' | 'EXPIRED' | 'DECLINED' }>;
  link: 'ACTIVE' | 'INACTIVE';
};

type Injector = { match: (request: AdsRequest) => boolean; error: unknown; executes: boolean; times: number };

/**
 * A small stateful stand-in for the parts of Google Ads that provisioning
 * talks to. It records every request, so tests can assert what was (not) sent,
 * and it answers the same GAQL the real code sends with REST-shaped rows.
 */
export class FakeGoogle {
  accounts = new Map<string, FakeAccount>();
  /** Active managers above the dedicated manager (customer_manager_link). Empty = it stands alone. */
  parents: string[] = [];
  calls: AdsRequest[] = [];
  private nextId = 5550000001;
  private injectors: Injector[] = [];

  /** Make the next matching request fail. `executes: true` = Google did the work and the answer was lost (timeout). */
  failNext(match: (request: AdsRequest) => boolean, error: unknown, options: { executes?: boolean; times?: number } = {}) {
    this.injectors.push({ match, error, executes: options.executes ?? false, times: options.times ?? 1 });
  }

  addAccount(partial: Partial<FakeAccount> & { name: string }) {
    const id = String(this.nextId++);
    const account: FakeAccount = { id, status: 'ENABLED', access: [], invitations: [], link: 'ACTIVE', ...partial };
    this.accounts.set(id, account);
    return account;
  }

  accept(customerId: string, email: string) {
    const account = this.accounts.get(customerId)!;
    account.invitations = account.invitations.filter((invitation) => invitation.email.toLowerCase() !== email.toLowerCase());
    account.access.push(email);
  }

  count(predicate: (request: AdsRequest) => boolean) {
    return this.calls.filter(predicate).length;
  }

  get creates() {
    return this.count((request) => request.path.endsWith(':createCustomerClient'));
  }
  get invites() {
    return this.count((request) => request.path.endsWith('/customerUserAccessInvitations:mutate'));
  }
  get unlinks() {
    return this.count((request) => request.path.endsWith('/customerClientLinks:mutate'));
  }

  transport: AdsTransport = async <T = any>(request: AdsRequest): Promise<T> => {
    this.calls.push(request);
    const injector = this.injectors.find((candidate) => candidate.times > 0 && candidate.match(request));
    if (injector) {
      injector.times -= 1;
      if (injector.executes) this.handle(request);
      throw injector.error;
    }
    return this.handle(request) as T;
  };

  private handle(request: AdsRequest): any {
    const body = (request.body ?? {}) as any;
    if (request.path.endsWith(':createCustomerClient')) {
      const account = this.addAccount({ name: body.customerClient.descriptiveName });
      return { resourceName: `customers/${account.id}` };
    }
    const invite = /^\/customers\/(\d+)\/customerUserAccessInvitations:mutate$/.exec(request.path);
    if (invite) {
      this.accounts.get(invite[1])!.invitations.push({ email: body.operation.create.emailAddress, status: 'PENDING' });
      return { result: { resourceName: `customers/${invite[1]}/customerUserAccessInvitations/1` } };
    }
    const link = /^\/customers\/(\d+)\/customerClientLinks:mutate$/.exec(request.path);
    if (link) {
      const resourceName: string = body.operation.update.resourceName;
      const account = [...this.accounts.values()].find((candidate) => resourceName.endsWith(`~${candidate.id}`));
      if (!account) throw new GoogleAdsRestError(400, 'no such link', ['INVALID_RESOURCE_NAME']);
      account.link = body.operation.update.status;
      return { result: { resourceName } };
    }
    const search = /^\/customers\/(\d+)\/googleAds:search$/.exec(request.path);
    if (search) return { results: this.search(search[1], String(body.query)) };
    throw new Error(`FakeGoogle: unexpected request ${request.method ?? 'GET'} ${request.path}`);
  }

  private search(customerId: string, query: string): any[] {
    if (query.includes('FROM customer_user_access_invitation')) {
      const account = this.accounts.get(customerId);
      return (account?.invitations ?? []).map((invitation) => ({
        customerUserAccessInvitation: { emailAddress: invitation.email, invitationStatus: invitation.status, accessRole: 'ADMIN' },
      }));
    }
    if (query.includes('FROM customer_user_access')) {
      const account = this.accounts.get(customerId);
      return (account?.access ?? []).map((email) => ({ customerUserAccess: { emailAddress: email, accessRole: 'ADMIN' } }));
    }
    if (query.includes('FROM customer_manager_link')) {
      return this.parents.map((id) => ({ customerManagerLink: { managerCustomer: `customers/${id}`, status: 'ACTIVE' } }));
    }
    if (query.includes('FROM customer_client_link')) {
      return [...this.accounts.values()].map((account) => ({
        customerClientLink: {
          resourceName: `customers/${TEST_MCC}/customerClientLinks/${account.id}~${account.id}`,
          status: account.link,
          clientCustomer: `customers/${account.id}`,
        },
      }));
    }
    if (query.includes('FROM customer_client')) {
      return [...this.accounts.values()].map((account) => ({
        customerClient: { id: account.id, descriptiveName: account.name, status: account.status, manager: false, level: '1' },
      }));
    }
    if (query.includes('FROM customer')) {
      return [{ customer: { id: customerId, manager: true, descriptiveName: 'Test MCC' } }];
    }
    throw new Error(`FakeGoogle: unexpected query ${query}`);
  }

  context(mccId = TEST_MCC): ProvisioningContext {
    return { mccId, transport: this.transport };
  }
}

/** An in-memory ads_account_provisions with the same guarantees the table gives (unique user, unique customer, atomic claim). */
export class MemoryStore implements ProvisionStore {
  rows = new Map<string, ProvisionRow>();
  private seq = 1;
  constructor(public now: () => Date = () => new Date()) {}

  private stamp() {
    return this.now().toISOString();
  }

  seed(partial: Partial<ProvisionRow> & { user_id: string }): ProvisionRow {
    const row: ProvisionRow = {
      id: `row-${this.seq++}`,
      invited_email: 'user@gmail.com',
      account_name: 'user',
      customer_id: null,
      status: 'creating',
      error_code: null,
      attempts: 1,
      created_at: this.stamp(),
      invited_at: null,
      accepted_at: null,
      unlinked_at: null,
      last_checked_at: null,
      updated_at: this.stamp(),
      ...partial,
    };
    this.rows.set(row.user_id, row);
    return row;
  }

  async get(userId: string) {
    const row = this.rows.get(userId);
    return row ? { ...row } : null;
  }

  async insert(input: { userId: string; invitedEmail: string; accountName: string }) {
    if (this.rows.has(input.userId)) return { conflict: true as const };
    const row = this.seed({ user_id: input.userId, invited_email: input.invitedEmail, account_name: input.accountName });
    return { row: { ...row } };
  }

  async claimRetry(row: ProvisionRow, patch: ProvisionPatch) {
    const current = this.rows.get(row.user_id);
    if (!current || current.status !== 'failed' || current.attempts !== row.attempts) return null;
    Object.assign(current, patch, { status: 'creating' as ProvisionStatus, attempts: row.attempts + 1, updated_at: this.stamp() });
    return { ...current };
  }

  async update(id: string, patch: ProvisionPatch, expectStatus?: ProvisionStatus) {
    const row = [...this.rows.values()].find((candidate) => candidate.id === id);
    if (!row) throw new Error('no such row');
    if (expectStatus && row.status !== expectStatus) return { ...row };
    if (patch.customer_id && [...this.rows.values()].some((other) => other !== row && other.customer_id === patch.customer_id)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    }
    Object.assign(row, patch, { updated_at: this.stamp() });
    return { ...row };
  }

  async claimCheck(row: ProvisionRow, nowIso: string) {
    const current = this.rows.get(row.user_id);
    if (!current || current.status !== row.status || current.last_checked_at !== row.last_checked_at) return false;
    current.last_checked_at = nowIso;
    return true;
  }

  async claimedCustomerIds() {
    return new Set([...this.rows.values()].map((row) => row.customer_id).filter((id): id is string => Boolean(id)));
  }

  async listOpen(statuses: ProvisionStatus[], limit: number) {
    return [...this.rows.values()]
      .filter((row) => statuses.includes(row.status))
      .sort((a, b) => (a.last_checked_at ?? '').localeCompare(b.last_checked_at ?? ''))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async failStale(cutoffIso: string) {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.status === 'creating' && row.updated_at < cutoffIso) {
        row.status = 'failed';
        row.error_code = row.customer_id ? 'INVITE_NOT_SENT' : 'CREATE_UNCONFIRMED';
        count += 1;
      }
    }
    return count;
  }

  async recent(limit: number) {
    return [...this.rows.values()].slice(0, limit).map((row) => ({ ...row }));
  }
}

export function restError(status: number, ...codes: string[]) {
  return new GoogleAdsRestError(status, codes.join(', ') || `HTTP ${status}`, codes);
}
