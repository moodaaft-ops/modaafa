/**
 * Saudi season calendar for the optimizer and the monthly session.
 *
 * Pure: no database, no network, no clock (callers pass the date). Dates are
 * calendar days in Riyadh time as "YYYY-MM-DD" strings.
 *
 * Why a table and not a formula. Ramadan, Eid al-Fitr and Eid al-Adha follow
 * the Hijri calendar. Saudi Arabia fixes them by moon sighting (Umm al-Qura is
 * the projection), so a formula can be a day off. The table below holds the
 * Umm al-Qura projection for 2026 to 2028 (checked against the ICU
 * "islamic-umalqura" calendar and against the Google Ads Titan skill, which
 * gives Ramadan 1448 as about 8 February 2027). Outside those years
 * `religiousDatesFromIcu` asks the runtime's ICU data, and returns nothing when
 * the runtime has none: the fixed-date and weekday seasons still work.
 *
 * What the seasons are used for (see docs/mb-upgrade/loops.md):
 *   - never judge a week against a season week: `seasonContext().judgement_unreliable`
 *     and `seasonRejection` (a budget CUT is held back when the last 7 days sit
 *     inside a season or in the 7 days after it);
 *   - pre-season hints: `upcoming[].in_prep_window` and `prep_budget_hint_ar`;
 *   - the season plan of the monthly session.
 */

export const SEASON_IDS = [
  'ramadan',
  'eid_al_fitr',
  'eid_al_adha',
  'national_day',
  'founding_day',
  'white_friday',
  'back_to_school',
] as const;
export type SeasonId = (typeof SEASON_IDS)[number];

export type Season = {
  id: SeasonId;
  name_ar: string;
  /** First day of the busy window. */
  start: string;
  /** Last day of the busy window. */
  end: string;
  /** From this day the account should be getting ready (budget, offers, creatives). */
  prep_from: string;
  /** The date itself can move by a day (moon sighting) or is a rough window. */
  approximate: boolean;
  hint_ar: string;
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Date helpers (UTC arithmetic on calendar days)
// ---------------------------------------------------------------------------

function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, days: number): string {
  return new Date(parseDay(day) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS);
}

function dayString(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/** Riyadh calendar day of an instant (UTC+3, no daylight saving). */
export function riyadhDay(now: Date): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Hijri dates: maintained table, ICU as a fallback outside it
// ---------------------------------------------------------------------------

export type ReligiousDates = {
  /** 1 Ramadan. */
  ramadan_start: string;
  /** 1 Shawwal, the first day of Eid al-Fitr. */
  eid_al_fitr: string;
  /** 10 Dhu al-Hijjah, the first day of Eid al-Adha. */
  eid_al_adha: string;
};

/** Gregorian year of the dates -> the three dates. Umm al-Qura projection. */
export const RELIGIOUS_DATES: Readonly<Record<number, ReligiousDates>> = {
  2026: { ramadan_start: '2026-02-18', eid_al_fitr: '2026-03-20', eid_al_adha: '2026-05-27' },
  2027: { ramadan_start: '2027-02-08', eid_al_fitr: '2027-03-09', eid_al_adha: '2027-05-16' },
  2028: { ramadan_start: '2028-01-28', eid_al_fitr: '2028-02-26', eid_al_adha: '2028-05-05' },
};

/**
 * The same three dates read from the runtime's Umm al-Qura calendar. Null when
 * the runtime has no such calendar (a Node build without full ICU) or the year
 * has no Ramadan start inside it. Used outside the table and by the tests as a
 * cross-check of the table.
 */
export function religiousDatesFromIcu(year: number): ReligiousDates | null {
  try {
    const format = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const parts = (ms: number) => {
      const out: Record<string, number> = {};
      for (const part of format.formatToParts(new Date(ms))) {
        if (part.type === 'day' || part.type === 'month' || part.type === 'year') out[part.type] = Number(part.value);
      }
      return out;
    };
    const first = Date.UTC(year, 0, 1);
    const last = Date.UTC(year, 11, 31);
    let ramadan: string | null = null;
    let fitr: string | null = null;
    let adha: string | null = null;
    for (let ms = first; ms <= last; ms += DAY_MS) {
      const { day, month } = parts(ms);
      const iso = new Date(ms).toISOString().slice(0, 10);
      if (day === 1 && month === 9 && !ramadan) ramadan = iso;
      if (day === 1 && month === 10 && !fitr) fitr = iso;
      if (day === 10 && month === 12 && !adha) adha = iso;
    }
    if (!ramadan || !fitr || !adha) return null;
    return { ramadan_start: ramadan, eid_al_fitr: fitr, eid_al_adha: adha };
  } catch {
    return null;
  }
}

function religiousDates(year: number): ReligiousDates | null {
  return RELIGIOUS_DATES[year] ?? religiousDatesFromIcu(year);
}

// ---------------------------------------------------------------------------
// The seasons of one Gregorian year
// ---------------------------------------------------------------------------

/** Black Friday: the Friday after the fourth Thursday of November. Saudi retail calls it the white Friday. */
export function whiteFriday(year: number): string {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0 Sunday .. 6 Saturday
  const firstThursday = 1 + ((4 - nov1 + 7) % 7);
  return dayString(year, 11, firstThursday + 21 + 1);
}

const HINTS: Record<SeasonId, string> = {
  ramadan: 'النشاط يتحرك بعد الإفطار وآخر الليل. جهّز العروض والميزانية قبلها بأسبوعين إلى ثلاثة',
  eid_al_fitr: 'ذروة الملابس والهدايا والسفر قبل العيد. جهّز قبلها بأسبوعين إلى ثلاثة',
  eid_al_adha: 'ذروة الأضاحي قبل العيد بأسابيع. جهّز قبلها بأربعة أسابيع',
  national_day: 'عروض وطنية، والمنافسة على الكلمات العامة ترتفع',
  founding_day: 'عروض وطنية قصيرة',
  white_friday: 'البحث يبدأ قبل الموسم بأسابيع. جهّز العروض والميزانية من بدري',
  back_to_school: 'قطاعات ترتفع وقطاعات تهدأ. اقرأ أرقام الحساب نفسه قبل ما تعدّل',
};

const NAMES: Record<SeasonId, string> = {
  ramadan: 'رمضان',
  eid_al_fitr: 'عيد الفطر',
  eid_al_adha: 'عيد الأضحى',
  national_day: 'اليوم الوطني',
  founding_day: 'يوم التأسيس',
  white_friday: 'الجمعة البيضاء',
  back_to_school: 'العودة للمدارس',
};

function season(id: SeasonId, start: string, end: string, prepDays: number, approximate: boolean): Season {
  return { id, name_ar: NAMES[id], start, end, prep_from: addDays(start, -prepDays), approximate, hint_ar: HINTS[id] };
}

/** Every season whose busy window starts in this Gregorian year, sorted by start. */
export function seasonsForYear(year: number): Season[] {
  const out: Season[] = [];
  const religious = religiousDates(year);
  if (religious) {
    out.push(season('ramadan', religious.ramadan_start, addDays(religious.eid_al_fitr, -1), 21, true));
    // The run-up to the Eid is the peak for clothing, gifts and travel, so the window opens a week before.
    out.push(season('eid_al_fitr', addDays(religious.eid_al_fitr, -7), addDays(religious.eid_al_fitr, 3), 21, true));
    // Sacrificial animals sell for weeks before the day.
    out.push(season('eid_al_adha', addDays(religious.eid_al_adha, -14), addDays(religious.eid_al_adha, 3), 28, true));
  }
  out.push(season('founding_day', dayString(year, 2, 15), dayString(year, 2, 23), 14, false));
  out.push(season('national_day', dayString(year, 9, 16), dayString(year, 9, 24), 14, false));
  const white = whiteFriday(year);
  out.push(season('white_friday', addDays(white, -7), addDays(white, 3), 42, false));
  // School start moves with the ministry calendar: a rough window, not a date.
  out.push(season('back_to_school', dayString(year, 8, 10), dayString(year, 9, 6), 21, true));
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function seasonsAround(day: string): Season[] {
  const year = Number(day.slice(0, 4));
  return [year - 1, year, year + 1].flatMap(seasonsForYear);
}

// ---------------------------------------------------------------------------
// Questions the loops ask
// ---------------------------------------------------------------------------

type Window = { from: string; to: string };

function overlaps(a: Window, b: Window) {
  return a.from <= b.to && b.from <= a.to;
}

/** Days after a season ends in which numbers are still bent by it (the post-peak dip). */
export const SEASON_AFTERGLOW_DAYS = 7;

/** Seasons that bend the numbers of a window: inside it, or ended up to 7 days before its end. */
export function distortingSeasons(window: Window): Season[] {
  return seasonsAround(window.to).filter((s) =>
    overlaps(window, { from: s.start, to: addDays(s.end, SEASON_AFTERGLOW_DAYS) })
  );
}

/**
 * Is it fair to compare two windows? Not when one sits in a season (or its
 * afterglow) and the other does not, or when they sit in different ones.
 */
export function compareWindows(current: Window, previous: Window): { fair: boolean; reason_ar: string | null } {
  const a = new Set(distortingSeasons(current).map((s) => s.id));
  const b = new Set(distortingSeasons(previous).map((s) => s.id));
  const same = a.size === b.size && [...a].every((id) => b.has(id));
  if (same) return { fair: true, reason_ar: null };
  const names = [...new Set([...a, ...b])].map((id) => NAMES[id]).join(' و');
  return { fair: false, reason_ar: `المقارنة غير عادلة لأن أحد الأسبوعين داخل موسم (${names})` };
}

export type SeasonContext = {
  today: string;
  /** Seasons whose busy window contains today. */
  active: Array<{ id: SeasonId; name_ar: string; ends_in_days: number; approximate: boolean }>;
  /** Seasons that ended in the last 7 days (their dip is still in the numbers). */
  recently_ended: Array<{ id: SeasonId; name_ar: string; ended_days_ago: number }>;
  /** Seasons that start within the horizon. in_prep_window: the account should be getting ready now. */
  upcoming: Array<{
    id: SeasonId;
    name_ar: string;
    starts_in_days: number;
    in_prep_window: boolean;
    approximate: boolean;
    hint_ar: string;
  }>;
  /** The last 7 days are inside a season or its afterglow: a week over week swing says little. */
  judgement_unreliable: boolean;
  caution_ar: string | null;
  /** Present when a season is close enough to prepare for. Fixed wording, no numbers of the account. */
  prep_budget_hint_ar: string | null;
};

export const DEFAULT_UPCOMING_HORIZON_DAYS = 60;

/** What the optimizer and the monthly session should know about the calendar today. */
export function seasonContext(today: string, horizonDays = DEFAULT_UPCOMING_HORIZON_DAYS): SeasonContext {
  const all = seasonsAround(today);
  const last7: Window = { from: addDays(today, -7), to: addDays(today, -1) };

  const active = all
    .filter((s) => s.start <= today && today <= s.end)
    .map((s) => ({ id: s.id, name_ar: s.name_ar, ends_in_days: daysBetween(today, s.end), approximate: s.approximate }));
  const recentlyEnded = all
    .filter((s) => s.end < today && daysBetween(s.end, today) <= SEASON_AFTERGLOW_DAYS)
    .map((s) => ({ id: s.id, name_ar: s.name_ar, ended_days_ago: daysBetween(s.end, today) }));
  const upcoming = all
    .filter((s) => s.start > today && daysBetween(today, s.start) <= horizonDays)
    .map((s) => ({
      id: s.id,
      name_ar: s.name_ar,
      starts_in_days: daysBetween(today, s.start),
      in_prep_window: today >= s.prep_from,
      approximate: s.approximate,
      hint_ar: s.hint_ar,
    }));

  const distorted = distortingSeasons(last7);
  const judgementUnreliable = distorted.length > 0;
  const preparing = upcoming.filter((u) => u.in_prep_window);

  return {
    today,
    active,
    recently_ended: recentlyEnded,
    upcoming,
    judgement_unreliable: judgementUnreliable,
    caution_ar: judgementUnreliable
      ? `آخر 7 أيام داخل موسم أو بعده مباشرة (${distorted.map((s) => s.name_ar).join(' و')}). لا تحكم على الأسبوع بمقارنته بأسبوع عادي`
      : null,
    prep_budget_hint_ar: preparing.length
      ? `${preparing[0].name_ar} قريب. الحملات الرابحة المحدودة بالميزانية تُجهّز لرفع تدريجي بخطوات من 10 إلى 20%، وبعد ما تعدي بوابة الربح المعتادة، مو قبلها`
      : null,
  };
}

/** Action types that cut money or reach, which a season dip must never trigger. */
const CUTTING_TYPES = new Set(['pause_campaign']);

/**
 * Deterministic rule used by the optimizer cron: while the last 7 days sit
 * inside a season (or its afterglow), a budget CUT or a campaign pause is held
 * back. Raises, keyword work, negatives and ad work stay as they are: they do
 * not rest on a week over week swing. Returns the reason code or null.
 */
export function seasonRejection(
  action: { type: string; params?: Record<string, unknown> | null },
  context: Pick<SeasonContext, 'judgement_unreliable'> | null | undefined
): 'season_week' | null {
  if (!context?.judgement_unreliable) return null;
  if (CUTTING_TYPES.has(action.type)) return 'season_week';
  if (action.type === 'adjust_budget') {
    const delta = Number(action.params?.delta_pct);
    const current = Number(action.params?.current_amount_micros);
    const next = Number(action.params?.new_amount_micros);
    if ((Number.isFinite(delta) && delta < 0) || (current > 0 && next > 0 && next < current)) return 'season_week';
  }
  return null;
}
