import { runMatchUpload } from '../audiences/match-action';
import { randomUUID } from 'node:crypto';
import { isAmbiguousGoogleAdsMutationError } from '../ai/execution-preflight';
import { growthOperationEnabled, isGrowthOperation } from './flags';
import type { GrowthCustomer } from './types';
import { validateStoredDemandGenPlan } from '../demand-gen/validate';
import { executeDemandGen, validateDemandGenOnly, DEMAND_GEN_ROLLBACK_ACTION } from '../demand-gen/execute';
import { executeLaunchRollback, type LaunchCustomer } from '../launch/execute';
import {
  CLOSE_USER_LIST_ROLLBACK,
  REMOVE_AUDIENCE_CRITERION_ROLLBACK,
  executeAttachAudience,
  executeAudienceRollback,
  executeCreateUserList,
  validateAttachAudience,
  validateCreateUserList,
} from '../audiences/execute';
import {
  END_EXPERIMENT_ROLLBACK,
  executeCreateExperiment,
  executeEndExperiment,
  executeExperimentRollback,
  executePromoteExperiment,
  validateCreateExperiment,
  validateEndExperiment,
  validatePromoteExperiment,
} from '../experiments/execute';
import { executeCreateImageAssets, validateCreateImageAssets } from '../image-assets/execute';

const nonce = () => randomUUID().replace(/-/g, '').slice(0, 8);

async function imageDeps() {
  const [{ systemResolver, pinnedHttpsTransport }] = await Promise.all([import('../landing-check/transport')]);
  return { resolve: systemResolver, transport: pinnedHttpsTransport, fetchStored: async (path: string) => {
    if (process.env.IMAGE_DEVICE_UPLOAD_ENABLED !== 'true') throw new Error('Device image upload is disabled');
    const { createAdminClient } = await import('../supabase/server');
    const { data, error } = await createAdminClient().storage.from('merchant-images').download(path);
    if (error || !data) throw new Error('Private image unavailable');
    return new Uint8Array(await data.arrayBuffer());
  } };
}

/**
 * Entry the shared executor calls for a growth action. Re-checks the flag on every call:
 * a card read back from the database is data, and a flag turned off after approval stops the action.
 */
export async function runGrowthAction(
  type: string,
  params: Record<string, unknown>,
  customer: unknown,
  options?: { validateOnly?: boolean }
) {
  if (!isGrowthOperation(type) || !growthOperationEnabled(type)) throw new Error('This growth operation is disabled.');
  const customerId = String(params?.customer_id ?? '').replace(/\D/g, '');
  if (!customerId) throw new Error('Growth action carries no account id.');
  const client = customer as GrowthCustomer;
  const validateOnly = Boolean(options?.validateOnly);

  switch (type) {
    case 'launch_demand_gen': {
      const checked = validateStoredDemandGenPlan(params.plan, customerId);
      if (!checked.ok) throw new Error(`Demand Gen plan rejected: ${checked.reason}`);
      if (validateOnly) return validateDemandGenOnly(checked.plan, client, customerId, { nonce });
      return executeDemandGen(checked.plan, client, customerId, { nonce, isAmbiguous: isAmbiguousGoogleAdsMutationError });
    }
    case 'upload_customer_match': return runMatchUpload(params, client, validateOnly);
    case 'create_user_list':
      return validateOnly ? validateCreateUserList(params, client) : executeCreateUserList(params, client, customerId);
    case 'attach_audience':
      return validateOnly ? validateAttachAudience(params, client, customerId, nonce) : executeAttachAudience(params, client, customerId, nonce);
    case 'create_experiment':
      return validateOnly
        ? validateCreateExperiment(params.plan, client, customerId, { nonce })
        : executeCreateExperiment(params.plan, client, customerId, { nonce });
    case 'end_experiment':
      return validateOnly ? validateEndExperiment(params, client, customerId) : executeEndExperiment(params, client, customerId);
    case 'promote_experiment':
      return validateOnly ? validatePromoteExperiment(params, client, customerId) : executePromoteExperiment(params, client, customerId);
    case 'create_image_assets': {
      const deps = await imageDeps();
      return validateOnly ? validateCreateImageAssets(params, client, deps) : executeCreateImageAssets(params, client, customerId, deps);
    }
  }
  throw new Error('This growth operation is disabled.');
}

/** Undo dispatch for rollback payloads whose action_type starts with growth_. */
export async function executeGrowthRollback(rollback: Record<string, any>, client: unknown, options?: { validateOnly?: boolean }) {
  switch (rollback.action_type) {
    case DEMAND_GEN_ROLLBACK_ACTION:
      // Same removal order and the same «refuses while enabled» rule as the Search launcher.
      return executeLaunchRollback(rollback, client as LaunchCustomer, options);
    case CLOSE_USER_LIST_ROLLBACK:
    case REMOVE_AUDIENCE_CRITERION_ROLLBACK:
      return executeAudienceRollback(rollback, client as GrowthCustomer, options);
    case END_EXPERIMENT_ROLLBACK:
      return executeExperimentRollback(rollback, client as GrowthCustomer, options);
    default:
      throw new Error('This action does not have a supported rollback operation');
  }
}
