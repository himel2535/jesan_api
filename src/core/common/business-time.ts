/**
 * Business dates. A business works in its own time zone (from its settings):
 * a purchase dated 2026-12-01 belongs to December there, whatever the server's
 * clock says. Dates travel as `YYYY-MM-DD` strings and are stored in DATE
 * columns (written as UTC midnight of that calendar day).
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Today's date in the time zone, e.g. "2026-11-18". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The calendar date `days` after `date` (negative goes back). */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** A DATE column value for the calendar date. */
export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The calendar date of a DATE column value. */
export function fromDbDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYYMM` of a calendar date, e.g. 202611. */
export function periodOf(date: string): number {
  return Number(date.slice(0, 4)) * 100 + Number(date.slice(5, 7));
}

/** Offset of the time zone from UTC at an instant, in minutes (Dhaka: +360). */
function offsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The instant the calendar date starts in the time zone (Dhaka: 18:00 UTC the day before). */
export function dayStartIn(date: string, timeZone: string): Date {
  const utcMidnight = toDbDate(date).getTime();
  // Two passes settle zones whose offset changes near midnight.
  let guess = utcMidnight - offsetMinutes(timeZone, new Date(utcMidnight)) * 60_000;
  guess = utcMidnight - offsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess);
}
