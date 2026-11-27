import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client';
import {
  applyIssue,
  applyReceipt,
  applyReturn,
  averageCost,
  emptyPools,
  totalQuantity,
  type Pools,
} from './inventory-cost';

const D = (value: string | number) => new Prisma.Decimal(value);
const avg = (pools: Pools) => averageCost(pools)?.toString() ?? null;

describe('moving weighted average', () => {
  it("re-averages on a new purchase (owner's example)", () => {
    // 30 bags already on hand at 670 = 20,100.
    let pools = applyReceipt(emptyPools(), D(30), D(670));
    expect(pools.costedValue.toString()).toBe('20100');
    expect(avg(pools)).toBe('670');

    // 100 more at 580 = 58,000 → 130 bags worth 78,100.
    pools = applyReceipt(pools, D(100), D(580));
    expect(pools.costedQuantity.toString()).toBe('130');
    expect(pools.costedValue.toString()).toBe('78100');
    expect(avg(pools)).toBe('600.769231');
  });

  it('costs a delivery at the average of that moment', () => {
    let pools = applyReceipt(emptyPools(), D(30), D(670));
    pools = applyReceipt(pools, D(100), D(580));

    const issue = applyIssue(pools, D(50));
    // 78,100 × 50 / 130 = 30,038.461538… — about ৳30,038.46 at two decimals.
    expect(issue.costAmount.toFixed(2)).toBe('30038.46');
    expect(issue.unitCost?.toString()).toBe('600.769231');
    expect(issue.uncostedQuantity.toString()).toBe('0');

    // The value left behind is exactly what was not taken.
    expect(issue.pools.costedQuantity.toString()).toBe('80');
    expect(issue.pools.costedValue.toFixed(2)).toBe('48061.54');
    expect(avg(issue.pools)).toBe('600.769231');
  });

  it('uses only the remaining stock when some was sold before the new purchase', () => {
    // 30 @ 670, deliver 10 (cost 6,700), leaving 20 worth 13,400.
    let pools = applyReceipt(emptyPools(), D(30), D(670));
    const issue = applyIssue(pools, D(10));
    expect(issue.costAmount.toString()).toBe('6700');
    pools = issue.pools;
    expect(pools.costedValue.toString()).toBe('13400');

    // Then 100 @ 580 → 120 bags worth 71,400, average exactly 595.
    pools = applyReceipt(pools, D(100), D(580));
    expect(pools.costedQuantity.toString()).toBe('120');
    expect(pools.costedValue.toString()).toBe('71400');
    expect(avg(pools)).toBe('595');
  });

  it('handles several purchases at different prices interleaved with deliveries', () => {
    let pools = applyReceipt(emptyPools(), D(100), D(500)); // 50,000
    pools = applyIssue(pools, D(40)).pools; // −20,000 → 60 @ 30,000
    pools = applyReceipt(pools, D(100), D(600)); // +60,000 → 160 @ 90,000
    expect(avg(pools)).toBe('562.5');
    pools = applyIssue(pools, D(60)).pools; // −33,750 → 100 @ 56,250
    pools = applyReceipt(pools, D(40), D(700)); // +28,000 → 140 @ 84,250
    expect(pools.costedQuantity.toString()).toBe('140');
    expect(pools.costedValue.toString()).toBe('84250');
    expect(avg(pools)).toBe('601.785714');
  });

  it('never lets rounding accumulate: the pool zeroes out exactly', () => {
    // A price that does not divide evenly, issued in thirds.
    let pools = applyReceipt(emptyPools(), D(3), D('100.01'));
    let residual = new Prisma.Decimal(0);
    for (let i = 0; i < 3; i += 1) {
      const issue = applyIssue(pools, D(1));
      pools = issue.pools;
      residual = residual.add(issue.roundingResidual);
    }
    expect(pools.costedQuantity.toString()).toBe('0');
    expect(pools.costedValue.toString()).toBe('0');
    expect(residual.toString()).toBe('0');
  });

  it('surfaces a stranded residue rather than leaving it in an empty pool', () => {
    let pools = applyReceipt(emptyPools(), D(3), D('10'));
    // Take an amount that leaves an inexact remainder, then empty the pool.
    pools = applyIssue(pools, D('0.001')).pools;
    const last = applyIssue(pools, pools.costedQuantity);
    expect(last.pools.costedQuantity.toString()).toBe('0');
    expect(last.pools.costedValue.toString()).toBe('0');
    expect(last.roundingResidual.abs().lessThan(D('0.000001'))).toBe(true);
  });
});

describe('uncosted stock stays separate', () => {
  it('a later purchase never prices earlier uncosted bags', () => {
    // 10 bags found with no cost, then 100 bought at 580.
    let pools = applyReceipt(emptyPools(), D(10), null);
    expect(pools.uncostedQuantity.toString()).toBe('10');
    expect(avg(pools)).toBeNull();

    pools = applyReceipt(pools, D(100), D(580));
    // The average is the purchase price, not 58,000 / 110 = 527.27.
    expect(avg(pools)).toBe('580');
    expect(pools.costedQuantity.toString()).toBe('100');
    expect(pools.uncostedQuantity.toString()).toBe('10');
    expect(totalQuantity(pools).toString()).toBe('110');
  });

  it('consumes the costed pool first and reports the uncosted spill', () => {
    let pools = applyReceipt(emptyPools(), D(10), null);
    pools = applyReceipt(pools, D(100), D(580));

    // 100 bags come out fully costed, the uncosted 10 are untouched.
    const first = applyIssue(pools, D(100));
    expect(first.costedQuantity.toString()).toBe('100');
    expect(first.costAmount.toString()).toBe('58000');
    expect(first.uncostedQuantity.toString()).toBe('0');
    expect(first.pools.uncostedQuantity.toString()).toBe('10');

    // The next 4 have no cost basis at all — never priced at zero silently.
    const second = applyIssue(first.pools, D(4));
    expect(second.costAmount.toString()).toBe('0');
    expect(second.uncostedQuantity.toString()).toBe('4');
    expect(second.unitCost).toBeNull();
    expect(second.pools.uncostedQuantity.toString()).toBe('6');
  });
});

describe('returns restore exactly what was taken', () => {
  it('a voided delivery puts the value back at its snapshot cost', () => {
    let pools = applyReceipt(emptyPools(), D(30), D(670));
    pools = applyReceipt(pools, D(100), D(580));
    const before = { ...pools };

    const issue = applyIssue(pools, D(50));
    const returned = applyReturn(issue.pools, {
      costedQuantity: issue.costedQuantity,
      unitCost: issue.unitCost,
      uncostedQuantity: issue.uncostedQuantity,
    });

    expect(returned.costedQuantity.toString()).toBe(before.costedQuantity.toString());
    // Within one unit of the stored scale; the average is undisturbed.
    expect(returned.costedValue.sub(before.costedValue).abs().lessThan(D('0.0001'))).toBe(true);
    expect(avg(returned)).toBe('600.769231');
  });

  it('a later purchase does not change what an earlier delivery already cost', () => {
    let pools = applyReceipt(emptyPools(), D(100), D(500));
    const issue = applyIssue(pools, D(50));
    expect(issue.costAmount.toString()).toBe('25000');

    // Buying dearer afterwards moves the average but not the snapshot.
    pools = applyReceipt(issue.pools, D(100), D(900));
    expect(avg(pools)).toBe('766.666667');
    expect(issue.costAmount.toString()).toBe('25000');

    // The return still uses the original snapshot, so value in equals value out.
    const returned = applyReturn(pools, {
      costedQuantity: issue.costedQuantity,
      unitCost: issue.unitCost,
      uncostedQuantity: issue.uncostedQuantity,
    });
    expect(returned.costedValue.sub(pools.costedValue).toString()).toBe('25000');
  });

  it('bags returned from a line that was never costed come back uncosted', () => {
    const pools = applyReceipt(emptyPools(), D(10), D(100));
    const returned = applyReturn(pools, {
      costedQuantity: D(5),
      unitCost: null,
      uncostedQuantity: D(0),
    });
    expect(returned.uncostedQuantity.toString()).toBe('5');
    expect(returned.costedValue.toString()).toBe('1000');
  });
});
