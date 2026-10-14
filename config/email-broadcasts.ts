import type { CopyKey } from '@/lib/lifecycle/types';

/**
 * One-off mail to a segment ("we shipped X"). A broadcast goes out gradually:
 * at most BROADCAST_BATCH_PER_RUN people per cron run (config/email-journeys.ts),
 * each person at most once, and only when the usual limits allow (their
 * category preference, suppression, send window, 24 hour gap, 3 per 7 days).
 * Broadcasts ignore the activation date and the holdout group on purpose:
 * they are announcements, not journeys. The global switch still applies
 * (EMAIL_LIFECYCLE_ENABLED and a non-null EMAIL_LIFECYCLE_ACTIVATED_AT).
 *
 * To send one:
 *   1. write its text in lib/lifecycle/copy.ts and add the key to COPY_KEYS
 *   2. read the text, flip the copy to `approved: true`
 *   3. add the entry below with `approved: true` (and `notBefore` if it must wait)
 * message_log template key: `broadcast_<id>`. Never reuse an id for new text.
 */
export const SEGMENT_IDS = [
  'all',
  'registered_not_connected',
  'connected_no_trial',
  'trial_lapsed',
  'canceled',
  'subscribers',
] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

export type Broadcast = {
  id: string;
  copyKey: CopyKey;
  segment: SegmentId;
  /** ISO time before which nothing goes out. null = as soon as approved. */
  notBefore: string | null;
  /** Flip to true only after the text is approved. */
  approved: boolean;
};

export const BROADCASTS: Broadcast[] = [
  {
    id: 'chat_relaunch',
    copyKey: 'broadcast_chat_relaunch',
    segment: 'registered_not_connected',
    notBefore: null,
    approved: false,
  },
];
