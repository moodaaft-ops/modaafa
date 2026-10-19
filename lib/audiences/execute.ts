import { escapeGaql, resourceNamesFromMutate } from '../launch/execute';
import { pickNum, pickStr, type GrowthCustomer } from '../growth/types';
import { COMFORTABLE_AUDIENCE_SIZE, MIN_AUDIENCE_SIZE } from '../demand-gen/execute';
import {
  buildAttachAudienceOperations,
  buildUserListOperation,
  validateAttachAudienceParams,
  validateCreateUserListParams,
  type AttachAudienceParams,
  type CreateUserListParams,
} from './user-lists';

/**
 * Executors for the two audience cards.
 *
 *  create_user_list   creates a website-visitors list or an (empty) Customer Match list.
 *                     Undo closes the list: Google does not delete user lists.
 *  attach_audience    wraps a ready user list in an Audience resource and attaches it to a
 *                     Demand Gen ad group. Undo removes the ad group criterion.
 *
 * Both validateOnly first, then one atomic mutate, then a readback.
 */

export const CLOSE_USER_LIST_ROLLBACK = 'growth_close_user_list';
export const REMOVE_AUDIENCE_CRITERION_ROLLBACK = 'growth_remove_audience_criterion';

const UL = /^customers\/\d+\/userLists\/\d+$/;
const AGC = /^customers\/\d+\/adGroupCriteria\/\d+~\d+$/;

export type Readback = { ok: boolean; mismatches: string[] };

async function existingListByName(customer: GrowthCustomer, name: string) {
  const rows = await customer.query(
    `SELECT user_list.resource_name FROM user_list WHERE user_list.name = '${escapeGaql(name)}' AND user_list.membership_status != 'CLOSED' LIMIT 1`
  );
  return rows[0] ? pickStr(rows[0], 'user_list.resource_name') : '';
}

export async function validateCreateUserList(rawParams: unknown, customer: GrowthCustomer) {
  const checked = validateCreateUserListParams(rawParams);
  if (!checked.ok) throw new Error(`User list is malformed (${checked.code})`);
  if (await existingListByName(customer, checked.value.name)) {
    throw new Error('A user list with this name already exists in the account; nothing to create.');
  }
  await customer.mutateOperations([buildUserListOperation(checked.value)], { validateOnly: true });
  return { validate_only: 'passed' as const, kind: checked.value.kind };
}

export async function executeCreateUserList(rawParams: unknown, customer: GrowthCustomer, customerId: string) {
  const checked = validateCreateUserListParams(rawParams);
  if (!checked.ok) throw new Error(`User list is malformed (${checked.code})`);
  const params: CreateUserListParams = checked.value;
  if (await existingListByName(customer, params.name)) {
    throw new Error('A user list with this name already exists in the account; nothing to create.');
  }
  const operations = [buildUserListOperation(params)];
  await customer.mutateOperations(operations, { validateOnly: true });
  const result = await customer.mutateOperations(operations);
  const [resource] = resourceNamesFromMutate(result, 1);
  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  if (!resource || !UL.test(resource) || !resource.startsWith(prefix)) {
    throw new Error('Google Ads did not return the created user list name.');
  }
  let readback: Readback;
  try {
    const rows = await customer.query(
      `SELECT user_list.resource_name, user_list.name, user_list.membership_status, user_list.type FROM user_list WHERE user_list.resource_name = '${escapeGaql(resource)}' LIMIT 1`
    );
    const mismatches: string[] = [];
    if (!rows[0]) mismatches.push('list_missing');
    else {
      if (pickStr(rows[0], 'user_list.name') !== params.name) mismatches.push('name');
      if (pickStr(rows[0], 'user_list.membership_status') !== 'OPEN') mismatches.push('status');
    }
    readback = { ok: mismatches.length === 0, mismatches };
  } catch {
    readback = { ok: false, mismatches: ['readback_failed'] };
  }
  return {
    user_list_resource: resource,
    kind: params.kind,
    name: params.name,
    validate_only: 'passed' as const,
    readback,
    rollback_payload: {
      reversible: true,
      action_type: CLOSE_USER_LIST_ROLLBACK,
      user_list_resource: resource,
      resource_names: [resource],
    },
  };
}

async function readAttachPreflight(params: AttachAudienceParams, customer: GrowthCustomer) {
  const groupRows = await customer.query(
    `SELECT ad_group.resource_name, ad_group.status, ad_group.audience_setting.use_audience_grouped, campaign.advertising_channel_type FROM ad_group WHERE ad_group.resource_name = '${escapeGaql(params.ad_group_resource)}' LIMIT 1`
  );
  const group = groupRows[0];
  if (!group) throw new Error('The ad group was not found.');
  if (pickStr(group, 'campaign.advertising_channel_type') !== 'DEMAND_GEN') throw new Error('Audiences are attached to Demand Gen ad groups only.');
  if (pickStr(group, 'ad_group.status') === 'REMOVED') throw new Error('The ad group is removed.');
  const grouped = (group as any)?.adGroup?.audienceSetting?.useAudienceGrouped ?? (group as any)?.ad_group?.audience_setting?.use_audience_grouped;
  if (grouped !== true) throw new Error('This ad group does not use grouped audiences, so a user list cannot be attached.');

  const listRows = await customer.query(
    `SELECT user_list.resource_name, user_list.membership_status, user_list.size_for_display FROM user_list WHERE user_list.resource_name = '${escapeGaql(params.user_list_resource)}' LIMIT 1`
  );
  const list = listRows[0];
  if (!list || pickStr(list, 'user_list.membership_status') !== 'OPEN') throw new Error('The user list is missing or closed.');
  const size = pickNum(list, 'user_list.size_for_display');
  if (size === null || size < MIN_AUDIENCE_SIZE) {
    throw new Error(`The user list has fewer than ${MIN_AUDIENCE_SIZE} members; Google will not serve it yet.`);
  }
  return { size, comfortable: size >= COMFORTABLE_AUDIENCE_SIZE };
}

export async function validateAttachAudience(rawParams: unknown, customer: GrowthCustomer, customerId: string, nonce: () => string) {
  const checked = validateAttachAudienceParams(rawParams, customerId);
  if (!checked.ok) throw new Error(`Audience attach is malformed (${checked.code})`);
  const pre = await readAttachPreflight(checked.value, customer);
  await customer.mutateOperations(buildAttachAudienceOperations(checked.value, customerId, `جمهور مُضاعِف ${nonce()}`), { validateOnly: true });
  return { validate_only: 'passed' as const, list_size: pre.size };
}

export async function executeAttachAudience(rawParams: unknown, customer: GrowthCustomer, customerId: string, nonce: () => string) {
  const checked = validateAttachAudienceParams(rawParams, customerId);
  if (!checked.ok) throw new Error(`Audience attach is malformed (${checked.code})`);
  const pre = await readAttachPreflight(checked.value, customer);
  const operations = buildAttachAudienceOperations(checked.value, customerId, `جمهور مُضاعِف ${nonce()}`);
  await customer.mutateOperations(operations, { validateOnly: true });
  const result = await customer.mutateOperations(operations);
  const [audience, criterion] = resourceNamesFromMutate(result, 2);
  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  if (!criterion || !AGC.test(criterion) || !criterion.startsWith(prefix)) {
    throw new Error('Google Ads did not return the created audience criterion name.');
  }
  let readback: Readback;
  try {
    const rows = await customer.query(
      `SELECT ad_group_criterion.resource_name, ad_group_criterion.type FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '${escapeGaql(criterion)}' LIMIT 1`
    );
    readback = rows[0] && pickStr(rows[0], 'ad_group_criterion.type') === 'AUDIENCE'
      ? { ok: true, mismatches: [] }
      : { ok: false, mismatches: ['criterion_missing'] };
  } catch {
    readback = { ok: false, mismatches: ['readback_failed'] };
  }
  return {
    audience_resource: audience ?? null,
    criterion_resource: criterion,
    list_size: pre.size,
    validate_only: 'passed' as const,
    readback,
    rollback_payload: {
      reversible: true,
      action_type: REMOVE_AUDIENCE_CRITERION_ROLLBACK,
      criterion_resource: criterion,
      resource_names: [criterion],
      retained_resources: audience ? [audience] : [],
    },
  };
}

export async function executeAudienceRollback(rollback: Record<string, any>, customer: GrowthCustomer, options?: { validateOnly?: boolean }) {
  if (rollback.action_type === CLOSE_USER_LIST_ROLLBACK) {
    const list = String(rollback.user_list_resource ?? '');
    if (!UL.test(list)) throw new Error('User list rollback descriptor is malformed.');
    return customer.mutateOperations(
      [{ user_list_operation: { update: { resource_name: list, membership_status: 'CLOSED' }, update_mask: 'membership_status' } }],
      options
    );
  }
  if (rollback.action_type === REMOVE_AUDIENCE_CRITERION_ROLLBACK) {
    const criterion = String(rollback.criterion_resource ?? '');
    if (!AGC.test(criterion)) throw new Error('Audience rollback descriptor is malformed.');
    return customer.mutateOperations([{ ad_group_criterion_operation: { remove: criterion } }], options);
  }
  throw new Error('This action does not have a supported rollback operation');
}
