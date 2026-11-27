import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-18"';

export class EntryListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

/** Commission received: how much, when, and why (free text). */
export class CreateEntryDto {
  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  @IsString()
  @Matches(DATE_PATTERN, { message: `receivedDate ${DATE_MESSAGE}` })
  receivedDate!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'note is required: say why this commission was received' })
  @MaxLength(500)
  note!: string;
}

export class PatchEntryDto {
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
  @IsNotEmpty({ message: 'note cannot be empty' })
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
