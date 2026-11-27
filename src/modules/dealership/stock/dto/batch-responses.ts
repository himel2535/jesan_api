import { Expose, Type } from 'class-transformer';

/**
 * One purchase batch: what came in, at what price, what has gone out of it and what that earned.
 * Every field is owner-only (the whole endpoint needs `profit.view`).
 */
export class BatchResponse {
  @Expose() id!: string;
  @Expose() productId!: string;
  @Expose() productCode!: string;
  @Expose() productNameEn!: string;
  @Expose() productNameBn!: string;
  /** `purchase`, or `adjustment` for found bags whose cost is unknown. */
  @Expose() sourceType!: string;
  /** The purchase (or null for found bags). */
  @Expose() purchaseId!: string | null;
  @Expose() purchaseCode!: string | null;
  @Expose() supplierId!: string | null;
  /** Current purchase date and what was first entered; they differ only after an approved correction. */
  @Expose() purchaseDate!: string;
  @Expose() originalPurchaseDate!: string;
  /** Price per bag now and as first entered; null = cost unknown (never zero). */
  @Expose() unitCost!: string | null;
  @Expose() originalUnitCost!: string | null;
  @Expose() purchasedQuantity!: string;
  @Expose() originalQuantity!: string;
  @Expose() purchaseValue!: string | null;
  /** Net of reversals and corrections, inside the delivery window when one is given. */
  @Expose() deliveredQuantity!: string;
  @Expose() remainingQuantity!: string;
  @Expose() remainingValue!: string | null;
  /** Selling revenue allocated to this batch, by the bags it supplied. */
  @Expose() revenue!: string;
  /** Cost of the bags delivered from this batch; null when its cost is unknown. */
  @Expose() cogs!: string | null;
  @Expose() grossProfit!: string | null;
  /** Gross profit per delivered bag; null when nothing was delivered or the cost is unknown. */
  @Expose() profitPerBag!: string | null;
  /** False for an unknown-cost batch: its cost and profit are unverified, not zero. */
  @Expose() costComplete!: boolean;
}

export class BatchListResponse {
  @Expose() @Type(() => BatchResponse) items!: BatchResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

class BatchDeliveryResponse {
  @Expose() deliveryId!: string;
  @Expose() deliveryCode!: string;
  @Expose() deliveryDate!: string;
  @Expose() status!: string;
  @Expose() customerId!: string;
  @Expose() quantity!: string;
  @Expose() cost!: string | null;
  @Expose() revenue!: string;
}

class BatchEventResponse {
  @Expose() eventType!: string;
  @Expose() businessDate!: string;
  @Expose() quantityDelta!: string;
  @Expose() valueDelta!: string;
  @Expose() reason!: string | null;
}

/** A batch with the deliveries that drew from it and every change made to its receipt. */
export class BatchDetailResponse extends BatchResponse {
  @Expose() @Type(() => BatchDeliveryResponse) deliveries!: BatchDeliveryResponse[];
  @Expose() @Type(() => BatchEventResponse) events!: BatchEventResponse[];
}
