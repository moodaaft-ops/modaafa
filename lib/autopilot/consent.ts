/**
 * The customer's answer to the one permission question (spec 83, 5.2).
 *
 * Storing an answer never turns execution on. "auto_small" is a recorded
 * consent that a reviewed script may act on after the global switch opens;
 * "always_ask" also moves an account that is somehow in conservative mode back
 * to off, because stopping automation must never wait for anything.
 */
export const CONSENT_COPY_VERSION = '2026-10-12';
export const CONSENT_ANSWERS = ['auto_small', 'always_ask'] as const;
export type ConsentAnswer = (typeof CONSENT_ANSWERS)[number];
/** Voice can ask the question but never answer it: an answer is a button press. */
export const CONSENT_CHANNELS = ['chat', 'settings'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export type ConsentRecord = {
  answer: ConsentAnswer;
  answered_at: string;
  channel: ConsentChannel;
  copy_version: string;
};

export function parseConsentInput(
  payload: Record<string, unknown> | null
): { customerId: string; answer: ConsentAnswer; channel: ConsentChannel } | null {
  if (!payload) return null;
  const customerId = String(payload.customerId ?? payload.customer_id ?? '').replace(/\D/g, '');
  const answer = String(payload.answer ?? '') as ConsentAnswer;
  const channel = String(payload.channel ?? 'chat') as ConsentChannel;
  if (!customerId || !CONSENT_ANSWERS.includes(answer) || !CONSENT_CHANNELS.includes(channel)) return null;
  return { customerId, answer, channel };
}

export function consentRecord(answer: ConsentAnswer, channel: ConsentChannel, now = new Date()): ConsentRecord {
  return { answer, answered_at: now.toISOString(), channel, copy_version: CONSENT_COPY_VERSION };
}
