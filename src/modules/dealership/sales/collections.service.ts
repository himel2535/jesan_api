import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { ChangeValues } from '../../../core/approvals/change-handler';
import { ChangeRequestsService } from '../../../core/approvals/change-requests.service';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { moneyString, moneyStringOrNull, toDecimal } from '../../../core/common/money';
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
import { CustomerAccounts } from './customer-accounts';
import {
  CollectionListQueryDto,
  CreateCollectionDto,
  LedgerQueryDto,
  UpdateCollectionDto,
} from './dto/requests';
import { CODE_WIDTH, orderNotFound } from './orders.service';
import { isUniqueViolation } from './sales.common';

const personRef = { select: { id: true, name: true } } as const;

const select = {
  id: true,
  code: true,
  collectionDate: true,
  method: true,
  amount: true,
  reference: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  updatedAt: true,
  customer: { select: { id: true, code: true, nameEn: true, nameBn: true } },
  order: { select: { id: true, code: true } },
  creator: personRef,
  voider: personRef,
} satisfies Prisma.CollectionSelect;

type Row = Prisma.CollectionGetPayload<{ select: typeof select }>;

function toResponse(row: Row) {
  return {
    id: row.id,
    code: row.code,
    customer: row.customer,
    order: row.order,
    collectionDate: fromDbDate(row.collectionDate),
    method: row.method,
    amount: moneyString(row.amount),
    reference: row.reference,
    note: row.note,
    status: row.status,
    version: row.version,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedBy: row.voider,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const collectionNotFound = () =>
  notFoundError('COLLECTION_NOT_FOUND', 'Collection not found');

/**
 * Money received. It goes straight to the customer's balance (an advance when
 * more than is owed: the balance turns negative). An order is only a
 * reference, never an allocation.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly counters: DocumentCounterService,
    private readonly accounts: CustomerAccounts,
    private readonly audit: AuditService,
    private readonly changes: ChangeRequestsService,
  ) {}

  async methods(access: BusinessAccess) {
    const config = await this.context.config(access.businessId);
    return { items: config.collectionMethods };
  }

  async create(
    access: BusinessAccess,
    dto: CreateCollectionDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    if (idempotencyKey) {
      const existing = await this.findByKey(access, actor, idempotencyKey);
      if (existing) return { created: false, collection: existing };
    }
    const config = await this.context.config(access.businessId);
    if (!config.collectionMethods.includes(dto.method)) {
      throw badRequest('COLLECTION_METHOD_UNKNOWN', 'Not one of this business’s methods', 'method');
    }
    const amount = toDecimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw badRequest('AMOUNT_TOO_SMALL', 'The amount must be above zero', 'amount');
    }
    const collectionDate = checkBusinessDate(dto.collectionDate, {
      timezone: config.timezone,
      backdateLimitDays: config.backdateLimitDays,
      mayBackdate: access.permissions.has('collection.edit'),
      subject: 'COLLECTION_DATE',
      field: 'collectionDate',
    });
    const [customer, order] = await Promise.all([
      db.customer.findUnique({ where: { id: dto.customerId }, select: { id: true } }),
      dto.orderId
        ? db.salesOrder.findUnique({
            where: { id: dto.orderId },
            select: { id: true, customerId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!customer) {
      throw notFoundError('CUSTOMER_NOT_FOUND', 'Customer not found', 'customerId');
    }
    if (dto.orderId && order?.customerId !== customer.id) {
      throw orderNotFound('orderId');
    }

    try {
      const id = await db.$transaction(async (tx) => {
        await this.accounts.lock(tx, access.businessId, customer.id);
        const number = await this.counters.next(tx, access.businessId, 'collection');
        const collection = await tx.collection.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.collection, number, CODE_WIDTH),
            customerId: customer.id,
            orderId: order?.id ?? null,
            collectionDate: toDbDate(collectionDate),
            method: dto.method,
            amount,
            reference: dto.reference || null,
            note: dto.note || null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: actor.userId,
          },
          select: { id: true, code: true },
        });
        await this.accounts.move(tx, access.businessId, actor.userId, customer.id, {
          collected: amount,
          ledger: {
            kind: 'collection',
            entryDate: collectionDate,
            sourceType: 'collection',
            sourceId: collection.id,
            reason: null,
          },
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'collection.created',
            entityType: 'collection',
            entityId: collection.id,
            changes: {
              code: collection.code,
              customerId: customer.id,
              orderId: order?.id ?? null,
              collectionDate,
              method: dto.method,
              amount: moneyString(amount),
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return collection.id;
      });
      return { created: true, collection: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, collection: existing };
      }
      throw error;
    }
  }

  async list(access: BusinessAccess, query: CollectionListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.CollectionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.from || query.to
        ? {
            collectionDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.collection.findMany({
        where,
        orderBy: [{ collectionDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.collection.count({ where }),
    ]);
    return { items: rows.map(toResponse), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .collection.findUnique({ where: { id }, select });
    if (!row) throw collectionNotFound();
    return toResponse(row);
  }

  async voidDirect(access: BusinessAccess, id: string, reason: string, actor: Actor) {
    await this.changes.applyDirect(
      access,
      {
        entityType: 'collection',
        entityId: id,
        kind: 'void',
        reason,
        notFound: collectionNotFound,
      },
      actor,
    );
    return this.get(access, id);
  }

  async updateDirect(access: BusinessAccess, id: string, dto: UpdateCollectionDto, actor: Actor) {
    const values: ChangeValues = {};
    for (const key of ['collectionDate', 'method', 'amount', 'reference', 'note'] as const) {
      if (dto[key] !== undefined) values[key] = dto[key];
    }
    await this.changes.applyDirect(
      access,
      {
        entityType: 'collection',
        entityId: id,
        kind: 'edit',
        values,
        reason: dto.reason,
        notFound: collectionNotFound,
      },
      actor,
    );
    return this.get(access, id);
  }

  /** A customer's statement: every balance change, newest first, with the totals. */
  async ledger(access: BusinessAccess, customerId: string, query: LedgerQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.CustomerLedgerEntryWhereInput = {
      customerId,
      ...(query.from || query.to
        ? {
            entryDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [customer, rows, total] = await Promise.all([
      db.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          code: true,
          nameEn: true,
          openingBalance: true,
          deliveredAmount: true,
          collectedAmount: true,
          currentBalance: true,
          creditLimit: true,
        },
      }),
      db.customerLedgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          kind: true,
          amount: true,
          entryDate: true,
          sourceType: true,
          sourceId: true,
          reason: true,
          createdAt: true,
          creator: personRef,
        },
      }),
      db.customerLedgerEntry.count({ where }),
    ]);
    if (!customer) throw notFoundError('CUSTOMER_NOT_FOUND', 'Customer not found');
    const ids = (type: string) => [
      ...new Set(rows.filter((row) => row.sourceType === type).map((row) => row.sourceId)),
    ];
    const [deliveries, collections] = await Promise.all([
      ids('delivery').length
        ? db.delivery.findMany({
            where: { id: { in: ids('delivery') } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
      ids('collection').length
        ? db.collection.findMany({
            where: { id: { in: ids('collection') } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
    ]);
    const codeOf = new Map([...deliveries, ...collections].map((row) => [row.id, row.code]));
    return {
      customer: {
        id: customer.id,
        code: customer.code,
        nameEn: customer.nameEn,
        openingBalance: moneyString(customer.openingBalance),
        deliveredAmount: moneyString(customer.deliveredAmount),
        collectedAmount: moneyString(customer.collectedAmount),
        currentBalance: moneyString(customer.currentBalance),
        creditLimit: moneyStringOrNull(customer.creditLimit),
      },
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: moneyString(row.amount),
        entryDate: fromDbDate(row.entryDate),
        source: { type: row.sourceType, id: row.sourceId, code: codeOf.get(row.sourceId) ?? null },
        reason: row.reason,
        createdBy: row.creator,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).collection.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id) : null;
  }
}
