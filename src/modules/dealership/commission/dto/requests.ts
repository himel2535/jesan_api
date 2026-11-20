import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const QUANTITY_MESSAGE = 'must be a quantity like "50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-18"';

export class UpsertSchemeDto {
  @IsString()
  @Matches(MONEY_PATTERN, { message: `rateBase ${MONEY_MESSAGE}` })
  rateBase!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `targetQty ${QUANTITY_MESSAGE}` })
  targetQty!: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `bonusRate ${MONEY_MESSAGE}` })
  bonusRate!: string;
}

export class EntryListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

export class CreateEntryDto {
  @IsString()
  @Matches(DATE_PATTERN, { message: `fromDate ${DATE_MESSAGE}` })
  fromDate!: string;

  @IsString()
  @Matches(DATE_PATTERN, { message: `toDate ${DATE_MESSAGE}` })
  toDate!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PatchEntryDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: `fromDate ${DATE_MESSAGE}` })
  fromDate?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: `toDate ${DATE_MESSAGE}` })
  toDate?: string;

  @IsOptional()
  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SuggestionQueryDto {
  @IsString()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from!: string;

  @IsString()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to!: string;
}

export class CreateReceiptDto {
  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  @IsString()
  @Matches(DATE_PATTERN, { message: `receivedDate ${DATE_MESSAGE}` })
  receivedDate!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PatchReceiptDto {
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: `receivedDate ${DATE_MESSAGE}` })
  receivedDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SummaryQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}
