import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { ChangeRequestsService } from '../../../core/approvals/change-requests.service';
import { ChangeValues } from '../../../core/approvals/change-handler';
import {
  addDays,
  fromDbDate,
  isCalendarDate,
  periodOf,
  toDbDate,
  todayIn,
} from '../../../core/common/business-time';
import { BusinessAccess } from '../../../core/common/request-context';
import { moneyString, toDecimal } from '../../../core/common/money';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, notFoundError } from '../../../core/errors';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { PeriodCounterService } from '../../../core/numbering/period-counter.service';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { StockLedger, quantityString } from '../stock/stock-ledger';
import { CreatePurchaseDto, PurchaseListQueryDto, UpdatePurchaseDto } from './dto/requests';

export const PURCHASE_CODE_WIDTH = 4;
export const PURCHASE_COUNTER_TABLE = 'monthly_purchase_counters';

const listSelect = {
  id: true,
  code: true,
  purchaseDate: true,
  paymentMethod: true,
  totalQuantity: true,
  totalAmount: true,
  status: true,
  supplierReference: true,
  createdAt: true,
  // Same business by the composite foreign key; one query, no N+1.
  supplier: { select: { id: true, code: true, nameEn: true, nameBn: true } },
  creator: { select: { id: true, name: true } },
  // No _count here: Prisma would group every purchase line of the business
  // before the page is cut (measured: ~100 ms at 200,000 lines). The line
  // counts of the page come from one groupBy over its ten ids instead.
} satisfies Prisma.PurchaseSelect;

const detailSelect = {
  ...listSelect,
  note: true,
  version: true,
  voidedAt: true,
  voidReason: true,
  updatedAt: true,
  voider: { select: { id: true, name: true } },
  items: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      product: { select: { id: true, code: true, nameEn: true, nameBn: true, unitKey: true } },
    },
  },
} satisfies Prisma.PurchaseSelect;

type ListRow = Prisma.PurchaseGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.PurchaseGetPayload<{ select: typeof detailSelect }>;

/** Line total: quantity × unit price, rounded half up to 2 places (same as the CHECK). */
export function lineTotalOf(quantity: Prisma.Decimal, unitPrice: Prisma.Decimal): Prisma.Decimal {
  return quantity.mul(unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Does the quantity fit the unit (whole bags, or up to `decimals` places)? */
export function fitsUnit(quantity: Prisma.Decimal, decimals: number): boolean {
  return quantity.greaterThan(0) && quantity.decimalPlaces() <= decimals;
}

function listItem(row: ListRow, itemCount: number) {
  return {
    id: row.id,
    code: row.code,
    purchaseDate: fromDbDate(row.purchaseDate),
    supplier: row.supplier,
    paymentMethod: row.paymentMethod,
    itemCount,
    totalQuantity: quantityString(row.totalQuantity),
    totalAmount: moneyString(row.totalAmount),
    status: row.status,
    supplierReference: row.supplierReference,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
}

function detail(row: DetailRow) {
  return {
    ...listItem(row, row.items.length),
    note: row.note,
    version: row.version,
    items: row.items.map((item) => ({
      id: item.id,
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

const purchaseNotFound = () => notFoundError('PURCHASE_NOT_FOUND', 'Purchase not found');

function isUniqueViolation(error: unknown, hint: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (JSON.stringify(error.meta ?? {}) + error.message).includes(hint)
  );
}

/**
 * Cash purchases from the supplier. Saving one, in a single transaction:
 * number, purchase and lines, stock movements and current stock, the
 * products' last purchase price, and the month's purchase counter.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly counters: DocumentCounterService,
    private readonly periods: PeriodCounterService,
    private readonly ledger: StockLedger,
    private readonly audit: AuditService,
    private readonly changes: ChangeRequestsService,
  ) {}

  async create(
    access: BusinessAccess,
    dto: CreatePurchaseDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ): Promise<{ created: boolean; purchase: ReturnType<typeof detail> }> {
    // Purchase prices are entered here, so the person must be allowed to see them.
    if (!access.permissions.has('product.cost.view')) {
      throw new ForbiddenException('Access denied');
    }
    const db = this.prisma.forBusiness(access.businessId);
    if (idempotencyKey) {
      const existing = await this.findByKey(access, actor, idempotencyKey);
      if (existing) {
        return { created: false, purchase: existing };
      }
    }

    const config = await this.context.config(access.businessId);
    const purchaseDate = this.checkDate(dto.purchaseDate, config, access);

    // Duplicate products are refused before any lookup.
    const seen = new Set<string>();
    dto.items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        throw badRequest(
          'PRODUCT_DUPLICATE',
          'A product can appear only once in a purchase',
          `items.${String(index)}.productId`,
        );
      }
      seen.add(item.productId);
    });

    const [supplier, products] = await Promise.all([
      dto.supplierId
        ? db.supplier.findUnique({
            where: { id: dto.supplierId },
            select: { id: true, isActive: true },
          })
        : db.supplier.findFirst({
            where: { isPrincipal: true },
            select: { id: true, isActive: true },
          }),
      db.product.findMany({
        where: { id: { in: [...seen] } },
        select: { id: true, isActive: true, unitKey: true },
      }),
    ]);
    if (!supplier?.isActive) {
      throw badRequest(
        'SUPPLIER_NOT_FOUND_OR_INACTIVE',
        'Supplier not found or inactive',
        dto.supplierId ? 'supplierId' : undefined,
      );
    }
    const productById = new Map(products.map((product) => [product.id, product]));
    const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
    const lines = dto.items.map((item, index) => {
      const product = productById.get(item.productId);
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
        productId: item.productId,
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
        const number = await this.counters.next(tx, access.businessId, 'purchase');
        const purchase = await tx.purchase.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.purchase, number, PURCHASE_CODE_WIDTH),
            supplierId: supplier.id,
            purchaseDate: toDbDate(purchaseDate),
            totalQuantity,
            totalAmount,
            note: dto.note || null,
            supplierReference: dto.supplierReference || null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: actor.userId,
          },
          select: { id: true, code: true },
        });
        await tx.purchaseItem.createMany({
          data: lines.map((line) => ({
            businessId: access.businessId,
            purchaseId: purchase.id,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            purchaseDate: toDbDate(purchaseDate),
          })),
        });
        await this.ledger.apply(
          tx,
          access.businessId,
          actor.userId,
          lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            kind: 'purchase',
            movementDate: purchaseDate,
            sourceType: 'purchase',
            sourceId: purchase.id,
            reason: null,
          })),
        );
        await this.ledger.refreshLastPurchase(
          tx,
          lines.map((line) => line.productId),
          config.timezone,
        );
        await this.periods.add(
          tx,
          PURCHASE_COUNTER_TABLE,
          access.businessId,
          periodOf(purchaseDate),
          totalQuantity,
        );
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'purchase.created',
            entityType: 'purchase',
            entityId: purchase.id,
            changes: {
              code: purchase.code,
              purchaseDate,
              supplierId: supplier.id,
              totalQuantity: quantityString(totalQuantity),
              totalAmount: moneyString(totalAmount),
              lines: lines.length,
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return purchase.id;
      });
      return { created: true, purchase: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) {
          return { created: false, purchase: existing };
        }
      }
      throw error;
    }
  }

  async list(access: BusinessAccess, query: PurchaseListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.PurchaseWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
      ...(query.from || query.to
        ? {
            purchaseDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.purchase.findMany({
        where,
        orderBy: [{ purchaseDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: listSelect,
      }),
      db.purchase.count({ where }),
    ]);
    const counts = rows.length
      ? await db.purchaseItem.groupBy({
          by: ['purchaseId'],
          where: { purchaseId: { in: rows.map((row) => row.id) } },
          _count: { _all: true },
        })
      : [];
    const countOf = new Map(counts.map((row) => [row.purchaseId, row._count._all]));
    return {
      items: rows.map((row) => listItem(row, countOf.get(row.id) ?? 0)),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .purchase.findUnique({ where: { id }, select: detailSelect });
    if (!row) {
      throw purchaseNotFound();
    }
    return detail(row);
  }

  /** Owner-level void, through the same handler as an approved request. */
  async voidDirect(access: BusinessAccess, id: string, reason: string, actor: Actor) {
    await this.changes.applyDirect(
      access,
      { entityType: 'purchase', entityId: id, kind: 'void', reason, notFound: purchaseNotFound },
      actor,
    );
    return this.get(access, id);
  }

  /**
   * Owner-level correction. Note and supplier reference need purchase.create;
   * date, quantities and prices need purchase.edit and a reason.
   */
  async updateDirect(access: BusinessAccess, id: string, dto: UpdatePurchaseDto, actor: Actor) {
    const values: ChangeValues = {};
    if (dto.purchaseDate !== undefined) values['purchaseDate'] = dto.purchaseDate;
    if (dto.note !== undefined) values['note'] = dto.note;
    if (dto.supplierReference !== undefined) values['supplierReference'] = dto.supplierReference;
    for (const item of dto.items ?? []) {
      if (item.quantity !== undefined) values[`items.${item.id}.quantity`] = item.quantity;
      if (item.unitPrice !== undefined) values[`items.${item.id}.unitPrice`] = item.unitPrice;
    }
    const weighty = Object.keys(values).some(
      (key) => key !== 'note' && key !== 'supplierReference',
    );
    if (weighty && !dto.reason) {
      throw badRequest('REASON_REQUIRED', 'A reason is required for this change', 'reason');
    }
    await this.changes.applyDirect(
      access,
      {
        entityType: 'purchase',
        entityId: id,
        kind: 'edit',
        values,
        reason: dto.reason ?? '',
        notFound: purchaseNotFound,
      },
      actor,
    );
    return this.get(access, id);
  }

  /** Bags bought per month of a year (commission progress; owner-only). */
  async monthlyCounters(access: BusinessAccess, year: number) {
    const rows = await this.prisma.forBusiness(access.businessId).monthlyPurchaseCounter.findMany({
      where: { period: { gte: year * 100 + 1, lte: year * 100 + 12 } },
      select: { period: true, quantity: true },
    });
    const byPeriod = new Map(rows.map((row) => [row.period, row.quantity]));
    return {
      year,
      months: Array.from({ length: 12 }, (_, index) => {
        const period = year * 100 + index + 1;
        return {
          month: `${String(year)}-${String(index + 1).padStart(2, '0')}`,
          quantity: quantityString(byPeriod.get(period) ?? new Prisma.Decimal(0)),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------

  /** Not in the future; staff without purchase.edit only a few days back. */
  private checkDate(
    value: string | undefined,
    config: { timezone: string; backdateLimitDays: number },
    access: BusinessAccess,
  ): string {
    const today = todayIn(config.timezone);
    if (value === undefined) {
      return today;
    }
    if (!isCalendarDate(value)) {
      throw badRequest('PURCHASE_DATE_INVALID', 'Not a real date', 'purchaseDate');
    }
    if (value > today) {
      throw badRequest(
        'PURCHASE_DATE_IN_FUTURE',
        'A purchase cannot be dated in the future',
        'purchaseDate',
      );
    }
    if (
      value < addDays(today, -config.backdateLimitDays) &&
      !access.permissions.has('purchase.edit')
    ) {
      throw badRequest(
        'PURCHASE_DATE_TOO_OLD',
        `Only the last ${String(config.backdateLimitDays)} days can be used`,
        'purchaseDate',
      );
    }
    return value;
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).purchase.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id) : null;
  }
}
