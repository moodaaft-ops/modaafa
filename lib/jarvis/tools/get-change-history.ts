import type { EvidenceRow, JarvisReadTool } from './types';
import { cleanText, enumLabel, okResult, parseArgs, pick, refCounter, runQuery, str } from './shared';

const ROW_LIMIT = 200;
const LATEST = 15;

export type ChangeActor = 'you' | 'google_auto' | 'api' | 'other_user';

const AUTO_CLIENT_TYPES = new Set(['GOOGLE_ADS_RECOMMENDATIONS', 'GOOGLE_ADS_AUTOMATED_RULE']);

const VIA_BY_CLIENT_TYPE: Record<string, string> = {
  GOOGLE_ADS_WEB_CLIENT: 'web',
  GOOGLE_ADS_API: 'api',
  GOOGLE_ADS_RECOMMENDATIONS: 'recommendations',
  GOOGLE_ADS_AUTOMATED_RULE: 'automated_rule',
  GOOGLE_ADS_SCRIPTS: 'script',
  GOOGLE_ADS_BULK_UPLOAD: 'bulk_upload',
  GOOGLE_ADS_MOBILE_APP: 'mobile_app',
  GOOGLE_ADS_EDITOR: 'editor',
};

/**
 * Who made a change. Emails are only ever compared here and never copied into a
 * result. A blank connected email never matches a blank user email.
 */
export function classifyActor(
  userEmail: string,
  clientType: string,
  connectedEmail: string | null | undefined
): ChangeActor {
  const email = userEmail.trim().toLowerCase();
  const connected = (connectedEmail ?? '').trim().toLowerCase();
  if (email !== '' && connected !== '' && email === connected) return 'you';
  if (AUTO_CLIENT_TYPES.has(clientType)) return 'google_auto';
  if (clientType === 'GOOGLE_ADS_API') return 'api';
  return 'other_user';
}

function changedFields(row: unknown): string {
  const raw = pick(row, 'change_event.changed_fields');
  if (typeof raw === 'string') return cleanText(raw).slice(0, 120);
  if (Array.isArray(raw)) return cleanText(raw.map(String).join(',')).slice(0, 120);
  return '';
}

export const getChangeHistoryTool: JarvisReadTool = {
  name: 'get_change_history',
  description:
    'Lists who changed what in the last 14 days (you, Google automatic features, API tools, or another user) with counts by actor and by resource type and the 15 latest changes. Use it to explain a sudden performance shift or to answer what was changed recently.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);

    const rows = await runQuery(
      ctx,
      `
      SELECT change_event.change_date_time, change_event.client_type, change_event.user_email,
        change_event.change_resource_type, change_event.resource_change_operation,
        change_event.changed_fields, campaign.name
      FROM change_event
      WHERE change_event.change_date_time DURING LAST_14_DAYS
      ORDER BY change_event.change_date_time DESC
      LIMIT ${ROW_LIMIT}
    `
    );

    const byActor: Record<ChangeActor, number> = { you: 0, google_auto: 0, api: 0, other_user: 0 };
    const byResourceType: Record<string, number> = {};
    const changes = rows.map((row) => {
      const clientType = str(row, 'change_event.client_type');
      const actor = classifyActor(str(row, 'change_event.user_email'), clientType, ctx.connectedEmail);
      const resourceType = enumLabel(str(row, 'change_event.change_resource_type'));
      byActor[actor] += 1;
      byResourceType[resourceType] = (byResourceType[resourceType] ?? 0) + 1;
      return {
        time: cleanText(str(row, 'change_event.change_date_time')).slice(0, 19),
        actor,
        via: VIA_BY_CLIENT_TYPE[clientType] ?? 'other',
        resourceType,
        operation: enumLabel(str(row, 'change_event.resource_change_operation')),
        campaign: cleanText(str(row, 'campaign.name')),
        fields: changedFields(row),
      };
    });

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const latest = changes.slice(0, LATEST).map((change) => {
      const ref = nextRef('chg');
      const compact = {
        time: change.time,
        actor: change.actor,
        via: change.via,
        resource_type: change.resourceType,
        operation: change.operation,
        campaign: change.campaign,
        changed_fields: change.fields,
      };
      evidence.push({ ref, kind: 'change', data: { ...compact } });
      return { ref, ...compact };
    });

    return okResult(
      {
        window_days: 14,
        events_scanned: changes.length,
        truncated: rows.length >= ROW_LIMIT,
        by_actor: byActor,
        by_resource_type: byResourceType,
        latest,
      },
      evidence
    );
  },
};
