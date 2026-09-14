/**
 * Calendar-date arithmetic on `YYYY-MM-DD` strings, in whatever timezone the caller
 * means. Date-only values have no zone, so UTC is just a safe counting frame here
 * and no date library is needed (D§7.1).
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function isLocalDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

function toUtcMillis(date: string): number {
  if (!isLocalDate(date)) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day);
}

/** `addDays('2026-02-28', 1)` → `'2026-03-01'`. Negative counts go backwards. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(toUtcMillis(date) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** `count` consecutive dates starting at `start`. */
export function dateRange(start: string, count: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < count; i += 1) dates.push(addDays(start, i));
  return dates;
}

/** Negative, zero or positive, like any comparator. */
export function compareDates(a: string, b: string): number {
  return toUtcMillis(a) - toUtcMillis(b);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / MS_PER_DAY);
}

/** The date part of an Open-Meteo local timestamp, `2026-09-14T13:00` → `2026-09-14`. */
export function dateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** The local hour of an Open-Meteo timestamp, `2026-09-14T13:00` → `13`. */
export function hourOf(timestamp: string): number {
  return Number(timestamp.slice(11, 13));
}
