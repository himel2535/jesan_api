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
