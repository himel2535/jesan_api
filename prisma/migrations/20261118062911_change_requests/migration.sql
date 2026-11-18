-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "updated_by" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN     "updated_by" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "updated_by" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "updated_by" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_label" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "base_version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "proposed_change" JSONB,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_note" VARCHAR(500),
    "idempotency_key" VARCHAR(64),
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_requests_business_id_status_requested_at_idx" ON "change_requests"("business_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "change_requests_business_id_requested_by_requested_at_idx" ON "change_requests"("business_id", "requested_by", "requested_at");

-- CreateIndex
CREATE INDEX "change_requests_business_id_entity_type_entity_id_idx" ON "change_requests"("business_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "change_requests_requested_by_idx" ON "change_requests"("requested_by");

-- CreateIndex
CREATE INDEX "change_requests_decided_by_idx" ON "change_requests"("decided_by");

-- CreateIndex
CREATE INDEX "customers_updated_by_idx" ON "customers"("updated_by");

-- CreateIndex
CREATE INDEX "product_categories_updated_by_idx" ON "product_categories"("updated_by");

-- CreateIndex
CREATE INDEX "products_updated_by_idx" ON "products"("updated_by");

-- CreateIndex
CREATE INDEX "suppliers_updated_by_idx" ON "suppliers"("updated_by");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (Prisma cannot express these).
-- ---------------------------------------------------------------------------

-- One pending request per record at a time.
CREATE UNIQUE INDEX "change_requests_one_pending_key" ON "change_requests" ("business_id", "entity_type", "entity_id") WHERE "status" = 'pending';

-- The same Idempotency-Key from the same user never creates a second request.
CREATE UNIQUE INDEX "change_requests_idempotency_key" ON "change_requests" ("business_id", "requested_by", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_kind_check" CHECK ("kind" IN ('edit', 'void'));
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled', 'stale'));
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_reason_check" CHECK (btrim("reason") <> '');
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_proposed_check" CHECK (("kind" = 'edit') = ("proposed_change" IS NOT NULL));
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_decision_check" CHECK (("status" IN ('pending', 'cancelled')) OR ("decided_at" IS NOT NULL));
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_rejected_note_check" CHECK ("status" <> 'rejected' OR ("decision_note" IS NOT NULL AND btrim("decision_note") <> ''));
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_version_check" CHECK ("version" >= 1);
ALTER TABLE "products" ADD CONSTRAINT "products_version_check" CHECK ("version" >= 1);
ALTER TABLE "customers" ADD CONSTRAINT "customers_version_check" CHECK ("version" >= 1);
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_version_check" CHECK ("version" >= 1);
