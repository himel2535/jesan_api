import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ParseIdPipe } from '../../../core/errors';
import { CurrentAccess } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import type { BusinessAccess } from '../../../core/common/request-context';
import { CommissionService } from './commission.service';
import {
  CreateEntryDto,
  CreateReceiptDto,
  EntryListQueryDto,
  PatchEntryDto,
  PatchReceiptDto,
  SuggestionQueryDto,
  SummaryQueryDto,
  UpsertSchemeDto,
} from './dto/requests';
import {
  EntryDetailResponse,
  EntryListResponse,
  ReceiptResponse,
  SchemeOrNullResponse,
  SchemeResponse,
  SuggestionResponse,
  SummaryResponse,
} from './dto/responses';

@Controller('b/:businessSlug/commission-scheme')
export class CommissionSchemeController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  @RequirePermission('commission.view')
  @SerializeWith(SchemeOrNullResponse)
  async get(@CurrentAccess() access: BusinessAccess) {
    return { scheme: await this.commission.getScheme(access) };
  }

  @Put()
  @RequirePermission('commission.manage')
  @SerializeWith(SchemeResponse)
  update(@CurrentAccess() access: BusinessAccess, @Body() body: UpsertSchemeDto) {
    return this.commission.upsertScheme(access, body);
  }
}

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
  @SerializeWith(EntryDetailResponse)
  create(@CurrentAccess() access: BusinessAccess, @Body() body: CreateEntryDto) {
    return this.commission.createEntry(access, body);
  }

  @Get('suggestion')
  @RequirePermission('commission.manage')
  @SerializeWith(SuggestionResponse)
  suggestion(@CurrentAccess() access: BusinessAccess, @Query() query: SuggestionQueryDto) {
    return this.commission.suggestion(access, query.from, query.to);
  }

  @Get(':id')
  @RequirePermission('commission.view')
  @SerializeWith(EntryDetailResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.commission.getEntry(access, id);
  }

  @Patch(':id')
  @RequirePermission('commission.manage')
  @SerializeWith(EntryDetailResponse)
  patch(
    @CurrentAccess() access: BusinessAccess,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: PatchEntryDto,
  ) {
    return this.commission.patchEntry(access, id, body);
  }

  @Post(':entryId/receipts')
  @RequirePermission('commission.manage')
  @SerializeWith(ReceiptResponse)
  createReceipt(
    @CurrentAccess() access: BusinessAccess,
    @Param('entryId', ParseIdPipe) entryId: string,
    @Body() body: CreateReceiptDto,
  ) {
    return this.commission.createReceipt(access, entryId, body);
  }

  @Patch(':entryId/receipts/:id')
  @RequirePermission('commission.manage')
  @SerializeWith(ReceiptResponse)
  patchReceipt(
    @CurrentAccess() access: BusinessAccess,
    @Param('entryId', ParseIdPipe) entryId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: PatchReceiptDto,
  ) {
    return this.commission.patchReceipt(access, entryId, id, body);
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
