import { Expose, Type } from 'class-transformer';

class CashBookMethodRow {
  @Expose() method!: string;
  /** True when this method moves physical cash (business config: cashMethodKeys). */
  @Expose() isCash!: boolean;
  @Expose() in!: string;
  @Expose() out!: string;
  @Expose() net!: string;
}

class CashBookTotals {
  @Expose() collections!: string;
  @Expose() expenses!: string;
  @Expose() purchases!: string;
  @Expose() in!: string;
  @Expose() out!: string;
  @Expose() net!: string;
  /** The cash-only part of the same totals. */
  @Expose() cashIn!: string;
  @Expose() cashOut!: string;
  @Expose() cashNet!: string;
}

class CashBookDay {
  @Expose() date!: string;
  @Expose() opening!: string;
  @Expose() collections!: string;
  @Expose() expenses!: string;
  @Expose() purchases!: string;
  @Expose() in!: string;
  @Expose() out!: string;
  @Expose() closing!: string;
}

export class CashBookResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  /** Net of everything before `from`; the day rows carry on from here. */
  @Expose() openingBalance!: string;
  @Expose() closingBalance!: string;
  @Expose() @Type(() => CashBookTotals) totals!: CashBookTotals;
  @Expose() @Type(() => CashBookMethodRow) byMethod!: CashBookMethodRow[];
  /** Only the days something happened, oldest first. */
  @Expose() @Type(() => CashBookDay) days!: CashBookDay[];
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}
