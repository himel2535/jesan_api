import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';
import { DATE_PATTERN } from '../../purchases/dto/requests';

const DATE_MESSAGE = 'must be a date like "2026-11-19"';

export class CashBookQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Defaults to the first day of this month in the business's time zone. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  /** Defaults to today in the business's time zone. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}
