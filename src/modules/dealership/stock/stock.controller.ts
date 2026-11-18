import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { AppRequest, AuthContext, BusinessAccess } from '../../../core/common/request-context';
import { ParseIdPipe } from '../../../core/errors';
import { CurrentAccess, CurrentAuth } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { MovementQueryDto, StockAdjustmentDto, StockListQueryDto } from './dto/requests';
import { MovementListResponse, StockItemResponse, StockListResponse } from './dto/responses';
import { StockService } from './stock.service';

@Controller('b/:businessSlug/stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @RequirePermission('stock.view')
  @SerializeWith(StockListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: StockListQueryDto) {
    return this.stock.list(access, query);
  }

  @Get(':productId/movements')
  @RequirePermission('stock.view')
  @SerializeWith(MovementListResponse)
  movements(
    @CurrentAccess() access: BusinessAccess,
    @Param('productId', ParseIdPipe) productId: string,
    @Query() query: MovementQueryDto,
  ) {
    return this.stock.movements(access, productId, query);
  }

  @Post('adjustments')
  @RequirePermission('stock.adjust')
  @SerializeWith(StockItemResponse)
  adjust(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: StockAdjustmentDto,
    @Req() request: AppRequest,
  ) {
    return this.stock.adjust(access, body, { userId: auth.userId, ip: request.ip });
  }
}
