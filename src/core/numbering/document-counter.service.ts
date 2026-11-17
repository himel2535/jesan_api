import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * Hands out the next number for a business, document type and period, e.g.
 * product codes or (later) invoice numbers. One atomic statement: concurrent
 * requests never get the same number, and the table size does not matter.
 * Always call it inside the transaction that stores the number, so a failed
 * save gives the number back.
 */
@Injectable()
export class DocumentCounterService {
  async next(
    tx: Prisma.TransactionClient,
    businessId: string,
    docType: string,
    period = 0,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ last_value: bigint }[]>`
      INSERT INTO document_counters (business_id, doc_type, period, last_value, updated_at)
      VALUES (${businessId}::uuid, ${docType}, ${period}, 1, now())
      ON CONFLICT (business_id, doc_type, period)
      DO UPDATE SET last_value = document_counters.last_value + 1, updated_at = now()
      RETURNING last_value`;
    const value = rows[0]?.last_value;
    if (value === undefined) {
      throw new Error('Document counter returned no value');
    }
    return Number(value);
  }
}

/** `formatCode('P', 7, 4)` gives `P-0007`. Longer numbers are never cut. */
export function formatCode(prefix: string, value: number, width: number): string {
  return `${prefix}-${String(value).padStart(width, '0')}`;
}
