import { Expose, Type } from 'class-transformer';

export class EntryResponse {
  @Expose() id!: string;
  @Expose() amount!: string;
  @Expose() receivedDate!: string;
  @Expose() note!: string | null;
  @Expose() createdAt!: string;
}

export class EntryListResponse {
  @Expose() @Type(() => EntryResponse) items!: EntryResponse[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

export class SummaryResponse {
  @Expose() year!: number;
  @Expose() totalReceived!: string;
  @Expose() entryCount!: number;
}
