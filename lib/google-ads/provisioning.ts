import { normalizeTrialEmail } from '@/lib/billing/trial-identity';
import { GoogleAdsRestError, getGoogleAdsErrorCodes, googleAdsRest } from './client';

/**
 * Google Ads calls behind «افتحه لي» (plan 121, section 2.4): create a client
 * account under the dedicated manager account, invite the user's email as
 * admin, follow the invitation, and (behind a flag) release the account.
 *
 * Every function takes a context with the transport, so tests run without
 * Google. The real transport is googleAdsRest with the manager's refresh token.
 * Every request goes out with `login-customer-id` = the dedicated manager id.
 *
 * Two rules that exist because of what Google does:
 * - the invitation is ALWAYS a second request: passing the email inside the
 *   create request returns CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE;
 * - creating is NEVER retried by the request layer (maxAttempts: 1), because a
 *   timeout after Google already made the account would otherwise make a second.
 */

export type AdsRequest = {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  loginCustomerId?: string | null;
  maxAttempts?: number;
};
export type AdsTransport = <T = any>(request: AdsRequest) => Promise<T>;

export type ProvisioningContext = {
  /** The dedicated manager account, 10 digits. Never the agency manager. */
  mccId: string;
  transport: AdsTransport;
};

export function transportFromRefreshToken(refreshToken: string): AdsTransport {
  return <T>(request: AdsRequest) => googleAdsRest<T>({ refreshToken, ...request });
}

/** A failure with a short stable code for the row, and whether Google may have acted anyway. */
export class ProvisioningError extends Error {
  code: string;
  /** True when the request may have reached Google and done its work (timeout, 5xx, dropped socket). */
  ambiguous: boolean;

  constructor(code: string, message?: string, ambiguous = false) {
    super(message ?? code);
    this.name = 'ProvisioningError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

/** The first Google error code, else the HTTP status, else a generic marker. At most 80 characters. */
export function provisioningErrorCode(error: unknown) {
  if (error instanceof ProvisioningError) return error.code.slice(0, 80);
  if (error instanceof GoogleAdsRestError) {
    return (error.codes[0] ?? `HTTP_${error.status}`).slice(0, 80);
  }
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'REQUEST_TIMEOUT';
  const known = getGoogleAdsErrorCodes(error);
  return (known[0] ?? 'UNKNOWN').slice(0, 80);
}

/**
 * Could the request have been executed by Google even though we got an error?
 * Only a definite refusal (a 4xx answer from Google) says no. A 5xx, a timeout, a
 * dropped socket, an answer we could not read, or anything unexpected may have
 * come after Google did the work, so the caller must look before it tries again.
 */
export function isAmbiguousFailure(error: unknown) {
  if (error instanceof ProvisioningError) return error.ambiguous;
  if (error instanceof GoogleAdsRestError) return error.status >= 500 || error.status < 400 || error.status === 408;
  return true;
}

function assertDedicatedMcc(mccId: string) {
  if (!/^\d{10}$/.test(mccId)) throw new ProvisioningError('MCC_NOT_CONFIGURED');
}

function assertCustomerId(customerId: string) {
  if (!/^\d{3,20}$/.test(customerId)) throw new ProvisioningError('BAD_CUSTOMER_ID');
}

export function parseCustomerId(resourceName: unknown) {
  const match = typeof resourceName === 'string' ? /customers\/(\d{3,20})/.exec(resourceName) : null;
  return match ? match[1] : null;
}

/** A field from a REST row, whichever spelling Google used. */
function field(row: any, resource: string, camel: string, snake: string) {
  const camelResource = resource.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
  const node = row?.[camelResource] ?? row?.[resource] ?? {};
  return node?.[camel] ?? node?.[snake];
}

async function searchRows(ctx: ProvisioningContext, customerId: string, query: string): Promise<any[]> {
  const rows: any[] = [];
  let pageToken: string | undefined;
  do {
    const data = await ctx.transport<{ results?: any[]; nextPageToken?: string }>({
      path: `/customers/${customerId}/googleAds:search`,
      method: 'POST',
      loginCustomerId: ctx.mccId,
      body: { query, ...(pageToken ? { pageToken } : {}) },
    });
    rows.push(...(data.results ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return rows;
}

/** Is `mccId` a manager account this token can act on? Used when the operator connects the token. */
export async function verifyManagerAccess(ctx: ProvisioningContext) {
  assertDedicatedMcc(ctx.mccId);
  const rows = await searchRows(ctx, ctx.mccId, 'SELECT customer.id, customer.manager, customer.descriptive_name FROM customer');
  const row = rows[0];
  return {
    manager: field(row, 'customer', 'manager', 'manager') === true,
    name: (field(row, 'customer', 'descriptiveName', 'descriptive_name') as string | undefined) ?? null,
  };
}

/**
 * The managers this manager sits under. The dedicated manager must stand alone:
 * if the agency manager (or any active parent) is above it, the accounts created
 * here would show up under the agency. Best effort: a failed read returns null
 * (unknown), it never blocks on its own.
 */
export async function activeParentManagers(ctx: ProvisioningContext): Promise<string[] | null> {
  assertDedicatedMcc(ctx.mccId);
  try {
    const rows = await searchRows(
      ctx,
      ctx.mccId,
      'SELECT customer_manager_link.manager_customer, customer_manager_link.status FROM customer_manager_link'
    );
    return rows
      .filter((row) => String(field(row, 'customer_manager_link', 'status', 'status')).toUpperCase() === 'ACTIVE')
      .map((row) => parseCustomerId(field(row, 'customer_manager_link', 'managerCustomer', 'manager_customer')))
      .filter((id): id is string => Boolean(id));
  } catch {
    return null;
  }
}

/**
 * Create a client account under the dedicated manager. One attempt only.
 * Throws a ProvisioningError whose `ambiguous` says whether the account may
 * exist anyway (then the caller must look for it before creating again).
 */
export async function createClientAccount(ctx: ProvisioningContext, name: string) {
  assertDedicatedMcc(ctx.mccId);
  const descriptiveName = name.trim().slice(0, 80);
  if (!descriptiveName) throw new ProvisioningError('BAD_ACCOUNT_NAME');

  let response: { resourceName?: string };
  try {
    response = await ctx.transport<{ resourceName?: string }>({
      path: `/customers/${ctx.mccId}:createCustomerClient`,
      method: 'POST',
      loginCustomerId: ctx.mccId,
      maxAttempts: 1,
      body: { customerClient: { descriptiveName, currencyCode: 'SAR', timeZone: 'Asia/Riyadh' } },
    });
  } catch (error) {
    throw new ProvisioningError(provisioningErrorCode(error), error instanceof Error ? error.message : undefined, isAmbiguousFailure(error));
  }

  const customerId = parseCustomerId(response?.resourceName);
  // Google answered OK but without an id: the account most likely exists.
  if (!customerId) throw new ProvisioningError('CREATE_NO_ID', 'createCustomerClient returned no customer id', true);
  return { customerId };
}

/** Invite `email` as admin of the new account. Its own request, never merged into the create. */
export async function inviteAdmin(ctx: ProvisioningContext, customerId: string, email: string) {
  assertDedicatedMcc(ctx.mccId);
  assertCustomerId(customerId);
  try {
    await ctx.transport({
      path: `/customers/${customerId}/customerUserAccessInvitations:mutate`,
      method: 'POST',
      loginCustomerId: ctx.mccId,
      body: { operation: { create: { emailAddress: email.trim(), accessRole: 'ADMIN' } } },
    });
  } catch (error) {
    throw new ProvisioningError(provisioningErrorCode(error), error instanceof Error ? error.message : undefined, isAmbiguousFailure(error));
  }
}

export type InviteState = 'accepted' | 'pending' | 'expired' | 'declined' | 'unknown';

const ACCESS_QUERY =
  'SELECT customer_user_access.email_address, customer_user_access.access_role FROM customer_user_access';
const INVITATION_QUERY =
  'SELECT customer_user_access_invitation.email_address, customer_user_access_invitation.invitation_status, customer_user_access_invitation.access_role FROM customer_user_access_invitation';

function sameEmail(a: unknown, b: unknown) {
  return typeof a === 'string' && typeof b === 'string' && normalizeTrialEmail(a) === normalizeTrialEmail(b);
}

/**
 * Where the invitation stands. Acceptance shows up as a row in
 * customer_user_access (the invitation row disappears: customer_user_access_invitation
 * only ever lists PENDING and EXPIRED, seen live on 15 Oct 2026). `unknown`
 * means neither table mentions the email: not yet visible, or cancelled by hand.
 */
export async function checkInvite(ctx: ProvisioningContext, customerId: string, email: string): Promise<InviteState> {
  assertDedicatedMcc(ctx.mccId);
  assertCustomerId(customerId);

  const access = await searchRows(ctx, customerId, ACCESS_QUERY);
  if (access.some((row) => sameEmail(field(row, 'customer_user_access', 'emailAddress', 'email_address'), email))) {
    return 'accepted';
  }

  const invitations = await searchRows(ctx, customerId, INVITATION_QUERY);
  const mine = invitations.find((row) =>
    sameEmail(field(row, 'customer_user_access_invitation', 'emailAddress', 'email_address'), email)
  );
  if (!mine) return 'unknown';
  const status = String(field(mine, 'customer_user_access_invitation', 'invitationStatus', 'invitation_status') ?? '').toUpperCase();
  if (status === 'PENDING') return 'pending';
  if (status === 'EXPIRED') return 'expired';
  if (status === 'DECLINED') return 'declined';
  return 'unknown';
}

export type UnlinkResult = 'unlinked' | 'already_unlinked';

/**
 * Release the account from the dedicated manager: the link goes INACTIVE and
 * the account becomes the customer's own, freeing a slot under the ceiling.
 * The caller decides WHEN (flag on, invitation accepted, re-checked live);
 * this only refuses what can never be right.
 */
export async function unlinkClient(ctx: ProvisioningContext, customerId: string): Promise<UnlinkResult> {
  assertDedicatedMcc(ctx.mccId);
  assertCustomerId(customerId);

  const links = await searchRows(
    ctx,
    ctx.mccId,
    `SELECT customer_client_link.resource_name, customer_client_link.status, customer_client_link.client_customer FROM customer_client_link WHERE customer_client_link.client_customer = 'customers/${customerId}'`
  );
  const own = links.filter(
    (row) => field(row, 'customer_client_link', 'clientCustomer', 'client_customer') === `customers/${customerId}`
  );
  if (own.length === 0) throw new ProvisioningError('LINK_NOT_FOUND');

  const active = own.find((row) => String(field(row, 'customer_client_link', 'status', 'status')).toUpperCase() === 'ACTIVE');
  if (!active) return 'already_unlinked';

  const resourceName = field(active, 'customer_client_link', 'resourceName', 'resource_name');
  if (typeof resourceName !== 'string' || !resourceName.startsWith(`customers/${ctx.mccId}/customerClientLinks/`)) {
    throw new ProvisioningError('LINK_RESOURCE_MISMATCH');
  }

  try {
    await ctx.transport({
      path: `/customers/${ctx.mccId}/customerClientLinks:mutate`,
      method: 'POST',
      loginCustomerId: ctx.mccId,
      body: { operation: { updateMask: 'status', update: { resourceName, status: 'INACTIVE' } } },
    });
  } catch (error) {
    throw new ProvisioningError(provisioningErrorCode(error), error instanceof Error ? error.message : undefined, false);
  }
  return 'unlinked';
}

export type ActiveClients = {
  /** Accounts that count against the ceiling: everything not canceled or closed. */
  active: number;
  byStatus: Record<string, number>;
};

/** How many client accounts sit under the dedicated manager now (the ceiling is 50 with no spend). */
export async function countActiveClients(ctx: ProvisioningContext): Promise<ActiveClients> {
  assertDedicatedMcc(ctx.mccId);
  const rows = await searchRows(
    ctx,
    ctx.mccId,
    'SELECT customer_client.id, customer_client.status, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1'
  );
  const byStatus: Record<string, number> = {};
  let active = 0;
  for (const row of rows) {
    if (field(row, 'customer_client', 'manager', 'manager') === true) continue;
    const status = String(field(row, 'customer_client', 'status', 'status') ?? 'UNKNOWN').toUpperCase();
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status !== 'CANCELED' && status !== 'CLOSED') active += 1;
  }
  return { active, byStatus };
}

/**
 * After a create that may or may not have happened: is there an account under
 * the manager with this exact name that nobody has claimed and nobody has been
 * invited to? Returns its id only when exactly one account qualifies. Anything
 * less certain returns null and the caller creates a fresh account (an extra
 * slot is the cheaper mistake; handing one user another user's account is not).
 */
export async function findUnclaimedAccount(
  ctx: ProvisioningContext,
  name: string,
  claimedCustomerIds: ReadonlySet<string>
): Promise<string | null> {
  assertDedicatedMcc(ctx.mccId);
  const rows = await searchRows(
    ctx,
    ctx.mccId,
    'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1'
  );
  const candidates = rows
    .filter((row) => field(row, 'customer_client', 'manager', 'manager') !== true)
    .filter((row) => String(field(row, 'customer_client', 'status', 'status')).toUpperCase() === 'ENABLED')
    .filter((row) => field(row, 'customer_client', 'descriptiveName', 'descriptive_name') === name)
    .map((row) => String(field(row, 'customer_client', 'id', 'id')))
    .filter((id) => /^\d{3,20}$/.test(id) && !claimedCustomerIds.has(id));
  if (candidates.length !== 1) return null;

  const [candidate] = candidates;
  const [access, invitations] = await Promise.all([
    searchRows(ctx, candidate, ACCESS_QUERY),
    searchRows(ctx, candidate, INVITATION_QUERY),
  ]);
  return access.length === 0 && invitations.length === 0 ? candidate : null;
}
