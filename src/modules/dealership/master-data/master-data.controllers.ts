import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AppRequest, AuthContext, BusinessAccess } from '../../../core/common/request-context';
import { CurrentAccess, CurrentAuth } from '../../../core/permissions/current.decorators';
import { RequirePermission } from '../../../core/permissions/decorators';
import { SerializeWith } from '../../../core/permissions/serialize/serialize.interceptor';
import { CategoriesService } from './categories.service';
import { CustomersService } from './customers.service';
import {
  CreateCategoryDto,
  CreateCustomerDto,
  CreateProductDto,
  ListQueryDto,
  ProductListQueryDto,
  UpdateCategoryDto,
  UpdateCustomerDto,
  UpdateProductDto,
} from './dto/requests';
import {
  CategoryListResponse,
  CategoryResponse,
  CustomerListResponse,
  CustomerResponse,
  ProductListResponse,
  ProductResponse,
  SupplierListResponse,
  SupplierResponse,
  UnitListResponse,
} from './dto/responses';
import { Actor } from './master-data.common';
import { DealershipContext } from './master-data.context';
import { ProductsService } from './products.service';
import { SuppliersService } from './suppliers.service';

function actorOf(auth: AuthContext, request: AppRequest): Actor {
  return { userId: auth.userId, ip: request.ip };
}

@Controller('b/:businessSlug/product-units')
export class ProductUnitsController {
  constructor(private readonly context: DealershipContext) {}

  /** The units this business sells in (from its settings). */
  @Get()
  @RequirePermission('product.view')
  @SerializeWith(UnitListResponse)
  async list(@CurrentAccess() access: BusinessAccess) {
    const config = await this.context.config(access.businessId);
    return { defaultUnitKey: config.defaultUnitKey, items: config.units };
  }
}

@Controller('b/:businessSlug/product-categories')
export class ProductCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission('product.view')
  @SerializeWith(CategoryListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ListQueryDto) {
    return this.categories.list(access, query.active);
  }

  @Post()
  @RequirePermission('product.manage')
  @SerializeWith(CategoryResponse)
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateCategoryDto,
    @Req() request: AppRequest,
  ) {
    return this.categories.create(access, body, actorOf(auth, request));
  }

  @Patch(':id')
  @RequirePermission('product.manage')
  @SerializeWith(CategoryResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
    @Req() request: AppRequest,
  ) {
    return this.categories.update(access, id, body, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('product.view')
  @SerializeWith(ProductListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ProductListQueryDto) {
    return this.products.list(access, query);
  }

  @Get(':id')
  @RequirePermission('product.view')
  @SerializeWith(ProductResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(access, id);
  }

  @Post()
  @RequirePermission('product.manage')
  @SerializeWith(ProductResponse)
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateProductDto,
    @Req() request: AppRequest,
  ) {
    return this.products.create(access, body, actorOf(auth, request));
  }

  @Patch(':id')
  @RequirePermission('product.manage')
  @SerializeWith(ProductResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductDto,
    @Req() request: AppRequest,
  ) {
    return this.products.update(access, id, body, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customer.view')
  @SerializeWith(CustomerListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ListQueryDto) {
    return this.customers.list(access, query);
  }

  @Get(':id')
  @RequirePermission('customer.view')
  @SerializeWith(CustomerResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(access, id);
  }

  @Post()
  @RequirePermission('customer.manage')
  @SerializeWith(CustomerResponse)
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateCustomerDto,
    @Req() request: AppRequest,
  ) {
    return this.customers.create(access, body, actorOf(auth, request));
  }

  @Patch(':id')
  @RequirePermission('customer.manage')
  @SerializeWith(CustomerResponse)
  update(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCustomerDto,
    @Req() request: AppRequest,
  ) {
    return this.customers.update(access, id, body, actorOf(auth, request));
  }
}

@Controller('b/:businessSlug/suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermission('supplier.view')
  @SerializeWith(SupplierListResponse)
  list(@CurrentAccess() access: BusinessAccess, @Query() query: ListQueryDto) {
    return this.suppliers.list(access, query);
  }

  @Get(':id')
  @RequirePermission('supplier.view')
  @SerializeWith(SupplierResponse)
  get(@CurrentAccess() access: BusinessAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.get(access, id);
  }
}
