import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

class BucketView {
  @Expose() opening!: string;
  /** Collections only (type `collection`): the "actual" cash or bank collection. */
  @Expose() collectionsIn!: string;
  @Expose() in!: string;
  @Expose() out!: string;
  @Expose() closing!: string;
}

export class CashbookResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  /** Cash-method rows (business config: cashMethodKeys). */
  @Expose() @Type(() => BucketView) cash!: BucketView;
  /** Every other method (bank, mobile banking, cheque). */
  @Expose() @Type(() => BucketView) bank!: BucketView;
  /** Ledger rows with no method recorded (e.g. commission receipts). Never added to cash or bank. */
  @Expose() @Type(() => BucketView) unassigned!: BucketView;
  /** cash.closing + bank.closing: the money actually held. Unassigned rows are excluded. */
  @Expose() availableCashAndBank!: string;
}

export class FinanceSummaryResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  /** Delivered value in the window: revenue is recognised on delivery. */
  @Expose() sales!: string;
  /** Money received. Shown for information; never added to profit. */
  @Expose() collection!: string;
  /** What customers owe right now — a balance, not a figure for this window. */
  @Expose() customerDue!: string;
  @Expose() expenses!: string;
  @Expose() commissionReceived!: string;

  /** Cost of the bags bought in the window, whether or not they have been sold. */
  @VisibleWith('profit.view') totalPurchase!: string;
  @VisibleWith('profit.view') currentStockQuantity!: string;
  /** What the bags still in the warehouse are worth, at weighted average cost. */
  @VisibleWith('profit.view') currentStockValue!: string;
  /** Sold Products Purchase Cost: snapshots of what was delivered, plus corrections booked now. */
  @VisibleWith('profit.view') cogs!: string;
  /** sales − cogs − expenses + commissionReceived. */
  @VisibleWith('profit.view') netProfit!: string;
  /** Bags delivered in the window with no cost basis; above zero, cogs is understated. */
  @VisibleWith('profit.view') uncostedQuantityDelivered!: string;
  @VisibleWith('profit.view') uncostedQuantityOnHand!: string;
  /** Delivery lines in the window that were never costed (made before costing existed). */
  @VisibleWith('profit.view') uncostedDeliveryLines!: number;
}

class MonthlySeriesRow {
  /** `YYYY-MM` */
  @Expose() month!: string;
  @Expose() collection!: string;
  @Expose() sales!: string;
  @Expose() salesQuantity!: string;
  @Expose() purchaseQuantity!: string;
  /** Purchase cost: only for users with `product.cost.view`; the field is absent otherwise. */
  @VisibleWith('product.cost.view')
  purchaseAmount!: string;
}

export class MonthlySeriesResponse {
  @Expose() year!: number;
  @Expose() @Type(() => MonthlySeriesRow) months!: MonthlySeriesRow[];
}

class CommissionSeriesRow {
  @Expose() month!: string;
  /** Sum of commission entries whose receivedDate falls in the month. */
  @Expose() received!: string;
}

export class CommissionSeriesResponse {
  @Expose() year!: number;
  @Expose() @Type(() => CommissionSeriesRow) months!: CommissionSeriesRow[];
  /** Calendar-year total (receivedDate year) and the all-time total. */
  @Expose() yearReceived!: string;
  @Expose() lifetimeReceived!: string;
}

class KpiWindow {
  @Expose() from!: string;
  @Expose() to!: string;
  /** Money received in the window (collections). */
  @Expose() collection!: string;
  /** Delivered value in the window: revenue is recognised on delivery. */
  @Expose() sales!: string;
  /** Bags delivered in the window. */
  @Expose() salesQuantity!: string;
  /** Bags bought in the window; only for users with `purchase.view`, absent otherwise. */
  @VisibleWith('purchase.view')
  purchaseQuantity!: string;
}

export class KpisResponse {
  @Expose() @Type(() => KpiWindow) current!: KpiWindow;
  /** The comparison window, or `null` when `prevFrom`/`prevTo` were not sent. */
  @Expose() @Type(() => KpiWindow) previous!: KpiWindow | null;
}
