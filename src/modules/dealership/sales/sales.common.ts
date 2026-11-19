import { Prisma } from '../../../generated/prisma/client';

export const DELIVERY_WINDOWS = ['today', 'two_days', 'one_week'] as const;
export type DeliveryWindow = (typeof DELIVERY_WINDOWS)[number];

/** pending (nothing delivered yet), partial or delivered: must match the CHECK. */
export function deliveryStatusOf(delivered: Prisma.Decimal, total: Prisma.Decimal): string {
  if (delivered.isZero()) return 'pending';
  return delivered.equals(total) ? 'delivered' : 'partial';
}

export function isUniqueViolation(error: unknown, hint: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (JSON.stringify(error.meta ?? {}) + error.message).includes(hint)
  );
}

export function signedQuantity(value: Prisma.Decimal): string {
  return `${value.isNegative() ? '' : '+'}${value.toString()}`;
}

export function signedMoney(value: Prisma.Decimal): string {
  return `${value.isNegative() ? '' : '+'}${value.toFixed(2)}`;
}
