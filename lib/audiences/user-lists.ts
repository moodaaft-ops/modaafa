import type { MutateOperation } from '../growth/types';

/**
 * User lists: website visitors (rule based on the Google tag) and Customer
 * Match (CRM based, filled later through the Data Manager transport).
 *
 * Website list shape from the Google Ads API guide «Visitors to specific pages»
 * (flexible_rule_user_list, url__ rule item, prepopulation REQUESTED). The
 * operator CONTAINS on the site's host means «anyone who opened any page of the
 * site». The guide's own example uses EQUALS for one page; CONTAINS is in the
 * same enum and is the part validateOnly checks.
 */

export const USER_LIST_LIFESPAN_MAX_DAYS = 540;
export const WEBSITE_LIST_DEFAULT_DAYS = 30;
/** Past this a visitor is rarely still a prospect (titan 22.4: «فوق 90 يوم نادراً تستاهل»). */
export const WEBSITE_LIST_WARN_DAYS = 90;

export type CreateUserListParams =
  | { kind: 'website_visitors'; name: string; url_contains: string; lookback_days: number }
  | { kind: 'customer_match'; name: string; consent_confirmed: true };

export type ParamsCheck<T> = { ok: true; value: T } | { ok: false; code: string };

const clean = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '');

export function validateCreateUserListParams(raw: unknown): ParamsCheck<CreateUserListParams> {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!p) return { ok: false, code: 'params_missing' };
  const name = clean(p.name);
  if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) return { ok: false, code: 'name' };
  if (p.kind === 'website_visitors') {
    const host = clean(p.url_contains).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    if (!/^[a-z0-9]([a-z0-9.-]{1,98})[a-z0-9](\/[a-z0-9\-._~%/]*)?$/.test(host) || !host.includes('.')) return { ok: false, code: 'url_rule' };
    const days = p.lookback_days === undefined ? WEBSITE_LIST_DEFAULT_DAYS : Number(p.lookback_days);
    if (!Number.isInteger(days) || days < 1 || days > USER_LIST_LIFESPAN_MAX_DAYS) return { ok: false, code: 'lookback' };
    return { ok: true, value: { kind: 'website_visitors', name, url_contains: host, lookback_days: days } };
  }
  if (p.kind === 'customer_match') {
    // The merchant's own confirmation of their customers' consent (Saudi PDPL). Never assumed.
    if (p.consent_confirmed !== true) return { ok: false, code: 'consent_not_confirmed' };
    return { ok: true, value: { kind: 'customer_match', name, consent_confirmed: true } };
  }
  return { ok: false, code: 'kind' };
}

export function buildUserListOperation(params: CreateUserListParams): MutateOperation {
  if (params.kind === 'website_visitors') {
    return {
      user_list_operation: {
        create: {
          name: params.name,
          description: 'زوار الموقع، أنشأتها مُضاعِف',
          membership_status: 'OPEN',
          membership_life_span: params.lookback_days,
          rule_based_user_list: {
            // Include people who visited before the list existed (Google fills it from the tag's history).
            prepopulation_status: 'REQUESTED',
            flexible_rule_user_list: {
              inclusive_rule_operator: 'AND',
              inclusive_operands: [
                {
                  rule: {
                    rule_item_groups: [
                      { rule_items: [{ name: 'url__', string_rule_item: { operator: 'CONTAINS', value: params.url_contains } }] },
                    ],
                  },
                  lookback_window_days: params.lookback_days,
                },
              ],
            },
          },
        },
      },
    };
  }
  return {
    user_list_operation: {
      create: {
        name: params.name,
        description: 'قائمة عملاء الشركة، أنشأتها مُضاعِف',
        membership_status: 'OPEN',
        membership_life_span: USER_LIST_LIFESPAN_MAX_DAYS,
        crm_based_user_list: { upload_key_type: 'CONTACT_INFO', data_source_type: 'FIRST_PARTY' },
      },
    },
  };
}

export type AttachAudienceParams = { ad_group_resource: string; user_list_resource: string; mode: 'target' };

export function validateAttachAudienceParams(raw: unknown, customerId?: string | null): ParamsCheck<AttachAudienceParams> {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!p) return { ok: false, code: 'params_missing' };
  const scope = customerId ? String(customerId).replace(/\D/g, '') : '\\d+';
  if (customerId && !scope) return { ok: false, code: 'account' };
  const adGroup = String(p.ad_group_resource ?? '');
  const userList = String(p.user_list_resource ?? '');
  if (!new RegExp(`^customers/${scope}/adGroups/\\d+$`).test(adGroup)) return { ok: false, code: 'ad_group' };
  if (!new RegExp(`^customers/${scope}/userLists/\\d+$`).test(userList)) return { ok: false, code: 'user_list' };
  // Targeting only. Excluding a list is part of the Demand Gen launch plan, not a separate card.
  if (p.mode !== undefined && p.mode !== 'target') return { ok: false, code: 'mode' };
  return { ok: true, value: { ad_group_resource: adGroup, user_list_resource: userList, mode: 'target' } };
}

export function buildAttachAudienceOperations(params: AttachAudienceParams, customerId: string, audienceName: string): MutateOperation[] {
  const temp = `customers/${customerId.replace(/\D/g, '')}/audiences/-1`;
  return [
    {
      audience_operation: {
        create: {
          resource_name: temp,
          name: audienceName,
          dimensions: [{ audience_segments: { segments: [{ user_list: { user_list: params.user_list_resource } }] } }],
        },
      },
    },
    { ad_group_criterion_operation: { create: { ad_group: params.ad_group_resource, audience: { audience: temp } } } },
  ];
}
