import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayStartIn,
  fromDbDate,
  isCalendarDate,
  periodOf,
  toDbDate,
  todayIn,
} from './business-time';

describe('business time', () => {
  it('knows real calendar dates', () => {
    expect(isCalendarDate('2026-11-30')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-11-31')).toBe(false);
    expect(isCalendarDate('2026-1-5')).toBe(false);
  });

  it('gives today in the business time zone, not the server’s', () => {
    // 30 Nov 23:59 in Dhaka is 17:59 UTC; 1 Dec 00:00 in Dhaka is 18:00 UTC.
    expect(todayIn('Asia/Dhaka', new Date('2026-11-30T17:59:59.999Z'))).toBe('2026-11-30');
    expect(todayIn('Asia/Dhaka', new Date('2026-11-30T18:00:00.000Z'))).toBe('2026-12-01');
    expect(todayIn('Asia/Dhaka', new Date('2026-12-31T18:00:00.000Z'))).toBe('2027-01-01');
    expect(todayIn('UTC', new Date('2026-11-30T18:00:00.000Z'))).toBe('2026-11-30');
  });

  it('turns dates into months and back and forth from DATE columns', () => {
    expect(periodOf('2026-11-30')).toBe(202611);
    expect(periodOf('2027-01-01')).toBe(202701);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(fromDbDate(toDbDate('2026-10-31'))).toBe('2026-10-31');
  });

  it('finds the start of a day in the time zone', () => {
    expect(dayStartIn('2026-12-01', 'Asia/Dhaka').toISOString()).toBe('2026-11-30T18:00:00.000Z');
    expect(dayStartIn('2026-12-01', 'UTC').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(dayStartIn('2026-12-01', 'Asia/Kolkata').toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });
});
