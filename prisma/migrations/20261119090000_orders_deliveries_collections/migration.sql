-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "collected_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "delivered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "pending_delivery_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_date" DATE NOT NULL,
    "delivery_window" VARCHAR(12) NOT NULL,
    "deliver_by" DATE,
    "total_quantity" DECIMAL(14,3) NOT NULL,
    "delivered_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "delivery_status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "note" VARCHAR(500),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_items" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "delivered_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "delivery_date" DATE NOT NULL,
    "transport_reference" VARCHAR(64),
    "total_quantity" DECIMAL(14,3) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "credit_limit_exceeded" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "note" VARCHAR(500),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_items" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "collection_date" DATE NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" VARCHAR(64),
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "note" VARCHAR(500),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ledger_entries" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entry_date" DATE NOT NULL,
    "source_type" VARCHAR(16) NOT NULL,
    "source_id" UUID NOT NULL,
    "reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_orders_business_id_order_date_id_idx" ON "sales_orders"("business_id", "order_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_business_id_status_delivery_status_order_date_idx" ON "sales_orders"("business_id", "status", "delivery_status", "order_date" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_business_id_customer_id_order_date_idx" ON "sales_orders"("business_id", "customer_id", "order_date" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_business_id_created_by_order_date_idx" ON "sales_orders"("business_id", "created_by", "order_date" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_created_by_idx" ON "sales_orders"("created_by");

-- CreateIndex
CREATE INDEX "sales_orders_updated_by_idx" ON "sales_orders"("updated_by");

-- CreateIndex
CREATE INDEX "sales_orders_voided_by_idx" ON "sales_orders"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_business_id_code_key" ON "sales_orders"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_business_id_id_key" ON "sales_orders"("business_id", "id");

-- CreateIndex
CREATE INDEX "sales_order_items_business_id_order_id_idx" ON "sales_order_items"("business_id", "order_id");

-- CreateIndex
CREATE INDEX "sales_order_items_business_id_product_id_idx" ON "sales_order_items"("business_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_items_order_id_product_id_key" ON "sales_order_items"("order_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_items_business_id_id_key" ON "sales_order_items"("business_id", "id");

-- CreateIndex
CREATE INDEX "deliveries_business_id_delivery_date_id_idx" ON "deliveries"("business_id", "delivery_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "deliveries_business_id_customer_id_delivery_date_idx" ON "deliveries"("business_id", "customer_id", "delivery_date" DESC);

-- CreateIndex
CREATE INDEX "deliveries_business_id_order_id_idx" ON "deliveries"("business_id", "order_id");

-- CreateIndex
CREATE INDEX "deliveries_created_by_idx" ON "deliveries"("created_by");

-- CreateIndex
CREATE INDEX "deliveries_updated_by_idx" ON "deliveries"("updated_by");

-- CreateIndex
CREATE INDEX "deliveries_voided_by_idx" ON "deliveries"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_business_id_code_key" ON "deliveries"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_business_id_id_key" ON "deliveries"("business_id", "id");

-- CreateIndex
CREATE INDEX "delivery_items_business_id_delivery_id_idx" ON "delivery_items"("business_id", "delivery_id");

-- CreateIndex
CREATE INDEX "delivery_items_business_id_order_item_id_status_idx" ON "delivery_items"("business_id", "order_item_id", "status");

-- CreateIndex
CREATE INDEX "delivery_items_business_id_product_id_idx" ON "delivery_items"("business_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_items_delivery_id_order_item_id_key" ON "delivery_items"("delivery_id", "order_item_id");

-- CreateIndex
CREATE INDEX "collections_business_id_collection_date_id_idx" ON "collections"("business_id", "collection_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "collections_business_id_customer_id_collection_date_idx" ON "collections"("business_id", "customer_id", "collection_date" DESC);

-- CreateIndex
CREATE INDEX "collections_business_id_order_id_idx" ON "collections"("business_id", "order_id");

-- CreateIndex
CREATE INDEX "collections_created_by_idx" ON "collections"("created_by");

-- CreateIndex
CREATE INDEX "collections_updated_by_idx" ON "collections"("updated_by");

-- CreateIndex
CREATE INDEX "collections_voided_by_idx" ON "collections"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "collections_business_id_code_key" ON "collections"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "collections_business_id_id_key" ON "collections"("business_id", "id");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_business_id_customer_id_created_at__idx" ON "customer_ledger_entries"("business_id", "customer_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "customer_ledger_entries_business_id_source_type_source_id_idx" ON "customer_ledger_entries"("business_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_created_by_idx" ON "customer_ledger_entries"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_id_key" ON "customers"("business_id", "id");

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "sales_orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "sales_orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_business_id_delivery_id_fkey" FOREIGN KEY ("business_id", "delivery_id") REFERENCES "deliveries"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_business_id_order_item_id_fkey" FOREIGN KEY ("business_id", "order_item_id") REFERENCES "sales_order_items"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "sales_orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written rules (Step 5b).
-- ---------------------------------------------------------------------------

-- Customer summaries. The balance identity is checked by
-- `npm run consistency:check` and the tests (current_balance may be negative:
-- an advance).
ALTER TABLE "customers" ADD CONSTRAINT "customers_summary_check" CHECK (
  "pending_delivery_quantity" >= 0 AND "delivered_amount" >= 0 AND "collected_amount" >= 0
);

-- Orders.
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_window_check"
  CHECK ("delivery_window" IN ('today', 'two_days', 'one_week'));
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_deliver_by_check"
  CHECK ("deliver_by" IS NULL OR "deliver_by" >= "order_date");
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quantity_check"
  CHECK ("total_quantity" > 0 AND "delivered_quantity" >= 0 AND "delivered_quantity" <= "total_quantity" AND "total_amount" >= 0);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_version_check" CHECK ("version" >= 1);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_status_check" CHECK (
  "delivery_status" = CASE
    WHEN "delivered_quantity" = 0 THEN 'pending'
    WHEN "delivered_quantity" = "total_quantity" THEN 'delivered'
    ELSE 'partial'
  END
);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_void_check" CHECK (
  ("status" = 'void') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "sales_orders_idempotency_key" ON "sales_orders" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_quantity_check"
  CHECK ("quantity" > 0 AND "delivered_quantity" >= 0 AND "delivered_quantity" <= "quantity");
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_price_check" CHECK ("unit_price" >= 0);
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_line_total_check"
  CHECK ("line_total" = round("quantity" * "unit_price", 2));

-- Deliveries.
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_totals_check" CHECK ("total_quantity" > 0 AND "total_amount" >= 0);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_version_check" CHECK ("version" >= 1);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_void_check" CHECK (
  ("status" = 'void') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "deliveries_idempotency_key" ON "deliveries" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_quantity_check" CHECK ("quantity" > 0 AND "unit_price" >= 0);
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_line_total_check"
  CHECK ("line_total" = round("quantity" * "unit_price", 2));

-- Collections.
ALTER TABLE "collections" ADD CONSTRAINT "collections_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "collections" ADD CONSTRAINT "collections_amount_check" CHECK ("amount" > 0);
ALTER TABLE "collections" ADD CONSTRAINT "collections_method_check" CHECK ("method" ~ '^[a-z][a-z0-9_]{0,15}$');
ALTER TABLE "collections" ADD CONSTRAINT "collections_version_check" CHECK ("version" >= 1);
ALTER TABLE "collections" ADD CONSTRAINT "collections_void_check" CHECK (
  ("status" = 'void') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "collections_idempotency_key" ON "collections" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Customer ledger.
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_kind_check" CHECK (
  "kind" IN ('delivery', 'delivery_edit', 'delivery_void', 'collection', 'collection_edit', 'collection_void')
);
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_amount_check" CHECK ("amount" <> 0);
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_source_check" CHECK (
  ("source_type" = 'delivery' AND "kind" IN ('delivery', 'delivery_edit', 'delivery_void'))
  OR ("source_type" = 'collection' AND "kind" IN ('collection', 'collection_edit', 'collection_void'))
);
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_reason_check" CHECK (
  "kind" IN ('delivery', 'collection') OR ("reason" IS NOT NULL AND btrim("reason") <> '')
);

-- Append-only, like the stock ledger (the same purge switch for test clean-up).
CREATE FUNCTION "customer_ledger_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('jesan.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'customer_ledger_entries is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "customer_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "customer_ledger_append_only"();

-- Stock movements from deliveries.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  "kind" IN ('purchase', 'purchase_edit', 'purchase_void', 'adjustment', 'delivery', 'delivery_edit', 'delivery_void')
);
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_source_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_source_check" CHECK (
  ("source_type" = 'purchase' AND "source_id" IS NOT NULL AND "kind" IN ('purchase', 'purchase_edit', 'purchase_void'))
  OR ("source_type" = 'delivery' AND "source_id" IS NOT NULL AND "kind" IN ('delivery', 'delivery_edit', 'delivery_void'))
  OR ("source_type" = 'adjustment' AND "source_id" IS NULL AND "kind" = 'adjustment')
);
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK (
  "kind" IN ('purchase', 'delivery') OR ("reason" IS NOT NULL AND btrim("reason") <> '')
);
