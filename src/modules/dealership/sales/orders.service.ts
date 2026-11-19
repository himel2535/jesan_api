import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { ChangeValues } from '../../../core/approvals/change-handler';
import { ChangeRequestsService } from '../../../core/approvals/change-requests.service';
import { fromDbDate, isCalendarDate, toDbDate } from '../../../core/common/business-time';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, notFoundError } from '../../../core/errors';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { checkBusinessDate } from '../business-dates';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { fitsUnit, lineTotalOf } from '../purchases/purchases.service';
import { quantityString } from '../stock/stock-ledger';
import { CustomerAccounts } from './customer-accounts';
import { CreateOrderDto, OrderListQueryDto, UpdateOrderDto } from './dto/requests';
import { isUniqueViolation } from './sales.common';

export const CODE_WIDTH = 4;

const customerRef = { select: { id: true, code: true, nameEn: true, nameBn: true } } as const;
const personRef = { select: { id: true, name: true } } as const;

const listSelect = {
  id: true,
  code: true,
  orderDate: true,
  deliveryWindow: true,
  deliverBy: true,
  totalQuantity: true,
  deliveredQuantity: true,
  totalAmount: true,
  status: true,
  deliveryStatus: true,
  createdBy: true,
  createdAt: true,
  // Same business by the composite foreign keys; one query.
  customer: customerRef,
  creator: personRef,
} satisfies Prisma.SalesOrderSelect;

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
      quantity: true,
      deliveredQuantity: true,
      unitPrice: true,
      lineTotal: true,
      product: { select: { id: true, code: true, nameEn: true, nameBn: true, unitKey: true } },
    },
  },
  deliveries: {
    orderBy: [{ deliveryDate: 'asc' as const }, { createdAt: 'asc' as const }],
    select: {
      id: true,
      code: true,
      deliveryDate: true,
      totalQuantity: true,
      totalAmount: true,
      status: true,
    },
  },
} satisfies Prisma.SalesOrderSelect;

type ListRow = Prisma.SalesOrderGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.SalesOrderGetPayload<{ select: typeof detailSelect }>;

function listItem(row: ListRow) {
  return {
    id: row.id,
    code: row.code,
    customer: row.customer,
    orderDate: fromDbDate(row.orderDate),
    deliveryWindow: row.deliveryWindow,
    deliverBy: row.deliverBy ? fromDbDate(row.deliverBy) : null,
    totalQuantity: quantityString(row.totalQuantity),
    deliveredQuantity: quantityString(row.deliveredQuantity),
    remainingQuantity: quantityString(
      row.status === 'void' ? new Prisma.Decimal(0) : row.totalQuantity.sub(row.deliveredQuantity),
    ),
    totalAmount: moneyString(row.totalAmount),
    status: row.status,
    deliveryStatus: row.deliveryStatus,
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
      product: item.product,
      quantity: quantityString(item.quantity),
      deliveredQuantity: quantityString(item.deliveredQuantity),
      remainingQuantity: quantityString(item.quantity.sub(item.deliveredQuantity)),
      unitPrice: moneyString(item.unitPrice),
      lineTotal: moneyString(item.lineTotal),
    })),
    deliveries: row.deliveries.map((delivery) => ({
      id: delivery.id,
      code: delivery.code,
      deliveryDate: fromDbDate(delivery.deliveryDate),
      totalQuantity: quantityString(delivery.totalQuantity),
      totalAmount: moneyString(delivery.totalAmount),
      status: delivery.status,
    })),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedBy: row.voider,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const orderNotFound = (field?: string) =>
  notFoundError('ORDER_NOT_FOUND', 'Order not found', field);

/**
 * Customer orders. Prices are fixed on the order; saving one changes no stock
 * and no balance, only the customer's "still to deliver" bags.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly counters: DocumentCounterService,
    private readonly accounts: CustomerAccounts,
    private readonly audit: AuditService,
    private readonly changes: ChangeRequestsService,
  ) {}

  async create(
    access: BusinessAccess,
    dto: CreateOrderDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    if (idempotencyKey) {
      const existing = await this.findByKey(access, actor, idempotencyKey);
      if (existing) return { created: false, order: existing };
    }
    const config = await this.context.config(access.businessId);
    const orderDate = checkBusinessDate(dto.orderDate, {
      timezone: config.timezone,
      backdateLimitDays: config.backdateLimitDays,
      mayBackdate: access.permissions.has('sale.edit'),
      subject: 'ORDER_DATE',
      field: 'orderDate',
    });
    if (
      dto.deliverBy !== undefined &&
      (!isCalendarDate(dto.deliverBy) || dto.deliverBy < orderDate)
    ) {
      throw badRequest(
        'DELIVER_BY_INVALID',
        'deliverBy must be a real date on or after the order date',
        'deliverBy',
      );
    }
    const seen = new Set<string>();
    dto.items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        throw badRequest(
          'PRODUCT_DUPLICATE',
          'A product can appear only once in an order',
          `items.${String(index)}.productId`,
        );
      }
      seen.add(item.productId);
    });
    const [customer, products] = await Promise.all([
      db.customer.findUnique({
        where: { id: dto.customerId },
        select: { id: true, isActive: true },
      }),
      db.product.findMany({
        where: { id: { in: [...seen] } },
        select: { id: true, isActive: true, unitKey: true },
      }),
    ]);
    if (!customer?.isActive) {
      throw badRequest(
        'CUSTOMER_NOT_FOUND_OR_INACTIVE',
        'Customer not found or inactive',
        'customerId',
      );
    }
    const byId = new Map(products.map((product) => [product.id, product]));
    const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
    const lines = dto.items.map((item, index) => {
      const product = byId.get(item.productId);
      if (!product?.isActive) {
        throw badRequest(
          'PRODUCT_NOT_FOUND_OR_INACTIVE',
          'Product not found or inactive',
          `items.${String(index)}.productId`,
        );
      }
      const quantity = toDecimal(item.quantity);
      if (!fitsUnit(quantity, decimalsOf.get(product.unitKey) ?? 0)) {
        throw badRequest(
          'QUANTITY_INVALID',
          'Quantity must be above zero and fit the product’s unit',
          `items.${String(index)}.quantity`,
        );
      }
      const unitPrice = toDecimal(item.unitPrice);
      return {
        productId: product.id,
        quantity,
        unitPrice,
        lineTotal: lineTotalOf(quantity, unitPrice),
      };
    });
    const totalQuantity = lines.reduce(
      (sum, line) => sum.add(line.quantity),
      new Prisma.Decimal(0),
    );
    const totalAmount = lines.reduce((sum, line) => sum.add(line.lineTotal), new Prisma.Decimal(0));

    try {
      const id = await db.$transaction(async (tx) => {
        const number = await this.counters.next(tx, access.businessId, 'order');
        const order = await tx.salesOrder.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.order, number, CODE_WIDTH),
            customerId: customer.id,
            orderDate: toDbDate(orderDate),
            deliveryWindow: dto.deliveryWindow,
            deliverBy: dto.deliverBy ? toDbDate(dto.deliverBy) : null,
            totalQuantity,
            totalAmount,
            note: dto.note || null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: actor.userId,
          },
          select: { id: true, code: true },
        });
        await tx.salesOrderItem.createMany({
          data: lines.map((line) => ({
            businessId: access.businessId,
            orderId: order.id,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        });
        await this.accounts.move(tx, access.businessId, actor.userId, customer.id, {
          pending: totalQuantity,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'sales_order.created',
            entityType: 'sales_order',
            entityId: order.id,
            changes: {
              code: order.code,
              customerId: customer.id,
              orderDate,
              totalQuantity: quantityString(totalQuantity),
              totalAmount: moneyString(totalAmount),
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return order.id;
      });
      return { created: true, order: await this.get(access, id, actor) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, order: existing };
      }
      throw error;
    }
  }

  async list(access: BusinessAccess, query: OrderListQueryDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const statusWhere: Prisma.SalesOrderWhereInput =
      query.status === undefined
        ? {}
        : query.status === 'void'
          ? { status: 'void' }
          : query.status === 'open'
            ? { status: 'active', deliveryStatus: { in: ['pending', 'partial'] } }
            : { status: 'active', deliveryStatus: query.status };
    const where: Prisma.SalesOrderWhereInput = {
      ...this.visibility(access, actor),
      ...statusWhere,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.from || query.to
        ? {
            orderDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.salesOrder.findMany({
        where,
        orderBy: [{ orderDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: listSelect,
      }),
      db.salesOrder.count({ where }),
    ]);
    return { items: rows.map(listItem), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string, actor: Actor) {
    const row = await this.prisma.forBusiness(access.businessId).salesOrder.findFirst({
      where: { id, ...this.visibility(access, actor) },
      select: detailSelect,
    });
    if (!row) throw orderNotFound();
    return detail(row);
  }

  async voidDirect(access: BusinessAccess, id: string, reason: string, actor: Actor) {
    await this.changes.applyDirect(
      access,
      {
        entityType: 'sales_order',
        entityId: id,
        kind: 'void',
        reason,
        notFound: () => orderNotFound(),
      },
      actor,
    );
    return this.get(access, id, actor);
  }

  async updateDirect(access: BusinessAccess, id: string, dto: UpdateOrderDto, actor: Actor) {
    const values: ChangeValues = {};
    if (dto.orderDate !== undefined) values['orderDate'] = dto.orderDate;
    if (dto.deliveryWindow !== undefined) values['deliveryWindow'] = dto.deliveryWindow;
    if (dto.deliverBy !== undefined) values['deliverBy'] = dto.deliverBy;
    if (dto.note !== undefined) values['note'] = dto.note;
    for (const item of dto.items ?? []) {
      if (item.quantity !== undefined) values[`items.${item.id}.quantity`] = item.quantity;
      if (item.unitPrice !== undefined) values[`items.${item.id}.unitPrice`] = item.unitPrice;
    }
    await this.changes.applyDirect(
      access,
      {
        entityType: 'sales_order',
        entityId: id,
        kind: 'edit',
        values,
        reason: dto.reason,
        notFound: () => orderNotFound(),
      },
      actor,
    );
    return this.get(access, id, actor);
  }

  /** sale.view.all sees every order; sale.view.own only the person's own. */
  private visibility(access: BusinessAccess, actor: Actor): Prisma.SalesOrderWhereInput {
    if (access.permissions.has('sale.view.all')) return {};
    if (access.permissions.has('sale.view.own')) return { createdBy: actor.userId };
    throw new ForbiddenException('Access denied');
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).salesOrder.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id, actor) : null;
  }
}
