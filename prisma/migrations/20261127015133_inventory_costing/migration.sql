-- AlterTable
ALTER TABLE "delivery_items" ADD COLUMN     "cost_amount" DECIMAL(18,6),
ADD COLUMN     "uncosted_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "unit_cost" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "costed_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "costed_value" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "uncosted_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateTable
CREATE TABLE "inventory_cost_corrections" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "correction_date" DATE NOT NULL,
    "effective_date" DATE NOT NULL,
    "cogs_delta" DECIMAL(20,6) NOT NULL,
    "stock_value_delta" DECIMAL(20,6) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "reason" VARCHAR(500),
    "source_type" VARCHAR(16),
    "source_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_cost_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_cost_corrections_business_id_correction_date_idx" ON "inventory_cost_corrections"("business_id", "correction_date");

-- CreateIndex
CREATE INDEX "inventory_cost_corrections_business_id_product_id_idx" ON "inventory_cost_corrections"("business_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_cost_corrections_created_by_idx" ON "inventory_cost_corrections"("created_by");

-- CreateIndex
CREATE INDEX "stock_movements_business_id_product_id_seq_idx" ON "stock_movements"("business_id", "product_id", "seq");

-- AddForeignKey
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is written by hand (CLAUDE.md: CHECK constraints and
-- triggers are not generated).
-- ---------------------------------------------------------------------------

-- Give `seq` the meaning costing depends on. ADD COLUMN ... BIGSERIAL fills
-- existing rows in physical order, which is only incidentally insertion order,
-- so renumber explicitly by (created_at, id) — the order the movement list and
-- consistency-check already treat as authoritative. The ledger's append-only
-- trigger refuses UPDATE, so it is switched off for this one statement; this
-- runs inside the migration's transaction and touches no other column.
ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_append_only";
WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "stock_movements"
)
UPDATE "stock_movements" m SET "seq" = o.rn FROM ordered o WHERE m."id" = o."id";
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_append_only";
SELECT setval(
  pg_get_serial_sequence('stock_movements', 'seq'),
  COALESCE((SELECT max("seq") FROM "stock_movements"), 0) + 1,
  false
);

-- The two cost pools are counts and money: never negative. The pools summing to
-- current_stock is checked by `npm run db:check` rather than here, because rows
-- written before costing existed hold 0/0 against a non-zero stock until the
-- backfill has run.
ALTER TABLE "products" ADD CONSTRAINT "products_costed_quantity_check" CHECK ("costed_quantity" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_costed_value_check" CHECK ("costed_value" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_uncosted_quantity_check" CHECK ("uncosted_quantity" >= 0);

-- A line's uncosted part is a share of that line, and cost is never negative.
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_uncosted_quantity_check"
  CHECK ("uncosted_quantity" >= 0 AND "uncosted_quantity" <= "quantity");
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_cost_amount_check"
  CHECK ("cost_amount" IS NULL OR "cost_amount" >= 0);
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_unit_cost_check"
  CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0);

ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_kind_check"
  CHECK ("kind" IN ('purchase_edit', 'purchase_void', 'backdated_entry', 'rounding_residual'));
-- A correction that moves nothing is noise.
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_delta_check"
  CHECK ("cogs_delta" <> 0 OR "stock_value_delta" <> 0);
-- The day it is booked on can never precede the change it corrects.
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_date_check"
  CHECK ("correction_date" >= "effective_date");

-- Corrections are an audit trail of money already reported: append-only, the
-- same rule as stock_movements and customer_ledger_entries.
CREATE FUNCTION "inventory_cost_corrections_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('jesan.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inventory_cost_corrections is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inventory_cost_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_cost_corrections"
  FOR EACH ROW EXECUTE FUNCTION "inventory_cost_corrections_append_only"();
