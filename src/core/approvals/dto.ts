import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'stale'] as const;
export type ChangeStatus = (typeof STATUSES)[number];

export class ChangeRequestBodyDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,47}$/)
  entityType!: string;

  @IsUUID()
  entityId!: string;

  @IsIn(['edit', 'void'])
  kind!: 'edit' | 'void';

  /** Required for edits: field name → requested new value. */
  @IsOptional()
  @IsObject()
  proposedChange?: Record<string, unknown>;
}

export class CreateChangeRequestDto extends ChangeRequestBodyDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class DecisionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}

export class MyListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ChangeStatus;
}

export class ListQueryDto extends MyListQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,47}$/)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  requestedBy?: string;

  /** Requested on or after (ISO date or date-time). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Requested before (ISO date or date-time). */
  @IsOptional()
  @IsDateString()
  to?: string;
}
