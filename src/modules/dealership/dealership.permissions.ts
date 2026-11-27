import { PermissionGroup } from '../../core/permissions/permission-registry';

/** Business type this module serves; matches `businesses.type`. */
export const DEALERSHIP_TYPE = 'dealership';

/**
 * Prisma models that hold business data. Queries on them must go through
 * PrismaService.forBusiness(businessId); unscoped queries are refused.
 */
export const DEALERSHIP_TENANT_MODELS = [
  'ProductCategory',
  'Product',
  'Customer',
  'Supplier',
  'Purchase',
  'PurchaseItem',
  'StockMovement',
  'MonthlyPurchaseCounter',
  'SalesOrder',
  'SalesOrderItem',
  'Delivery',
  'DeliveryItem',
  'Collection',
  'CustomerLedgerEntry',
  'ExpenseCategory',
  'Expense',
  'CommissionReceipt',
  'BusinessLedgerEntry',
];

/**
 * Permissions of the dealership module (declarations only, no features yet).
 * Defaults can be changed per business by the owner in Settings. Commission and
 * profit permissions are owner-only: nobody but the platform owner can hold them.
 */
export const DEALERSHIP_PERMISSIONS: PermissionGroup = {
  module: 'dealership',
  businessType: DEALERSHIP_TYPE,
  permissions: [
    { key: 'product.view', defaultRoles: ['manager', 'salesman'] },
    { key: 'product.manage', defaultRoles: ['manager'] },
    { key: 'product.cost.view', defaultRoles: ['manager'] },
    // Deactivating after creation: owner level only by default (staff send a
    // change request instead). Products carry no editable price: the last
    // purchase price is set by purchases only.
    { key: 'product.deactivate' },
    { key: 'customer.view', defaultRoles: ['manager', 'salesman', 'accountant'] },
    { key: 'customer.manage', defaultRoles: ['manager', 'salesman'] },
    { key: 'customer.due.view', defaultRoles: ['manager', 'accountant'] },
    { key: 'customer.balance.edit' },
    { key: 'customer.deactivate' },
    { key: 'collection.create', defaultRoles: ['manager', 'accountant'] },
    { key: 'collection.view', defaultRoles: ['manager', 'accountant'] },
    // Correcting or voiding a collection: owner level by default.
    { key: 'collection.edit' },
    { key: 'collection.void' },
    { key: 'supplier.view', defaultRoles: ['manager'] },
    { key: 'purchase.view', defaultRoles: ['manager'] },
    { key: 'purchase.create', defaultRoles: ['manager'] },
    // Correcting (quantity, price, date) or voiding a purchase: owner level by
    // default; staff send a change request.
    { key: 'purchase.edit' },
    { key: 'purchase.void' },
    { key: 'stock.view', defaultRoles: ['manager', 'salesman'] },
    // Adjusting stock up to the daily limit per product and user (settings).
    { key: 'stock.adjust', defaultRoles: ['manager'] },
    // Beyond the limit, and approving larger adjustments: owner level by default.
    { key: 'stock.adjust.large' },
    { key: 'sale.create', defaultRoles: ['manager', 'salesman'] },
    { key: 'sale.view.all', defaultRoles: ['manager'] },
    { key: 'sale.view.own', defaultRoles: ['salesman'] },
    // Orders (Step 5b). Correcting or voiding an order: owner level by default.
    { key: 'sale.edit' },
    { key: 'sale.void' },
    { key: 'delivery.view', defaultRoles: ['manager'] },
    { key: 'delivery.create', defaultRoles: ['manager'] },
    { key: 'delivery.edit' },
    { key: 'delivery.void' },
    // Deliver beyond the customer's credit limit when the business blocks it.
    { key: 'delivery.credit.override' },
    { key: 'ledger.view', defaultRoles: ['accountant'] },
    { key: 'ledger.entry.create', defaultRoles: ['accountant'] },
    { key: 'payment.create', defaultRoles: ['accountant'] },
    // Expenses (Step 6). A manager runs the shop day to day, so recording an
    // expense is theirs too; correcting or voiding one is owner level by
    // default and staff send a change request instead.
    { key: 'expense.create', defaultRoles: ['manager', 'accountant'] },
    { key: 'expense.view', defaultRoles: ['manager', 'accountant'] },
    { key: 'expense.edit' },
    { key: 'expense.void' },
    { key: 'expense.category.manage', defaultRoles: ['manager'] },
    // The cash book and the read-only reports (Step 6). A salesman sees only
    // their own orders, so neither is theirs.
    { key: 'cashbook.view', defaultRoles: ['manager', 'accountant'] },
    { key: 'report.view', defaultRoles: ['manager', 'accountant'] },
    // Kept for Step 7 (profit and commission reports); not used yet.
    { key: 'summary.finance.view' },
    { key: 'reports.finance.view' },
    { key: 'commission.view', ownerOnly: true },
    { key: 'commission.manage', ownerOnly: true },
    { key: 'profit.view', ownerOnly: true },
  ],
};
