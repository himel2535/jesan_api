-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name_en" VARCHAR(80) NOT NULL,
    "name_bn" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "expense_date" DATE NOT NULL,
    "category_id" UUID NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" VARCHAR(500),
    "proof_note" VARCHAR(200),
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_business_id_is_active_sort_order_id_idx" ON "expense_categories"("business_id", "is_active", "sort_order", "id");

-- CreateIndex
CREATE INDEX "expense_categories_created_by_idx" ON "expense_categories"("created_by");

-- CreateIndex
CREATE INDEX "expense_categories_updated_by_idx" ON "expense_categories"("updated_by");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_business_id_name_en_key" ON "expense_categories"("business_id", "name_en");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_business_id_name_bn_key" ON "expense_categories"("business_id", "name_bn");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_business_id_id_key" ON "expense_categories"("business_id", "id");

-- CreateIndex
CREATE INDEX "expenses_business_id_expense_date_id_idx" ON "expenses"("business_id", "expense_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "expenses_business_id_category_id_expense_date_idx" ON "expenses"("business_id", "category_id", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_business_id_status_expense_date_idx" ON "expenses"("business_id", "status", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_business_id_status_expense_date_method_amount_idx" ON "expenses"("business_id", "status", "expense_date", "method", "amount");

-- CreateIndex
CREATE INDEX "expenses_business_id_method_expense_date_idx" ON "expenses"("business_id", "method", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_created_by_idx" ON "expenses"("created_by");

-- CreateIndex
CREATE INDEX "expenses_updated_by_idx" ON "expenses"("updated_by");

-- CreateIndex
CREATE INDEX "expenses_voided_by_idx" ON "expenses"("voided_by");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_business_id_code_key" ON "expenses"("business_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_business_id_id_key" ON "expenses"("business_id", "id");

-- CreateIndex
CREATE INDEX "collections_business_id_status_collection_date_method_amoun_idx" ON "collections"("business_id", "status", "collection_date", "method", "amount");

-- CreateIndex
CREATE INDEX "purchases_business_id_status_purchase_date_payment_method_t_idx" ON "purchases"("business_id", "status", "purchase_date", "payment_method", "total_amount");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_category_id_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "expense_categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written rules Prisma cannot express.

-- Expense categories: real names, no silent blanks.
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_name_en_check"
  CHECK (btrim("name_en") <> '');
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_name_bn_check"
  CHECK (btrim("name_bn") <> '');
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_version_check" CHECK ("version" >= 1);

-- Expenses: money is always positive, the method looks like a config key, and a
-- voided row always carries who voided it, when and why (like collections).
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_status_check" CHECK ("status" IN ('active', 'void'));
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_check" CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_method_check" CHECK ("method" ~ '^[a-z][a-z0-9_]{0,15}$');
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_version_check" CHECK ("version" >= 1);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_void_check" CHECK (
  ("status" = 'void') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);

-- One expense per Idempotency-Key per user, so a double click saves once.
CREATE UNIQUE INDEX "expenses_idempotency_key" ON "expenses" ("business_id", "created_by", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
