import { DAYS_OF_WEEK, MAX_SCHEDULE_SLOTS_PER_DAY, MINUTE_ENUM, type DayOfWeek, type MinuteEnum } from './types';
import { slotMinutes, type ScheduleSlot } from './validate';

/**
 * Ad schedule planning, pure.
 *
 * Google rules that shape the plan (AdScheduleInfo, v22):
 *  - day, start and end are immutable after create: only bid_modifier can be
 *    updated, so changing a window means remove + create;
 *  - no more than six schedules per day, and windows of one day cannot overlap;
 *  - the moment a campaign has ANY ad schedule, ads run only inside the
 *    scheduled windows. Adding one adjusted window to a campaign that ran 24/7
 *    would silently switch off every other hour. So unless the caller says
 *    `restrict`, the plan keeps every uncovered hour serving at modifier 1.
 *
 * The week is modelled as 96 quarter-hour cells per day (the finest unit the
 * MinuteOfHour enum allows).
 */

const CELLS_PER_DAY = 96;
const CELL_MINUTES = 15;

export type ExistingScheduleCriterion = {
  resource_name: string;
  day_of_week: DayOfWeek;
  start_hour: number;
  start_minute: MinuteEnum;
  end_hour: number;
  end_minute: MinuteEnum;
  bid_modifier: number;
};

export type SchedulePlan = {
  creates: ScheduleSlot[];
  updates: Array<{ resource_name: string; bid_modifier: number; previous_modifier: number }>;
  removes: ExistingScheduleCriterion[];
  final: ScheduleSlot[];
  /** Minutes per week the campaign serves after the plan (10080 = always on). */
  coverage_minutes: number;
};

export type SchedulePlanResult = { ok: true; plan: SchedulePlan } | { ok: false; code: string };

const WEEK_MINUTES = 7 * 24 * 60;

function minuteName(minutes: number): MinuteEnum {
  const name = (Object.keys(MINUTE_ENUM) as MinuteEnum[]).find((key) => MINUTE_ENUM[key] === minutes);
  if (!name) throw new Error('minute is not a quarter hour');
  return name;
}

function slotFromMinutes(day: DayOfWeek, from: number, to: number, bid_modifier: number): ScheduleSlot {
  const endHour = Math.floor(to / 60);
  return {
    day_of_week: day,
    start_hour: Math.floor(from / 60),
    start_minute: minuteName(from % 60),
    end_hour: endHour,
    end_minute: minuteName(to % 60),
    bid_modifier,
  };
}

function emptyWeek(fill: number | null): Record<DayOfWeek, Array<number | null>> {
  const week = {} as Record<DayOfWeek, Array<number | null>>;
  for (const day of DAYS_OF_WEEK) week[day] = new Array(CELLS_PER_DAY).fill(fill);
  return week;
}

function paint(
  week: Record<DayOfWeek, Array<number | null>>,
  day: DayOfWeek,
  window: { from: number; to: number },
  modifier: number
) {
  for (let cell = window.from / CELL_MINUTES; cell < window.to / CELL_MINUTES; cell += 1) week[day][cell] = modifier;
}

export function planAdSchedule(
  existing: ExistingScheduleCriterion[],
  requested: ScheduleSlot[],
  restrict: boolean
): SchedulePlanResult {
  const week = emptyWeek(!restrict && existing.length === 0 ? 1 : null);
  if (!restrict) {
    for (const criterion of existing) {
      paint(week, criterion.day_of_week, slotMinutes(criterion), criterion.bid_modifier);
    }
  }
  for (const slot of requested) paint(week, slot.day_of_week, slotMinutes(slot), slot.bid_modifier);

  const final: ScheduleSlot[] = [];
  for (const day of DAYS_OF_WEEK) {
    const cells = week[day];
    const runs: ScheduleSlot[] = [];
    let start = 0;
    while (start < CELLS_PER_DAY) {
      const value = cells[start];
      if (value === null) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < CELLS_PER_DAY && cells[end] === value) end += 1;
      runs.push(slotFromMinutes(day, start * CELL_MINUTES, end * CELL_MINUTES, value));
      start = end;
    }
    if (runs.length > MAX_SCHEDULE_SLOTS_PER_DAY) return { ok: false, code: 'schedule_too_fragmented' };
    final.push(...runs);
  }
  if (final.length === 0) return { ok: false, code: 'schedule_empty' };

  const key = (slot: { day_of_week: string } & Parameters<typeof slotMinutes>[0]) => {
    const { from, to } = slotMinutes(slot);
    return `${slot.day_of_week}|${from}|${to}`;
  };
  const existingByKey = new Map(existing.map((criterion) => [key(criterion), criterion]));
  const finalKeys = new Set(final.map(key));

  const creates: ScheduleSlot[] = [];
  const updates: SchedulePlan['updates'] = [];
  for (const slot of final) {
    const match = existingByKey.get(key(slot));
    if (!match) creates.push(slot);
    else if (Math.abs(match.bid_modifier - slot.bid_modifier) > 0.0001) {
      updates.push({
        resource_name: match.resource_name,
        bid_modifier: slot.bid_modifier,
        previous_modifier: match.bid_modifier,
      });
    }
  }
  const removes = existing.filter((criterion) => !finalKeys.has(key(criterion)));
  if (creates.length === 0 && updates.length === 0 && removes.length === 0) return { ok: false, code: 'no_change' };

  // A brand-new schedule made only of neutral 24h windows changes nothing the merchant can see.
  if (
    existing.length === 0 &&
    !restrict &&
    requested.every((slot) => slot.bid_modifier === 1)
  ) {
    return { ok: false, code: 'no_change' };
  }

  const coverage = final.reduce((sum, slot) => {
    const { from, to } = slotMinutes(slot);
    return sum + (to - from);
  }, 0);
  return { ok: true, plan: { creates, updates, removes, final, coverage_minutes: Math.min(coverage, WEEK_MINUTES) } };
}

/** Read GAQL rows into the planner's input. A row with unreadable fields makes the whole read null. */
export function scheduleCriteriaFromRows(rows: any[]): ExistingScheduleCriterion[] | null {
  const out: ExistingScheduleCriterion[] = [];
  for (const row of rows ?? []) {
    const criterion = row?.campaignCriterion ?? row?.campaign_criterion;
    const schedule = criterion?.adSchedule ?? criterion?.ad_schedule;
    if (!criterion || !schedule) return null;
    const day = String(schedule.dayOfWeek ?? schedule.day_of_week ?? '');
    const startHour = Number(schedule.startHour ?? schedule.start_hour);
    const endHour = Number(schedule.endHour ?? schedule.end_hour);
    const startMinute = String(schedule.startMinute ?? schedule.start_minute ?? 'ZERO');
    const endMinute = String(schedule.endMinute ?? schedule.end_minute ?? 'ZERO');
    // float32 on the wire: compare at two decimals, the precision the platform writes.
    const modifier = Math.round(Number(criterion.bidModifier ?? criterion.bid_modifier ?? 1) * 100) / 100;
    const resource = String(criterion.resourceName ?? criterion.resource_name ?? '');
    if (
      !resource ||
      !(DAYS_OF_WEEK as readonly string[]).includes(day) ||
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      !(startMinute in MINUTE_ENUM) ||
      !(endMinute in MINUTE_ENUM) ||
      !Number.isFinite(modifier)
    ) {
      // An unreadable window cannot be planned around: refuse the whole read.
      return null;
    }
    out.push({
      resource_name: resource,
      day_of_week: day as DayOfWeek,
      start_hour: startHour,
      start_minute: startMinute as MinuteEnum,
      end_hour: endHour,
      end_minute: endMinute as MinuteEnum,
      bid_modifier: modifier,
    });
  }
  return out;
}
