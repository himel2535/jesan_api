import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

class PersonRef {
  @Expose() id!: string;
  @Expose() name!: string;
}

class SupplierRef {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
}

class ProductRef {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
}

export class PurchaseItemResponse {
  @Expose() id!: string;
  @Expose() @Type(() => ProductRef) product!: ProductRef;
  @Expose() quantity!: string;
  /** Purchase prices and totals: product.cost.view only. */
  @VisibleWith('product.cost.view') unitPrice!: string;
  @VisibleWith('product.cost.view') lineTotal!: string;
}

export class PurchaseListItemResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() purchaseDate!: string;
  @Expose() @Type(() => SupplierRef) supplier!: SupplierRef;
  @Expose() paymentMethod!: string;
  @Expose() itemCount!: number;
  @Expose() totalQuantity!: string;
  @VisibleWith('product.cost.view') totalAmount!: string;
  @Expose() status!: string;
  @Expose() supplierReference!: string | null;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

export class PurchaseListResponse {
  @Expose() @Type(() => PurchaseListItemResponse) items!: PurchaseListItemResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class PurchaseResponse extends PurchaseListItemResponse {
  @Expose() note!: string | null;
  @Expose() version!: number;
  @Expose() @Type(() => PurchaseItemResponse) items!: PurchaseItemResponse[];
  @Expose() voidedAt!: string | null;
  @Expose() voidReason!: string | null;
  @Expose() @Type(() => PersonRef) voidedBy!: PersonRef | null;
  @Expose() updatedAt!: string;
}

class CounterMonth {
  /** YYYY-MM */
  @Expose() month!: string;
  @Expose() quantity!: string;
}

export class PurchaseCounterResponse {
  @Expose() year!: number;
  @Expose() @Type(() => CounterMonth) months!: CounterMonth[];
}
