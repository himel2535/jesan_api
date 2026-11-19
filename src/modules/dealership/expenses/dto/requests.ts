import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';
import { DATE_PATTERN } from '../../purchases/dto/requests';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-19"';

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// --- Expense kinds -----------------------------------------------------------

export class ExpenseCategoryListQueryDto {
  @IsOptional()
  @IsIn(['true', 'false', 'all'])
  active: 'true' | 'false' | 'all' = 'true';
}

export class CreateExpenseCategoryDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameEn!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameBn!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateExpenseCategoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameEn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameBn?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Required when the kind is activated or deactivated. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

// --- Expenses ----------------------------------------------------------------

export class CreateExpenseDto {
  /** Defaults to today in the business's time zone. */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `expenseDate ${DATE_MESSAGE}` })
  expenseDate?: string;

  @IsUUID()
  categoryId!: string;

  @IsString()
  @MaxLength(16)
  method!: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  /** What the money was for. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Where the proof is kept: receipt number, voucher, file. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  proofNote?: string;
}

export class ExpenseListQueryDto {
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
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  @IsOptional()
  @IsIn(['active', 'void'])
  status?: 'active' | 'void';
}

export class UpdateExpenseDto extends ReasonDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `expenseDate ${DATE_MESSAGE}` })
  expenseDate?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  proofNote?: string;
}
