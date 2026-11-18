import { PermissionGroup } from './permission-registry';

/** Permissions of the platform itself; every business has them. */
export const CORE_PERMISSIONS: PermissionGroup = {
  module: 'core',
  permissions: [
    { key: 'settings.view', defaultRoles: ['manager', 'accountant'] },
    { key: 'settings.manage', ownerOnly: true },
    { key: 'users.view', defaultRoles: ['manager'] },
    { key: 'users.manage', ownerOnly: true },
    { key: 'roles.manage', ownerOnly: true },
    { key: 'audit.view', ownerOnly: true },
    // Maker-checker (change requests). Not owner-only: the business-level owner
    // role approves too, and the owner may trust someone else with approval.
    // Approving also needs the direct permission for the change itself.
    { key: 'change.request', defaultRoles: ['manager', 'accountant', 'salesman'] },
    { key: 'change.view.own', defaultRoles: ['manager', 'accountant', 'salesman'] },
    { key: 'change.view.all' },
    { key: 'change.approve' },
  ],
};
