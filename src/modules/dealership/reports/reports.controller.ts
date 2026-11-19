import { Controller, Get, Query } from '@nestjs/common';
import type { BusinessAccess } from '../../../core/common/request-context';
import { CurrentAccess } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import {
  CollectionsReportQueryDto,
  DailySummaryQueryDto,
  DuesReportQueryDto,
  ExpensesReportQueryDto,
  SalesReportQueryDto,
  StockMovementsReportQueryDto,
  StockReportQueryDto,
} from './dto/requests';
import {
  CollectionsReportResponse,
  DailySummaryResponse,
  DuesReportResponse,
  ExpensesReportResponse,
  SalesReportResponse,
  StockMovementsReportResponse,
  StockReportResponse,
} from './dto/responses';
import { ReportsService } from './reports.service';

/**
 * Every report here is read-only and never carries a purchase price, profit
 * or commission figure (that needs `product.cost.view` / `commission.view`,
 * which none of these ask for).
 */
@Controller('b/:businessSlug/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermission('report.view')
  @SerializeWith(SalesReportResponse)
  sales(@CurrentAccess() access: BusinessAccess, @Query() query: SalesReportQueryDto) {
    return this.reports.sales(access, query);
  }

  @Get('collections')
  @RequirePermission('report.view')
  @SerializeWith(CollectionsReportResponse)
  collections(@CurrentAccess() access: BusinessAccess, @Query() query: CollectionsReportQueryDto) {
    return this.reports.collections(access, query);
  }

  @Get('dues')
  @RequirePermission('report.view')
  @SerializeWith(DuesReportResponse)
  dues(@CurrentAccess() access: BusinessAccess, @Query() query: DuesReportQueryDto) {
    return this.reports.dues(access, query);
  }

  @Get('stock')
  @RequirePermission('report.view')
  @SerializeWith(StockReportResponse)
  stock(@CurrentAccess() access: BusinessAccess, @Query() query: StockReportQueryDto) {
    return this.reports.stock(access, query);
  }

  @Get('stock-movements')
  @RequirePermission('report.view')
  @SerializeWith(StockMovementsReportResponse)
  stockMovements(
    @CurrentAccess() access: BusinessAccess,
    @Query() query: StockMovementsReportQueryDto,
  ) {
    return this.reports.stockMovements(access, query);
  }

  @Get('expenses')
  @RequirePermission('report.view')
  @SerializeWith(ExpensesReportResponse)
  expenses(@CurrentAccess() access: BusinessAccess, @Query() query: ExpensesReportQueryDto) {
    return this.reports.expenses(access, query);
  }

  @Get('daily-summary')
  @RequirePermission('report.view')
  @SerializeWith(DailySummaryResponse)
  dailySummary(@CurrentAccess() access: BusinessAccess, @Query() query: DailySummaryQueryDto) {
    return this.reports.dailySummary(access, query);
  }
}
