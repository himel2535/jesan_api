import { BadRequestException, ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { ChangeValues } from '../../../core/approvals/change-handler';
import { ChangeRequestsService } from '../../../core/approvals/change-requests.service';
import { fromDbDate, toDbDate, todayIn } from '../../../core/common/business-time';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { lockRows } from '../../../core/database/row-lock';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, conflict, errorBody, notFoundError } from '../../../core/errors';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { checkBusinessDate } from '../business-dates';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { fitsUnit, lineTotalOf } from '../purchases/purchases.service';
import { StockLedger, quantityString } from '../stock/stock-ledger';
import { InventoryCostingService } from '../stock/inventory-costing.service';
import { CustomerAccounts } from './customer-accounts';
import { CreateDeliveryDto, DeliveryListQueryDto, UpdateDeliveryDto } from './dto/requests';
import { CODE_WIDTH, orderNotFound } from './orders.service';
import { deliveryStatusOf, isUniqueViolation } from './sales.common';

const customerRef = { select: { id: true, code: true, nameEn: true, nameBn: true } } as const;
const personRef = { select: { id: true, name: true } } as const;

const listSelect = {
  id: true,
  code: true,
  deliveryDate: true,
  transportReference: true,
  totalQuantity: true,
  totalAmount: true,
  creditLimitExceeded: true,
  status: true,
  createdAt: true,
  order: { select: { id: true, code: true } },
  customer: customerRef,
  creator: personRef,
} satisfies Prisma.DeliverySelect;

const detailSelect = {
  ...listSelect,
  note: true,
  version: true,
  voidedAt: true,
  voidReason: true,
  updatedAt: true,
  voider: personRef,
  items: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      orderItemId: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      product: { select: { id: true, code: true, nameEn: true, nameBn: true, unitKey: true } },
    },
  },
} satisfies Prisma.DeliverySelect;

type ListRow = Prisma.DeliveryGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.DeliveryGetPayload<{ select: typeof detailSelect }>;

function listItem(row: ListRow) {
  return {
    id: row.id,
    code: row.code,
    order: row.order,
    customer: row.customer,
    deliveryDate: fromDbDate(row.deliveryDate),
    transportReference: row.transportReference,
    totalQuantity: quantityString(row.totalQuantity),
    totalAmount: moneyString(row.totalAmount),
    creditLimitExceeded: row.creditLimitExceeded,
    status: row.status,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
}

function detail(row: DetailRow) {
  return {
    ...listItem(row),
    note: row.note,
    version: row.version,
    items: row.items.map((item) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      product: item.product,
      quantity: quantityString(item.quantity),
      unitPrice: moneyString(item.unitPrice),
      lineTotal: moneyString(item.lineTotal),
    })),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedBy: row.voider,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const deliveryNotFound = () => notFoundError('DELIVERY_NOT_FOUND', 'Delivery not found');

/** 400 when a delivery would take more than is left to deliver on an order line. */
export function tooMuch(remaining: Prisma.Decimal, field: string) {
  return new BadRequestException({
    ...errorBody(
      HttpStatus.BAD_REQUEST,
      'DELIVERY_QUANTITY_TOO_LARGE',
      'More than is left to deliver on this order line',
      field,
    ),
    details: { remaining: quantityString(remaining) },
  });
}

/**
 * Deliveries of an order. Saving one, in one transaction (locks: order, then
 * customer, then products): number, delivery and lines, stock out, the order's
 * delivered bags, the customer's balance, pending bags and ledger. Over the
 * credit limit: flagged, or refused when the business blocks it.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly counters: DocumentCounterService,
    private readonly ledger: StockLedger,
    private readonly costing: InventoryCostingService,
    private readonly accounts: CustomerAccounts,
    private readonly audit: AuditService,
    private readonly changes: ChangeRequestsService,
  ) {}

  async create(
    access: BusinessAccess,
    dto: CreateDeliveryDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    if (idempotencyKey) {
      const existing = await this.findByKey(access, actor, idempotencyKey);
      if (existing) return { created: false, delivery: existing };
    }
    const config = await this.context.config(access.businessId);
    const seen = new Set<string>();
    dto.items.forEach((item, index) => {
      if (seen.has(item.orderItemId)) {
        throw badRequest(
          'ORDER_ITEM_DUPLICATE',
          'An order line can appear only once in a delivery',
          `items.${String(index)}.orderItemId`,
        );
      }
      seen.add(item.orderItemId);
    });

    try {
      const id = await db.$transaction(async (tx) => {
        // Lock order: the order first, then the customer, then the products.
        const locked = await lockRows(tx, 'sales_orders', access.businessId, [dto.orderId]);
        const order = locked.length
          ? await tx.salesOrder.findUnique({
              where: { id: dto.orderId },
              select: {
                id: true,
                code: true,
                status: true,
                customerId: true,
                orderDate: true,
                totalQuantity: true,
                deliveredQuantity: true,
                items: {
                  select: {
                    id: true,
                    productId: true,
                    quantity: true,
                    deliveredQuantity: true,
                    unitPrice: true,
                    product: { select: { unitKey: true } },
                  },
                },
              },
            })
          : null;
        if (!order) throw orderNotFound('orderId');
        if (order.status === 'void') {
          throw conflict('ORDER_ALREADY_VOID', 'This order is void');
        }
        const deliveryDate = checkBusinessDate(dto.deliveryDate, {
          timezone: config.timezone,
          backdateLimitDays: config.backdateLimitDays,
          mayBackdate: access.permissions.has('delivery.edit'),
          subject: 'DELIVERY_DATE',
          field: 'deliveryDate',
          earliest: fromDbDate(order.orderDate),
        });
        const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
        const itemById = new Map(order.items.map((item) => [item.id, item]));
        const lines = dto.items.map((item, index) => {
          const orderItem = itemById.get(item.orderItemId);
          if (!orderItem) {
            throw badRequest(
              'ORDER_ITEM_NOT_FOUND',
              'This line is not on the order',
              `items.${String(index)}.orderItemId`,
            );
          }
          const quantity = toDecimal(item.quantity);
          if (!fitsUnit(quantity, decimalsOf.get(orderItem.product.unitKey) ?? 0)) {
            throw badRequest(
              'QUANTITY_INVALID',
              'Quantity must be above zero and fit the product’s unit',
              `items.${String(index)}.quantity`,
            );
          }
          const remaining = orderItem.quantity.sub(orderItem.deliveredQuantity);
          if (quantity.greaterThan(remaining)) {
            throw tooMuch(remaining, `items.${String(index)}.quantity`);
          }
          return {
            index,
            orderItem,
            quantity,
            lineTotal: lineTotalOf(quantity, orderItem.unitPrice),
          };
        });
        const totalQuantity = lines.reduce(
          (sum, line) => sum.add(line.quantity),
          new Prisma.Decimal(0),
        );
        const totalAmount = lines.reduce(
          (sum, line) => sum.add(line.lineTotal),
          new Prisma.Decimal(0),
        );

        // Credit limit, with the customer locked.
        await this.accounts.lock(tx, access.businessId, order.customerId);
        const customer = await tx.customer.findUniqueOrThrow({
          where: { id: order.customerId },
          select: { currentBalance: true, creditLimit: true },
        });
        const balanceAfter = customer.currentBalance.add(totalAmount);
        const exceeded =
          customer.creditLimit !== null && balanceAfter.greaterThan(customer.creditLimit);
        if (
          exceeded &&
          config.creditLimitMode === 'block' &&
          !access.permissions.has('delivery.credit.override')
        ) {
          throw new ConflictException({
            ...errorBody(
              HttpStatus.CONFLICT,
              'CREDIT_LIMIT_EXCEEDED',
              'This delivery takes the customer over the credit limit',
              'items',
            ),
            details: {
              creditLimit: moneyString(customer.creditLimit ?? new Prisma.Decimal(0)),
              balanceAfter: moneyString(balanceAfter),
            },
          });
        }

        const number = await this.counters.next(tx, access.businessId, 'delivery');
        const delivery = await tx.delivery.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.delivery, number, CODE_WIDTH),
            orderId: order.id,
            customerId: order.customerId,
            deliveryDate: toDbDate(deliveryDate),
            transportReference: dto.transportReference || null,
            totalQuantity,
            totalAmount,
            creditLimitExceeded: exceeded,
            note: dto.note || null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: actor.userId,
          },
          select: { id: true, code: true },
        });
        const indexOf = new Map(lines.map((line) => [line.orderItem.productId, line.index]));
        // Stock moves first so costing can tell us what these bags cost; the
        // lines are then written with that snapshot frozen onto them.
        const costs = await this.ledger.apply(
          tx,
          access.businessId,
          actor.userId,
          lines.map((line) => ({
            productId: line.orderItem.productId,
            quantity: line.quantity.negated(),
            kind: 'delivery' as const,
            movementDate: deliveryDate,
            sourceType: 'delivery' as const,
            sourceId: delivery.id,
            reason: null,
          })),
          (productId) => `items.${String(indexOf.get(productId) ?? 0)}.quantity`,
        );
        const items = await tx.deliveryItem.createManyAndReturn({
          data: lines.map((line, at) => ({
            businessId: access.businessId,
            deliveryId: delivery.id,
            orderItemId: line.orderItem.id,
            productId: line.orderItem.productId,
            quantity: line.quantity,
            unitPrice: line.orderItem.unitPrice,
            lineTotal: line.lineTotal,
            // The snapshot frozen at the moment of delivery: what the bags taken from
            // each batch cost. Unknown-cost bags are counted here, never priced at zero.
            unitCost: costs[at]?.unitCost ?? null,
            costAmount: costs[at]?.costAmount ?? null,
            uncostedQuantity: costs[at]?.uncostedQuantity ?? new Prisma.Decimal(0),
            costSource: 'live',
          })),
          select: { id: true, orderItemId: true },
        });
        const itemOf = new Map(items.map((item) => [item.orderItemId, item.id]));
        await Promise.all(
          lines.map((line, at) =>
            this.ledger.writeAllocations(tx, access.businessId, {
              deliveryItemId: itemOf.get(line.orderItem.id) ?? '',
              productId: line.orderItem.productId,
              kind: 'original',
              slices: costs[at]?.slices ?? [],
              revenueTotal: line.lineTotal,
              allocationDate: deliveryDate,
            }),
          ),
        );
        // A delivery dated in the past slots into the middle of the product's
        // timeline: which batch each later delivery drew from may change, and it can
        // leave an earlier day short. The timeline is replayed oldest-first; a
        // shortfall refuses the delivery, and any difference is booked as a
        // correction dated today rather than by rewriting earlier snapshots.
        if (deliveryDate < todayIn(config.timezone)) {
          await this.costing.recompute(
            tx,
            access.businessId,
            actor.userId,
            lines.map((line) => line.orderItem.productId),
            {
              kind: 'backdated_entry',
              reason: null,
              sourceType: 'delivery',
              sourceId: delivery.id,
              today: todayIn(config.timezone),
              fieldFor: (productId) => `items.${String(indexOf.get(productId) ?? 0)}.quantity`,
            },
          );
        }
        await Promise.all(
          lines.map((line) =>
            tx.salesOrderItem.update({
              where: { id: line.orderItem.id },
              data: { deliveredQuantity: { increment: line.quantity } },
            }),
          ),
        );
        const delivered = order.deliveredQuantity.add(totalQuantity);
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            deliveredQuantity: delivered,
            deliveryStatus: deliveryStatusOf(delivered, order.totalQuantity),
          },
        });
        await this.accounts.move(tx, access.businessId, actor.userId, order.customerId, {
          delivered: totalAmount,
          pending: totalQuantity.negated(),
          ledger: {
            kind: 'delivery',
            entryDate: deliveryDate,
            sourceType: 'delivery',
            sourceId: delivery.id,
            reason: null,
          },
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'delivery.created',
            entityType: 'delivery',
            entityId: delivery.id,
            changes: {
              code: delivery.code,
              orderId: order.id,
              deliveryDate,
              totalQuantity: quantityString(totalQuantity),
              totalAmount: moneyString(totalAmount),
              creditLimitExceeded: exceeded,
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return delivery.id;
      });
      return { created: true, delivery: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, delivery: existing };
      }
      throw error;
    }
  }

  async list(access: BusinessAccess, query: DeliveryListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.DeliveryWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.from || query.to
        ? {
            deliveryDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.delivery.findMany({
        where,
        orderBy: [{ deliveryDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: listSelect,
      }),
      db.delivery.count({ where }),
    ]);
    return { items: rows.map(listItem), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .delivery.findUnique({ where: { id }, select: detailSelect });
    if (!row) throw deliveryNotFound();
    return detail(row);
  }

  async voidDirect(access: BusinessAccess, id: string, reason: string, actor: Actor) {
    await this.changes.applyDirect(
      access,
      { entityType: 'delivery', entityId: id, kind: 'void', reason, notFound: deliveryNotFound },
      actor,
    );
    return this.get(access, id);
  }

  async updateDirect(access: BusinessAccess, id: string, dto: UpdateDeliveryDto, actor: Actor) {
    const values: ChangeValues = {};
    if (dto.deliveryDate !== undefined) values['deliveryDate'] = dto.deliveryDate;
    if (dto.transportReference !== undefined) values['transportReference'] = dto.transportReference;
    if (dto.note !== undefined) values['note'] = dto.note;
    for (const item of dto.items ?? []) {
      values[`items.${item.id}.quantity`] = item.quantity;
    }
    await this.changes.applyDirect(
      access,
      {
        entityType: 'delivery',
        entityId: id,
        kind: 'edit',
        values,
        reason: dto.reason,
        notFound: deliveryNotFound,
      },
      actor,
    );
    return this.get(access, id);
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).delivery.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id) : null;
  }
}
