import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

const TABLE = /^[a-z][a-z_]{0,62}$/;

/**
 * Adds to a running total per business and period (e.g. bags bought in a
 * month) with one atomic upsert, so concurrent saves never lose an update.
 * The table needs (business_id, period) as its key and a `quantity` column.
 * Call it inside the transaction that causes the change.
 */
@Injectable()
export class PeriodCounterService {
  async add(
    tx: Prisma.TransactionClient,
    table: string,
    businessId: string,
    period: number,
    delta: Prisma.Decimal,
  ): Promise<void> {
    if (!TABLE.test(table)) {
      throw new Error(`PeriodCounterService: invalid table name ${table}`);
    }
    if (delta.isZero()) {
      return;
    }
    const amount = delta.toString();
    const table_ = Prisma.raw(`"${table}"`);
    if (delta.isNegative()) {
      // Taking away needs an existing row. (An upsert would fail here: the
      // CHECK on quantity is evaluated on the proposed insert row first.)
      const changed = await tx.$executeRaw`
        UPDATE ${table_} SET quantity = quantity + ${amount}::numeric, updated_at = now()
        WHERE business_id = ${businessId}::uuid AND period = ${period}`;
      if (changed !== 1) {
        throw new Error(
          `PeriodCounterService: nothing to subtract from ${table} ${String(period)}`,
        );
      }
      return;
    }
    await tx.$executeRaw`
      INSERT INTO ${table_} (business_id, period, quantity, updated_at)
      VALUES (${businessId}::uuid, ${period}, ${amount}::numeric, now())
      ON CONFLICT (business_id, period)
      DO UPDATE SET quantity = ${table_}.quantity + EXCLUDED.quantity,
                    updated_at = now()`;
  }
}
