import { Controller, Get, Param, Query } from '@nestjs/common';
import type { BusinessAccess } from '../../../core/common/request-context';
import { ParseIdPipe } from '../../../core/errors';
import { CurrentAccess } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { BatchesService } from './batches.service';
import { BatchListQueryDto } from './dto/batch-requests';
import { BatchDetailResponse, BatchListResponse } from './dto/batch-responses';

/**
 * Purchase batches and what each one earned. Owner-only (`profit.view`): it exposes purchase
 * prices, cost of sales and profit per batch. No writes: batches change only through purchases,
 * deliveries and their approved corrections.
 */
@Controller('b/:businessSlug/inventory/batches')
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Get()
  @RequirePermission('profit.view')
  @SerializeWith(BatchListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: BatchListQueryDto) {
    return this.batches.list(access, query);
  }

  @Get(':id')
  @RequirePermission('profit.view')
  @SerializeWith(BatchDetailResponse)
  detail(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.batches.detail(access, id);
  }
}
