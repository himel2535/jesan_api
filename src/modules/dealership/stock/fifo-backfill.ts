/**
 * Rebuilds FIFO batches for stock and deliveries that predate them.
 *
 *   npm run inventory:fifo-backfill -- --business <slug>                      dry run (default): writes nothing
 *   npm run inventory:fifo-backfill -- --business <slug> --json               the same report as JSON
 *   npm run inventory:fifo-backfill -- --business <slug> --commit --fingerprint <printed by the dry run>
 *                                         [--book-policy-correction] [--actor <user id>]
 *   npm run inventory:fifo-backfill -- --business <slug> --rollback <run id>
 *
 * The migration only adds empty tables; nothing is batched until this is committed, and a commit is
 * refused unless it presents the fingerprint of a dry run read just before it. Read the report first:
 * it lists the products, the batches it would rebuild, every delivery line it would touch, the cost of
 * sales and net profit before and after, and everything it cannot work out.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../core/database/prisma.service';
import { FifoBackfillService } from './fifo-backfill.service';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  const log = new Logger('inventory:fifo-backfill');
  const slug = option('business');
  if (!slug) throw new Error('--business <slug> is required');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const service = app.get(FifoBackfillService);
    const business = await prisma.client.business.findUniqueOrThrow({
      where: { slug },
      select: { id: true },
    });

    const rollback = option('rollback');
    if (rollback) {
      const done = await service.rollback(business.id, rollback);
      log.log(`Rolled back run ${rollback}: ${String(done.products)} product(s) restored.`);
      return;
    }

    const report = await service.plan(business.id);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const plan of report.products) {
        log.log(
          `${plan.code}  [${plan.status}]  stock ${plan.currentStock}  batches ${String(plan.batches.length)}  ` +
            `cogs ${plan.cogsBefore} -> ${plan.cogsAfter}  remaining ${plan.remainingQuantity} worth ${plan.remainingValue}`,
        );
        for (const problem of plan.problems) log.warn(`    ${plan.code}: ${problem}`);
      }
      const t = report.totals;
      log.log(
        `\n${String(t.products)} products: ${String(t.ready)} ready, ${String(t.unresolved)} unresolved, ` +
          `${String(t.alreadyBatched)} already batched. ${String(t.batches)} batches, ${String(t.linesAffected)} delivery lines.\n` +
          `Cost of sales ${t.cogsBefore} -> ${t.cogsAfter} (net profit change ${t.netProfitChange}); ` +
          `moving-average difference ${t.policyDifference}; stock left worth ${t.remainingValue}; ` +
          `${String(t.unknownCostLines)} delivery line(s) with unknown-cost bags.\nFingerprint: ${report.fingerprint}`,
      );
    }

    if (!process.argv.includes('--commit')) {
      log.log('Dry run: nothing was written.');
      return;
    }
    const fingerprint = option('fingerprint');
    if (!fingerprint)
      throw new Error('--commit needs --fingerprint <value printed by the dry run>');
    const actor =
      option('actor') ??
      (
        await prisma.client.user.findFirstOrThrow({
          where: { isPlatformOwner: true, isActive: true },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        })
      ).id;
    const done = await service.commit(business.id, {
      fingerprint,
      actorUserId: actor,
      bookPolicyCorrection: process.argv.includes('--book-policy-correction'),
    });
    log.log(
      `Committed run ${done.runId}: ${String(done.written.length)} product(s) written, ${String(done.skipped.length)} skipped. ` +
        `Roll back with --rollback ${done.runId}. Run \`npm run consistency:check\` to confirm.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('inventory:fifo-backfill failed:', error);
  process.exitCode = 1;
});
