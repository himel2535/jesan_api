import { Prisma } from '../../generated/prisma/client';

const TABLE = /^[a-z][a-z_]{0,62}$/;

/**
 * Locks rows of a business-data table for the rest of the transaction
 * (SELECT ... FOR UPDATE), always in id order so two transactions locking the
 * same rows cannot deadlock. Raw SQL: the business filter is written out here.
 * Returns the ids that were found (and locked).
 */
export async function lockRows(
  tx: Prisma.TransactionClient,
  table: string,
  businessId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (!TABLE.test(table)) {
    throw new Error(`lockRows: invalid table name ${table}`);
  }
  if (ids.length === 0) {
    return [];
  }
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM ${Prisma.raw(`"${table}"`)}
    WHERE business_id = ${businessId}::uuid AND id = ANY(${sorted}::uuid[])
    ORDER BY id
    FOR UPDATE`;
  return rows.map((row) => row.id);
}
