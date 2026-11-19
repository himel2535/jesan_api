import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { normalizePhone } from '../../../core/auth/identifier';
import { moneyString, moneyStringOrNull, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { badRequest } from '../../../core/errors';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { CreateCustomerDto, ListQueryDto, UpdateCustomerDto } from './dto/requests';
import { DealershipContext } from './master-data.context';
import {
  Actor,
  PAGE_SIZE,
  Page,
  activeFilter,
  diff,
  notFound,
  requirePermission,
  requireReason,
  rethrowUnique,
} from './master-data.common';

const CUSTOMER_CODE_WIDTH = 5;

const select = {
  id: true,
  code: true,
  nameEn: true,
  nameBn: true,
  phone: true,
  address: true,
  area: true,
  openingBalance: true,
  currentBalance: true,
  creditLimit: true,
  pendingDeliveryQuantity: true,
  deliveredAmount: true,
  collectedAmount: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof select }>;

const DUPLICATE = {
  phone: {
    code: 'PHONE_DUPLICATE',
    field: 'phone',
    message: 'A customer with this phone number already exists',
  },
};

function toResponse(row: CustomerRow) {
  return {
    ...row,
    openingBalance: moneyString(row.openingBalance),
    currentBalance: moneyString(row.currentBalance),
    creditLimit: moneyStringOrNull(row.creditLimit),
    pendingDeliveryQuantity: row.pendingDeliveryQuantity.toString(),
    deliveredAmount: moneyString(row.deliveredAmount),
    collectedAmount: moneyString(row.collectedAmount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function phoneOrThrow(value: string): string {
  const phone = normalizePhone(value);
  if (!phone) {
    throw badRequest('PHONE_INVALID', 'Phone number is not valid', 'phone');
  }
  return phone;
}

const emptyToNull = (value: string | null | undefined): string | null | undefined =>
  value === '' ? null : value;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly counters: DocumentCounterService,
    private readonly context: DealershipContext,
  ) {}

  /** Search matches name (English or Bangla), phone and code. */
  async list(access: BusinessAccess, query: ListQueryDto): Promise<Page<unknown>> {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.CustomerWhereInput = {
      ...activeFilter(query.active),
      ...(query.search
        ? {
            OR: [
              { nameEn: { contains: query.search, mode: 'insensitive' } },
              { nameBn: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search.replace(/[\s-]/g, '') } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.customer.count({ where }),
    ]);
    return { items: rows.map(toResponse), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .customer.findUnique({ where: { id }, select });
    return row ? toResponse(row) : notFound('Customer');
  }

  async create(access: BusinessAccess, dto: CreateCustomerDto, actor: Actor) {
    // A salesman may add a customer with name and phone; balances need due access.
    if (dto.openingBalance !== undefined || (dto.creditLimit ?? null) !== null) {
      requirePermission(access, 'customer.due.view');
    }
    const phone = phoneOrThrow(dto.phone);
    const opening = toDecimal(dto.openingBalance ?? '0');
    const db = this.prisma.forBusiness(access.businessId);
    const config = await this.context.config(access.businessId);

    try {
      const row = await db.$transaction(async (tx) => {
        const number = await this.counters.next(tx, access.businessId, 'customer');
        const created = await tx.customer.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.customer, number, CUSTOMER_CODE_WIDTH),
            nameEn: dto.nameEn,
            nameBn: emptyToNull(dto.nameBn) ?? null,
            phone,
            address: emptyToNull(dto.address) ?? null,
            area: emptyToNull(dto.area) ?? null,
            openingBalance: opening,
            currentBalance: opening,
            creditLimit: dto.creditLimit ? toDecimal(dto.creditLimit) : null,
            createdBy: actor.userId,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'customer.created',
            entityType: 'customer',
            entityId: created.id,
            changes: {
              code: created.code,
              nameEn: created.nameEn,
              phone: created.phone,
              openingBalance: moneyString(created.openingBalance),
              creditLimit: moneyStringOrNull(created.creditLimit),
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return created;
      });
      return toResponse(row);
    } catch (error) {
      rethrowUnique(error, DUPLICATE);
    }
  }

  /**
   * Contact details need customer.manage. Opening balance and credit limit need
   * customer.balance.edit, (de)activation customer.deactivate, both with a reason.
   * Changing the opening balance moves the current balance by the same amount.
   */
  async update(access: BusinessAccess, id: string, dto: UpdateCustomerDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const current = await db.customer.findUnique({ where: { id }, select });
    if (!current) {
      notFound('Customer');
    }
    const phone = dto.phone === undefined ? undefined : phoneOrThrow(dto.phone);
    const creditLimit =
      dto.creditLimit === undefined
        ? undefined
        : dto.creditLimit === null
          ? null
          : toDecimal(dto.creditLimit).toFixed(2);
    const changes = diff(toResponse(current), {
      nameEn: dto.nameEn,
      nameBn: emptyToNull(dto.nameBn),
      phone,
      address: emptyToNull(dto.address),
      area: emptyToNull(dto.area),
      openingBalance: dto.openingBalance && toDecimal(dto.openingBalance).toFixed(2),
      creditLimit,
      isActive: dto.isActive,
    });
    if (Object.keys(changes).length === 0) {
      throw badRequest('NOTHING_TO_CHANGE', 'Nothing to change');
    }

    let reason: string | undefined;
    if ('openingBalance' in changes || 'creditLimit' in changes) {
      requirePermission(access, 'customer.due.view');
      requirePermission(access, 'customer.balance.edit');
      reason = requireReason(dto.reason);
    }
    if ('isActive' in changes) {
      requirePermission(access, 'customer.deactivate');
      reason = requireReason(dto.reason);
    }

    const delta =
      dto.openingBalance === undefined
        ? undefined
        : toDecimal(dto.openingBalance).minus(current.openingBalance);

    try {
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.customer.update({
          where: { id },
          data: {
            // Every change bumps the version, so pending change requests go stale.
            version: { increment: 1 },
            updatedBy: actor.userId,
            nameEn: dto.nameEn,
            nameBn: emptyToNull(dto.nameBn),
            phone,
            address: emptyToNull(dto.address),
            area: emptyToNull(dto.area),
            openingBalance:
              dto.openingBalance === undefined ? undefined : toDecimal(dto.openingBalance),
            // Atomic: never read-modify-write a balance in JavaScript.
            currentBalance: delta && !delta.isZero() ? { increment: delta } : undefined,
            creditLimit:
              creditLimit === undefined
                ? undefined
                : creditLimit === null
                  ? null
                  : toDecimal(creditLimit),
            isActive: dto.isActive,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'customer.updated',
            entityType: 'customer',
            entityId: id,
            changes: { ...changes, ...(reason ? { reason } : {}) },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return updated;
      });
      return toResponse(row);
    } catch (error) {
      rethrowUnique(error, DUPLICATE);
    }
  }
}
