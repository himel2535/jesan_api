import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, todayIn, toDbDate } from '../../../core/common/business-time';
import { uuid7 } from '../../../core/common/uuid7';
import { PrismaService } from '../../../core/database/prisma.service';
import { DealershipContext } from '../master-data/master-data.context';
import { snapshotOf, type FifoState, type Slice } from './fifo';
import { InventoryCostingService, type ReplayResult } from './inventory-costing.service';
import { StockLedger, poolsOf } from './stock-ledger';

const ZERO = new Prisma.Decimal(0);
const SCALE = 6;

type WriteResult =
  { reason: string; summary: null } | { reason: null; summary: Record<string, unknown> };

export type ProductStatus = 'ready' | 'already_batched' | 'unresolved';

export interface LinePlan {
  deliveryItemId: string;
  deliveryCode: string;
  deliveryDate: string;
  status: string;
  quantity: string;
  /** Cost as reported today: null = never costed (the dashboard counts it as 0). */
  costBefore: string | null;
  /** Where today's snapshot came from: null = moving average (or none), live, backfill. */
  costSourceBefore: string | null;
  /** FIFO cost of the known bags; null when none of the bags has a known cost. */
  costAfter: string | null;
  unknownCostQuantity: string;
  /** costAfter − costBefore (null cost counts as 0), for lines that count towards sales today. */
  difference: string;
  /** True when the line carries a moving-average snapshot that FIFO would disagree with. */
  policyChange: boolean;
}

export interface ProductPlan {
  productId: string;
  code: string;
  currentStock: string;
  status: ProductStatus;
  problems: string[];
  batches: { source: string; date: string; quantity: string; unitCost: string | null }[];
  lines: LinePlan[];
  cogsBefore: string;
  cogsAfter: string;
  /** Σ differences on lines holding a moving-average snapshot (what a policy correction would book). */
  policyDifference: string;
  /** Σ differences on lines never costed before (they simply gain a cost). */
  newlyCosted: string;
  remainingQuantity: string;
  remainingValue: string;
  /** Bags on hand whose cost cannot be known. */
  unknownCostOnHand: string;
}

export interface BackfillReport {
  businessId: string;
  products: ProductPlan[];
  totals: {
    products: number;
    ready: number;
    unresolved: number;
    alreadyBatched: number;
    batches: number;
    linesAffected: number;
    cogsBefore: string;
    cogsAfter: string;
    /** Net profit moves by the opposite of the cogs change (sales, expenses and commission are untouched). */
    netProfitChange: string;
    policyDifference: string;
    remainingValue: string;
    unknownCostLines: number;
  };
  /** Identifies exactly what this report says; a commit must present it. */
  fingerprint: string;
}

const text = (value: Prisma.Decimal | null, places = 2) =>
  value === null ? null : value.toDecimalPlaces(places).toFixed(places);

/**
 * Rebuilds FIFO batches for stock and deliveries that predate them, from the history already in the
 * database. Planning changes nothing. A commit requires the fingerprint of a plan the owner has read,
 * is idempotent (a product that already has batches is skipped), works one product per transaction,
 * tags every row with a run id, and can be rolled back. It never invents a price: bags that arrived
 * with none stay unknown-cost, and a product whose history does not add up is reported and skipped.
 * Moving-average snapshots already frozen on delivery lines are never rewritten; the difference to
 * FIFO is only booked, as one `costing_policy_change` correction, if the owner asks for it.
 */
@Injectable()
export class FifoBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly costing: InventoryCostingService,
    private readonly ledger: StockLedger,
  ) {}

  /** Reads everything and writes nothing. */
  async plan(businessId: string): Promise<BackfillReport> {
    const db = this.prisma.forBusiness(businessId);
    const products = await db.product.findMany({
      select: { id: true },
      orderBy: { code: 'asc' },
    });
    const plans: ProductPlan[] = [];
    for (const product of products) {
      plans.push(await db.$transaction((tx) => this.planProduct(tx, product.id)));
    }
    return this.report(businessId, plans);
  }

  /**
   * Writes what `plan` described, product by product. `fingerprint` must be the one of the plan that was
   * reviewed; a product whose plan has changed since is skipped, not guessed at.
   */
  async commit(
    businessId: string,
    options: {
      fingerprint: string;
      actorUserId: string;
      bookPolicyCorrection: boolean;
    },
  ): Promise<{
    runId: string;
    written: string[];
    skipped: { productId: string; reason: string }[];
  }> {
    const reviewed = await this.plan(businessId);
    if (reviewed.fingerprint !== options.fingerprint) {
      throw new Error(
        'The history changed since the report was read, or the fingerprint is not the one printed. ' +
          'Run the dry run again and review it before committing.',
      );
    }
    const db = this.prisma.forBusiness(businessId);
    const config = await this.context.config(businessId);
    const today = todayIn(config.timezone);
    const runId = uuid7();
    await db.inventoryBackfillRun.create({
      data: { id: runId, businessId, status: 'running', summary: {} },
    });
    const written: string[] = [];
    const skipped: { productId: string; reason: string }[] = [];
    const summary: Record<string, unknown>[] = [];
    for (const plan of reviewed.products) {
      if (plan.status !== 'ready') {
        skipped.push({ productId: plan.productId, reason: plan.status });
        continue;
      }
      const result = await db.$transaction(async (tx): Promise<WriteResult> => {
        await this.ledger.lock(tx, businessId, [plan.productId]);
        const again = await this.planProduct(tx, plan.productId);
        if (again.status !== 'ready' || again.cogsAfter !== plan.cogsAfter) {
          return { reason: 'the product changed while the backfill was running', summary: null };
        }
        return {
          reason: null,
          summary: await this.writeProduct(tx, {
            businessId,
            runId,
            today,
            actorUserId: options.actorUserId,
            bookPolicyCorrection: options.bookPolicyCorrection,
            plan: again,
          }),
        };
      });
      if (result.summary === null) {
        skipped.push({ productId: plan.productId, reason: result.reason });
      } else {
        written.push(plan.productId);
        summary.push(result.summary);
      }
    }
    await db.inventoryBackfillRun.update({
      where: { id: runId },
      data: { status: 'committed', summary: { products: summary } as Prisma.InputJsonValue },
    });
    return { runId, written, skipped };
  }

  /**
   * Undoes a committed run: deletes what it wrote and puts the product pools and the delivery snapshots it
   * filled back as they were. Refused if anything has since been recorded against its batches.
   */
  async rollback(businessId: string, runId: string): Promise<{ products: number }> {
    const db = this.prisma.forBusiness(businessId);
    const run = await db.inventoryBackfillRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'committed') throw new Error(`Run ${runId} is ${run.status}, not committed`);
    const summary =
      (
        run.summary as {
          products?: {
            productId: string;
            poolsBefore: Record<string, string>;
            filledLines: string[];
          }[];
        }
      ).products ?? [];
    await db.$transaction(async (tx) => {
      const later = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT (
          (SELECT count(*) FROM delivery_item_allocations a
             JOIN inventory_batches b ON b.id = a.batch_id
            WHERE b.backfill_run_id = ${runId}::uuid AND a.backfill_run_id IS DISTINCT FROM ${runId}::uuid)
          + (SELECT count(*) FROM inventory_batch_events e
               JOIN inventory_batches b ON b.id = e.batch_id
              WHERE b.backfill_run_id = ${runId}::uuid AND e.backfill_run_id IS DISTINCT FROM ${runId}::uuid)
        ) AS n`;
      if (Number(later[0]?.n ?? 0) > 0) {
        throw new Error(
          'Cannot roll back: deliveries, corrections or edits were recorded against these batches since.',
        );
      }
      await tx.$executeRaw`SELECT set_config('jesan.allow_fifo_rollback', 'on', true)`;
      for (const entry of summary) {
        await tx.$executeRaw`SELECT 1 FROM products WHERE id = ${entry.productId}::uuid FOR UPDATE`;
      }
      await tx.inventoryCostCorrection.deleteMany({
        where: { sourceType: 'backfill', sourceId: runId },
      });
      await tx.deliveryItemAllocation.deleteMany({ where: { backfillRunId: runId } });
      await tx.inventoryBatchEvent.deleteMany({ where: { backfillRunId: runId } });
      await tx.inventoryBatch.deleteMany({ where: { backfillRunId: runId } });
      for (const entry of summary) {
        if (entry.filledLines.length > 0) {
          await tx.deliveryItem.updateMany({
            where: { id: { in: entry.filledLines } },
            data: { unitCost: null, costAmount: null, uncostedQuantity: 0, costSource: null },
          });
        }
        await tx.product.update({
          where: { id: entry.productId },
          data: {
            costedQuantity: new Prisma.Decimal(entry.poolsBefore['costedQuantity'] ?? '0'),
            costedValue: new Prisma.Decimal(entry.poolsBefore['costedValue'] ?? '0'),
            uncostedQuantity: new Prisma.Decimal(entry.poolsBefore['uncostedQuantity'] ?? '0'),
          },
        });
      }
      await tx.inventoryBackfillRun.update({
        where: { id: runId },
        data: { status: 'rolled_back', rolledBackAt: new Date() },
      });
    });
    return { products: summary.length };
  }

  // ---------------------------------------------------------------------------

  private async planProduct(tx: Prisma.TransactionClient, productId: string): Promise<ProductPlan> {
    const product = await tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { id: true, code: true, currentStock: true },
    });
    const base = {
      productId,
      code: product.code,
      currentStock: product.currentStock.toString(),
      batches: [] as ProductPlan['batches'],
      lines: [] as LinePlan[],
      cogsBefore: '0.00',
      cogsAfter: '0.00',
      policyDifference: '0.00',
      newlyCosted: '0.00',
      remainingQuantity: '0',
      remainingValue: '0.00',
      unknownCostOnHand: '0',
    };
    if ((await tx.inventoryBatch.count({ where: { productId } })) > 0) {
      return { ...base, status: 'already_batched', problems: [] };
    }
    const replay = await this.costing.replayProduct(tx, productId, { rebuild: true });
    const problems: string[] = [];
    if (replay.negativeAt) {
      problems.push(
        `stock goes below zero on ${replay.negativeAt.date} by ${replay.negativeAt.shortfall.toString()} (a delivery is dated before the purchase that supplied it)`,
      );
    }
    if (!replay.endQuantity.equals(product.currentStock)) {
      problems.push(
        `the replayed history ends at ${replay.endQuantity.toString()} but current stock is ${product.currentStock.toString()}`,
      );
    }

    const lineRows = await tx.deliveryItem.findMany({
      where: { productId },
      select: {
        id: true,
        deliveryId: true,
        quantity: true,
        status: true,
        costAmount: true,
        costSource: true,
      },
    });
    const deliveries = lineRows.length
      ? await tx.delivery.findMany({
          where: { id: { in: lineRows.map((line) => line.deliveryId) } },
          select: { id: true, code: true, deliveryDate: true, status: true },
        })
      : [];
    const deliveryOf = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
    const lines: LinePlan[] = [];
    let before = ZERO;
    let after = ZERO;
    let policy = ZERO;
    let newly = ZERO;
    for (const line of lineRows) {
      const delivery = deliveryOf.get(line.deliveryId);
      if (!delivery) continue;
      const counts = line.status === 'active' && delivery.status === 'active';
      const slices = (counts ? replay.deliveries : replay.issued).get(line.deliveryId) ?? [];
      const held = slices.reduce((sum, slice) => sum.add(slice.quantity), ZERO);
      if (counts && !held.equals(line.quantity)) {
        problems.push(
          `delivery ${delivery.code} holds ${line.quantity.toString()} bags but the replay found ${held.toString()}`,
        );
      }
      const snapshot = snapshotOf(slices);
      const diff = (snapshot.costAmount ?? ZERO).sub(line.costAmount ?? ZERO);
      const legacySnapshot = line.costSource === null && line.costAmount !== null;
      if (counts) {
        before = before.add(line.costAmount ?? ZERO);
        after = after.add(snapshot.costAmount ?? ZERO);
        if (legacySnapshot) policy = policy.add(diff);
        else if (line.costAmount === null) newly = newly.add(diff);
      }
      lines.push({
        deliveryItemId: line.id,
        deliveryCode: delivery.code,
        deliveryDate: fromDbDate(delivery.deliveryDate),
        status: counts ? 'active' : 'void',
        quantity: line.quantity.toString(),
        costBefore: text(line.costAmount),
        costSourceBefore: line.costSource,
        costAfter: text(snapshot.costAmount),
        unknownCostQuantity: snapshot.uncostedQuantity.toString(),
        difference: diff.toDecimalPlaces(2).toFixed(2),
        policyChange: counts && legacySnapshot && !diff.isZero(),
      });
    }
    lines.sort(
      (a, b) =>
        a.deliveryDate.localeCompare(b.deliveryDate) ||
        a.deliveryCode.localeCompare(b.deliveryCode),
    );

    const sources = [...replay.sources.values()]
      .filter((source) => source.quantity.greaterThan(0))
      .sort((a, b) => a.date.localeCompare(b.date) || Number(a.seq - b.seq));
    let remainingQuantity = ZERO;
    let remainingValue = ZERO;
    let unknownOnHand = ZERO;
    for (const source of sources) {
      const left = replay.remaining.get(source.key) ?? ZERO;
      remainingQuantity = remainingQuantity.add(left);
      if (source.unitCost === null) unknownOnHand = unknownOnHand.add(left);
      else remainingValue = remainingValue.add(left.mul(source.unitCost));
    }
    if (unknownOnHand.greaterThan(0)) {
      problems.push(
        `${unknownOnHand.toString()} bags on hand arrived with no price (a stock adjustment); they stay unknown-cost`,
      );
    }
    const unknownLines = lines.filter(
      (line) => line.status === 'active' && Number(line.unknownCostQuantity) > 0,
    );
    if (unknownLines.length > 0) {
      problems.push(
        `${String(unknownLines.length)} delivery line(s) include bags with no known cost; their cost stays incomplete`,
      );
    }
    const blocking =
      replay.negativeAt !== null ||
      !replay.endQuantity.equals(product.currentStock) ||
      lines.some(
        (line) =>
          line.status === 'active' &&
          problems.some((p) => p.startsWith(`delivery ${line.deliveryCode} holds`)),
      );
    return {
      ...base,
      status: blocking ? 'unresolved' : 'ready',
      problems,
      batches: sources.map((source) => ({
        source: `${source.sourceType} ${source.sourceId}`,
        date: source.date,
        quantity: source.quantity.toString(),
        unitCost: text(source.unitCost),
      })),
      lines,
      cogsBefore: before.toDecimalPlaces(2).toFixed(2),
      cogsAfter: after.toDecimalPlaces(2).toFixed(2),
      policyDifference: policy.toDecimalPlaces(2).toFixed(2),
      newlyCosted: newly.toDecimalPlaces(2).toFixed(2),
      remainingQuantity: remainingQuantity.toString(),
      remainingValue: remainingValue.toDecimalPlaces(2).toFixed(2),
      unknownCostOnHand: unknownOnHand.toString(),
    };
  }

  private report(businessId: string, products: ProductPlan[]): BackfillReport {
    const sum = (pick: (plan: ProductPlan) => string) =>
      products.reduce((total, plan) => total.add(pick(plan)), ZERO);
    const before = sum((plan) => plan.cogsBefore);
    const after = sum((plan) => plan.cogsAfter);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(products))
      .digest('hex')
      .slice(0, 16);
    return {
      businessId,
      products,
      totals: {
        products: products.length,
        ready: products.filter((plan) => plan.status === 'ready').length,
        unresolved: products.filter((plan) => plan.status === 'unresolved').length,
        alreadyBatched: products.filter((plan) => plan.status === 'already_batched').length,
        batches: products.reduce((n, plan) => n + plan.batches.length, 0),
        linesAffected: products.reduce((n, plan) => n + plan.lines.length, 0),
        cogsBefore: before.toFixed(2),
        cogsAfter: after.toFixed(2),
        netProfitChange: before.sub(after).toFixed(2),
        policyDifference: sum((plan) => plan.policyDifference).toFixed(2),
        remainingValue: sum((plan) => plan.remainingValue).toFixed(2),
        unknownCostLines: products.reduce(
          (n, plan) =>
            n +
            plan.lines.filter(
              (line) => line.status === 'active' && Number(line.unknownCostQuantity) > 0,
            ).length,
          0,
        ),
      },
      fingerprint,
    };
  }

  private async writeProduct(
    tx: Prisma.TransactionClient,
    input: {
      businessId: string;
      runId: string;
      today: string;
      actorUserId: string;
      bookPolicyCorrection: boolean;
      plan: ProductPlan;
    },
  ): Promise<Record<string, unknown>> {
    const { businessId, runId, plan } = input;
    const replay: ReplayResult = await this.costing.replayProduct(tx, plan.productId, {
      rebuild: true,
    });
    const before = await tx.product.findUniqueOrThrow({
      where: { id: plan.productId },
      select: { costedQuantity: true, costedValue: true, uncostedQuantity: true },
    });

    // Batches: one per purchase and per found-bags adjustment, at the values as they stand now.
    const batchOf = new Map<string, string>();
    const open = [...replay.sources.values()]
      .filter((source) => source.quantity.greaterThan(0))
      .sort((a, b) => a.date.localeCompare(b.date) || Number(a.seq - b.seq));
    for (const source of open) batchOf.set(source.key, uuid7());
    await tx.inventoryBatch.createMany({
      data: open.map((source) => ({
        id: batchOf.get(source.key) ?? '',
        businessId,
        productId: plan.productId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        originalQuantity: source.quantity,
        originalUnitCost: source.unitCost,
        originalReceivedDate: toDbDate(source.date),
        receivedQuantity: source.quantity,
        unitCost: source.unitCost,
        receivedDate: toDbDate(source.date),
        remainingQuantity: replay.remaining.get(source.key) ?? ZERO,
        backfillRunId: runId,
      })),
    });
    await tx.inventoryBatchEvent.createMany({
      data: open.map((source) => ({
        businessId,
        batchId: batchOf.get(source.key) ?? '',
        productId: plan.productId,
        eventType: source.sourceType === 'purchase' ? 'received' : 'adjust_in',
        businessDate: toDbDate(source.date),
        quantityDelta: source.quantity,
        valueDelta: source.unitCost === null ? ZERO : source.quantity.mul(source.unitCost),
        sourceType: 'backfill',
        sourceId: runId,
        reason: 'FIFO backfill',
        createdBy: input.actorUserId,
        backfillRunId: runId,
      })),
    });

    // Delivery lines: which batches their bags came from, and a cost for those that never had one.
    const toBatch = (slices: readonly Slice[]): Slice[] =>
      slices.map((slice) => ({
        ...slice,
        batchKey: slice.batchKey ? (batchOf.get(slice.batchKey) ?? null) : null,
      }));
    const lines = await tx.deliveryItem.findMany({
      where: { productId: plan.productId },
      select: {
        id: true,
        deliveryId: true,
        lineTotal: true,
        status: true,
        costAmount: true,
        costSource: true,
      },
    });
    const filled: string[] = [];
    for (const line of lines) {
      const planned = plan.lines.find((entry) => entry.deliveryItemId === line.id);
      if (!planned) continue;
      const active = planned.status === 'active';
      const slices = toBatch(
        (active ? replay.deliveries : replay.issued).get(line.deliveryId) ?? [],
      );
      if (slices.length === 0) continue;
      const date = planned.deliveryDate;
      await this.ledger.writeAllocations(tx, businessId, {
        deliveryItemId: line.id,
        productId: plan.productId,
        kind: 'original',
        slices,
        revenueTotal: line.lineTotal,
        allocationDate: date,
        backfillRunId: runId,
      });
      if (!active) {
        // A voided delivery drew these bags and gave them back.
        await this.ledger.writeAllocations(tx, businessId, {
          deliveryItemId: line.id,
          productId: plan.productId,
          kind: 'reversal',
          slices,
          revenueTotal: line.lineTotal.negated(),
          allocationDate: date,
          backfillRunId: runId,
        });
      }
      if (active && line.costAmount === null) {
        const snapshot = snapshotOf(slices);
        await tx.deliveryItem.update({
          where: { id: line.id },
          data: {
            unitCost: snapshot.unitCost,
            costAmount: snapshot.costAmount,
            uncostedQuantity: snapshot.uncostedQuantity,
            costSource: 'backfill',
          },
        });
        filled.push(line.id);
      }
    }

    // The product's pools follow its batches.
    const state: FifoState = {
      legacy: ZERO,
      batches: open.map((source) => ({
        key: batchOf.get(source.key) ?? '',
        unitCost: source.unitCost,
        remaining: replay.remaining.get(source.key) ?? ZERO,
      })),
    };
    await tx.product.update({ where: { id: plan.productId }, data: poolsOf(state) });

    // Only on request: the difference between FIFO and the moving-average snapshots already reported.
    const policy = new Prisma.Decimal(plan.policyDifference);
    if (input.bookPolicyCorrection && !policy.isZero()) {
      await tx.inventoryCostCorrection.create({
        data: {
          businessId,
          productId: plan.productId,
          correctionDate: toDbDate(input.today),
          effectiveDate: toDbDate(replay.earliestDate ?? input.today),
          cogsDelta: policy,
          stockValueDelta: policy.negated(),
          kind: 'costing_policy_change',
          reason: 'FIFO replaces the moving average: difference on deliveries costed before FIFO',
          sourceType: 'backfill',
          sourceId: runId,
          createdBy: input.actorUserId,
        },
      });
    }
    return {
      productId: plan.productId,
      poolsBefore: {
        costedQuantity: before.costedQuantity.toString(),
        costedValue: before.costedValue.toFixed(SCALE),
        uncostedQuantity: before.uncostedQuantity.toString(),
      },
      batches: open.length,
      filledLines: filled,
      policyCorrection: input.bookPolicyCorrection && !policy.isZero() ? policy.toFixed(2) : null,
    };
  }
}
