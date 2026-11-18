import { PermissionGroup } from '../../core/permissions/permission-registry';

/** Business type this module serves; matches `businesses.type`. */
export const DEALERSHIP_TYPE = 'dealership';

/**
 * Prisma models that hold business data. Queries on them must go through
 * PrismaService.forBusiness(businessId); unscoped queries are refused.
 */
export const DEALERSHIP_TENANT_MODELS = ['ProductCategory', 'Product', 'Customer', 'Supplier'];

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
    { key: 'supplier.view', defaultRoles: ['manager'] },
    { key: 'purchase.view', defaultRoles: ['manager'] },
    { key: 'purchase.create', defaultRoles: ['manager'] },
    { key: 'purchase.void' },
    { key: 'stock.view', defaultRoles: ['manager', 'salesman'] },
    { key: 'stock.adjust', defaultRoles: ['manager'] },
    { key: 'sale.create', defaultRoles: ['manager', 'salesman'] },
    { key: 'sale.view.all', defaultRoles: ['manager'] },
    { key: 'sale.view.own', defaultRoles: ['salesman'] },
    { key: 'sale.void' },
    { key: 'ledger.view', defaultRoles: ['accountant'] },
    { key: 'ledger.entry.create', defaultRoles: ['accountant'] },
    { key: 'payment.create', defaultRoles: ['accountant'] },
    { key: 'expense.create', defaultRoles: ['accountant'] },
    { key: 'summary.finance.view' },
    { key: 'reports.finance.view' },
    { key: 'commission.view', ownerOnly: true },
    { key: 'commission.manage', ownerOnly: true },
    { key: 'profit.view', ownerOnly: true },
  ],
};
