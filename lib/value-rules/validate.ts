import { resourceInAccount } from '@/lib/ai/extended-actions/validate';
import {
  MAX_AUDIENCES_PER_RULE,
  MAX_GEO_PER_RULE,
  MAX_RULES_PER_SET,
  VALUE_MULTIPLIER_MAX,
  VALUE_MULTIPLIER_MIN,
  VALUE_RULE_DEVICES,
  VALUE_RULE_DIMENSIONS,
  VALUE_RULE_GEO_MATCH,
  VALUE_RULE_STATUSES,
  type ValueRuleDimension,
  type ValueRuleOperation,
} from './types';

/**
 * Pure payload validators for the value rule actions. Same contract as
 * validateExtendedPayload: a canonical `target_id` and whitelisted `params`, or
 * a short code. Nothing here talks to Google.
 */
export type ValueRuleValidation =
  | { ok: true; target_id: string; params: Record<string, unknown> }
  | { ok: false; code: string };

const bad = (code: string): ValueRuleValidation => ({ ok: false, code });

const GEO_CONSTANT = /^geoTargetConstants\/\d{1,12}$/;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

export function cleanMultiplier(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(n)) return null;
  if (n === 1 || n < VALUE_MULTIPLIER_MIN || n > VALUE_MULTIPLIER_MAX) return null;
  return n;
}

export type CleanRule = {
  label: string;
  multiplier: number;
  geo_target_constants?: string[];
  geo_match_type?: (typeof VALUE_RULE_GEO_MATCH)[number];
  device_types?: Array<(typeof VALUE_RULE_DEVICES)[number]>;
  user_lists?: string[];
};

function uniqueStrings(list: unknown, test: (item: string) => boolean, max: number): string[] | null {
  if (!Array.isArray(list) || list.length === 0 || list.length > max) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !test(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return text && text.length <= 40 ? text : fallback;
}

function cleanRule(raw: unknown, dimension: ValueRuleDimension, index: number, customerId?: string | null): CleanRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const rule = raw as Record<string, unknown>;
  const multiplier = cleanMultiplier(rule.multiplier);
  if (multiplier === null) return null;
  const label = cleanLabel(rule.label, `قاعدة ${index + 1}`);

  if (dimension === 'GEO_LOCATION') {
    const geo = uniqueStrings(rule.geo_target_constants, (item) => GEO_CONSTANT.test(item), MAX_GEO_PER_RULE);
    if (!geo) return null;
    const match = String(rule.geo_match_type ?? 'PRESENCE');
    if (!(VALUE_RULE_GEO_MATCH as readonly string[]).includes(match)) return null;
    return { label, multiplier, geo_target_constants: geo, geo_match_type: match as CleanRule['geo_match_type'] };
  }
  if (dimension === 'DEVICE') {
    const devices = uniqueStrings(rule.device_types, (item) => (VALUE_RULE_DEVICES as readonly string[]).includes(item), VALUE_RULE_DEVICES.length);
    if (!devices) return null;
    return { label, multiplier, device_types: devices as CleanRule['device_types'] };
  }
  const lists = uniqueStrings(rule.user_lists, (item) => resourceInAccount(item, 'userLists', customerId), MAX_AUDIENCES_PER_RULE);
  if (!lists) return null;
  return { label, multiplier, user_lists: lists };
}

/** Two rules of one set must not claim the same device, place or audience: the first match wins and the second would be dead. */
function overlaps(rules: CleanRule[], dimension: ValueRuleDimension): boolean {
  const seen = new Set<string>();
  for (const rule of rules) {
    const keys = dimension === 'GEO_LOCATION' ? rule.geo_target_constants! : dimension === 'DEVICE' ? rule.device_types! : rule.user_lists!;
    for (const key of keys) {
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return false;
}

export function validateValueRulePayload(
  operation: ValueRuleOperation,
  targetId: string,
  paramsInput: unknown,
  accountCustomerId?: string | null
): ValueRuleValidation {
  const params = paramsInput && typeof paramsInput === 'object' ? (paramsInput as Record<string, unknown>) : {};

  if (operation === 'create_value_rule_set') {
    const attachment = String(params.attachment ?? '');
    if (attachment !== 'customer' && attachment !== 'campaign') return bad('attachment_invalid');
    const campaign = String(params.campaign_resource ?? '');
    if (attachment === 'campaign' && !resourceInAccount(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
    if (attachment === 'customer' && campaign) return bad('campaign_not_allowed');

    const dimension = String(params.dimension ?? '');
    if (!(VALUE_RULE_DIMENSIONS as readonly string[]).includes(dimension)) return bad('dimension_invalid');
    const rawRules = params.rules;
    if (!Array.isArray(rawRules) || rawRules.length === 0 || rawRules.length > MAX_RULES_PER_SET) return bad('rules_invalid');
    const rules: CleanRule[] = [];
    for (const [index, raw] of rawRules.entries()) {
      const rule = cleanRule(raw, dimension as ValueRuleDimension, index, accountCustomerId);
      if (!rule) return bad('rule_invalid');
      rules.push(rule);
    }
    if (overlaps(rules, dimension as ValueRuleDimension)) return bad('rules_overlap');

    const out: Record<string, unknown> = { attachment, dimension, rules };
    if (attachment === 'campaign') out.campaign_resource = campaign;
    return { ok: true, target_id: attachment === 'campaign' ? campaign : '', params: out };
  }

  // update_value_rule
  const rule = String(params.rule_resource ?? targetId ?? '');
  if (!resourceInAccount(rule, 'conversionValueRules', accountCustomerId)) return bad('rule_invalid');
  const out: Record<string, unknown> = { rule_resource: rule };
  let changes = 0;
  if (params.multiplier !== undefined) {
    const multiplier = cleanMultiplier(params.multiplier);
    if (multiplier === null) return bad('multiplier_invalid');
    out.multiplier = multiplier;
    changes += 1;
  }
  if (params.status !== undefined) {
    const status = String(params.status);
    if (!(VALUE_RULE_STATUSES as readonly string[]).includes(status)) return bad('status_invalid');
    out.status = status;
    changes += 1;
  }
  if (changes === 0) return bad('update_empty');
  return { ok: true, target_id: rule, params: out };
}
