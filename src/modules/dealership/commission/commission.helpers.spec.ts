import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client';
import { calculateCommission } from './commission.helpers';

const scheme = (rateBase: string, targetQty: string, bonusRate: string) => ({
  rateBase: new Prisma.Decimal(rateBase),
  targetQty: new Prisma.Decimal(targetQty),
  bonusRate: new Prisma.Decimal(bonusRate),
});

describe('calculateCommission', () => {
  it('charges only the base rate below target', () => {
    const result = calculateCommission(new Prisma.Decimal('8'), scheme('10', '10', '1'));
    expect(result.baseAmount.toFixed(2)).toBe('80.00');
    expect(result.bonusAmount.toFixed(2)).toBe('0.00');
    expect(result.totalAmount.toFixed(2)).toBe('80.00');
  });

  it('has no bonus exactly at the target (extra is zero)', () => {
    const result = calculateCommission(new Prisma.Decimal('10'), scheme('10', '10', '1'));
    expect(result.baseAmount.toFixed(2)).toBe('100.00');
    expect(result.bonusAmount.toFixed(2)).toBe('0.00');
    expect(result.totalAmount.toFixed(2)).toBe('100.00');
  });

  it('adds the bonus rate on units above the target', () => {
    const result = calculateCommission(new Prisma.Decimal('15'), scheme('10', '10', '1'));
    expect(result.baseAmount.toFixed(2)).toBe('150.00');
    expect(result.bonusAmount.toFixed(2)).toBe('5.00');
    expect(result.totalAmount.toFixed(2)).toBe('155.00');
  });

  it('scales the bonus with more units above the target', () => {
    const result = calculateCommission(new Prisma.Decimal('20'), scheme('10', '10', '1'));
    expect(result.baseAmount.toFixed(2)).toBe('200.00');
    expect(result.bonusAmount.toFixed(2)).toBe('10.00');
    expect(result.totalAmount.toFixed(2)).toBe('210.00');
  });

  it('charges only base when bonusRate is zero', () => {
    const result = calculateCommission(new Prisma.Decimal('15'), scheme('10', '10', '0'));
    expect(result.baseAmount.toFixed(2)).toBe('150.00');
    expect(result.bonusAmount.toFixed(2)).toBe('0.00');
    expect(result.totalAmount.toFixed(2)).toBe('150.00');
  });

  it('is zero for zero quantity', () => {
    const result = calculateCommission(new Prisma.Decimal('0'), scheme('10', '10', '1'));
    expect(result.baseAmount.toFixed(2)).toBe('0.00');
    expect(result.bonusAmount.toFixed(2)).toBe('0.00');
    expect(result.totalAmount.toFixed(2)).toBe('0.00');
  });
});
