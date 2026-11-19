import { Expose, Type } from 'class-transformer';

class PersonRef {
  @Expose() id!: string;
  @Expose() name!: string;
}

class ExpenseCategoryRef {
  @Expose() id!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
}

export class ExpenseCategoryResponse {
  @Expose() id!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() sortOrder!: number;
  @Expose() isActive!: boolean;
  @Expose() version!: number;
  @Expose() createdAt!: string;
  @Expose() updatedAt!: string;
}

export class ExpenseCategoryListResponse {
  @Expose() @Type(() => ExpenseCategoryResponse) items!: ExpenseCategoryResponse[];
}

export class ExpenseMethodsResponse {
  @Expose() items!: string[];
}

export class ExpenseResponse {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() expenseDate!: string;
  @Expose() @Type(() => ExpenseCategoryRef) category!: ExpenseCategoryRef;
  @Expose() method!: string;
  @Expose() amount!: string;
  @Expose() note!: string | null;
  @Expose() proofNote!: string | null;
  @Expose() status!: string;
  @Expose() version!: number;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
  @Expose() voidedAt!: string | null;
  @Expose() voidReason!: string | null;
  @Expose() @Type(() => PersonRef) voidedBy!: PersonRef | null;
  @Expose() updatedAt!: string;
}

export class ExpenseListResponse {
  @Expose() @Type(() => ExpenseResponse) items!: ExpenseResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
