import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

class CategoryRef {
  @Expose() id!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
}

class PersonRef {
  @Expose() id!: string;
  @Expose() name!: string;
}

/** Stock on hand. Quantities for everyone with stock.view; prices only with product.cost.view. */
export class StockItemResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
  @Expose() @Type(() => CategoryRef) category!: CategoryRef;
  @Expose() currentStock!: string;
  @Expose() isActive!: boolean;
  @VisibleWith('product.cost.view') lastPurchasePrice!: string | null;
  @VisibleWith('product.cost.view') lastPurchasedAt!: string | null;
}

export class StockListResponse {
  @Expose() @Type(() => StockItemResponse) items!: StockItemResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

class MovementSource {
  @Expose() type!: string;
  @Expose() id!: string | null;
  /** The purchase number, e.g. PUR-0042. */
  @Expose() code!: string | null;
}

export class MovementResponse {
  @Expose() id!: string;
  @Expose() kind!: string;
  @Expose() quantity!: string;
  @Expose() balanceAfter!: string;
  @Expose() movementDate!: string;
  @Expose() @Type(() => MovementSource) source!: MovementSource;
  @Expose() reason!: string | null;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

export class MovementListResponse {
  @Expose() @Type(() => StockItemResponse) product!: StockItemResponse;
  @Expose() @Type(() => MovementResponse) items!: MovementResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
