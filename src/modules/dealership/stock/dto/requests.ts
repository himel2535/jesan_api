import { Transform, Type } from 'class-transformer';
import {
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
import { DATE_PATTERN, SIGNED_QUANTITY_PATTERN } from '../../purchases/dto/requests';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class StockListQueryDto {
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
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(['true', 'false', 'all'])
  active: 'true' | 'false' | 'all' = 'true';
}

export const MOVEMENT_KINDS = ['purchase', 'purchase_edit', 'purchase_void', 'adjustment'] as const;

export class MovementQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a date like "2026-11-18"' })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a date like "2026-11-18"' })
  to?: string;

  @IsOptional()
  @IsIn(MOVEMENT_KINDS)
  kind?: (typeof MOVEMENT_KINDS)[number];
}

export class StockAdjustmentDto {
  @IsUUID()
  productId!: string;

  /** Signed: "-3" for three torn bags, "2" for two found. Never zero. */
  @IsString()
  @Matches(SIGNED_QUANTITY_PATTERN, {
    message: 'quantity must be a quantity like "-3" (as a string)',
  })
  quantity!: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
