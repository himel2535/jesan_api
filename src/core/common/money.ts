import { Prisma } from '../../generated/prisma/client';

/** Money in the API: a decimal string with up to 2 places, e.g. "570" or "570.50". */
export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
/** Like MONEY_PATTERN but may be negative (balances: negative = advance). */
export const SIGNED_MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;

/** Money leaves the API as a string with exactly two decimals, never a float. */
export function moneyString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function moneyStringOrNull(value: Prisma.Decimal | null): string | null {
  return value === null ? null : moneyString(value);
}

export function toDecimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
