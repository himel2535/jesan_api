-- Products no longer carry a default sale price: the owner sells to each
-- customer at a different price, set on the invoice at the time of sale.

-- Pending change requests that propose the removed field can never be applied.
UPDATE "change_requests"
SET "status" = 'cancelled',
    "decision_note" = 'Default sale price was removed from products',
    "updated_at" = now()
WHERE "status" = 'pending'
  AND "entity_type" = 'product'
  AND "proposed_change" ? 'defaultSalePrice';

ALTER TABLE "products" DROP CONSTRAINT "products_prices_check";

ALTER TABLE "products" DROP COLUMN "default_sale_price";

ALTER TABLE "products" ADD CONSTRAINT "products_purchase_price_check" CHECK ("purchase_price" >= 0);
