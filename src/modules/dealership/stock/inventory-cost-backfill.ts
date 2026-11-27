/**
 * Works out what every product's stock is worth, and what every delivery cost,
 * from the history already in the database.
 *
 *   npm run inventory:cost-backfill -- --dry-run     (default: changes nothing)
 *   npm run inventory:cost-backfill -- --commit
 *
 * The migration only adds empty columns; nothing is costed until this is run,
 * so a deploy can never leave the books half-costed. The dry run prints exactly
 * what the commit would write, plus anything it cannot work out, and writes
 * nothing. Read that report before committing.
 *
 * It runs the same engine the application uses — `InventoryCostingService`
 * through the Nest container — so a backfilled figure and a figure costed live
 * can never disagree.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { InventoryCostingService } from './inventory-costing.service';
import { averageCost, VALUE_SCALE } from './inventory-cost';

const ZERO = new Prisma.Decimal(0);

interface ProductReport {
  code: string;
  productId: string;
  currentStock: string;
  costedQuantity: string;
  costedValue: string;
  averageCost: string;
  cogsTotal: string;
  uncostedOnHand: string;
  uncostedDelivered: string;
  problems: string[];
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const log = new Logger('inventory:cost-backfill');
  // The report is the point of this command, so `log` stays on; the rest of
  // the application's start-up chatter does not.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const costing = app.get(InventoryCostingService);
    const businesses = await prisma.client.business.findMany({
      where: { type: 'dealership' },
      select: { id: true, slug: true },
      orderBy: { slug: 'asc' },
    });

    let totalValue = ZERO;
    let totalCogs = ZERO;
    let problemCount = 0;

    for (const business of businesses) {
      const db = prisma.forBusiness(business.id);
      const products = await db.product.findMany({
        select: { id: true, code: true, currentStock: true },
        orderBy: { code: 'asc' },
      });
      const reports: ProductReport[] = [];

      for (const product of products) {
        // One product at a time, each in its own transaction, so a problem with
        // one never leaves another half-written.
        const report = await prisma.forBusiness(business.id).$transaction(async (tx) => {
          const replay = await costing.replayProduct(tx, product.id);
          const problems: string[] = [];
          if (replay.negativeAt) {
            problems.push(
              `stock goes below zero on ${replay.negativeAt.date} by ${replay.negativeAt.shortfall.toString()} — ` +
                `a delivery is dated before the purchase that supplied it`,
            );
          }
          if (!replay.endQuantity.equals(product.currentStock)) {
            problems.push(
              `replay ends at ${replay.endQuantity.toString()} but current stock is ${product.currentStock.toString()}`,
            );
          }
          if (replay.pools.uncostedQuantity.greaterThan(0)) {
            problems.push(
              `${replay.pools.uncostedQuantity.toString()} bags on hand arrived with no price (a stock adjustment)`,
            );
          }
          if (replay.uncostedDelivered.greaterThan(0)) {
            problems.push(
              `${replay.uncostedDelivered.toString()} bags were delivered with no cost basis — ` +
                `cost of goods sold is understated by an unknown amount`,
            );
          }

          // Only write when the replay agrees with the stock on hand; a product
          // whose history does not add up is reported, never guessed at.
          const safe =
            problems.length === 0 ||
            (!replay.negativeAt && replay.endQuantity.equals(product.currentStock));
          if (commit && safe) {
            await tx.product.update({
              where: { id: product.id },
              data: {
                costedQuantity: replay.pools.costedQuantity,
                costedValue: replay.pools.costedValue,
                uncostedQuantity: replay.pools.uncostedQuantity,
              },
            });
            await writeSnapshots(tx, product.id, replay.deliveryCosts);
          }

          return {
            code: product.code,
            productId: product.id,
            currentStock: product.currentStock.toString(),
            costedQuantity: replay.pools.costedQuantity.toString(),
            costedValue: replay.pools.costedValue.toFixed(2),
            averageCost: averageCost(replay.pools)?.toString() ?? '—',
            cogsTotal: replay.cogsTotal.toFixed(2),
            uncostedOnHand: replay.pools.uncostedQuantity.toString(),
            uncostedDelivered: replay.uncostedDelivered.toString(),
            problems,
          } satisfies ProductReport;
        });

        reports.push(report);
        totalValue = totalValue.add(new Prisma.Decimal(report.costedValue));
        totalCogs = totalCogs.add(new Prisma.Decimal(report.cogsTotal));
        problemCount += report.problems.length;
      }

      log.log(`\n=== ${business.slug} — ${String(reports.length)} products ===`);
      for (const row of reports) {
        log.log(
          `${row.code}  stock ${row.currentStock}  costed ${row.costedQuantity} ` +
            `worth ${row.costedValue} (avg ${row.averageCost})  cogs ${row.cogsTotal}`,
        );
        for (const problem of row.problems) log.warn(`    ${row.code}: ${problem}`);
      }
    }

    log.log(
      `\nTotal stock value ${totalValue.toFixed(2)}, total cost of goods sold ${totalCogs.toFixed(2)}, ` +
        `${String(problemCount)} thing(s) to look at.`,
    );
    log.log(
      commit
        ? 'Committed. Run `npm run consistency:check` to confirm the pools reconcile.'
        : 'Dry run — nothing was written. Re-run with --commit to apply.',
    );
  } finally {
    await app.close();
  }
}

/** Writes each delivery line's share of what the replay says that delivery cost. */
async function writeSnapshots(
  tx: Prisma.TransactionClient,
  productId: string,
  costs: Map<
    string,
    {
      unitCost: Prisma.Decimal | null;
      costAmount: Prisma.Decimal;
      uncostedQuantity: Prisma.Decimal;
    }
  >,
): Promise<void> {
  for (const [deliveryId, cost] of costs) {
    const lines = await tx.deliveryItem.findMany({
      where: { deliveryId, productId },
      select: { id: true, quantity: true },
    });
    const total = lines.reduce((sum, line) => sum.add(line.quantity), ZERO);
    if (total.isZero()) continue;
    for (const line of lines) {
      // A delivery normally has one line per product; when it has more, each
      // takes its share by quantity.
      const share = line.quantity.div(total);
      await tx.deliveryItem.update({
        where: { id: line.id },
        data: {
          unitCost: cost.unitCost,
          costAmount: cost.costAmount.mul(share).toDecimalPlaces(VALUE_SCALE),
          uncostedQuantity: cost.uncostedQuantity.mul(share).toDecimalPlaces(3),
        },
      });
    }
  }
}

main().catch((error: unknown) => {
  console.error('inventory:cost-backfill failed:', error);
  process.exitCode = 1;
});
