import { Controller, Get, Query } from '@nestjs/common';
import type { BusinessAccess } from '../../../core/common/request-context';
import { CurrentAccess } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { DashboardService } from './dashboard.service';
import { DashboardCashbookQueryDto, DashboardYearQueryDto } from './dto/requests';
import {
  CashbookResponse,
  CommissionSeriesResponse,
  FinanceSummaryResponse,
  MonthlySeriesResponse,
} from './dto/responses';

@Controller('b/:businessSlug/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('cashbook')
  @RequirePermission('cashbook.view')
  @SerializeWith(CashbookResponse)
  cashbook(@CurrentAccess() access: BusinessAccess, @Query() query: DashboardCashbookQueryDto) {
    return this.dashboard.cashbook(access, query);
  }

  /**
   * Everything the Financial Summary shows. The cost and profit fields are
   * owner-only (`profit.view`); a manager gets the rest of the panel without them.
   */
  @Get('finance-summary')
  @RequirePermission('report.view')
  @SerializeWith(FinanceSummaryResponse)
  financeSummary(
    @CurrentAccess() access: BusinessAccess,
    @Query() query: DashboardCashbookQueryDto,
  ) {
    return this.dashboard.financeSummary(access, query);
  }

  @Get('monthly-series')
  @RequirePermission('report.view')
  @SerializeWith(MonthlySeriesResponse)
  monthlySeries(@CurrentAccess() access: BusinessAccess, @Query() query: DashboardYearQueryDto) {
    return this.dashboard.monthlySeries(access, query);
  }

  /** Owner-only through the permission registry (`commission.view` is ownerOnly). */
  @Get('commission-series')
  @RequirePermission('commission.view')
  @SerializeWith(CommissionSeriesResponse)
  commissionSeries(@CurrentAccess() access: BusinessAccess, @Query() query: DashboardYearQueryDto) {
    return this.dashboard.commissionSeries(access, query);
  }
}
