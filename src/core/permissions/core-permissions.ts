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
  ],
};
