import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { toDbDate } from '../../../core/common/business-time';
import { lockRows } from '../../../core/database/row-lock';

export type LedgerKind =
  | 'delivery'
  | 'delivery_edit'
  | 'delivery_void'
  | 'collection'
  | 'collection_edit'
  | 'collection_void';

export interface AccountChange {
  /** Value delivered (+) or taken back (-). */
  delivered?: Prisma.Decimal;
  /** Money collected (+) or reversed (-). */
  collected?: Prisma.Decimal;
  /** Bags still to deliver: + on order, - on delivery. */
  pending?: Prisma.Decimal;
  /** One ledger line for this change (amount: delivered - collected). */
  ledger?: {
    kind: LedgerKind;
    entryDate: string;
    sourceType: 'delivery' | 'collection';
    sourceId: string;
    reason: string | null;
  };
}

const ZERO = new Prisma.Decimal(0);

/**
 * The only way a customer's balance and summaries change. In the caller's
 * transaction: lock the customer row, move delivered/collected/pending and the
 * current balance by the same amounts (atomic increments), and append the
 * ledger line. So current_balance = opening + delivered - collected, and the
 * ledger sums to delivered - collected, always.
 */
@Injectable()
export class CustomerAccounts {
  async lock(tx: Prisma.TransactionClient, businessId: string, customerId: string): Promise<void> {
    await lockRows(tx, 'customers', businessId, [customerId]);
  }

  async move(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    customerId: string,
    change: AccountChange,
  ): Promise<void> {
    const delivered = change.delivered ?? ZERO;
    const collected = change.collected ?? ZERO;
    const pending = change.pending ?? ZERO;
    const balance = delivered.sub(collected);
    if (delivered.isZero() && collected.isZero() && pending.isZero()) {
      return;
    }
    await this.lock(tx, businessId, customerId);
    await tx.customer.update({
      where: { id: customerId },
      data: {
        ...(balance.isZero() ? {} : { currentBalance: { increment: balance } }),
        ...(delivered.isZero() ? {} : { deliveredAmount: { increment: delivered } }),
        ...(collected.isZero() ? {} : { collectedAmount: { increment: collected } }),
        ...(pending.isZero() ? {} : { pendingDeliveryQuantity: { increment: pending } }),
      },
    });
    if (change.ledger && !balance.isZero()) {
      await tx.customerLedgerEntry.create({
        data: {
          businessId,
          customerId,
          kind: change.ledger.kind,
          amount: balance,
          entryDate: toDbDate(change.ledger.entryDate),
          sourceType: change.ledger.sourceType,
          sourceId: change.ledger.sourceId,
          reason: change.ledger.reason,
          createdBy: actorUserId,
        },
      });
    }
  }
}
