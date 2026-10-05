import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideAlert,
  normalizeErrorCode,
  planOpsAlert,
  summarizeErrors,
} from '../lib/platform/ops-alerts';

type Row = { job_name: string; started_at: string; details: Record<string, unknown> };

/** Minimal in-memory job_runs that honours the eq/gte filters planOpsAlert uses. */
function fakeSupabase(rows: Row[], failWith?: unknown) {
  return {
    from(table: string) {
      assert.equal(table, 'job_runs');
      const filters: Array<(row: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(column: string, value: string) {
          filters.push((row) =>
            column.startsWith('details->>')
              ? String(row.details[column.slice('details->>'.length)]) === value
              : (row as any)[column] === value
          );
          return builder;
        },
        gte(column: string, value: string) {
          filters.push((row) => (row as any)[column] >= value);
          return builder;
        },
        limit: () => builder,
        async maybeSingle() {
          if (failWith) return { data: null, error: failWith };
          return { data: rows.find((row) => filters.every((f) => f(row))) ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

const NOW = new Date('2026-10-05T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const optimizeErrors = [
  '1234567890: OPERATOR_FIELD_MISMATCH: Request contains an invalid argument.',
  '2234567890: OPERATOR_FIELD_MISMATCH: Request contains an invalid argument.',
  '3234567890: CUSTOMER_NOT_ENABLED: The caller does not have permission',
  'benchmark_lookup:تجارة|SAR:42P01 | relation does not exist',
];

test('error entries collapse to stable codes with ids and numbers removed', () => {
  assert.equal(normalizeErrorCode(optimizeErrors[0]), 'OPERATOR_FIELD_MISMATCH');
  assert.equal(normalizeErrorCode({ customer_id: '123', message: 'CUSTOMER_NOT_ENABLED: x' }), 'CUSTOMER_NOT_ENABLED');
  assert.equal(normalizeErrorCode('1234567890:queue_cursor:boom 77'), 'queue_cursor');
  assert.equal(normalizeErrorCode(optimizeErrors[3]), 'benchmark_lookup');
});

test('summary counts failed accounts and lists codes with counts, fingerprint ignores counts', () => {
  const a = summarizeErrors(optimizeErrors, 29);
  const b = summarizeErrors(optimizeErrors.slice(0, 3), 29);
  assert.match(a.summaryAr, /^فشل 3 من 29 حساب: /);
  assert.match(a.summaryAr, /OPERATOR_FIELD_MISMATCH ×2/);
  assert.match(a.summaryAr, /CUSTOMER_NOT_ENABLED ×1/);
  assert.notEqual(a.fingerprint, b.fingerprint); // benchmark_lookup code added
  const fewer = summarizeErrors(optimizeErrors.slice(1), 29);
  assert.equal(fewer.fingerprint, a.fingerprint); // same code set, different counts
});

test('same fingerprint within 24h is suppressed, a new code set or an older alert is not', async () => {
  const fp = summarizeErrors(optimizeErrors, 29).fingerprint;
  const sent: Row = {
    job_name: 'optimize',
    started_at: hoursAgo(3),
    details: { alert_fingerprint: fp, alerted: true },
  };
  const base = { jobName: 'optimize', errors: optimizeErrors, attemptedAccounts: 29, now: NOW };

  const repeat = await planOpsAlert({ ...base, supabase: fakeSupabase([sent]), processed: 5 });
  assert.equal(repeat.send, false);
  assert.equal(repeat.details.alerted, false);
  assert.equal(repeat.details.alert_fingerprint, fp);

  const changed = await planOpsAlert({
    ...base,
    supabase: fakeSupabase([sent]),
    errors: [...optimizeErrors, '4234567890: USER_PERMISSION_DENIED: nope'],
    processed: 5,
  });
  assert.equal(changed.send, true);

  const stale = await planOpsAlert({
    ...base,
    supabase: fakeSupabase([{ ...sent, started_at: hoursAgo(25) }]),
    processed: 5,
  });
  assert.equal(stale.send, true);

  const otherJob = await planOpsAlert({
    ...base,
    supabase: fakeSupabase([{ ...sent, job_name: 'sync-google-ads' }]),
    processed: 5,
  });
  assert.equal(otherJob.send, true);
});

test('total failure bypasses the fingerprint window but not its own 6h window', async () => {
  const fp = summarizeErrors(optimizeErrors, 29).fingerprint;
  const base = { jobName: 'optimize', errors: optimizeErrors, attemptedAccounts: 29, processed: 0, now: NOW };

  const fingerprintOnly: Row = {
    job_name: 'optimize',
    started_at: hoursAgo(2),
    details: { alert_fingerprint: fp, alert_kind: 'errors', alerted: true },
  };
  const first = await planOpsAlert({ ...base, supabase: fakeSupabase([fingerprintOnly]) });
  assert.equal(first.send, true);
  assert.equal(first.details.alert_kind, 'total_failure');

  const recentTotal: Row = { ...fingerprintOnly, started_at: hoursAgo(5), details: { ...fingerprintOnly.details, alert_kind: 'total_failure' } };
  assert.equal((await planOpsAlert({ ...base, supabase: fakeSupabase([recentTotal]) })).send, false);

  const oldTotal: Row = { ...recentTotal, started_at: hoursAgo(7) };
  assert.equal((await planOpsAlert({ ...base, supabase: fakeSupabase([oldTotal]) })).send, true);
});

test('a failing dedup lookup fails open and zero attempted accounts is not a total failure', async () => {
  const lookupFails = await planOpsAlert({
    supabase: fakeSupabase([], { message: 'boom' }),
    jobName: 'sync-google-ads',
    errors: optimizeErrors,
    attemptedAccounts: 10,
    processed: 4,
    now: NOW,
  });
  assert.equal(lookupFails.send, true);

  const none = await planOpsAlert({
    supabase: fakeSupabase([]),
    jobName: 'sync-google-ads',
    errors: ['queue_cursor:x'],
    attemptedAccounts: 0,
    processed: 0,
    now: NOW,
  });
  assert.equal(none.details.alert_kind, 'errors');
  assert.equal(decideAlert({ isTotalFailure: false, fingerprintAlertedRecently: true, totalFailureAlertedRecently: false }), false);
});

import { hasRecentCompletedRun } from '../lib/platform/jobs';

function fakeRuns(rows: Array<{ job_name: string; status: string; started_at: string }>, failWith?: unknown) {
  return {
    from() {
      const filters: Array<(row: any) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(column: string, value: string) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: string[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        gte(column: string, value: string) {
          filters.push((row) => row[column] >= value);
          return builder;
        },
        limit: () => builder,
        async maybeSingle() {
          if (failWith) return { data: null, error: failWith };
          return { data: rows.find((row) => filters.every((f) => f(row))) ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

test('run throttle counts only completed runs of the same job inside 50 minutes', async () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const now = NOW.getTime();
  const recent = (status: string, minutesAgo = 20, job = 'optimize') => [
    { job_name: job, status, started_at: at(minutesAgo) },
  ];

  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('success')), 'optimize', undefined, now), true);
  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('partial')), 'optimize', undefined, now), true);
  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('failed')), 'optimize', undefined, now), false);
  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('running')), 'optimize', undefined, now), false);
  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('success', 55)), 'optimize', undefined, now), false);
  assert.equal(await hasRecentCompletedRun(fakeRuns(recent('success', 20, 'sync-google-ads')), 'optimize', undefined, now), false);
  assert.equal(await hasRecentCompletedRun(fakeRuns([], { message: 'boom' }), 'optimize', undefined, now), false);
});
