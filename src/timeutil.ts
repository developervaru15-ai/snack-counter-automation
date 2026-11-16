/**
 * Business-time arithmetic, so a Friday-evening offer does not expire over the weekend.
 *
 * A "LocalDate" is a plain "YYYY-MM-DD" string: it sorts correctly as text, so range checks are simple.
 * Weekdays are numbered Monday = 0 ... Sunday = 6.
 *
 * Deadlines are computed on the office's wall clock: a local time is turned into a "wall" number
 * (the local fields read as if they were UTC), moved around, then converted back to a real instant.
 * Office hours are 09-18, so DST changes (which happen at night) never land inside the arithmetic.
 */

export type LocalDate = string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;   // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // Monday = 0
}

/** The wall-clock reading of instant `d` in time zone `tz`, as milliseconds (local fields read as UTC). */
function wall(d: Date, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(d)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) + d.getUTCMilliseconds();
}

/** The real instant whose wall-clock reading in `tz` is `ms`. */
function fromWall(ms: number, tz: string): Date {
  let guess = ms;
  for (let i = 0; i < 2; i++) guess = ms - (wall(new Date(guess), tz) - guess);
  return new Date(guess);
}

function weekdayOfWall(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

const startOfDay = (ms: number): number => Math.floor(ms / DAY) * DAY;

export function localParts(d: Date, tz: string): LocalParts {
  const w = new Date(wall(d, tz));
  return {
    year: w.getUTCFullYear(), month: w.getUTCMonth() + 1, day: w.getUTCDate(),
    hour: w.getUTCHours(), minute: w.getUTCMinutes(), weekday: weekdayOfWall(w.getTime()),
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function localDate(d: Date, tz: string): LocalDate {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "2026-11" in the given time zone. */
export function monthOf(d: Date, tz: string): string {
  return localDate(d, tz).slice(0, 7);
}

/** "Tue 10:00" in the given time zone. */
export function formatLocal(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${DAY_NAMES[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function weekdayOf(date: LocalDate): number {
  return weekdayOfWall(Date.parse(`${date}T00:00:00Z`));
}

function addDays(date: LocalDate, n: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Every calendar date (in tz) from start to end, inclusive. */
export function localDates(start: Date, end: Date, tz: string): LocalDate[] {
  const last = localDate(end, tz);
  const out: LocalDate[] = [];
  for (let d = localDate(start, tz); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Move t forward to the next moment inside business time (Mon-Fri, openH-closeH). */
function snap(t: number, openH: number, closeH: number): number {
  for (;;) {
    const hour = new Date(t).getUTCHours();
    if (weekdayOfWall(t) >= 5) t = startOfDay(t) + DAY + openH * HOUR;
    else if (hour < openH) return startOfDay(t) + openH * HOUR;
    else if (hour >= closeH) t = startOfDay(t) + DAY + openH * HOUR;
    else return t;
  }
}

/**
 * The moment `hours` of office time after `start`, measured on the office wall clock.
 * Public holidays are not modelled (see DESIGN.md).
 */
export function addBusinessHours(start: Date, hours: number, tz: string, openH = 9, closeH = 18): Date {
  let t = wall(start, tz);
  let remaining = hours * HOUR;
  for (;;) {
    t = snap(t, openH, closeH);
    const endOfDay = startOfDay(t) + closeH * HOUR;
    if (remaining <= endOfDay - t) return fromWall(t + remaining, tz);
    remaining -= endOfDay - t;
    t = endOfDay;
  }
}
