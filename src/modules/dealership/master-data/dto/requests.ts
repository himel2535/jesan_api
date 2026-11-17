import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MONEY_PATTERN, SIGNED_MONEY_PATTERN } from '../../../../core/common/money';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const SIGNED_MONEY_MESSAGE = 'must be an amount like "1500" or "-200.50" (as a string)';

/** `?page=1&search=...&active=true|false|all` */
export class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['true', 'false', 'all'])
  active: 'true' | 'false' | 'all' = 'true';
}

export class ProductListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

/** Required when a change has financial weight (prices, balances, deactivation). */
class WithReason {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class CreateCategoryDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameBn!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class UpdateCategoryDto extends WithReason {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameBn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateProductDto {
  @IsUUID()
  categoryId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameBn!: string;

  /** One of the business's units; defaults to its main unit. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  unitKey?: string;

  /** Needs product.cost.view. Defaults to "0". */
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `purchasePrice ${MONEY_MESSAGE}` })
  purchasePrice?: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `defaultSalePrice ${MONEY_MESSAGE}` })
  defaultSalePrice!: string;
}

export class UpdateProductDto extends WithReason {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameBn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unitKey?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `purchasePrice ${MONEY_MESSAGE}` })
  purchasePrice?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `defaultSalePrice ${MONEY_MESSAGE}` })
  defaultSalePrice?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCustomerDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameBn?: string;

  /** 01XXXXXXXXX or +8801XXXXXXXXX. Unique within the business. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  area?: string;

  /** Needs customer.due.view. Negative means an advance. Defaults to "0". */
  @IsOptional()
  @IsString()
  @Matches(SIGNED_MONEY_PATTERN, { message: `openingBalance ${SIGNED_MONEY_MESSAGE}` })
  openingBalance?: string;

  /** Needs customer.due.view. Leave out (or null) for no limit. */
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `creditLimit ${MONEY_MESSAGE}` })
  creditLimit?: string | null;
}

export class UpdateCustomerDto extends WithReason {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nameEn?: string;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameBn?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone?: string;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  area?: string | null;

  @IsOptional()
  @IsString()
  @Matches(SIGNED_MONEY_PATTERN, { message: `openingBalance ${SIGNED_MONEY_MESSAGE}` })
  openingBalance?: string;

  /** null removes the limit. */
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `creditLimit ${MONEY_MESSAGE}` })
  creditLimit?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
