import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { idempotencyKeyOf } from '../../../core/common/idempotency';
import type { AppRequest, AuthContext, BusinessAccess } from '../../../core/common/request-context';
import { ParseIdPipe } from '../../../core/errors';
import { CurrentAccess, CurrentAuth } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { Actor } from '../master-data/master-data.common';
import {
  CounterQueryDto,
  CreatePurchaseDto,
  PurchaseListQueryDto,
  UpdatePurchaseDto,
  VoidPurchaseDto,
} from './dto/requests';
import { PurchaseCounterResponse, PurchaseListResponse, PurchaseResponse } from './dto/responses';
import { PurchasesService } from './purchases.service';

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  /** Optional `Idempotency-Key` header: the same key again returns the same purchase (200). */
  @Post()
  @RequirePermission('purchase.create')
  @SerializeWith(PurchaseResponse)
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreatePurchaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.purchases.create(
      access,
      body,
      actorOf(auth, request),
      idempotencyKeyOf(idempotencyKey),
    );
    response.status(result.created ? 201 : 200);
    return result.purchase;
  }

  @Get()
  @RequirePermission('purchase.view')
  @SerializeWith(PurchaseListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: PurchaseListQueryDto) {
    return this.purchases.list(access, query);
  }

  @Get(':id')
  @RequirePermission('purchase.view')
  @SerializeWith(PurchaseResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.purchases.get(access, id);
  }

  /** Direct correction; the service checks the permission for each field. */
  @Patch(':id')
  @RequirePermission('purchase.view')
  @SerializeWith(PurchaseResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdatePurchaseDto,
    @Req() request: AppRequest,
  ) {
    return this.purchases.updateDirect(access, id, body, actorOf(auth, request));
  }

  @Post(':id/void')
  @RequirePermission('purchase.void')
  @SerializeWith(PurchaseResponse)
  void(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: VoidPurchaseDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.purchases.voidDirect(access, id, body.reason, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/purchase-counters')
export class PurchaseCountersController {
  constructor(private readonly purchases: PurchasesService) {}

  /** Bags bought per month (commission progress): owner-only. */
  @Get()
  @RequirePermission('commission.view')
  @SerializeWith(PurchaseCounterResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: CounterQueryDto) {
    return this.purchases.monthlyCounters(access, query.year);
  }
}
