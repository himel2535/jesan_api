import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Quantities as decimal strings, up to 3 places; the unit decides how many are allowed. */
export const QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;
export const SIGNED_QUANTITY_PATTERN = /^-?\d{1,11}(\.\d{1,3})?$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PURCHASE_LINES = 50;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const QUANTITY_MESSAGE = 'must be a quantity like "50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-18"';

export class PurchaseItemDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity!: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `unitPrice ${MONEY_MESSAGE}` })
  unitPrice!: string;
}

export class CreatePurchaseDto {
  /** The business's calendar date; today (business time zone) when left out. */
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: `purchaseDate ${DATE_MESSAGE}` })
  purchaseDate?: string;

  /** Defaults to the principal supplier. */
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  supplierReference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items!: PurchaseItemDto[];
}

export class PurchaseListQueryDto {
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
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsIn(['active', 'void'])
  status?: 'active' | 'void';
}

export class PurchaseSummaryQueryDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

export class VoidPurchaseDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class UpdatePurchaseItemDto {
  @IsUUID()
  id!: string;

  @IsOptional()
  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `unitPrice ${MONEY_MESSAGE}` })
  unitPrice?: string;
}

/** Owner-level direct correction. Quantities, prices and the date need a reason. */
export class UpdatePurchaseDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_PATTERN, { message: `purchaseDate ${DATE_MESSAGE}` })
  purchaseDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  supplierReference?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => UpdatePurchaseItemDto)
  items?: UpdatePurchaseItemDto[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class CounterQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  year!: number;
}
