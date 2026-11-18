-- AlterTable
ALTER TABLE "products" ADD COLUMN     "current_stock" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_date" DATE NOT NULL,
    "payment_method" VARCHAR(16) NOT NULL DEFAULT 'cash',
    "total_quantity" DECIMAL(14,3) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "note" VARCHAR(500),
    "supplier_reference" VARCHAR(64),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "purchase_date" DATE NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "balance_after" DECIMAL(14,3) NOT NULL,
    "movement_date" DATE NOT NULL,
    "source_type" VARCHAR(16) NOT NULL,
    "source_id" UUID,
    "reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_purchase_counters" (
    "business_id" UUID NOT NULL,
    "period" INTEGER NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_purchase_counters_pkey" PRIMARY KEY ("business_id","period")
);

-- CreateIndex
CREATE INDEX "purchases_business_id_purchase_date_id_idx" ON "purchases"("business_id", "purchase_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "purchases_business_id_supplier_id_purchase_date_idx" ON "purchases"("business_id", "supplier_id", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "purchases_business_id_status_purchase_date_idx" ON "purchases"("business_id", "status", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "purchases_created_by_idx" ON "purchases"("created_by");

-- CreateIndex
CREATE INDEX "purchases_updated_by_idx" ON "purchases"("updated_by");

-- CreateIndex
CREATE INDEX "purchases_voided_by_idx" ON "purchases"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_business_id_code_key" ON "purchases"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_business_id_id_key" ON "purchases"("business_id", "id");

-- CreateIndex
CREATE INDEX "purchase_items_business_id_purchase_id_idx" ON "purchase_items"("business_id", "purchase_id");

-- CreateIndex
CREATE INDEX "purchase_items_business_id_product_id_purchase_date_created_idx" ON "purchase_items"("business_id", "product_id", "purchase_date" DESC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_purchase_id_product_id_key" ON "purchase_items"("purchase_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_movements_business_id_product_id_created_at_id_idx" ON "stock_movements"("business_id", "product_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_business_id_movement_date_idx" ON "stock_movements"("business_id", "movement_date");

-- CreateIndex
CREATE INDEX "stock_movements_business_id_source_type_source_id_idx" ON "stock_movements"("business_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "stock_movements_created_by_idx" ON "stock_movements"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "products_business_id_id_key" ON "products"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_business_id_id_key" ON "suppliers"("business_id", "id");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_business_id_supplier_id_fkey" FOREIGN KEY ("business_id", "supplier_id") REFERENCES "suppliers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_business_id_purchase_id_fkey" FOREIGN KEY ("business_id", "purchase_id") REFERENCES "purchases"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_purchase_counters" ADD CONSTRAINT "monthly_purchase_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written rules (Step 5a).
-- ---------------------------------------------------------------------------

-- Stock is never negative.
ALTER TABLE "products" ADD CONSTRAINT "products_current_stock_check" CHECK ("current_stock" >= 0);

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_payment_method_check" CHECK ("payment_method" IN ('cash'));
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_totals_check" CHECK ("total_quantity" > 0 AND "total_amount" >= 0);
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_version_check" CHECK ("version" >= 1);
-- A void purchase says when, by whom and why; an active one has none of that.
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_void_check" CHECK (
  ("status" = 'void') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_void_reason_check" CHECK ("void_reason" IS NULL OR btrim("void_reason") <> '');
-- Double-click and network retries: one purchase per user and key.
CREATE UNIQUE INDEX "purchases_idempotency_key" ON "purchases" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_unit_price_check" CHECK ("unit_price" >= 0);
-- PostgreSQL's numeric round() rounds halves away from zero: half up for these
-- non-negative amounts, the same as Decimal.ROUND_HALF_UP in the API.
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_line_total_check" CHECK ("line_total" = round("quantity" * "unit_price", 2));

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check"
  CHECK ("kind" IN ('purchase', 'purchase_edit', 'purchase_void', 'adjustment'));
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_check" CHECK ("quantity" <> 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_balance_check" CHECK ("balance_after" >= 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_source_check" CHECK (
  ("source_type" = 'purchase' AND "source_id" IS NOT NULL AND "kind" IN ('purchase', 'purchase_edit', 'purchase_void'))
  OR ("source_type" = 'adjustment' AND "source_id" IS NULL AND "kind" = 'adjustment')
);
-- Corrections and adjustments always say why.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK (
  "kind" = 'purchase' OR ("reason" IS NOT NULL AND btrim("reason") <> '')
);

ALTER TABLE "monthly_purchase_counters" ADD CONSTRAINT "monthly_purchase_counters_quantity_check" CHECK ("quantity" >= 0);
ALTER TABLE "monthly_purchase_counters" ADD CONSTRAINT "monthly_purchase_counters_period_check"
  CHECK ("period" BETWEEN 200001 AND 999912 AND "period" % 100 BETWEEN 1 AND 12);

-- The stock ledger is append-only. Only a deliberate purge (test clean-up,
-- inside a transaction with SET LOCAL jesan.allow_purge = 'on') may delete;
-- application code never does.
CREATE FUNCTION "stock_movements_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('jesan.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'stock_movements is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_movements_append_only"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();
