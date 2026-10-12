import {
  STAGE_LABEL_AR,
  USER_STAGES,
  stageForEvent,
  stageRank,
  type UserStage,
} from '@/lib/stages/types';

/**
 * Stage funnel for /operations/funnel and its CSV export.
 *
 * Definitions (also printed on the page, so the numbers can be checked):
 *   - "reached"  = the user got to this stage or any later one. Computed from
 *     user_events, with users.stage as a floor, so a user who skipped a stage
 *     still counts as having passed it.
 *   - "current"  = users whose furthest stage is exactly this one.
 *   - conversion to next = reached(next) / reached(this), as a share of the
 *     people who reached this stage.
 *   - "last 7 days" = the people who REGISTERED in the last 7 days, and how
 *     far each of them has got so far. It is a cohort, not a count of events
 *     that happened this week, so it understates the newest people who have
 *     not had time yet. The 14-day-old number is the fairer one to compare.
 */
export type FunnelUser = { id: string; stage: string | null; createdAt: string };
export type FunnelEvent = { userId: string; eventType: string };

export type FunnelRow = {
  stage: UserStage;
  label: string;
  reached: number;
  current: number;
  /** Share (0..1) of `reached` that also reached the next stage; null for the last stage or an empty stage. */
  rateToNext: number | null;
};

export type FunnelReport = {
  windowDays: number;
  allTime: { total: number; rows: FunnelRow[] };
  recent: { total: number; rows: FunnelRow[] };
};

export function computeFunnel(input: {
  users: FunnelUser[];
  events: FunnelEvent[];
  now?: Date;
  windowDays?: number;
}): FunnelReport {
  const windowDays = input.windowDays ?? 7;
  const now = input.now ?? new Date();
  const since = now.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const furthestFromEvents = new Map<string, number>();
  for (const event of input.events) {
    const stage = stageForEvent(event.eventType);
    if (!stage) continue;
    const rank = stageRank(stage);
    if (rank > (furthestFromEvents.get(event.userId) ?? 0)) furthestFromEvents.set(event.userId, rank);
  }

  const furthest = (user: FunnelUser) =>
    Math.max(1, stageRank(user.stage), furthestFromEvents.get(user.id) ?? 0);

  const build = (users: FunnelUser[]): { total: number; rows: FunnelRow[] } => {
    const ranks = users.map(furthest);
    const rows: FunnelRow[] = USER_STAGES.map((stage) => {
      const rank = stageRank(stage);
      return {
        stage,
        label: STAGE_LABEL_AR[stage],
        reached: ranks.filter((value) => value >= rank).length,
        current: ranks.filter((value) => value === rank).length,
        rateToNext: null,
      };
    });
    rows.forEach((row, index) => {
      const next = rows[index + 1];
      row.rateToNext = next && row.reached > 0 ? next.reached / row.reached : null;
    });
    return { total: users.length, rows };
  };

  return {
    windowDays,
    allTime: build(input.users),
    recent: build(input.users.filter((user) => Date.parse(user.createdAt) >= since)),
  };
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return 'لا يوجد';
  return `${Math.round(rate * 1000) / 10}%`;
}

/** CSV with a BOM so Excel opens the Arabic labels correctly. */
export function funnelToCsv(report: FunnelReport): string {
  const header = [
    'المرحلة',
    'وصلوا للمرحلة (الكل)',
    'الحاليون فيها (الكل)',
    'نسبة الانتقال للتالية (الكل)',
    `وصلوا للمرحلة (آخر ${report.windowDays} أيام)`,
    `الحاليون فيها (آخر ${report.windowDays} أيام)`,
    `نسبة الانتقال للتالية (آخر ${report.windowDays} أيام)`,
  ];
  const lines = [header.map(csvCell).join(',')];
  report.allTime.rows.forEach((row, index) => {
    const recent = report.recent.rows[index];
    lines.push(
      [
        row.label,
        row.reached,
        row.current,
        csvPercent(row.rateToNext),
        recent.reached,
        recent.current,
        csvPercent(recent.rateToNext),
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function csvPercent(rate: number | null): string {
  return rate === null ? '' : `${Math.round(rate * 1000) / 10}%`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  // Neutralise spreadsheet formulas in any text that might ever come from data.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
