import { Module } from '@nestjs/common';
import { registerTenantModels } from '../../core/database/tenant-scope';
import { PermissionRegistry } from '../../core/permissions/permission-registry';
import { PermissionsModule } from '../../core/permissions/permissions.module';
import { CategoriesService } from './master-data/categories.service';
import { CustomersService } from './master-data/customers.service';
import {
  CustomersController,
  ProductCategoriesController,
  ProductUnitsController,
  ProductsController,
  SuppliersController,
} from './master-data/master-data.controllers';
import { DealershipContext } from './master-data/master-data.context';
import { ProductsService } from './master-data/products.service';
import { SuppliersService } from './master-data/suppliers.service';
import { DEALERSHIP_PERMISSIONS, DEALERSHIP_TENANT_MODELS } from './dealership.permissions';

@Module({
  imports: [PermissionsModule],
  controllers: [
    ProductUnitsController,
    ProductCategoriesController,
    ProductsController,
    CustomersController,
    SuppliersController,
  ],
  providers: [
    DealershipContext,
    CategoriesService,
    ProductsService,
    CustomersService,
    SuppliersService,
  ],
})
export class DealershipModule {
  constructor(registry: PermissionRegistry) {
    registry.register(DEALERSHIP_PERMISSIONS);
    registerTenantModels(DEALERSHIP_TENANT_MODELS);
  }
}
