import { Expose, Type } from 'class-transformer';

class PersonRef {
  @Expose() id!: string;
  @Expose() name!: string;
}

class ByTypeRow {
  @Expose() type!: string;
  @Expose() in!: string;
  @Expose() out!: string;
}

export class AccountsSummaryResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() totalIn!: string;
  @Expose() totalOut!: string;
  @Expose() net!: string;
  @Expose() totalDue!: string;
  @Expose() totalAdvance!: string;
  @Expose() @Type(() => ByTypeRow) byType!: ByTypeRow[];
}

export class LedgerEntryResponse {
  @Expose() id!: string;
  @Expose() type!: string;
  @Expose() direction!: string;
  @Expose() amount!: string;
  @Expose() method!: string | null;
  @Expose() referenceType!: string | null;
  @Expose() referenceId!: string | null;
  @Expose() entryDate!: string;
  @Expose() note!: string | null;
  @Expose() status!: string;
  @Expose() @Type(() => PersonRef) createdBy!: PersonRef;
  @Expose() createdAt!: string;
}

export class LedgerListResponse {
  @Expose() @Type(() => LedgerEntryResponse) items!: LedgerEntryResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
