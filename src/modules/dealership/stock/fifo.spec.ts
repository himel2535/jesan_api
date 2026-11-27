import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client';
import {
  costedPool,
  distributeMoney,
  emptyState,
  issue,
  netSlices,
  restore,
  takeBack,
  totalOnHand,
  uncostedOnHand,
  type FifoState,
} from './fifo';

const d = (value: string | number) => new Prisma.Decimal(value);
const state = (
  batches: [key: string, cost: string | null, remaining: string][],
  legacy = '0',
): FifoState => ({
  legacy: d(legacy),
  batches: batches.map(([key, cost, remaining]) => ({
    key,
    unitCost: cost === null ? null : d(cost),
    remaining: d(remaining),
  })),
});
const sum = (values: (Prisma.Decimal | null)[]) =>
  values.reduce<Prisma.Decimal>((acc, v) => acc.add(v ?? 0), d(0));

describe('FIFO issue', () => {
  it('100 @ 570 then 100 @ 580, deliver 120: 57,000 + 11,600 = 68,600, 80 left worth 46,400', () => {
    const out = issue(
      state([
        ['A', '570', '100'],
        ['B', '580', '100'],
      ]),
      d(120),
    );
    expect(out.shortfall.toString()).toBe('0');
    expect(
      out.slices.map((s) => [s.batchKey, s.quantity.toString(), s.costAmount?.toString()]),
    ).toEqual([
      ['A', '100', '57000'],
      ['B', '20', '11600'],
    ]);
    expect(sum(out.slices.map((s) => s.costAmount)).toString()).toBe('68600');
    expect(out.state.batches.map((b) => b.remaining.toString())).toEqual(['0', '80']);
    const pool = costedPool(out.state);
    expect(pool.quantity.toString()).toBe('80');
    expect(pool.value.toString()).toBe('46400');
  });

  it('does not change the state it was given', () => {
    const before = state([['A', '570', '100']]);
    issue(before, d(40));
    expect(before.batches[0]?.remaining.toString()).toBe('100');
  });

  it('takes legacy stock first and never gives it a cost', () => {
    const out = issue(state([['A', '570', '10']], '5'), d(8));
    expect(out.slices).toHaveLength(2);
    expect(out.slices[0]).toMatchObject({ batchKey: null, costAmount: null, unitCost: null });
    expect(out.slices[1]?.costAmount?.toString()).toBe('1710');
    expect(out.state.legacy.toString()).toBe('0');
  });

  it('delivers unknown-cost bags in their turn, flagged with a null cost (not zero)', () => {
    const out = issue(
      state([
        ['F', null, '10'],
        ['B', '580', '10'],
      ]),
      d(15),
    );
    expect(out.slices[0]).toMatchObject({ batchKey: 'F', costAmount: null });
    expect(out.slices[1]?.costAmount?.toString()).toBe('2900');
    expect(uncostedOnHand(out.state).toString()).toBe('0');
  });

  it('reports a shortfall instead of going below zero', () => {
    const out = issue(state([['A', '570', '10']]), d(15));
    expect(out.shortfall.toString()).toBe('5');
    expect(totalOnHand(out.state).toString()).toBe('0');
  });

  it('keeps fractional bags exact', () => {
    const out = issue(state([['A', '570.55', '10.5']]), d('2.25'));
    expect(out.slices[0]?.costAmount?.toString()).toBe('1283.7375');
  });

  it('an empty state has nothing to issue', () => {
    expect(issue(emptyState(), d(1)).shortfall.toString()).toBe('1');
  });
});

describe('FIFO return', () => {
  it('takes the last bags out first and puts them back in the batches they came from', () => {
    const start = state([
      ['A', '570', '100'],
      ['B', '580', '100'],
    ]);
    const out = issue(start, d(120));
    const back = takeBack(out.slices, d(30));
    expect(back.returned.map((s) => [s.batchKey, s.quantity.toString()])).toEqual([
      ['B', '20'],
      ['A', '10'],
    ]);
    const restored = restore(out.state, back.returned);
    expect(restored.batches.map((b) => b.remaining.toString())).toEqual(['10', '100']);
    expect(sum(back.returned.map((s) => s.costAmount)).toString()).toBe('17300');
  });

  it('a slice whose batch is gone returns to legacy stock', () => {
    const restored = restore(emptyState(), [
      { batchKey: 'gone', quantity: d(4), unitCost: d(570), costAmount: d(2280) },
    ]);
    expect(restored.legacy.toString()).toBe('4');
  });

  it('nets issues and returns per batch', () => {
    const out = issue(
      state([
        ['A', '570', '100'],
        ['B', '580', '100'],
      ]),
      d(120),
    );
    const back = takeBack(out.slices, d(20)).returned.map((s) => ({
      ...s,
      quantity: s.quantity.negated(),
      costAmount: s.costAmount?.negated() ?? null,
    }));
    const net = netSlices([...out.slices, ...back]);
    expect(net.map((s) => [s.batchKey, s.quantity.toString()])).toEqual([['A', '100']]);
  });
});

describe('revenue split', () => {
  it('splits a line total by the bags taken from each batch and always adds up', () => {
    const parts = distributeMoney(d('108000'), [d(100), d(20)]);
    expect(parts.map((p) => p.toString())).toEqual(['90000', '18000']);
    const odd = distributeMoney(d('100.00'), [d(1), d(1), d(1)]);
    expect(odd.map((p) => p.toString())).toEqual(['33.33', '33.33', '33.34']);
    expect(sum(odd).toString()).toBe('100');
  });

  it('handles a negative total (a return) and a zero weight sum', () => {
    expect(sum(distributeMoney(d('-50.01'), [d(3), d(7)])).toString()).toBe('-50.01');
    expect(distributeMoney(d('10'), [d(0)]).map((p) => p.toString())).toEqual(['10']);
  });
});
