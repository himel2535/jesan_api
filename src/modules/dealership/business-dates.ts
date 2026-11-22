import { addDays, isCalendarDate, todayIn } from '../../core/common/business-time';
import { badRequest } from '../../core/errors';

/**
 * A document's business date: not in the future (business time zone), and
 * only `backdateLimitDays` back unless the person may correct such documents.
 * Codes: <SUBJECT>_INVALID / _IN_FUTURE / _TOO_OLD on the given field.
 */
export function checkBusinessDate(
  value: string | undefined,
  options: {
    timezone: string;
    backdateLimitDays: number;
    mayBackdate: boolean;
    subject: string;
    field: string;
    earliest?: string;
  },
): string {
  const today = todayIn(options.timezone);
  if (value === undefined) {
    return today;
  }
  if (!isCalendarDate(value)) {
    throw badRequest(`${options.subject}_INVALID`, 'Not a real date', options.field);
  }
  if (value > today) {
    throw badRequest(
      `${options.subject}_IN_FUTURE`,
      'The date cannot be in the future',
      options.field,
    );
  }
  if (options.earliest !== undefined && value < options.earliest) {
    throw badRequest(
      `${options.subject}_INVALID`,
      `The date cannot be before ${options.earliest}`,
      options.field,
    );
  }
  if (!options.mayBackdate && value < addDays(today, -options.backdateLimitDays)) {
    throw badRequest(
      `${options.subject}_TOO_OLD`,
      `Only the last ${String(options.backdateLimitDays)} days can be used`,
      options.field,
    );
  }
  return value;
}

export interface DateRange {
  from: string;
  to: string;
}

/** Whole days from `from` to `to` (both calendar dates, `to` the later one). */
export function daysBetween(from: string, to: string): number {
  const ms =
    new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The date range of a read-only report: what was asked, or this month in the
 * business's time zone. `to` is never before `from`. The span is not capped —
 * a caller may ask for the business's full lifetime — because every consumer
 * still paginates its rows/groups at `PAGE_SIZE`, so a wider span only grows
 * the aggregate scan, not the response size.
 * Codes: `FROM_INVALID` / `TO_INVALID`.
 */
export function resolveDateRange(
  query: { from?: string | undefined; to?: string | undefined },
  timezone: string,
): DateRange {
  const today = todayIn(timezone);
  if (query.from !== undefined && !isCalendarDate(query.from)) {
    throw badRequest('FROM_INVALID', 'Not a real date', 'from');
  }
  if (query.to !== undefined && !isCalendarDate(query.to)) {
    throw badRequest('TO_INVALID', 'Not a real date', 'to');
  }
  const from = query.from ?? `${today.slice(0, 7)}-01`;
  const to = query.to ?? (today > from ? today : from);
  if (to < from) {
    throw badRequest('TO_INVALID', 'The end date cannot be before the start date', 'to');
  }
  return { from, to };
}
