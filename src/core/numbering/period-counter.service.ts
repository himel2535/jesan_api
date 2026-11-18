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
    await tx.$executeRaw`
      INSERT INTO ${Prisma.raw(`"${table}"`)} (business_id, period, quantity, updated_at)
      VALUES (${businessId}::uuid, ${period}, ${amount}::numeric, now())
      ON CONFLICT (business_id, period)
      DO UPDATE SET quantity = ${Prisma.raw(`"${table}"`)}.quantity + EXCLUDED.quantity,
                    updated_at = now()`;
  }
}
