import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AppRequest, AuthContext, BusinessAccess } from '../common/request-context';
import { badRequest, ParseIdPipe } from '../errors';
import { CurrentAccess, CurrentAuth } from '../permissions/current.decorators';
import { AnyBusinessMember, RequirePermission } from '../permissions/decorators';
import { Actor, ChangeRequestsService } from './change-requests.service';
import {
  ChangeRequestBodyDto,
  CreateChangeRequestDto,
  DecisionDto,
  ListQueryDto,
  MyListQueryDto,
  RejectDto,
} from './dto';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/change-requests')
export class ChangeRequestsController {
  constructor(private readonly requests: ChangeRequestsService) {}

  /** Optional `Idempotency-Key` header: sending the same key again returns the same request (200). */
  @Post()
  @RequirePermission('change.request')
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateChangeRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw badRequest(
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 8-64 letters, digits, - or _',
        'Idempotency-Key',
      );
    }
    const result = await this.requests.create(access, body, actorOf(auth, request), idempotencyKey);
    response.status(result.created ? 201 : 200);
    return result.request;
  }

  /** Impact of a change before it is requested or decided. Nothing is saved. */
  @Post('preview')
  @HttpCode(200)
  @AnyBusinessMember()
  preview(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: ChangeRequestBodyDto,
    @Req() request: AppRequest,
  ) {
    return this.requests.preview(access, body, actorOf(auth, request));
  }

  @Get('mine')
  @RequirePermission('change.view.own')
  mine(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Query() query: MyListQueryDto,
    @Req() request: AppRequest,
  ) {
    return this.requests.listMine(access, query, actorOf(auth, request));
  }

  @Get('pending-count')
  @RequirePermission('change.view.all')
  pendingCount(@CurrentAccess() access: BusinessAccess) {
    return this.requests.pendingCount(access);
  }

  @Get()
  @RequirePermission('change.view.all')
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ListQueryDto) {
    return this.requests.listAll(access, query);
  }

  /** Own requests with change.view.own; any with change.view.all. */
  @Get(':id')
  @AnyBusinessMember()
  detail(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Req() request: AppRequest,
  ) {
    return this.requests.detail(access, id, actorOf(auth, request));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('change.approve')
  approve(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: DecisionDto,
    @Req() request: AppRequest,
  ) {
    return this.requests.approve(access, id, body.note, actorOf(auth, request));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('change.approve')
  reject(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: RejectDto,
    @Req() request: AppRequest,
  ) {
    return this.requests.reject(access, id, body.note, actorOf(auth, request));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('change.view.own')
  cancel(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Req() request: AppRequest,
  ) {
    return this.requests.cancel(access, id, actorOf(auth, request));
  }
}
