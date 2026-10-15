export const PROVISION_STATUSES = ['creating', 'invited', 'accepted', 'unlinked', 'expired', 'failed'] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

/** A row of ads_account_provisions as the service reads it. */
export type ProvisionRow = {
  id: string;
  user_id: string;
  invited_email: string;
  account_name: string;
  customer_id: string | null;
  status: ProvisionStatus;
  error_code: string | null;
  attempts: number;
  created_at: string;
  invited_at: string | null;
  accepted_at: string | null;
  unlinked_at: string | null;
  last_checked_at: string | null;
  updated_at: string;
};

export const PROVISION_COLUMNS =
  'id, user_id, invited_email, account_name, customer_id, status, error_code, attempts, created_at, invited_at, accepted_at, unlinked_at, last_checked_at, updated_at';

/**
 * What the browser gets. No customer id, no error detail: the screen needs the
 * state and the email the invitation went to, nothing else.
 */
export type ProvisionView = {
  status: ProvisionStatus;
  invitedEmail: string;
  /** True when pressing the button again is allowed (a failed row that holds no account yet or still needs its invite). */
  canRetry: boolean;
};

export function provisionView(row: ProvisionRow): ProvisionView {
  return { status: row.status, invitedEmail: row.invited_email, canRetry: row.status === 'failed' };
}

/** What a page or a screen is told once it asks «is the button available to this user?». */
export type ProvisioningInitial = {
  available: boolean;
  view: ProvisionView | null;
};

export const PROVISIONING_UNAVAILABLE: ProvisioningInitial = { available: false, view: null };
