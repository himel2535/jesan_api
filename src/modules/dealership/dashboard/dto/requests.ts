import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { DATE_PATTERN } from '../../purchases/dto/requests';

const DATE_MESSAGE = 'must be a date like "2026-11-19"';

/** Cash position for a date range; defaults to this month in the business's time zone. */
export class DashboardCashbookQueryDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

/** A calendar year of monthly series; defaults to the current year in the business's time zone. */
export class DashboardYearQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

/**
 * The four KPI figures for one window. There is no comparison window: the dashboard shows the
 * figure for what is selected and asks for nothing else (`prevFrom`/`prevTo` were removed, and are
 * now refused as unknown parameters).
 */
export class DashboardKpisQueryDto extends DashboardCashbookQueryDto {}
