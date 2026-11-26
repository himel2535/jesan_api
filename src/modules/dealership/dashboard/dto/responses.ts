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
  /** Sum of entries whose fromDate falls in the month (calculated, not received). */
  @Expose() calculated!: string;
  /** Sum of receipts whose receivedDate falls in the month. */
  @Expose() received!: string;
}

export class CommissionSeriesResponse {
  @Expose() year!: number;
  @Expose() @Type(() => CommissionSeriesRow) months!: CommissionSeriesRow[];
  /** Calendar-year totals (entries by fromDate year, receipts by receivedDate year). */
  @Expose() yearCalculated!: string;
  @Expose() yearReceived!: string;
  /** Lifetime totals: receivable = calculated − received, across all years. */
  @Expose() lifetimeCalculated!: string;
  @Expose() lifetimeReceived!: string;
  @Expose() receivable!: string;
}
