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

  /**
   * Restates the active entry of a source document after it was corrected: the
   * amount, and the date when the document moved to another day, so the entry
   * keeps counting in the document's own month. Updates the row in place rather
   * than adding a second one — the entry mirrors one document, so a correction
   * is not a new money movement. Appends one when none is active, for documents
   * recorded before their module wrote to the ledger.
   */
  async restateByReference(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    reference: { referenceType: string; referenceId: string },
    entry: Omit<LedgerEntryInput, 'referenceType' | 'referenceId'>,
  ): Promise<void> {
    const { count } = await tx.businessLedgerEntry.updateMany({
      where: {
        businessId,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId,
        status: 'active',
      },
      data: { amount: entry.amount, entryDate: toDbDate(entry.entryDate) },
    });
    if (count === 0) {
      await this.append(tx, businessId, actorUserId, {
        ...entry,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId,
      });
    }
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
