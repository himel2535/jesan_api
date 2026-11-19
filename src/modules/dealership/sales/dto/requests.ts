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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../../core/common/money';
import { DATE_PATTERN, QUANTITY_PATTERN } from '../../purchases/dto/requests';
import { DELIVERY_WINDOWS } from '../sales.common';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_MESSAGE = 'must be an amount like "570" or "570.50" (as a string)';
const QUANTITY_MESSAGE = 'must be a quantity like "50" (as a string)';
const DATE_MESSAGE = 'must be a date like "2026-11-19"';
export const MAX_LINES = 50;

class PageQuery {
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
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// --- Orders ------------------------------------------------------------------

export class OrderItemDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity!: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `unitPrice ${MONEY_MESSAGE}` })
  unitPrice!: string;
}

export class CreateOrderDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `orderDate ${DATE_MESSAGE}` })
  orderDate?: string;

  @IsIn(DELIVERY_WINDOWS)
  deliveryWindow!: (typeof DELIVERY_WINDOWS)[number];

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `deliverBy ${DATE_MESSAGE}` })
  deliverBy?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

export const ORDER_STATUSES = ['open', 'pending', 'partial', 'delivered', 'void'] as const;

export class OrderListQueryDto extends PageQuery {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];
}

export class UpdateOrderItemDto {
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

export class UpdateOrderDto extends ReasonDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `orderDate ${DATE_MESSAGE}` })
  orderDate?: string;

  @IsOptional()
  @IsIn(DELIVERY_WINDOWS)
  deliveryWindow?: (typeof DELIVERY_WINDOWS)[number];

  /** null clears the promised date. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @Matches(DATE_PATTERN, { message: `deliverBy ${DATE_MESSAGE}` })
  deliverBy?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];
}

// --- Deliveries --------------------------------------------------------------

export class DeliveryItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity!: string;
}

export class CreateDeliveryDto {
  @IsUUID()
  orderId!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `deliveryDate ${DATE_MESSAGE}` })
  deliveryDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  transportReference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => DeliveryItemDto)
  items!: DeliveryItemDto[];
}

export class DeliveryListQueryDto extends PageQuery {
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(['active', 'void'])
  status?: 'active' | 'void';
}

export class UpdateDeliveryItemDto {
  @IsUUID()
  id!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN, { message: `quantity ${QUANTITY_MESSAGE}` })
  quantity!: string;
}

export class UpdateDeliveryDto extends ReasonDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `deliveryDate ${DATE_MESSAGE}` })
  deliveryDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  transportReference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => UpdateDeliveryItemDto)
  items?: UpdateDeliveryItemDto[];
}

// --- Collections -------------------------------------------------------------

export class CreateCollectionDto {
  @IsUUID()
  customerId!: string;

  /** Optional: the order this money is for (an advance). Not an allocation. */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: `collectionDate ${DATE_MESSAGE}` })
  collectionDate?: string;

  @IsString()
  @MaxLength(16)
  method!: string;

  @IsString()
  @Matches(MONEY_PATTERN, { message: `amount ${MONEY_MESSAGE}` })
  amount!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  reference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CollectionListQueryDto extends PageQuery {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  @IsOptional()
  @IsIn(['active', 'void'])
  status?: 'active' | 'void';
}

export class UpdateCollectionDto extends ReasonDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: `collectionDate ${DATE_MESSAGE}` })
  collectionDate?: string;

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
  @MaxLength(64)
  reference?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class LedgerQueryDto extends PageQuery {}
