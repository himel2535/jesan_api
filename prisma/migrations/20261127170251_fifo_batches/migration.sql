-- AlterTable
ALTER TABLE "delivery_items" ADD COLUMN     "cost_source" VARCHAR(12);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "business_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source_type" VARCHAR(12) NOT NULL,
    "source_id" UUID NOT NULL,
    "original_quantity" DECIMAL(14,3) NOT NULL,
    "original_unit_cost" DECIMAL(14,2),
    "original_received_date" DATE NOT NULL,
    "received_quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,2),
    "received_date" DATE NOT NULL,
    "remaining_quantity" DECIMAL(14,3) NOT NULL,
    "backfill_run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_item_allocations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "delivery_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "kind" VARCHAR(12) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,2),
    "cost_amount" DECIMAL(18,6),
    "revenue_amount" DECIMAL(14,2) NOT NULL,
    "cost_known" BOOLEAN NOT NULL,
    "allocation_date" DATE NOT NULL,
    "correction_id" UUID,
    "backfill_run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_item_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batch_events" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "event_type" VARCHAR(16) NOT NULL,
    "business_date" DATE NOT NULL,
    "quantity_delta" DECIMAL(14,3) NOT NULL,
    "value_delta" DECIMAL(20,6) NOT NULL,
    "source_type" VARCHAR(16),
    "source_id" UUID,
    "correction_id" UUID,
    "reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "backfill_run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_batch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_backfill_runs" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "summary" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolled_back_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_backfill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_batches_business_id_product_id_received_date_seq_idx" ON "inventory_batches"("business_id", "product_id", "received_date", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_business_id_id_key" ON "inventory_batches"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_business_id_source_type_source_id_product_key" ON "inventory_batches"("business_id", "source_type", "source_id", "product_id");

-- CreateIndex
CREATE INDEX "delivery_item_allocations_business_id_delivery_item_id_idx" ON "delivery_item_allocations"("business_id", "delivery_item_id");

-- CreateIndex
CREATE INDEX "delivery_item_allocations_business_id_batch_id_idx" ON "delivery_item_allocations"("business_id", "batch_id");

-- CreateIndex
CREATE INDEX "delivery_item_allocations_business_id_product_id_allocation_idx" ON "delivery_item_allocations"("business_id", "product_id", "allocation_date");

-- CreateIndex
CREATE INDEX "delivery_item_allocations_correction_id_idx" ON "delivery_item_allocations"("correction_id");

-- CreateIndex
CREATE INDEX "inventory_batch_events_business_id_batch_id_idx" ON "inventory_batch_events"("business_id", "batch_id");

-- CreateIndex
CREATE INDEX "inventory_batch_events_business_id_product_id_business_date_idx" ON "inventory_batch_events"("business_id", "product_id", "business_date");

-- CreateIndex
CREATE INDEX "inventory_batch_events_correction_id_idx" ON "inventory_batch_events"("correction_id");

-- CreateIndex
CREATE INDEX "inventory_batch_events_created_by_idx" ON "inventory_batch_events"("created_by");

-- CreateIndex
CREATE INDEX "inventory_backfill_runs_business_id_idx" ON "inventory_backfill_runs"("business_id");

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_delivery_item_id_fkey" FOREIGN KEY ("delivery_item_id") REFERENCES "delivery_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_business_id_batch_id_fkey" FOREIGN KEY ("business_id", "batch_id") REFERENCES "inventory_batches"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "inventory_cost_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_business_id_batch_id_fkey" FOREIGN KEY ("business_id", "batch_id") REFERENCES "inventory_batches"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "inventory_cost_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_backfill_runs" ADD CONSTRAINT "inventory_backfill_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is written by hand (CLAUDE.md: CHECK constraints and
-- triggers are not generated). This migration only adds tables, columns and
-- constraints: it changes no existing row and creates no batch. Stock that
-- existed before FIFO stays unbatched until an approved backfill rebuilds it.
-- ---------------------------------------------------------------------------

ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_cost_source_check"
  CHECK ("cost_source" IS NULL OR "cost_source" IN ('live', 'backfill'));

-- Batches: counts and money are never negative; what is left never exceeds what
-- came in; a purchase batch always has a price, an adjustment batch never does
-- (found bags have no cost, and a missing cost is never written as zero).
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_source_type_check"
  CHECK ("source_type" IN ('purchase', 'adjustment'));
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_quantities_check"
  CHECK ("original_quantity" > 0 AND "received_quantity" >= 0
     AND "remaining_quantity" >= 0 AND "remaining_quantity" <= "received_quantity");
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_cost_check"
  CHECK (("original_unit_cost" IS NULL OR "original_unit_cost" >= 0)
     AND ("unit_cost" IS NULL OR "unit_cost" >= 0)
     AND (("source_type" = 'purchase') = ("original_unit_cost" IS NOT NULL))
     AND (("source_type" = 'purchase') = ("unit_cost" IS NOT NULL)));

-- What was entered never changes; only the effective values and what remains do.
CREATE FUNCTION "inventory_batches_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('jesan.allow_purge', true) = 'on'
       OR current_setting('jesan.allow_fifo_rollback', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'inventory_batches rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."original_quantity" IS DISTINCT FROM OLD."original_quantity"
     OR NEW."original_unit_cost" IS DISTINCT FROM OLD."original_unit_cost"
     OR NEW."original_received_date" IS DISTINCT FROM OLD."original_received_date"
     OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."business_id" IS DISTINCT FROM OLD."business_id" THEN
    RAISE EXCEPTION 'inventory_batches original values are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inventory_batches_guard"
  BEFORE UPDATE OR DELETE ON "inventory_batches"
  FOR EACH ROW EXECUTE FUNCTION "inventory_batches_guard"();

-- Allocations: a slice is either known (batch and cost) or unknown (no cost,
-- never zero); signs follow the kind. An adjustment may move cost without moving
-- bags (a corrected price), so only an adjustment may have a zero quantity.
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_kind_check"
  CHECK ("kind" IN ('original', 'reversal', 'adjustment'));
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_quantity_check"
  CHECK (("quantity" <> 0 OR ("kind" = 'adjustment' AND "cost_amount" IS NOT NULL AND "cost_amount" <> 0))
     AND ("kind" <> 'original' OR ("quantity" > 0 AND "revenue_amount" >= 0
                                   AND ("cost_amount" IS NULL OR "cost_amount" >= 0)))
     AND ("kind" <> 'reversal' OR ("quantity" < 0 AND "revenue_amount" <= 0
                                   AND ("cost_amount" IS NULL OR "cost_amount" <= 0))));
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_cost_known_check"
  CHECK (("cost_known" = ("cost_amount" IS NOT NULL))
     AND ("cost_known" = ("unit_cost" IS NOT NULL))
     AND ("cost_known" = false OR "batch_id" IS NOT NULL));
ALTER TABLE "delivery_item_allocations" ADD CONSTRAINT "delivery_item_allocations_adjustment_check"
  CHECK (("kind" = 'adjustment') = ("correction_id" IS NOT NULL));

ALTER TABLE "inventory_batch_events" ADD CONSTRAINT "inventory_batch_events_type_check"
  CHECK ("event_type" IN ('received', 'quantity_edit', 'price_edit', 'date_edit',
                          'void', 'adjust_in', 'adjust_out'));

-- Allocations and events are an audit trail of money and stock already reported:
-- append-only, the same rule as stock_movements and inventory_cost_corrections.
-- Deleting is allowed only for a test purge, or while an approved FIFO backfill
-- is being rolled back.
CREATE FUNCTION "inventory_fifo_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (current_setting('jesan.allow_purge', true) = 'on'
                           OR current_setting('jesan.allow_fifo_rollback', true) = 'on') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "delivery_item_allocations_append_only"
  BEFORE UPDATE OR DELETE ON "delivery_item_allocations"
  FOR EACH ROW EXECUTE FUNCTION "inventory_fifo_append_only"();
CREATE TRIGGER "inventory_batch_events_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_batch_events"
  FOR EACH ROW EXECUTE FUNCTION "inventory_fifo_append_only"();

-- A policy change is a recognised kind of correction.
ALTER TABLE "inventory_cost_corrections" DROP CONSTRAINT "inventory_cost_corrections_kind_check";
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_kind_check"
  CHECK ("kind" IN ('purchase_edit', 'purchase_void', 'backdated_entry', 'rounding_residual',
                    'costing_policy_change'));
-- The existing append-only trigger on corrections also needs to allow a FIFO rollback of a
-- policy-change correction; corrections written by a backfill are deleted with the run.
CREATE OR REPLACE FUNCTION "inventory_cost_corrections_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (current_setting('jesan.allow_purge', true) = 'on'
                           OR current_setting('jesan.allow_fifo_rollback', true) = 'on') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inventory_cost_corrections is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
