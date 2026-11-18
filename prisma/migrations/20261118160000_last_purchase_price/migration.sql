-- The purchase price on a product becomes read-only: the rate and date of
-- the latest valid purchase, set by purchases in the same transaction.
-- There are no purchases yet, so every product starts with none (the old
-- hand-typed prices were sample data only).

-- Pending change requests for the removed field can never be applied.
UPDATE "change_requests"
SET "status" = 'cancelled',
    "decision_note" = 'Purchase price is now set by purchases only',
    "updated_at" = now()
WHERE "status" = 'pending'
  AND "entity_type" = 'product'
  AND "proposed_change" ? 'purchasePrice';

ALTER TABLE "products" DROP CONSTRAINT "products_purchase_price_check";
ALTER TABLE "products" DROP COLUMN "purchase_price";

ALTER TABLE "products" ADD COLUMN "last_purchase_price" DECIMAL(14,2),
ADD COLUMN "last_purchased_at" TIMESTAMPTZ(3);

ALTER TABLE "products" ADD CONSTRAINT "products_last_purchase_price_check"
  CHECK ("last_purchase_price" IS NULL OR "last_purchase_price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_last_purchase_pair_check"
  CHECK (("last_purchase_price" IS NULL) = ("last_purchased_at" IS NULL));

-- product.price.edit is retired: nothing on a product sets a price any more.
-- Record the removal per business (permission changes are always audited),
-- then remove the grants. The permission row itself is deactivated by the
-- permission sync at start-up, like every undeclared permission.
INSERT INTO "audit_logs" ("id", "business_id", "actor_user_id", "action", "entity_type", "entity_id", "changes", "created_at")
SELECT gen_random_uuid(), rp."business_id", NULL, 'permission.retired', 'permission', 'product.price.edit',
       jsonb_build_object('permission', 'product.price.edit', 'removedFromRoles', jsonb_agg(r."key" ORDER BY r."key")),
       now()
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."role_id"
WHERE rp."permission_key" = 'product.price.edit'
GROUP BY rp."business_id";

DELETE FROM "role_permissions" WHERE "permission_key" = 'product.price.edit';
