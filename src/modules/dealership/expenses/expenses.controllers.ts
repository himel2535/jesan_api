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
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseCategoryListQueryDto,
  ExpenseListQueryDto,
  ReasonDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/requests';
import {
  ExpenseCategoryListResponse,
  ExpenseCategoryResponse,
  ExpenseListResponse,
  ExpenseMethodsResponse,
  ExpenseResponse,
} from './dto/responses';
import { ExpenseCategoriesService } from './expense-categories.service';
import { ExpensesService } from './expenses.service';

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly categories: ExpenseCategoriesService) {}

  @Get()
  @RequirePermission('expense.view')
  @SerializeWith(ExpenseCategoryListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ExpenseCategoryListQueryDto) {
    return this.categories.list(access, query.active);
  }

  @Post()
  @RequirePermission('expense.category.manage')
  @SerializeWith(ExpenseCategoryResponse)
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateExpenseCategoryDto,
    @Req() request: AppRequest,
  ) {
    return this.categories.create(access, body, actorOf(auth, request));
  }

  /** Deactivating or reactivating a kind always needs a reason. */
  @Patch(':id')
  @RequirePermission('expense.category.manage')
  @SerializeWith(ExpenseCategoryResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdateExpenseCategoryDto,
    @Req() request: AppRequest,
  ) {
    return this.categories.update(access, id, body, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/expense-methods')
export class ExpenseMethodsController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission('expense.create')
  @SerializeWith(ExpenseMethodsResponse)
  list(@CurrentAccess() access: BusinessAccess) {
    return this.expenses.methods(access);
  }
}

@Controller('b/:businessSlug/expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  /** Optional `Idempotency-Key`: the same key again returns the same expense (200). */
  @Post()
  @RequirePermission('expense.create')
  @SerializeWith(ExpenseResponse)
  async create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateExpenseDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.expenses.create(
      access,
      body,
      actorOf(auth, request),
      idempotencyKeyOf(key),
    );
    response.status(result.created ? 201 : 200);
    return result.expense;
  }

  @Get()
  @RequirePermission('expense.view')
  @SerializeWith(ExpenseListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ExpenseListQueryDto) {
    return this.expenses.list(access, query);
  }

  @Get(':id')
  @RequirePermission('expense.view')
  @SerializeWith(ExpenseResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseIdPipe) id: string) {
    return this.expenses.get(access, id);
  }

  /** Staff without this permission send a change request instead. */
  @Patch(':id')
  @RequirePermission('expense.edit')
  @SerializeWith(ExpenseResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: UpdateExpenseDto,
    @Req() request: AppRequest,
  ) {
    return this.expenses.updateDirect(access, id, body, actorOf(auth, request));
  }

  @Post(':id/void')
  @RequirePermission('expense.void')
  @SerializeWith(ExpenseResponse)
  void(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: ReasonDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.expenses.voidDirect(access, id, body.reason, actorOf(auth, request));
  }
}
