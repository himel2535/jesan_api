import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Min, MaxLength } from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';
import { DATE_PATTERN } from '../../purchases/dto/requests';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-19"';

export class AccountsSummaryQueryDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

export class LedgerListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;

  @IsOptional()
  @IsIn(['collection', 'expense', 'purchase', 'commission_receipt', 'manual', 'supplier_payment'])
  type?: string;
}

export class CreateLedgerEntryDto {
  @IsIn(['in', 'out'])
  direction!: 'in' | 'out';

  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  /** Defaults to today in the business's time zone; at most 7 days back. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `entryDate ${DATE_MESSAGE}` })
  entryDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateSupplierPaymentDto {
  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  @IsString()
  @MaxLength(16)
  method!: string;

  /** Defaults to today in the business's time zone; at most 7 days back. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `paymentDate ${DATE_MESSAGE}` })
  paymentDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
