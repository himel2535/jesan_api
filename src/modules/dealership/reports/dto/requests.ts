import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Min } from 'class-validator';
import { DATE_PATTERN } from '../../purchases/dto/requests';

const DATE_MESSAGE = 'must be a date like "2026-11-19"';

class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

class RangeQuery extends PageQuery {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

export const SALES_GROUP_BY = ['date', 'customer', 'product', 'category'] as const;
export class SalesReportQueryDto extends RangeQuery {
  @IsOptional()
  @IsIn(SALES_GROUP_BY)
  groupBy: (typeof SALES_GROUP_BY)[number] = 'date';
}

export const COLLECTIONS_GROUP_BY = ['date', 'method'] as const;
export class CollectionsReportQueryDto extends RangeQuery {
  @IsOptional()
  @IsIn(COLLECTIONS_GROUP_BY)
  groupBy: (typeof COLLECTIONS_GROUP_BY)[number] = 'date';
}

export class DuesReportQueryDto extends PageQuery {}

export class StockReportQueryDto extends PageQuery {}

export class StockMovementsReportQueryDto extends RangeQuery {}

export const EXPENSES_GROUP_BY = ['category', 'month'] as const;
export class ExpensesReportQueryDto extends RangeQuery {
  @IsOptional()
  @IsIn(EXPENSES_GROUP_BY)
  groupBy: (typeof EXPENSES_GROUP_BY)[number] = 'category';
}

export class DailySummaryQueryDto {
  /** Defaults to today in the business's time zone. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `date ${DATE_MESSAGE}` })
  date?: string;
}
