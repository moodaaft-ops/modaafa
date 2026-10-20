import { randomUUID } from 'node:crypto';
import { isAmbiguousGoogleAdsMutationError } from '../ai/execution-preflight';
import { campaignLaunchEnabled } from './flag';
import { executeLaunch, validateLaunchOnly, type LaunchCustomer } from './execute';
import { validateStoredPlan } from './validate';

/**
 * The entry the shared action executor calls for a `launch_campaign` action.
 * It re-checks the flag and the stored plan on every call: a plan read back
 * from the database is data, and a flag turned off after approval must stop
 * the build.
 */
export async function runLaunchAction(
  params: Record<string, unknown>,
  customer: unknown,
  options?: { validateOnly?: boolean }
) {
  if (!campaignLaunchEnabled()) throw new Error('Campaign launch is disabled.');
  const checked = validateStoredPlan(params?.plan);
  if (!checked.ok) throw new Error(`Launch plan rejected: ${checked.reason}`);
  const customerId = String(params?.customer_id ?? '').replace(/\D/g, '');
  if (!customerId) throw new Error('Launch action carries no account id.');
  const nonce = () => randomUUID().replace(/-/g, '').slice(0, 8);
  const client = customer as LaunchCustomer;
  if (options?.validateOnly) return validateLaunchOnly(checked.plan, client, customerId, { nonce });
  return executeLaunch(checked.plan, client, customerId, { nonce, isAmbiguous: isAmbiguousGoogleAdsMutationError });
}
