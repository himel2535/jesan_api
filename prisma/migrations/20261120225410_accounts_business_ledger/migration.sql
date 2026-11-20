-- CreateTable
CREATE TABLE "business_ledger_entries" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "direction" VARCHAR(4) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" VARCHAR(16),
    "reference_type" VARCHAR(32),
    "reference_id" UUID,
    "entry_date" DATE NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "idempotency_key" VARCHAR(64),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_ledger_entries_business_id_entry_date_id_idx" ON "business_ledger_entries"("business_id", "entry_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "business_ledger_entries_business_id_type_entry_date_idx" ON "business_ledger_entries"("business_id", "type", "entry_date" DESC);

-- CreateIndex
CREATE INDEX "business_ledger_entries_business_id_reference_type_referenc_idx" ON "business_ledger_entries"("business_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "business_ledger_entries_business_id_status_direction_amount_idx" ON "business_ledger_entries"("business_id", "status", "direction", "amount");

-- CreateIndex
CREATE INDEX "business_ledger_entries_created_by_idx" ON "business_ledger_entries"("created_by");

-- AddForeignKey
ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_type_check"
  CHECK ("type" IN ('collection', 'expense', 'purchase', 'commission_receipt', 'manual', 'supplier_payment'));

ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_direction_check"
  CHECK ("direction" IN ('in', 'out'));

ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_amount_check"
  CHECK ("amount" > 0);

ALTER TABLE "business_ledger_entries" ADD CONSTRAINT "business_ledger_entries_status_check"
  CHECK ("status" IN ('active', 'void'));

-- Idempotency: the same key by the same person in the same business returns
-- the same row instead of saving twice (manual entries and payments only).
CREATE UNIQUE INDEX "business_ledger_entries_idempotency_key" ON "business_ledger_entries" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
