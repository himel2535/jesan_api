import { Controller, Get, Query } from '@nestjs/common';
import type { BusinessAccess } from '../../../core/common/request-context';
import { CurrentAccess } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { CashBookService } from './cash-book.service';
import { CashBookQueryDto } from './dto/requests';
import { CashBookResponse } from './dto/responses';

@Controller('b/:businessSlug/cash-book')
export class CashBookController {
  constructor(private readonly cashBook: CashBookService) {}

  @Get()
  @RequirePermission('cashbook.view')
  @SerializeWith(CashBookResponse)
  read(@CurrentAccess() access: BusinessAccess, @Query() query: CashBookQueryDto) {
    return this.cashBook.read(access, query);
  }
}
