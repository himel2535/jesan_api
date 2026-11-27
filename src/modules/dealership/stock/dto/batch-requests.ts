import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a date like "2026-11-18"';

/** Filters of the purchase-batch report; every one is optional and they combine. */
export class BatchListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  /** The batch's purchase (received) date range. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `purchaseFrom ${DATE_MESSAGE}` })
  purchaseFrom?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `purchaseTo ${DATE_MESSAGE}` })
  purchaseTo?: string;

  /** Delivery date range: delivered bags, revenue and cost are counted only inside it. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `deliveryFrom ${DATE_MESSAGE}` })
  deliveryFrom?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `deliveryTo ${DATE_MESSAGE}` })
  deliveryTo?: string;

  /** Only batches whose delivered bags made a gross profit or a loss (cost-known batches only). */
  @IsOptional()
  @IsIn(['profit', 'loss'])
  result?: 'profit' | 'loss';

  /** `purchase` or `adjustment` (found bags, cost unknown). */
  @IsOptional()
  @IsIn(['purchase', 'adjustment'])
  source?: 'purchase' | 'adjustment';
}
