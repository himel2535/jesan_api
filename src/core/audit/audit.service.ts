import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface AuditEntry {
  businessId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Only the changed fields, before and after. Never passwords or hashes. */
  changes?: Prisma.InputJsonValue;
  ip?: string | null;
}

/** Writes the append-only audit log. Pass `tx` to make it part of a transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma.client;
    await db.auditLog.create({
      data: {
        businessId: entry.businessId ?? null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        changes: entry.changes ?? Prisma.JsonNull,
        ip: entry.ip ?? null,
      },
    });
  }
}
