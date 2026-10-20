import type { EvidenceRow, JarvisReadTool } from './types';
import { okResult, parseArgs, refCounter } from './shared';
import { readValueRuleSets } from '@/lib/value-rules/reader';

/**
 * The account's conversion value rules, one row per set. Registered only when
 * EXTENDED_ACTIONS_ENABLED is on. Read only: a change goes through an approval
 * card (create_value_rule_set / update_value_rule). Resource names stay in the
 * evidence rows; the summary has refs, scopes, dimensions and multipliers.
 */
const DEVICE_AR: Record<string, string> = { MOBILE: 'الجوال', DESKTOP: 'الكمبيوتر', TABLET: 'التابلت' };

export const getValueRulesTool: JarvisReadTool = {
  name: 'get_value_rules',
  description:
    'Lists the conversion value rules of the account (rules that tell Smart Bidding a conversion from a place, device or audience is worth more or less). Use it before suggesting a value rule or when the merchant asks why bidding favours a city or a device. Read only.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);
    const sets = await readValueRuleSets(ctx.customer);
    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const items = sets.slice(0, 20).map((set) => {
      const ref = nextRef('vr');
      const rules = set.rules.map((rule) => ({
        multiplier: rule.operation === 'MULTIPLY' ? Math.round(rule.value * 100) / 100 : null,
        operation: rule.operation,
        status: rule.status,
        condition: rule.condition,
        devices: rule.device_types.map((d) => DEVICE_AR[d] ?? d),
        locations: rule.geo_target_constants.length,
        audiences: rule.user_lists.length + rule.user_interests.length,
      }));
      evidence.push({ ref, kind: 'value_rule_set', data: { resource_name: set.resource_name, campaign: set.campaign, rules: set.rules.map((r) => r.resource_name) } });
      return {
        ref,
        scope: set.attachment_type === 'CAMPAIGN' ? 'campaign' : 'account',
        dimension: set.dimensions[0] ?? null,
        status: set.status,
        rules,
      };
    });
    return okResult(
      {
        total_sets: sets.length,
        sets: items,
        note_ar:
          sets.length === 0
            ? 'ما فيه قواعد قيمة تحويل على الحساب'
            : 'القواعد تغيّر القيمة اللي تتعلم عليها المزايدة الذكية، ما تغيّر المبيعات الفعلية',
      },
      evidence
    );
  },
};
