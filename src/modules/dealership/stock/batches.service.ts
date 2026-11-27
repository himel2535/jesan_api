import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { moneyString } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { notFoundError } from '../../../core/errors';
import { PAGE_SIZE } from '../master-data/master-data.common';
import { BatchListQueryDto } from './dto/batch-requests';
import { quantityString } from './stock-ledger';

const ZERO = new Prisma.Decimal(0);

type Db = ReturnType<PrismaService['forBusiness']>;

interface DateWindow {
  gte?: Date;
  lte?: Date;
}

/**
 * The purchase-batch report's data: one row per batch with what came in, at what price, what has
 * left it, the selling revenue and cost of those bags, and the resulting gross profit. Built from
 * the real delivery allocations, never by comparing a current price with total sales.
 */
@Injectable()
export class BatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(access: BusinessAccess, query: BatchListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where = await this.filter(db, query);
    const window = this.window(query.deliveryFrom, query.deliveryTo);
    const orderBy: Prisma.InventoryBatchOrderByWithRelationInput[] = [
      { receivedDate: 'asc' },
      { seq: 'asc' },
    ];

    // Filtering by result needs every candidate's profit first; otherwise only the page is measured.
    if (query.result) {
      const all = await db.inventoryBatch.findMany({ where, orderBy });
      const figures = await this.figures(db, all, window);
      const kept = all.filter((batch) => {
        const profit = figures.get(batch.id)?.grossProfit;
        if (profit === null || profit === undefined) return false;
        return query.result === 'profit' ? profit.greaterThan(0) : profit.isNegative();
      });
      const pageRows = kept.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE);
      return {
        items: await this.rows(db, pageRows, figures),
        page: query.page,
        pageSize: PAGE_SIZE,
        total: kept.length,
      };
    }

    const [rows, total] = await Promise.all([
      db.inventoryBatch.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.inventoryBatch.count({ where }),
    ]);
    const figures = await this.figures(db, rows, window);
    return {
      items: await this.rows(db, rows, figures),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  async detail(access: BusinessAccess, id: string) {
    const db = this.prisma.forBusiness(access.businessId);
    const batch = await db.inventoryBatch.findUnique({ where: { id } });
    if (!batch) throw notFoundError('BATCH_NOT_FOUND', 'Batch not found');
    const figures = await this.figures(db, [batch], undefined);
    const [row] = await this.rows(db, [batch], figures);

    const [held, events] = await Promise.all([
      db.deliveryItemAllocation.groupBy({
        by: ['deliveryItemId'],
        where: { batchId: id },
        _sum: { quantity: true, costAmount: true, revenueAmount: true },
      }),
      db.inventoryBatchEvent.findMany({
        where: { batchId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          eventType: true,
          businessDate: true,
          quantityDelta: true,
          valueDelta: true,
          reason: true,
        },
      }),
    ]);
    const lines = held.length
      ? await db.deliveryItem.findMany({
          where: { id: { in: held.map((entry) => entry.deliveryItemId) } },
          select: { id: true, deliveryId: true },
        })
      : [];
    const deliveries = lines.length
      ? await db.delivery.findMany({
          where: { id: { in: lines.map((line) => line.deliveryId) } },
          orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }],
          select: { id: true, code: true, deliveryDate: true, status: true, customerId: true },
        })
      : [];
    const lineOf = new Map(lines.map((line) => [line.id, line.deliveryId]));
    const byDelivery = new Map<
      string,
      { quantity: Prisma.Decimal; cost: Prisma.Decimal | null; revenue: Prisma.Decimal }
    >();
    for (const entry of held) {
      const deliveryId = lineOf.get(entry.deliveryItemId);
      if (!deliveryId) continue;
      const have = byDelivery.get(deliveryId) ?? { quantity: ZERO, cost: null, revenue: ZERO };
      byDelivery.set(deliveryId, {
        quantity: have.quantity.add(entry._sum.quantity ?? ZERO),
        cost:
          entry._sum.costAmount === null && have.cost === null
            ? null
            : (have.cost ?? ZERO).add(entry._sum.costAmount ?? ZERO),
        revenue: have.revenue.add(entry._sum.revenueAmount ?? ZERO),
      });
    }
    return {
      ...row,
      deliveries: deliveries.map((delivery) => {
        const sums = byDelivery.get(delivery.id);
        return {
          deliveryId: delivery.id,
          deliveryCode: delivery.code,
          deliveryDate: fromDbDate(delivery.deliveryDate),
          status: delivery.status,
          customerId: delivery.customerId,
          quantity: quantityString(sums?.quantity ?? ZERO),
          cost:
            sums?.cost === null || sums === undefined
              ? null
              : moneyString(sums.cost.toDecimalPlaces(2)),
          revenue: moneyString(sums?.revenue ?? ZERO),
        };
      }),
      events: events.map((event) => ({
        eventType: event.eventType,
        businessDate: fromDbDate(event.businessDate),
        quantityDelta: quantityString(event.quantityDelta),
        valueDelta: moneyString(event.valueDelta.toDecimalPlaces(2)),
        reason: event.reason,
      })),
    };
  }

  private window(from: string | undefined, to: string | undefined): DateWindow | undefined {
    if (!from && !to) return undefined;
    return {
      ...(from ? { gte: toDbDate(from) } : {}),
      ...(to ? { lte: toDbDate(to) } : {}),
    };
  }

  private async filter(db: Db, query: BatchListQueryDto): Promise<Prisma.InventoryBatchWhereInput> {
    let purchaseIds: string[] | undefined;
    if (query.supplierId) {
      const purchases = await db.purchase.findMany({
        where: { supplierId: query.supplierId },
        select: { id: true },
      });
      purchaseIds = purchases.map((purchase) => purchase.id);
    }
    return {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.source ? { sourceType: query.source } : {}),
      ...(purchaseIds ? { sourceType: 'purchase', sourceId: { in: purchaseIds } } : {}),
      ...(query.purchaseFrom || query.purchaseTo
        ? {
            receivedDate: {
              ...(query.purchaseFrom ? { gte: toDbDate(query.purchaseFrom) } : {}),
              ...(query.purchaseTo ? { lte: toDbDate(query.purchaseTo) } : {}),
            },
          }
        : {}),
    };
  }

  /** Delivered bags, revenue, cost and profit per batch, inside the delivery window if one is given. */
  private async figures(
    db: Db,
    batches: readonly { id: string; unitCost: Prisma.Decimal | null }[],
    window: DateWindow | undefined,
  ) {
    const result = new Map<
      string,
      {
        delivered: Prisma.Decimal;
        revenue: Prisma.Decimal;
        cogs: Prisma.Decimal | null;
        grossProfit: Prisma.Decimal | null;
      }
    >();
    if (batches.length === 0) return result;
    const inWindow: Prisma.DeliveryItemAllocationWhereInput = window
      ? {
          OR: [
            {
              kind: { in: ['original', 'reversal'] },
              deliveryItem: { delivery: { deliveryDate: window } },
            },
            { kind: 'adjustment', allocationDate: window },
          ],
        }
      : {};
    const sums = await db.deliveryItemAllocation.groupBy({
      by: ['batchId'],
      where: { batchId: { in: batches.map((batch) => batch.id) }, ...inWindow },
      _sum: { quantity: true, costAmount: true, revenueAmount: true },
    });
    const sumOf = new Map(sums.map((row) => [row.batchId ?? '', row._sum]));
    for (const batch of batches) {
      const sum = sumOf.get(batch.id);
      const revenue = sum?.revenueAmount ?? ZERO;
      // An unknown-cost batch has no cost and so no profit: unverified, never "revenue minus zero".
      const known = batch.unitCost !== null;
      const cogs = known ? (sum?.costAmount ?? ZERO) : null;
      result.set(batch.id, {
        delivered: sum?.quantity ?? ZERO,
        revenue,
        cogs,
        grossProfit: cogs === null ? null : revenue.sub(cogs),
      });
    }
    return result;
  }

  private async rows(
    db: Db,
    batches: readonly Prisma.InventoryBatchGetPayload<object>[],
    figures: Awaited<ReturnType<BatchesService['figures']>>,
  ) {
    if (batches.length === 0) return [];
    const productIds = [...new Set(batches.map((batch) => batch.productId))];
    const purchaseIds = batches.filter((b) => b.sourceType === 'purchase').map((b) => b.sourceId);
    const [products, purchases] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, code: true, nameEn: true, nameBn: true },
      }),
      purchaseIds.length
        ? db.purchase.findMany({
            where: { id: { in: purchaseIds } },
            select: { id: true, code: true, supplierId: true },
          })
        : Promise.resolve([]),
    ]);
    const productOf = new Map(products.map((product) => [product.id, product]));
    const purchaseOf = new Map(purchases.map((purchase) => [purchase.id, purchase]));
    return batches.map((batch) => {
      const product = productOf.get(batch.productId);
      const purchase = batch.sourceType === 'purchase' ? purchaseOf.get(batch.sourceId) : undefined;
      const figure = figures.get(batch.id);
      const delivered = figure?.delivered ?? ZERO;
      const known = batch.unitCost !== null;
      return {
        id: batch.id,
        productId: batch.productId,
        productCode: product?.code ?? '',
        productNameEn: product?.nameEn ?? '',
        productNameBn: product?.nameBn ?? '',
        sourceType: batch.sourceType,
        purchaseId: purchase?.id ?? null,
        purchaseCode: purchase?.code ?? null,
        supplierId: purchase?.supplierId ?? null,
        purchaseDate: fromDbDate(batch.receivedDate),
        originalPurchaseDate: fromDbDate(batch.originalReceivedDate),
        unitCost: batch.unitCost ? moneyString(batch.unitCost) : null,
        originalUnitCost: batch.originalUnitCost ? moneyString(batch.originalUnitCost) : null,
        purchasedQuantity: quantityString(batch.receivedQuantity),
        originalQuantity: quantityString(batch.originalQuantity),
        purchaseValue: batch.unitCost
          ? moneyString(batch.receivedQuantity.mul(batch.unitCost).toDecimalPlaces(2))
          : null,
        deliveredQuantity: quantityString(delivered),
        remainingQuantity: quantityString(batch.remainingQuantity),
        remainingValue: batch.unitCost
          ? moneyString(batch.remainingQuantity.mul(batch.unitCost).toDecimalPlaces(2))
          : null,
        revenue: moneyString((figure?.revenue ?? ZERO).toDecimalPlaces(2)),
        cogs: figure?.cogs
          ? moneyString(figure.cogs.toDecimalPlaces(2))
          : known
            ? moneyString(ZERO)
            : null,
        grossProfit: figure?.grossProfit
          ? moneyString(figure.grossProfit.toDecimalPlaces(2))
          : known
            ? moneyString(ZERO)
            : null,
        profitPerBag:
          known && figure?.grossProfit && !delivered.isZero()
            ? moneyString(figure.grossProfit.div(delivered).toDecimalPlaces(2))
            : null,
        costComplete: known,
      };
    });
  }
}
