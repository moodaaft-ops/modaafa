/**
 * Read tools for the Jarvis brain (PR-J2).
 *
 * Contract between a tool and the brain:
 * - `summary` is the ONLY part the model may see. It is compact, free of Google
 *   resource names, and every third-party string in it went through
 *   `sanitizePromptText`. Rows the model can point at carry a short `ref`.
 * - `rows` is the server-side evidence registry for the same refs. It keeps the
 *   full data (resource names, ids, match types) so a later "prepare change"
 *   tool can resolve a ref to a real resource without trusting the model to
 *   type a resource name or a number. It must never be sent to the model.
 * - Refs are unique per kind inside ONE result. The brain namespaces them when
 *   several results land in the same turn.
 */

export type GaqlCustomer = { query(gaql: string): Promise<any[]> };

export type ToolContext = {
  customer: GaqlCustomer;
  accountId: string; // our uuid
  customerId: string; // 10 digits
  currencyCode: string; // e.g. 'SAR'
  business: { name: string | null; sector: string | null; keywords?: string[] } | null;
  connectedEmail?: string | null;
  /** The owner's break-even, when the caller loaded it. The n-gram tool uses it for the waste limit. */
  economics?: import('@/lib/economics/break-even').BreakEven | null;
  now: Date;
};

export type EvidenceKind =
  | 'campaign'
  | 'search_term'
  | 'negative_word'
  | 'keyword'
  | 'geo'
  | 'ad'
  | 'conversion_action'
  | 'change'
  | 'schedule_slot'
  | 'device'
  | 'pmax_category'
  | 'google_recommendation'
  | 'auto_apply'
  | 'rsa_ad'
  | 'ad_test';

export type EvidenceRow = { ref: string; kind: EvidenceKind; data: Record<string, unknown> };

export type ToolResult =
  | { ok: true; summary: Record<string, unknown>; rows: EvidenceRow[] }
  | { ok: false; error: string; message_ar: string };

export type JarvisReadTool = {
  name: string;
  description: string; // English, 1 to 3 sentences, says when to use it
  input_schema: Record<string, unknown>; // JSON schema, additionalProperties false
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
};
