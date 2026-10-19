import { LEAD_ACTION_PRIMARY_MIN_30D, LEAD_CONVERSION_ACTION_NAME } from './goals';

/**
 * The conversion action that carries the merchant's real customers
 * ("مُضاعِف | زبون فعلي", type UPLOAD_CLICKS), plus the approved operations
 * around it. Both operations go through the normal approval card, validateOnly,
 * readback and rollback:
 *
 *  - create_lead_conversion_action  creates it as SECONDARY (no change to bidding)
 *  - set_conversion_primary         makes it primary and demotes WhatsApp click
 *                                   actions in the same atomic mutate
 */
export const CREATE_LEAD_ACTION_OPERATION = 'create_lead_conversion_action';
export const SET_PRIMARY_OPERATION = 'set_conversion_primary';
export const MAX_DEMOTIONS = 3;
export { LEAD_ACTION_PRIMARY_MIN_30D, LEAD_CONVERSION_ACTION_NAME };

/** Same shape check as executable-action's validGoogleAdsResource (kept local: that file imports this one). */
function validResource(value: string, type: string, customerId?: string | null) {
  const customer = customerId ? customerId.replace(/\D/g, '') : '\\d+';
  if (customerId && !customer) return false;
  return new RegExp(`^customers/${customer}/${type}/[^/]+$`).test(value);
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** GAQL that finds the lead action by name, any state but removed. */
export function findLeadActionQuery() {
  return `
    SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status,
      conversion_action.type, conversion_action.primary_for_goal
    FROM conversion_action
    WHERE conversion_action.name = '${escapeGaql(LEAD_CONVERSION_ACTION_NAME)}'
      AND conversion_action.status != 'REMOVED'
    LIMIT 5
  `;
}

export type FoundLeadAction = {
  resourceName: string;
  status: string;
  type: string;
  primaryForGoal: boolean | null;
};

export function parseFoundLeadAction(rows: any[] | null | undefined): FoundLeadAction | null {
  for (const row of rows ?? []) {
    const action = row?.conversionAction ?? row?.conversion_action;
    const resourceName = String(action?.resourceName ?? action?.resource_name ?? '');
    const type = String(action?.type ?? '');
    if (!resourceName || (type && type !== 'UPLOAD_CLICKS')) continue;
    return {
      resourceName,
      status: String(action?.status ?? ''),
      type: type || 'UPLOAD_CLICKS',
      primaryForGoal: typeof (action?.primaryForGoal ?? action?.primary_for_goal) === 'boolean'
        ? Boolean(action?.primaryForGoal ?? action?.primary_for_goal)
        : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// create_lead_conversion_action
// ---------------------------------------------------------------------------

export function validateCreateLeadActionParams(params: unknown): { ok: true; currency_code: string } | { ok: false } {
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const currency = typeof p.currency_code === 'string' ? p.currency_code.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false };
  if (p.name !== undefined && p.name !== LEAD_CONVERSION_ACTION_NAME) return { ok: false };
  return { ok: true, currency_code: currency };
}

/**
 * Body of the ConversionAction create. Created as SECONDARY (primary_for_goal
 * false) so it can collect uploads without changing what bidding optimises
 * for; promoting it is a separate approved step once it has volume. Category
 * CONVERTED_LEAD and the 90 day click window match an offline import; both are
 * checked by Google on the validateOnly pass before anything is created.
 */
export function buildLeadConversionActionCreate(currencyCode: string) {
  return {
    name: LEAD_CONVERSION_ACTION_NAME,
    type: 'UPLOAD_CLICKS',
    category: 'CONVERTED_LEAD',
    status: 'ENABLED',
    primary_for_goal: false,
    counting_type: 'ONE_PER_CLICK',
    click_through_lookback_window_days: 90,
    value_settings: {
      default_value: 0,
      default_currency_code: currencyCode,
      always_use_default_value: false,
    },
  };
}

// ---------------------------------------------------------------------------
// set_conversion_primary
// ---------------------------------------------------------------------------

export type SetPrimaryParams = {
  conversion_action_resource: string;
  demote_resources: string[];
};

export function validateSetPrimaryParams(
  params: unknown,
  customerId?: string | null
): { ok: true; value: SetPrimaryParams } | { ok: false } {
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const target = String(p.conversion_action_resource ?? '');
  if (!validResource(target, 'conversionActions', customerId)) return { ok: false };
  const demote = p.demote_resources === undefined ? [] : p.demote_resources;
  if (!Array.isArray(demote) || demote.length > MAX_DEMOTIONS) return { ok: false };
  for (const item of demote) {
    if (typeof item !== 'string' || !validResource(item, 'conversionActions', customerId) || item === target) {
      return { ok: false };
    }
  }
  return { ok: true, value: { conversion_action_resource: target, demote_resources: [...new Set(demote as string[])] } };
}

/** Update items for one atomic mutate: the lead action up, the click actions down. */
export function buildSetPrimaryItems(value: SetPrimaryParams) {
  return [
    { resource_name: value.conversion_action_resource, primary_for_goal: true },
    ...value.demote_resources.map((resource) => ({ resource_name: resource, primary_for_goal: false })),
  ];
}
