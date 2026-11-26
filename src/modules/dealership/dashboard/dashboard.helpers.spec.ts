import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client';
import {
  bucketOf,
  closingOf,
  foldLedgerBuckets,
  monthKey,
  monthKeyOf,
  monthRange,
} from './dashboard.helpers';

const D = (value: string) => new Prisma.Decimal(value);
const CASH = new Set(['cash']);

describe('monthRange', () => {
  it('covers each month exactly, including leap years', () => {
    expect(monthRange(2026, 11)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('keys months as YYYY-MM', () => {
    expect(monthKey(2026, 3)).toBe('2026-03');
    expect(monthKeyOf('2026-11-19')).toBe('2026-11');
  });
});

describe('bucketOf', () => {
  it('splits cash, bank and rows without a method', () => {
    expect(bucketOf('cash', CASH)).toBe('cash');
    expect(bucketOf('bkash', CASH)).toBe('bank');
    expect(bucketOf(null, CASH)).toBe('unassigned');
  });
});

describe('foldLedgerBuckets', () => {
  const opening = [
    { type: 'collection', method: 'cash', direction: 'in', amount: D('1000.00') },
    { type: 'expense', method: 'cash', direction: 'out', amount: D('200.00') },
    { type: 'collection', method: 'bank', direction: 'in', amount: D('500.00') },
    { type: 'commission_receipt', method: null, direction: 'in', amount: D('300.00') },
  ];
  const period = [
    { type: 'collection', method: 'cash', direction: 'in', amount: D('400.00') },
    { type: 'purchase', method: 'cash', direction: 'out', amount: D('150.00') },
    { type: 'supplier_payment', method: 'bank', direction: 'out', amount: D('100.00') },
    { type: 'commission_receipt', method: null, direction: 'in', amount: D('250.00') },
  ];

  it('gives opening and closing balances per bucket from the ledger rows', () => {
    const buckets = foldLedgerBuckets(period, opening, CASH);
    expect(buckets.cash.opening.toFixed(2)).toBe('800.00');
    expect(closingOf(buckets.cash).toFixed(2)).toBe('1050.00');
    expect(buckets.bank.opening.toFixed(2)).toBe('500.00');
    expect(closingOf(buckets.bank).toFixed(2)).toBe('400.00');
    expect(closingOf(buckets.unassigned).toFixed(2)).toBe('550.00');
  });

  it('counts only collections as actual collection, but all money in as in', () => {
    const buckets = foldLedgerBuckets(period, opening, CASH);
    expect(buckets.cash.collectionsIn.toFixed(2)).toBe('400.00');
    expect(buckets.cash.in.toFixed(2)).toBe('400.00');
    expect(buckets.unassigned.collectionsIn.toFixed(2)).toBe('0.00');
    expect(buckets.unassigned.in.toFixed(2)).toBe('250.00');
  });

  it('reconciles: the three buckets add up to the whole ledger net', () => {
    const buckets = foldLedgerBuckets(period, opening, CASH);
    const total = closingOf(buckets.cash)
      .add(closingOf(buckets.bank))
      .add(closingOf(buckets.unassigned));
    // Whole-ledger net = (1000 + 500 + 300 − 200) + (400 + 250 − 150 − 100) = 1600 + 400 = 2000
    expect(total.toFixed(2)).toBe('2000.00');
  });
});
