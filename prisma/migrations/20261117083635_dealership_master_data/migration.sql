-- Trigram search (ILIKE '%...%') needs pg_trgm; available on Neon and standard PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateTable
CREATE TABLE "document_counters" (
    "business_id" UUID NOT NULL,
    "doc_type" VARCHAR(32) NOT NULL,
    "period" INTEGER NOT NULL DEFAULT 0,
    "last_value" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("business_id","doc_type","period")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_bn" VARCHAR(120) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "category_id" UUID NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_bn" VARCHAR(120) NOT NULL,
    "unit_key" VARCHAR(16) NOT NULL,
    "purchase_price" DECIMAL(14,2) NOT NULL,
    "default_sale_price" DECIMAL(14,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_bn" VARCHAR(120),
    "phone" VARCHAR(20) NOT NULL,
    "address" VARCHAR(255),
    "area" VARCHAR(80),
    "opening_balance" DECIMAL(14,2) NOT NULL,
    "current_balance" DECIMAL(14,2) NOT NULL,
    "credit_limit" DECIMAL(14,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_bn" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20),
    "address" VARCHAR(255),
    "is_principal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_business_id_is_active_sort_order_idx" ON "product_categories"("business_id", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "product_categories_created_by_idx" ON "product_categories"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_business_id_id_key" ON "product_categories"("business_id", "id");

-- CreateIndex
CREATE INDEX "products_business_id_category_id_idx" ON "products"("business_id", "category_id");

-- CreateIndex
CREATE INDEX "products_business_id_is_active_name_en_id_idx" ON "products"("business_id", "is_active", "name_en", "id");

-- CreateIndex
CREATE INDEX "products_created_by_idx" ON "products"("created_by");

-- CreateIndex
CREATE INDEX "products_name_en_trgm_idx" ON "products" USING GIN ("name_en" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_name_bn_trgm_idx" ON "products" USING GIN ("name_bn" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_code_trgm_idx" ON "products" USING GIN ("code" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "products_business_id_code_key" ON "products"("business_id", "code");

-- CreateIndex
CREATE INDEX "customers_business_id_is_active_name_en_id_idx" ON "customers"("business_id", "is_active", "name_en", "id");

-- CreateIndex
CREATE INDEX "customers_business_id_current_balance_idx" ON "customers"("business_id", "current_balance");

-- CreateIndex
CREATE INDEX "customers_created_by_idx" ON "customers"("created_by");

-- CreateIndex
CREATE INDEX "customers_name_en_trgm_idx" ON "customers" USING GIN ("name_en" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_name_bn_trgm_idx" ON "customers" USING GIN ("name_bn" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_phone_trgm_idx" ON "customers" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_code_trgm_idx" ON "customers" USING GIN ("code" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_code_key" ON "customers"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_phone_key" ON "customers"("business_id", "phone");

-- CreateIndex
CREATE INDEX "suppliers_business_id_is_active_name_en_idx" ON "suppliers"("business_id", "is_active", "name_en");

-- CreateIndex
CREATE INDEX "suppliers_created_by_idx" ON "suppliers"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_business_id_code_key" ON "suppliers"("business_id", "code");

-- AddForeignKey
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_category_id_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "product_categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (Prisma cannot express these).
-- ---------------------------------------------------------------------------


-- Names are unique per business regardless of letter case.
CREATE UNIQUE INDEX "product_categories_business_id_name_en_lower_key" ON "product_categories" ("business_id", lower("name_en"));
CREATE UNIQUE INDEX "products_business_id_name_en_lower_key" ON "products" ("business_id", lower("name_en"));

-- One principal supplier per business.
CREATE UNIQUE INDEX "suppliers_business_id_principal_key" ON "suppliers" ("business_id") WHERE "is_principal";


-- Money and quantity rules.
ALTER TABLE "products" ADD CONSTRAINT "products_prices_check" CHECK ("purchase_price" >= 0 AND "default_sale_price" >= 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_check" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_last_value_check" CHECK ("last_value" > 0);

-- Codes and names are never blank.
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_name_check" CHECK (btrim("name_en") <> '' AND btrim("name_bn") <> '');
ALTER TABLE "products" ADD CONSTRAINT "products_text_check" CHECK (btrim("code") <> '' AND btrim("name_en") <> '' AND btrim("name_bn") <> '' AND btrim("unit_key") <> '');
ALTER TABLE "customers" ADD CONSTRAINT "customers_text_check" CHECK (btrim("code") <> '' AND btrim("name_en") <> '' AND btrim("phone") <> '');
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_text_check" CHECK (btrim("code") <> '' AND btrim("name_en") <> '' AND btrim("name_bn") <> '');
