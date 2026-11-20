import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../core/approvals/approvals.module';
import { ChangeHandlerRegistry } from '../../core/approvals/change-handler.registry';
import { registerTenantModels } from '../../core/database/tenant-scope';
import { PermissionRegistry } from '../../core/permissions/permission-registry';
import { PermissionsModule } from '../../core/permissions/permissions.module';
import { CategoriesService } from './master-data/categories.service';
import {
  categoryChangeHandler,
  customerChangeHandler,
  productChangeHandler,
} from './master-data/change-handlers';
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
import { CashBookController } from './cashbook/cash-book.controller';
import { CashBookService } from './cashbook/cash-book.service';
import { ExpenseCategoriesService } from './expenses/expense-categories.service';
import {
  ExpenseChangeHandler,
  expenseCategoryChangeHandler,
} from './expenses/expense-change-handlers';
import {
  ExpenseCategoriesController,
  ExpenseMethodsController,
  ExpensesController,
} from './expenses/expenses.controllers';
import { ExpensesService } from './expenses/expenses.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import {
  CommissionEntriesController,
  CommissionSchemeController,
  CommissionSummaryController,
} from './commission/commission.controller';
import { CommissionService } from './commission/commission.service';
import { PurchaseChangeHandler } from './purchases/purchase-change-handler';
import { PurchaseCountersController, PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';
import { ProductStockChangeHandler } from './stock/product-stock-handler';
import { StockLedger } from './stock/stock-ledger';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';
import { CollectionsService } from './sales/collections.service';
import { CustomerAccounts } from './sales/customer-accounts';
import { DeliveriesService } from './sales/deliveries.service';
import { OrdersService } from './sales/orders.service';
import {
  CollectionChangeHandler,
  DeliveryChangeHandler,
  SalesOrderChangeHandler,
} from './sales/sales-change-handlers';
import {
  CollectionMethodsController,
  CollectionsController,
  CustomerLedgerController,
  DeliveriesController,
  OrdersController,
} from './sales/sales.controllers';

@Module({
  imports: [PermissionsModule, ApprovalsModule],
  controllers: [
    ProductUnitsController,
    ProductCategoriesController,
    ProductsController,
    CustomersController,
    SuppliersController,
    PurchasesController,
    PurchaseCountersController,
    StockController,
    OrdersController,
    DeliveriesController,
    CollectionsController,
    CollectionMethodsController,
    CustomerLedgerController,
    ExpenseCategoriesController,
    ExpenseMethodsController,
    ExpensesController,
    CashBookController,
    ReportsController,
    CommissionSchemeController,
    CommissionEntriesController,
    CommissionSummaryController,
  ],
  providers: [
    DealershipContext,
    CategoriesService,
    ProductsService,
    CustomersService,
    SuppliersService,
    StockLedger,
    PurchasesService,
    PurchaseChangeHandler,
    StockService,
    ProductStockChangeHandler,
    CustomerAccounts,
    OrdersService,
    DeliveriesService,
    CollectionsService,
    SalesOrderChangeHandler,
    DeliveryChangeHandler,
    CollectionChangeHandler,
    ExpenseCategoriesService,
    ExpensesService,
    ExpenseChangeHandler,
    CashBookService,
    ReportsService,
    CommissionService,
  ],
})
export class DealershipModule {
  constructor(
    registry: PermissionRegistry,
    changeHandlers: ChangeHandlerRegistry,
    purchaseHandler: PurchaseChangeHandler,
    stockHandler: ProductStockChangeHandler,
    orderHandler: SalesOrderChangeHandler,
    deliveryHandler: DeliveryChangeHandler,
    collectionHandler: CollectionChangeHandler,
    expenseHandler: ExpenseChangeHandler,
  ) {
    registry.register(DEALERSHIP_PERMISSIONS);
    registerTenantModels(DEALERSHIP_TENANT_MODELS);
    // Sensitive master-data fields: staff send a change request instead.
    changeHandlers.register(productChangeHandler);
    changeHandlers.register(customerChangeHandler);
    changeHandlers.register(categoryChangeHandler);
    // Purchases: void and correct through the same workflow (Step 5a).
    changeHandlers.register(purchaseHandler);
    // Stock adjustments above the daily limit.
    changeHandlers.register(stockHandler);
    // Orders, deliveries and collections (Step 5b).
    changeHandlers.register(orderHandler);
    changeHandlers.register(deliveryHandler);
    changeHandlers.register(collectionHandler);
    // Expenses and their kinds (Step 6).
    changeHandlers.register(expenseHandler);
    changeHandlers.register(expenseCategoryChangeHandler);
  }
}
