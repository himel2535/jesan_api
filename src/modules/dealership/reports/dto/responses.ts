import { Expose, Type } from 'class-transformer';
import { VisibleWith } from '../../../../core/permissions/serialize/visible-with';

class PageInfo {
  @Expose() page!: number;
  @Expose() pageSize!: number;
  @Expose() total!: number;
}

// --- Sales report --------------------------------------------------------

class SalesReportRow {
  @Expose() key!: string;
  @Expose() label!: string;
  @Expose() quantity!: string;
  @Expose() amount!: string;
}

export class SalesReportResponse extends PageInfo {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() groupBy!: string;
  @Expose() @Type(() => SalesReportRow) items!: SalesReportRow[];
  @Expose() totalQuantity!: string;
  @Expose() totalAmount!: string;
}

// --- Collections report --------------------------------------------------

class CollectionsReportRow {
  @Expose() key!: string;
  @Expose() count!: number;
  @Expose() amount!: string;
}

export class CollectionsReportResponse extends PageInfo {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() groupBy!: string;
  @Expose() @Type(() => CollectionsReportRow) items!: CollectionsReportRow[];
  @Expose() totalAmount!: string;
}

// --- Dues report ----------------------------------------------------------

class DuesAgingBuckets {
  @Expose() d0To7!: string;
  @Expose() d8To30!: string;
  @Expose() d30Plus!: string;
}

class DuesReportRow {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string | null;
  @Expose() currentBalance!: string;
  @Expose() dueAmount!: string;
  @Expose() advanceAmount!: string;
  @Expose() @Type(() => DuesAgingBuckets) aging!: DuesAgingBuckets;
}

export class DuesReportResponse extends PageInfo {
  @Expose() @Type(() => DuesReportRow) items!: DuesReportRow[];
  @Expose() totalDue!: string;
  @Expose() totalAdvance!: string;
}

// --- Stock report -----------------------------------------------------------

class StockReportRow {
  @Expose() id!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
  @Expose() currentStock!: string;
  @Expose() isActive!: boolean;
}

export class StockReportResponse extends PageInfo {
  @Expose() @Type(() => StockReportRow) items!: StockReportRow[];
}

// --- Stock movements summary -----------------------------------------------

class StockMovementKindRow {
  @Expose() kind!: string;
  @Expose() quantity!: string;
}

class StockMovementsReportRow {
  @Expose() productId!: string;
  @Expose() code!: string;
  @Expose() nameEn!: string;
  @Expose() nameBn!: string;
  @Expose() unitKey!: string;
  @Expose() net!: string;
  @Expose() @Type(() => StockMovementKindRow) byKind!: StockMovementKindRow[];
}

export class StockMovementsReportResponse extends PageInfo {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() @Type(() => StockMovementsReportRow) items!: StockMovementsReportRow[];
}

// --- Expenses report --------------------------------------------------------

class ExpensesReportRow {
  @Expose() key!: string;
  @Expose() label!: string;
  @Expose() count!: number;
  @Expose() amount!: string;
}

export class ExpensesReportResponse {
  @Expose() from!: string;
  @Expose() to!: string;
  @Expose() groupBy!: string;
  @Expose() @Type(() => ExpensesReportRow) items!: ExpensesReportRow[];
  @Expose() totalAmount!: string;
}

// --- Daily summary -----------------------------------------------------------

class DailyCountAmount {
  @Expose() count!: number;
  @Expose() amount!: string;
}

class DailyCash {
  @Expose() openingBalance!: string;
  @Expose() closingBalance!: string;
  @Expose() net!: string;
}

export class DailySummaryResponse {
  @Expose() date!: string;
  @Expose() @Type(() => DailyCountAmount) orders!: DailyCountAmount;
  @Expose() @Type(() => DailyCountAmount) deliveries!: DailyCountAmount;
  @Expose() @Type(() => DailyCountAmount) collections!: DailyCountAmount;
  @Expose() @Type(() => DailyCountAmount) expenses!: DailyCountAmount;
  @Expose()
  @Type(() => DailyCash)
  @VisibleWith('cashbook.view')
  cash!: DailyCash;
}
