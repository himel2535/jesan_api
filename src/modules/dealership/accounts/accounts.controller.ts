import { Body, Controller, Get, Headers, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { requiredIdempotencyKeyOf } from '../../../core/common/idempotency';
import type { AppRequest, AuthContext, BusinessAccess } from '../../../core/common/request-context';
import { CurrentAccess, CurrentAuth } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { Actor } from '../master-data/master-data.common';
import { AccountsService } from './accounts.service';
import {
  AccountsSummaryQueryDto,
  CreateLedgerEntryDto,
  CreateSupplierPaymentDto,
  LedgerListQueryDto,
} from './dto/requests';
import { AccountsSummaryResponse, LedgerEntryResponse, LedgerListResponse } from './dto/responses';

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('summary')
  @RequirePermission('ledger.view')
  @SerializeWith(AccountsSummaryResponse)
  summary(@CurrentAccess() access: BusinessAccess, @Query() query: AccountsSummaryQueryDto) {
    return this.accounts.summary(access, query);
  }

  @Get('ledger')
  @RequirePermission('ledger.view')
  @SerializeWith(LedgerListResponse)
  ledger(@CurrentAccess() access: BusinessAccess, @Query() query: LedgerListQueryDto) {
    return this.accounts.ledgerList(access, query);
  }

  /** Required `Idempotency-Key`: the same key again returns the same entry (200). */
  @Post('entries')
  @RequirePermission('ledger.entry.create')
  @SerializeWith(LedgerEntryResponse)
  async createEntry(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateLedgerEntryDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.accounts.createEntry(
      access,
      body,
      actorOf(auth, request),
      requiredIdempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.entry;
  }

  /** Required `Idempotency-Key`: the same key again returns the same payment (200). */
  @Post('payments')
  @RequirePermission('payment.create')
  @SerializeWith(LedgerEntryResponse)
  async createPayment(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateSupplierPaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.accounts.createPayment(
      access,
      body,
      actorOf(auth, request),
      requiredIdempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.entry;
  }
}
