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
import { AnyBusinessMember, RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { Actor } from '../master-data/master-data.common';
import { CollectionsService } from './collections.service';
import { DeliveriesService } from './deliveries.service';
import {
  CollectionListQueryDto,
  CreateCollectionDto,
  CreateDeliveryDto,
  CreateOrderDto,
  DeliveryListQueryDto,
  LedgerQueryDto,
  OrderListQueryDto,
  ReasonDto,
  UpdateCollectionDto,
  UpdateDeliveryDto,
  UpdateOrderDto,
} from './dto/requests';
import {
  CollectionListResponse,
  CollectionMethodsResponse,
  CollectionResponse,
  DeliveryListResponse,
  DeliveryResponse,
  LedgerResponse,
  OrderListResponse,
  OrderResponse,
} from './dto/responses';
import { OrdersService } from './orders.service';

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Optional `Idempotency-Key`: the same key again returns the same order (200). */
  @Post()
  @RequirePermission('sale.create')
  @SerializeWith(OrderResponse)
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateOrderDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.orders.create(
      access,
      body,
      actorOf(auth, request),
      idempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.order;
  }

  /** sale.view.all: every order; sale.view.own: the person's own (checked in the service). */
  @Get()
  @AnyBusinessMember()
  @SerializeWith(OrderListResponse)
  list(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Query() query: OrderListQueryDto,
    @Req() request: AppRequest,
  ) {
    return this.orders.list(access, query, actorOf(auth, request));
  }

  @Get(':id')
  @AnyBusinessMember()
  @SerializeWith(OrderResponse)
  get(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Req() request: AppRequest,
  ) {
    return this.orders.get(access, id, actorOf(auth, request));
  }

  @Patch(':id')
  @RequirePermission('sale.edit')
  @SerializeWith(OrderResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdateOrderDto,
    @Req() request: AppRequest,
  ) {
    return this.orders.updateDirect(access, id, body, actorOf(auth, request));
  }

  @Post(':id/void')
  @RequirePermission('sale.void')
  @SerializeWith(OrderResponse)
  void(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: ReasonDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.orders.voidDirect(access, id, body.reason, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  /** Optional `Idempotency-Key`. The answer says whether the credit limit was passed. */
  @Post()
  @RequirePermission('delivery.create')
  @SerializeWith(DeliveryResponse)
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateDeliveryDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.deliveries.create(
      access,
      body,
      actorOf(auth, request),
      idempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.delivery;
  }

  @Get()
  @RequirePermission('delivery.view')
  @SerializeWith(DeliveryListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: DeliveryListQueryDto) {
    return this.deliveries.list(access, query);
  }

  @Get(':id')
  @RequirePermission('delivery.view')
  @SerializeWith(DeliveryResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.deliveries.get(access, id);
  }

  @Patch(':id')
  @RequirePermission('delivery.edit')
  @SerializeWith(DeliveryResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdateDeliveryDto,
    @Req() request: AppRequest,
  ) {
    return this.deliveries.updateDirect(access, id, body, actorOf(auth, request));
  }

  @Post(':id/void')
  @RequirePermission('delivery.void')
  @SerializeWith(DeliveryResponse)
  void(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: ReasonDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.deliveries.voidDirect(access, id, body.reason, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post()
  @RequirePermission('collection.create')
  @SerializeWith(CollectionResponse)
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateCollectionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.collections.create(
      access,
      body,
      actorOf(auth, request),
      idempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.collection;
  }

  @Get()
  @RequirePermission('collection.view')
  @SerializeWith(CollectionListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: CollectionListQueryDto) {
    return this.collections.list(access, query);
  }

  @Get(':id')
  @RequirePermission('collection.view')
  @SerializeWith(CollectionResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.collections.get(access, id);
  }

  @Patch(':id')
  @RequirePermission('collection.edit')
  @SerializeWith(CollectionResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdateCollectionDto,
    @Req() request: AppRequest,
  ) {
    return this.collections.updateDirect(access, id, body, actorOf(auth, request));
  }

  @Post(':id/void')
  @RequirePermission('collection.void')
  @SerializeWith(CollectionResponse)
  void(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: ReasonDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.collections.voidDirect(access, id, body.reason, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/collection-methods')
export class CollectionMethodsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @RequirePermission('collection.create')
  @SerializeWith(CollectionMethodsResponse)
  list(@CurrentAccess() access: BusinessAccess) {
    return this.collections.methods(access);
  }
}

@Controller('b/:businessSlug/customers')
export class CustomerLedgerController {
  constructor(private readonly collections: CollectionsService) {}

  /** A customer's statement (balance changes from deliveries and collections). */
  @Get(':id/ledger')
  @RequirePermission('customer.due.view')
  @SerializeWith(LedgerResponse)
  ledger(
    @CurrentAccess() access: BusinessAccess,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.collections.ledger(access, id, query);
  }
}
