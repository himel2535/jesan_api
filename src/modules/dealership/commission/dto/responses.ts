import { Expose, Type } from 'class-transformer';

export class SchemeResponse {
  @Expose() rateBase!: string;
  @Expose() targetQty!: string;
  @Expose() bonusRate!: string;
  @Expose() updatedAt!: string;
}

export class SchemeOrNullResponse {
  @Expose() @Type(() => SchemeResponse) scheme!: SchemeResponse | null;
}

export class EntryListItemResponse {
  @Expose() id!: string;
  @Expose() fromDate!: string;
  @Expose() toDate!: string;
  @Expose() quantity!: string;
  @Expose() calculatedAmount!: string;
  @Expose() receivedAmount!: string;
  @Expose() pendingAmount!: string;
  @Expose() note!: string | null;
  @Expose() createdAt!: string;
}

export class EntryListResponse {
  @Expose() @Type(() => EntryListItemResponse) items!: EntryListItemResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class ReceiptResponse {
  @Expose() id!: string;
  @Expose() amount!: string;
  @Expose() receivedDate!: string;
  @Expose() reference!: string | null;
  @Expose() note!: string | null;
}

export class EntryDetailResponse extends EntryListItemResponse {
  @Expose() @Type(() => ReceiptResponse) receipts!: ReceiptResponse[];
}

export class SuggestionResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() quantity!: string;
}

export class SummaryResponse {
  @Expose() year!: number;
  @Expose() totalCalculated!: string;
  @Expose() totalReceived!: string;
  @Expose() totalPending!: string;
  @Expose() entryCount!: number;
  @Expose() receiptCount!: number;
}
