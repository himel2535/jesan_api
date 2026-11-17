import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

/**
 * Response shapes. Only fields declared here leave the API; money fields with
 * @VisibleWith are dropped on the server for callers without that permission.
 * Money is a string with two decimals ("570.00").
 */

export class UnitResponse {
  @Expose() key!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() decimals!: number;
}

export class UnitListResponse {
  @Expose() defaultUnitKey!: string;
  @Expose() @Type(() => UnitResponse) items!: UnitResponse[];
}

export class CategoryResponse {
  @Expose() id!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() sortOrder!: number;
  @Expose() isActive!: boolean;
  @Expose() createdAt!: string;
  @Expose() updatedAt!: string;
}

export class CategoryListResponse {
  @Expose() @Type(() => CategoryResponse) items!: CategoryResponse[];
}

export class CategoryRefResponse {
  @Expose() id!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
}

export class ProductResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() @Type(() => CategoryRefResponse) category!: CategoryRefResponse;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
  @VisibleWith('product.cost.view') purchasePrice!: string;
  @Expose() defaultSalePrice!: string;
  @Expose() isActive!: boolean;
  @Expose() createdAt!: string;
  @Expose() updatedAt!: string;
}

export class ProductListResponse {
  @Expose() @Type(() => ProductResponse) items!: ProductResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class CustomerResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string | null;
  @Expose() phone!: string;
  @Expose() address!: string | null;
  @Expose() area!: string | null;
  @VisibleWith('customer.due.view') openingBalance!: string;
  @VisibleWith('customer.due.view') currentBalance!: string;
  @VisibleWith('customer.due.view') creditLimit!: string | null;
  @Expose() isActive!: boolean;
  @Expose() createdAt!: string;
  @Expose() updatedAt!: string;
}

export class CustomerListResponse {
  @Expose() @Type(() => CustomerResponse) items!: CustomerResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class SupplierResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() phone!: string | null;
  @Expose() address!: string | null;
  @Expose() isPrincipal!: boolean;
  @Expose() isActive!: boolean;
}

export class SupplierListResponse {
  @Expose() @Type(() => SupplierResponse) items!: SupplierResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
