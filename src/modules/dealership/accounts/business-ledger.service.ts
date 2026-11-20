import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { toDbDate } from '../../../core/common/business-time';

export type LedgerEntryType =
  'collection' | 'expense' | 'purchase' | 'commission_receipt' | 'manual' | 'supplier_payment';

export type LedgerDirection = 'in' | 'out';

export interface LedgerEntryInput {
  type: LedgerEntryType;
  direction: LedgerDirection;
  amount: Prisma.Decimal;
  method?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  entryDate: string;
  note?: string | null;
  idempotencyKey?: string | null;
}

/**
 * The business-level general ledger: every money movement, of any kind, in
 * one place. Mirrors `CustomerAccounts`: the caller's own transaction, no
 * transaction of its own. `BusinessLedgerEntry` is created or voided only
 * through this service, never directly by a module.
 */
@Injectable()
export class BusinessLedgerService {
  /** Returns the new row's id, or null if the amount was zero (no row written). */
  async append(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    entry: LedgerEntryInput,
  ): Promise<string | null> {
    if (!entry.amount.greaterThan(0)) return null;
    const row = await tx.businessLedgerEntry.create({
      data: {
        businessId,
        type: entry.type,
        direction: entry.direction,
        amount: entry.amount,
        method: entry.method ?? null,
        referenceType: entry.referenceType ?? null,
        referenceId: entry.referenceId ?? null,
        entryDate: toDbDate(entry.entryDate),
        note: entry.note ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        createdBy: actorUserId,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Flips the active entry(ies) created for a source document to void. */
  async voidByReference(
    tx: Prisma.TransactionClient,
    businessId: string,
    referenceType: string,
    referenceId: string,
  ): Promise<void> {
    await tx.businessLedgerEntry.updateMany({
      where: { businessId, referenceType, referenceId, status: 'active' },
      data: { status: 'void' },
    });
  }
}
