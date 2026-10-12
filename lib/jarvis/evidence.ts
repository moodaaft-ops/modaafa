import type { EvidenceRow } from './tools/types';

const REF_PATTERN = /^([a-z]{1,6})_(\d{1,4})$/;
/** Hard ceiling on rows kept for one turn; a turn never needs more. */
const MAX_ROWS = 400;

/**
 * Server-side evidence for ONE chat turn.
 *
 * Every read tool numbers its refs from 1 (st_1, st_2, ...), so two calls in
 * the same turn would both say st_1. The registry renumbers each new result
 * against what the turn already holds (the second call's st_1 becomes st_6 if
 * five st rows exist) and rewrites the refs inside the summary the model sees.
 * The model therefore only ever sees unique refs, and prepare_change resolves
 * them here, never from anything the model typed.
 */
export class EvidenceRegistry {
  private readonly rows = new Map<string, EvidenceRow>();
  private readonly counters = new Map<string, number>();

  get size() {
    return this.rows.size;
  }

  get(ref: unknown): EvidenceRow | undefined {
    if (typeof ref !== 'string') return undefined;
    return this.rows.get(ref.trim().toLowerCase());
  }

  /**
   * Adds the rows of one tool result and returns the summary with every
   * `ref` rewritten to its turn-unique name. Rows over the turn ceiling are
   * dropped from the registry AND their refs removed from the summary, so the
   * model can never point at evidence the server does not hold.
   */
  add(summary: Record<string, unknown>, rows: EvidenceRow[]): Record<string, unknown> {
    const renamed = new Map<string, string>();
    for (const row of rows) {
      const match = REF_PATTERN.exec(row.ref);
      if (!match || renamed.has(row.ref)) continue;
      if (this.rows.size >= MAX_ROWS) break;
      const prefix = match[1];
      const next = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, next);
      const ref = `${prefix}_${next}`;
      renamed.set(row.ref, ref);
      this.rows.set(ref, { ...row, ref });
    }
    return rewriteRefs(summary, renamed) as Record<string, unknown>;
  }
}

function rewriteRefs(value: unknown, renamed: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, renamed));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'ref') {
      // A ref that was not registered is not shown at all.
      if (typeof item === 'string' && renamed.has(item)) out.ref = renamed.get(item);
      continue;
    }
    out[key] = rewriteRefs(item, renamed);
  }
  return out;
}
