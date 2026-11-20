-- CreateTable
CREATE TABLE "commission_schemes" (
    "business_id" UUID NOT NULL,
    "rate_base" DECIMAL(14,2) NOT NULL,
    "target_qty" DECIMAL(14,3) NOT NULL,
    "bonus_rate" DECIMAL(14,2) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_schemes_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "calculated_amount" DECIMAL(14,2) NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_receipts" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "received_date" DATE NOT NULL,
    "reference" VARCHAR(100),
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_entries_business_id_from_date_idx" ON "commission_entries"("business_id", "from_date");

-- CreateIndex
CREATE INDEX "commission_receipts_business_id_received_date_idx" ON "commission_receipts"("business_id", "received_date");

-- CreateIndex
CREATE INDEX "commission_receipts_entry_id_idx" ON "commission_receipts"("entry_id");

-- AddForeignKey
ALTER TABLE "commission_schemes" ADD CONSTRAINT "commission_schemes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_receipts" ADD CONSTRAINT "commission_receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_receipts" ADD CONSTRAINT "commission_receipts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
