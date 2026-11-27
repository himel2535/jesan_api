import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ParseIdPipe } from '../../../core/errors';
import { CurrentAccess, CurrentAuth } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import type { AuthContext, BusinessAccess } from '../../../core/common/request-context';
import { CommissionService } from './commission.service';
import { CreateEntryDto, EntryListQueryDto, PatchEntryDto, SummaryQueryDto } from './dto/requests';
import { EntryListResponse, EntryResponse, SummaryResponse } from './dto/responses';

@Controller('b/:businessSlug/commission-entries')
export class CommissionEntriesController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  @RequirePermission('commission.view')
  @SerializeWith(EntryListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: EntryListQueryDto) {
    return this.commission.listEntries(access, query.page);
  }

  @Post()
  @RequirePermission('commission.manage')
  @SerializeWith(EntryResponse)
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateEntryDto,
  ) {
    return this.commission.createEntry(access, body, auth.userId);
  }

  @Get(':id')
  @RequirePermission('commission.view')
  @SerializeWith(EntryResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.commission.getEntry(access, id);
  }

  @Patch(':id')
  @RequirePermission('commission.manage')
  @SerializeWith(EntryResponse)
  patch(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: PatchEntryDto,
  ) {
    return this.commission.patchEntry(access, id, body, auth.userId);
  }
}

@Controller('b/:businessSlug/commission-summary')
export class CommissionSummaryController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  @RequirePermission('commission.view')
  @SerializeWith(SummaryResponse)
  get(@CurrentAccess() access: BusinessAccess, @Query() query: SummaryQueryDto) {
    return this.commission.summary(access, query.year);
  }
}
