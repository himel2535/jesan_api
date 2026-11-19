import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

class PersonRef {
  @Expose() id!: string;
  @Expose() name!: string;
}

class CustomerRef {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string | null;
}

class ProductRef {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
}

class DocRef {
  @Expose() id!: string;
  @Expose() code!: string;
}

// --- Orders ------------------------------------------------------------------

export class OrderListItemResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() @Type(() => CustomerRef) customer!: CustomerRef;
  @Expose() orderDate!: string;
  @Expose() deliveryWindow!: string;
  @Expose() deliverBy!: string | null;
  @Expose() totalQuantity!: string;
  @Expose() deliveredQuantity!: string;
  @Expose() remainingQuantity!: string;
  @Expose() totalAmount!: string;
  @Expose() status!: string;
  @Expose() deliveryStatus!: string;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

export class OrderListResponse {
  @Expose() @Type(() => OrderListItemResponse) items!: OrderListItemResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

class OrderItemResponse {
  @Expose() id!: string;
  @Expose() @Type(() => ProductRef) product!: ProductRef;
  @Expose() quantity!: string;
  @Expose() deliveredQuantity!: string;
  @Expose() remainingQuantity!: string;
  @Expose() unitPrice!: string;
  @Expose() lineTotal!: string;
}

class OrderDeliveryRef {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() deliveryDate!: string;
  @Expose() totalQuantity!: string;
  @Expose() totalAmount!: string;
  @Expose() status!: string;
}

export class OrderResponse extends OrderListItemResponse {
  @Expose() note!: string | null;
  @Expose() version!: number;
  @Expose() @Type(() => OrderItemResponse) items!: OrderItemResponse[];
  @Expose() @Type(() => OrderDeliveryRef) deliveries!: OrderDeliveryRef[];
  @Expose() voidedAt!: string | null;
  @Expose() voidReason!: string | null;
  @Expose() @Type(() => PersonRef) voidedBy!: PersonRef | null;
  @Expose() updatedAt!: string;
}

// --- Deliveries --------------------------------------------------------------

export class DeliveryListItemResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() @Type(() => DocRef) order!: DocRef;
  @Expose() @Type(() => CustomerRef) customer!: CustomerRef;
  @Expose() deliveryDate!: string;
  @Expose() transportReference!: string | null;
  @Expose() totalQuantity!: string;
  @Expose() totalAmount!: string;
  /** The balance went over the credit limit with this delivery (credit is due-related). */
  @VisibleWith('customer.due.view') creditLimitExceeded!: boolean;
  @Expose() status!: string;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

export class DeliveryListResponse {
  @Expose() @Type(() => DeliveryListItemResponse) items!: DeliveryListItemResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

class DeliveryItemResponse {
  @Expose() id!: string;
  @Expose() orderItemId!: string;
  @Expose() @Type(() => ProductRef) product!: ProductRef;
  @Expose() quantity!: string;
  @Expose() unitPrice!: string;
  @Expose() lineTotal!: string;
}

export class DeliveryResponse extends DeliveryListItemResponse {
  @Expose() note!: string | null;
  @Expose() version!: number;
  @Expose() @Type(() => DeliveryItemResponse) items!: DeliveryItemResponse[];
  @Expose() voidedAt!: string | null;
  @Expose() voidReason!: string | null;
  @Expose() @Type(() => PersonRef) voidedBy!: PersonRef | null;
  @Expose() updatedAt!: string;
}

// --- Collections -------------------------------------------------------------

export class CollectionResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() @Type(() => CustomerRef) customer!: CustomerRef;
  @Expose() @Type(() => DocRef) order!: DocRef | null;
  @Expose() collectionDate!: string;
  @Expose() method!: string;
  @Expose() amount!: string;
  @Expose() reference!: string | null;
  @Expose() note!: string | null;
  @Expose() status!: string;
  @Expose() version!: number;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
  @Expose() voidedAt!: string | null;
  @Expose() voidReason!: string | null;
  @Expose() @Type(() => PersonRef) voidedBy!: PersonRef | null;
  @Expose() updatedAt!: string;
}

export class CollectionListResponse {
  @Expose() @Type(() => CollectionResponse) items!: CollectionResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class CollectionMethodsResponse {
  @Expose() items!: string[];
}

// --- Customer ledger ---------------------------------------------------------

class LedgerSource {
  @Expose() type!: string;
  @Expose() id!: string;
  @Expose() code!: string | null;
}

class LedgerEntryResponse {
  @Expose() id!: string;
  @Expose() kind!: string;
  @Expose() amount!: string;
  @Expose() entryDate!: string;
  @Expose() @Type(() => LedgerSource) source!: LedgerSource;
  @Expose() reason!: string | null;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

class LedgerCustomer {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() openingBalance!: string;
  @Expose() deliveredAmount!: string;
  @Expose() collectedAmount!: string;
  @Expose() currentBalance!: string;
  @Expose() creditLimit!: string | null;
}

export class LedgerResponse {
  @Expose() @Type(() => LedgerCustomer) customer!: LedgerCustomer;
  @Expose() @Type(() => LedgerEntryResponse) items!: LedgerEntryResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
