import { Prisma } from '../../../generated/prisma/client';

export interface CommissionScheme {
  rateBase: Prisma.Decimal;
  targetQty: Prisma.Decimal;
  bonusRate: Prisma.Decimal;
}

export interface CommissionAmounts {
  baseAmount: Prisma.Decimal;
  bonusAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

/**
 * baseAmount = quantity × rateBase; bonusAmount = max(0, quantity − targetQty) ×
 * bonusRate (extra units above the target only); totalAmount = their sum.
 */
export function calculateCommission(
  quantity: Prisma.Decimal,
  scheme: CommissionScheme,
): CommissionAmounts {
  const baseAmount = quantity.mul(scheme.rateBase).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const extra = Prisma.Decimal.max(0, quantity.sub(scheme.targetQty));
  const bonusAmount = extra.mul(scheme.bonusRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { baseAmount, bonusAmount, totalAmount: baseAmount.add(bonusAmount) };
}
