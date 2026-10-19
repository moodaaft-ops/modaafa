/**
 * The merchant's verdict on one lead, and what it does to the upload state.
 * Pure: the route reads the row, asks for the patch and writes it.
 */
export const LEAD_STATUSES = ['new', 'customer', 'no_reply', 'not_serious'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const MARKABLE_STATUSES = ['customer', 'no_reply', 'not_serious'] as const;

export const LEAD_STATUS_LABELS_AR: Record<LeadStatus, string> = {
  new: 'جديد',
  customer: 'صار زبون',
  no_reply: 'ما رد',
  not_serious: 'مو جاد',
};

export const MAX_LEAD_VALUE_SAR = 10_000_000;

export type UploadStatus = 'none' | 'pending' | 'uploading' | 'uploaded' | 'failed' | 'skipped';

export type LeadRowForMarking = {
  status: LeadStatus;
  upload_status: UploadStatus;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
};

export type MarkInput = { status: (typeof MARKABLE_STATUSES)[number]; value_sar: number | null };

export type MarkParseError = 'invalid_status' | 'invalid_value';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** "1,500" "١٥٠٠" "1500.5" "1٬500" all become a number; anything else is an error. */
export function parseValueSar(input: unknown): number | null | 'invalid' {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 && input <= MAX_LEAD_VALUE_SAR ? round2(input) : 'invalid';
  }
  if (typeof input !== 'string') return 'invalid';
  const text = input
    .replace(/[٠-٩]/g, (char) => String(ARABIC_DIGITS.indexOf(char)))
    .replace(/[,٬\s]/g, '')
    .replace(/٫/g, '.');
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return 'invalid';
  const value = Number(text);
  return value > 0 && value <= MAX_LEAD_VALUE_SAR ? round2(value) : 'invalid';
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function parseMarkInput(body: unknown): { ok: true; input: MarkInput } | { ok: false; error: MarkParseError } {
  const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const status = source.status;
  if (typeof status !== 'string' || !(MARKABLE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'invalid_status' };
  }
  if (status !== 'customer') return { ok: true, input: { status: status as MarkInput['status'], value_sar: null } };
  const value = parseValueSar(source.value_sar);
  if (value === 'invalid') return { ok: false, error: 'invalid_value' };
  return { ok: true, input: { status: 'customer', value_sar: value } };
}

/**
 * A lead that already went to Google (or is being sent right now) is locked:
 * changing it afterwards would need a conversion adjustment, which this loop
 * does not do. The inbox says so instead of silently editing the row.
 */
export function canChangeLead(row: Pick<LeadRowForMarking, 'upload_status'>) {
  return row.upload_status !== 'uploaded' && row.upload_status !== 'uploading';
}

export type MarkPatch = {
  status: LeadStatus;
  marked_at: string;
  value_sar: number | null;
  upload_status: UploadStatus;
  upload_attempts: number;
  upload_error: string | null;
};

export function buildMarkPatch(
  row: LeadRowForMarking,
  input: MarkInput,
  now: Date
): { ok: true; patch: MarkPatch } | { ok: false; error: 'locked_uploaded' } {
  if (!canChangeLead(row)) return { ok: false, error: 'locked_uploaded' };

  let upload_status: UploadStatus = 'none';
  let upload_error: string | null = null;
  if (input.status === 'customer') {
    if (row.gclid || row.gbraid || row.wbraid) {
      upload_status = 'pending';
    } else {
      // Nothing to attribute to an ad: the lead is still a customer in the inbox, it just cannot train bidding.
      upload_status = 'skipped';
      upload_error = 'no_click_id';
    }
  }
  return {
    ok: true,
    patch: {
      status: input.status,
      marked_at: now.toISOString(),
      value_sar: input.status === 'customer' ? input.value_sar : null,
      upload_status,
      upload_attempts: 0,
      upload_error,
    },
  };
}
