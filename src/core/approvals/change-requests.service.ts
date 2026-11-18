import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { BusinessAccess } from '../common/request-context';
import { PrismaService } from '../database/prisma.service';
import {
  ChangeContext,
  ChangeHandler,
  ChangeValues,
  ImpactLine,
  LoadedRecord,
  ProposedChange,
} from './change-handler';
import { ChangeHandlerRegistry } from './change-handler.registry';
import { ChangeRequestBodyDto, CreateChangeRequestDto, ListQueryDto, MyListQueryDto } from './dto';

export const PAGE_SIZE = 10;

export interface Actor {
  userId: string;
  ip?: string | undefined;
}

const listSelect = {
  id: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  kind: true,
  status: true,
  // Small: only the affected fields. Used for the summary, never returned in lists.
  snapshot: true,
  proposedChange: true,
  requestedAt: true,
  decidedAt: true,
  requester: { select: { id: true, name: true } },
  decider: { select: { id: true, name: true } },
} as const;

type ListRow = Prisma.ChangeRequestGetPayload<{ select: typeof listSelect }>;

const detailSelect = {
  ...listSelect,
  reason: true,
  baseVersion: true,
  decisionNote: true,
  appliedAt: true,
  requestedBy: true,
} as const;

type DetailRow = Prisma.ChangeRequestGetPayload<{ select: typeof detailSelect }>;

function asValues(json: Prisma.JsonValue | null): ChangeValues {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as ChangeValues) : {};
}

function contextOf(access: BusinessAccess, actor: Actor): ChangeContext {
  return {
    businessId: access.businessId,
    businessType: access.businessType,
    actorUserId: actor.userId,
    permissions: access.permissions,
  };
}

function isUniqueViolation(error: unknown, hint: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (JSON.stringify(error.meta ?? {}) + error.message).includes(hint)
  );
}

/**
 * Maker-checker: staff request an edit or void with a reason; someone allowed
 * to approve (never the requester) applies it, in one transaction, only if the
 * record has not changed since. Works for any registered record type.
 */
@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChangeHandlerRegistry,
    private readonly audit: AuditService,
  ) {}

  /** What the change would do, without saving anything. */
  async preview(access: BusinessAccess, dto: ChangeRequestBodyDto, actor: Actor) {
    if (!access.permissions.has('change.request') && !access.permissions.has('change.approve')) {
      throw new ForbiddenException('Access denied');
    }
    const handler = this.handlerFor(access, dto.entityType);
    const ctx = contextOf(access, actor);
    const db = this.prisma.forBusiness(access.businessId);
    return db.$transaction(async (tx) => {
      const current = await this.loadOrThrow(handler, tx, ctx, dto.entityId, false);
      const change = this.validateChange(handler, ctx, current, dto, access);
      if (change.kind === 'void') {
        await handler.validateVoid?.(tx, ctx, current);
      }
      const lines = await handler.preview(tx, ctx, current, change);
      return { entityLabel: current.label, impact: this.visibleLines(lines, access.permissions) };
    });
  }

  async create(
    access: BusinessAccess,
    dto: CreateChangeRequestDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ): Promise<{ created: boolean; request: unknown }> {
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(access, actor, idempotencyKey);
      if (existing) {
        return { created: false, request: existing };
      }
    }
    const handler = this.handlerFor(access, dto.entityType);
    const ctx = contextOf(access, actor);
    const db = this.prisma.forBusiness(access.businessId);

    try {
      const id = await db.$transaction(async (tx) => {
        const current = await this.loadOrThrow(handler, tx, ctx, dto.entityId, false);
        const change = this.validateChange(handler, ctx, current, dto, access);
        if (change.kind === 'void') {
          await handler.validateVoid?.(tx, ctx, current);
        }
        const snapshot =
          change.kind === 'edit'
            ? Object.fromEntries(
                Object.keys(change.values).map((key) => [key, current.values[key] ?? null]),
              )
            : current.values;
        const created = await tx.changeRequest.create({
          data: {
            businessId: access.businessId,
            entityType: handler.entityType,
            entityId: dto.entityId,
            entityLabel: current.label.slice(0, 160),
            kind: change.kind,
            reason: dto.reason,
            baseVersion: current.version,
            snapshot,
            proposedChange: change.kind === 'edit' ? change.values : Prisma.DbNull,
            requestedBy: actor.userId,
            idempotencyKey: idempotencyKey ?? null,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'change_request.created',
            entityType: 'change_request',
            entityId: created.id,
            changes: {
              entityType: handler.entityType,
              entityId: dto.entityId,
              kind: change.kind,
              reason: dto.reason,
              ...(change.kind === 'edit' ? { proposed: change.values } : {}),
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return created.id;
      });
      return { created: true, request: await this.detail(access, id, actor) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByIdempotencyKey(access, actor, idempotencyKey);
        if (existing) {
          return { created: false, request: existing };
        }
      }
      if (isUniqueViolation(error, 'one_pending') || isUniqueViolation(error, 'entity_id')) {
        throw new ConflictException('This record already has a pending change request');
      }
      throw error;
    }
  }

  async listMine(access: BusinessAccess, query: MyListQueryDto, actor: Actor) {
    return this.list(
      access,
      { requestedBy: actor.userId, ...(query.status ? { status: query.status } : {}) },
      query.page,
    );
  }

  async listAll(access: BusinessAccess, query: ListQueryDto) {
    const where: Prisma.ChangeRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.requestedBy ? { requestedBy: query.requestedBy } : {}),
      ...(query.from || query.to
        ? {
            requestedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    return this.list(access, where, query.page);
  }

  /** For the approver's badge: one indexed count. */
  async pendingCount(access: BusinessAccess) {
    const count = await this.prisma
      .forBusiness(access.businessId)
      .changeRequest.count({ where: { status: 'pending' } });
    return { count };
  }

  async detail(access: BusinessAccess, id: string, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const row = await db.changeRequest.findUnique({ where: { id }, select: detailSelect });
    if (!row || !this.canView(access, row, actor)) {
      throw new NotFoundException('Change request not found');
    }
    const handler = this.registry.find(row.entityType, access.businessType);
    let impact: ImpactLine[] | null = null;
    let isStale = row.status === 'stale';
    if (row.status === 'pending' && handler) {
      const ctx = contextOf(access, actor);
      const live = await db.$transaction(async (tx) => {
        const current = await handler.load(tx, ctx, row.entityId, { forUpdate: false });
        if (!current) {
          return null;
        }
        const change: ProposedChange =
          row.kind === 'void'
            ? { kind: 'void' }
            : { kind: 'edit', values: asValues(row.proposedChange) };
        return { current, lines: await handler.preview(tx, ctx, current, change) };
      });
      isStale = !live || live.current.version !== row.baseVersion;
      impact = live ? this.visibleLines(live.lines, access.permissions) : null;
    }
    return {
      ...this.toListItem(row, handler, access.permissions),
      reason: row.reason,
      snapshot: this.visibleValues(asValues(row.snapshot), handler, access.permissions),
      proposedChange:
        row.kind === 'edit'
          ? this.visibleValues(asValues(row.proposedChange), handler, access.permissions)
          : null,
      impact,
      isStale,
      decisionNote: row.decisionNote,
      appliedAt: row.appliedAt?.toISOString() ?? null,
    };
  }

  /**
   * Applies the request. In one transaction: lock the request, check it is
   * pending and not the approver's own, check the approver may make this change
   * directly, lock the record, and either mark the request stale (record changed
   * since) or apply it. Any error rolls everything back.
   */
  async approve(access: BusinessAccess, id: string, note: string | undefined, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const ctx = contextOf(access, actor);

    const outcome = await db.$transaction(async (tx) => {
      const request = await this.lockPending(tx, access, id);
      if (request.requestedBy === actor.userId) {
        throw new ForbiddenException('You cannot decide your own change request');
      }
      const handler = this.registry.find(request.entityType, access.businessType);
      if (!handler) {
        throw new ConflictException('This kind of record can no longer be changed here');
      }
      const proposed = asValues(request.proposedChange);
      this.requireDirectPermissions(handler, request.kind, Object.keys(proposed), access);

      const current = await handler.load(tx, ctx, request.entityId, { forUpdate: true });
      if (!current || current.version !== request.baseVersion) {
        await tx.changeRequest.update({
          where: { id },
          data: {
            status: 'stale',
            decidedBy: actor.userId,
            decidedAt: new Date(),
            decisionNote: note ?? null,
          },
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'change_request.stale',
            entityType: 'change_request',
            entityId: id,
            changes: { baseVersion: request.baseVersion, currentVersion: current?.version ?? null },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return { stale: true as const };
      }

      let after: ChangeValues | null = null;
      if (request.kind === 'edit') {
        // Validated again against the record as it is now.
        const values = handler.validateEdit(ctx, current, proposed);
        await handler.applyEdit(tx, ctx, request.entityId, current, values);
        after = values;
      } else {
        await handler.validateVoid?.(tx, ctx, current);
        await handler.applyVoid?.(tx, ctx, request.entityId, current, request.reason);
      }

      const now = new Date();
      await tx.changeRequest.update({
        where: { id },
        data: {
          status: 'approved',
          decidedBy: actor.userId,
          decidedAt: now,
          appliedAt: now,
          decisionNote: note ?? null,
        },
      });
      const before = Object.fromEntries(
        Object.keys(after ?? current.values).map((key) => [key, current.values[key] ?? null]),
      );
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'change_request.approved',
          entityType: 'change_request',
          entityId: id,
          changes: { note: note ?? null },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'change_request.applied',
          entityType: request.entityType,
          entityId: request.entityId,
          changes: {
            changeRequestId: id,
            kind: request.kind,
            reason: request.reason,
            before,
            after,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return { stale: false as const };
    });

    if (outcome.stale) {
      throw new ConflictException(
        'The record changed after this request was made; the request is now stale',
      );
    }
    return this.detail(access, id, actor);
  }

  async reject(access: BusinessAccess, id: string, note: string, actor: Actor) {
    await this.prisma.forBusiness(access.businessId).$transaction(async (tx) => {
      const request = await this.lockPending(tx, access, id);
      if (request.requestedBy === actor.userId) {
        throw new ForbiddenException('You cannot decide your own change request');
      }
      await tx.changeRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedBy: actor.userId,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'change_request.rejected',
          entityType: 'change_request',
          entityId: id,
          changes: { note },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.detail(access, id, actor);
  }

  /** The requester withdraws their own pending request. */
  async cancel(access: BusinessAccess, id: string, actor: Actor) {
    await this.prisma.forBusiness(access.businessId).$transaction(async (tx) => {
      const request = await this.lockPending(tx, access, id, actor.userId);
      if (request.requestedBy !== actor.userId) {
        throw new NotFoundException('Change request not found');
      }
      await tx.changeRequest.update({ where: { id }, data: { status: 'cancelled' } });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'change_request.cancelled',
          entityType: 'change_request',
          entityId: id,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.detail(access, id, actor);
  }

  // ---------------------------------------------------------------------------

  private handlerFor(access: BusinessAccess, entityType: string): ChangeHandler {
    const handler = this.registry.find(entityType, access.businessType);
    if (!handler) {
      throw new BadRequestException(`Unknown record type: ${entityType}`);
    }
    if (!access.permissions.has(handler.viewPermission)) {
      throw new ForbiddenException('Access denied');
    }
    return handler;
  }

  private async loadOrThrow(
    handler: ChangeHandler,
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    entityId: string,
    forUpdate: boolean,
  ): Promise<LoadedRecord> {
    const current = await handler.load(tx, ctx, entityId, { forUpdate });
    if (!current) {
      throw new NotFoundException('Record not found');
    }
    return current;
  }

  /** Checks the fields and values a requester proposes; returns the normalized change. */
  private validateChange(
    handler: ChangeHandler,
    ctx: ChangeContext,
    current: LoadedRecord,
    dto: ChangeRequestBodyDto,
    access: BusinessAccess,
  ): ProposedChange {
    if (dto.kind === 'void') {
      if (!handler.void) {
        throw new BadRequestException(
          'This kind of record cannot be voided; deactivate it instead',
        );
      }
      if (dto.proposedChange !== undefined) {
        throw new BadRequestException('A void request has no proposedChange');
      }
      return { kind: 'void' };
    }

    const proposed = dto.proposedChange ?? {};
    const keys = Object.keys(proposed);
    if (keys.length === 0) {
      throw new BadRequestException('proposedChange must name at least one field');
    }
    for (const key of keys) {
      const rule = handler.fields[key];
      if (!rule) {
        throw new BadRequestException(`Field "${key}" cannot be changed by request`);
      }
      // Nobody may request (and so see) a value they are not allowed to see.
      if (rule.visibleWith && !access.permissions.has(rule.visibleWith)) {
        throw new ForbiddenException('Access denied');
      }
    }
    const values = handler.validateEdit(ctx, current, proposed as ChangeValues);
    const changed = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => current.values[key] !== value),
    );
    if (Object.keys(changed).length === 0) {
      throw new BadRequestException('Nothing to change');
    }
    return { kind: 'edit', values: changed };
  }

  /** The approver must be allowed to make the very same change directly. */
  private requireDirectPermissions(
    handler: ChangeHandler,
    kind: string,
    fields: string[],
    access: BusinessAccess,
  ): void {
    const needed =
      kind === 'void'
        ? [handler.void?.directPermission ?? 'change.approve']
        : fields.map((field) => handler.fields[field]?.directPermission ?? 'change.approve');
    for (const permission of ['change.approve', ...needed]) {
      if (!access.permissions.has(permission)) {
        throw new ForbiddenException('Access denied');
      }
    }
  }

  /** Locks a request row for the rest of the transaction; it must be pending. */
  private async lockPending(
    tx: Prisma.TransactionClient,
    access: BusinessAccess,
    id: string,
    ownerOnlyUserId?: string,
  ) {
    // Raw SQL on business data: the business filter is written out here.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM change_requests
      WHERE id = ${id}::uuid AND business_id = ${access.businessId}::uuid
      FOR UPDATE`;
    const request = locked.length
      ? await tx.changeRequest.findUnique({
          where: { id },
          select: {
            status: true,
            requestedBy: true,
            entityType: true,
            entityId: true,
            kind: true,
            reason: true,
            baseVersion: true,
            proposedChange: true,
          },
        })
      : null;
    const visible =
      request &&
      (ownerOnlyUserId
        ? request.requestedBy === ownerOnlyUserId
        : access.permissions.has('change.view.all') || access.permissions.has('change.approve'));
    if (!request || !visible) {
      throw new NotFoundException('Change request not found');
    }
    if (request.status !== 'pending') {
      throw new ConflictException(`This change request is already ${request.status}`);
    }
    return request;
  }

  private async list(access: BusinessAccess, where: Prisma.ChangeRequestWhereInput, page: number) {
    const db = this.prisma.forBusiness(access.businessId);
    const [rows, total] = await Promise.all([
      db.changeRequest.findMany({
        where,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: listSelect,
      }),
      db.changeRequest.count({ where }),
    ]);
    return {
      items: rows.map((row) =>
        this.toListItem(
          row,
          this.registry.find(row.entityType, access.businessType),
          access.permissions,
        ),
      ),
      page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  private canView(access: BusinessAccess, row: DetailRow, actor: Actor): boolean {
    return (
      access.permissions.has('change.view.all') ||
      (row.requestedBy === actor.userId && access.permissions.has('change.view.own'))
    );
  }

  private async findByIdempotencyKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).changeRequest.findFirst({
      where: { requestedBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.detail(access, row.id, actor) : null;
  }

  /** List shape: no snapshot, and a summary built for this viewer only. */
  private toListItem(
    row: ListRow,
    handler: ChangeHandler | undefined,
    permissions: ReadonlySet<string>,
  ) {
    return {
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      kind: row.kind,
      summary: this.summary(row, handler, permissions),
      status: row.status,
      requestedBy: row.requester,
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: row.decider,
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  /** "Default sale price: 560.00 → 565.00"; hidden fields are named without values. */
  private summary(
    row: ListRow,
    handler: ChangeHandler | undefined,
    permissions: ReadonlySet<string>,
  ): string {
    if (row.kind === 'void') {
      return handler?.void?.label ?? 'Void';
    }
    const before = asValues(row.snapshot);
    const after = asValues(row.proposedChange);
    return Object.keys(after)
      .map((key) => {
        const rule = handler?.fields[key];
        const label = rule?.label ?? key;
        if (!rule || (rule.visibleWith && !permissions.has(rule.visibleWith))) {
          return `${label} changed`;
        }
        return `${label}: ${String(before[key] ?? '—')} → ${String(after[key] ?? '—')}`;
      })
      .join('; ');
  }

  private visibleValues(
    values: ChangeValues,
    handler: ChangeHandler | undefined,
    permissions: ReadonlySet<string>,
  ): ChangeValues {
    return Object.fromEntries(
      Object.entries(values).filter(([key]) => {
        const rule = handler?.fields[key];
        return rule ? !rule.visibleWith || permissions.has(rule.visibleWith) : false;
      }),
    );
  }

  private visibleLines(lines: ImpactLine[], permissions: ReadonlySet<string>) {
    return lines
      .filter((line) => !line.visibleWith || permissions.has(line.visibleWith))
      .map((line) => {
        const shown: Omit<ImpactLine, 'visibleWith'> & { visibleWith?: string } = { ...line };
        delete shown.visibleWith;
        return shown;
      });
  }
}
