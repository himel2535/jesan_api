-- Commission is now just "amount received + reason". The scheme, target and
-- calculated entries go away; every receipt (the money actually received, and
-- the ledger rows that point at it) is kept. Where a receipt has no note, it
-- inherits its old entry's note so the reason is not lost.
UPDATE "commission_receipts" r
SET "note" = COALESCE(NULLIF(r."note", ''), NULLIF(e."note", ''), NULLIF(r."reference", ''))
FROM "commission_entries" e
WHERE e."id" = r."entry_id";

ALTER TABLE "commission_receipts" DROP CONSTRAINT "commission_receipts_entry_id_fkey";
DROP INDEX "commission_receipts_entry_id_idx";
ALTER TABLE "commission_receipts" DROP COLUMN "entry_id";
ALTER TABLE "commission_receipts" DROP COLUMN "reference";

DROP TABLE "commission_entries";
DROP TABLE "commission_schemes";
