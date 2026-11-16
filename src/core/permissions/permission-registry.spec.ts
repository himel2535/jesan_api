import { describe, expect, it } from 'vitest';
import { DEALERSHIP_PERMISSIONS } from '../../modules/dealership/dealership.permissions';
import { CORE_PERMISSIONS } from './core-permissions';
import { PermissionGroup, PermissionRegistry } from './permission-registry';

const group = (permissions: PermissionGroup['permissions']): PermissionGroup => ({
  module: 'test',
  permissions,
});

describe('PermissionRegistry', () => {
  it('registers valid permissions and finds them again', () => {
    const registry = new PermissionRegistry();
    registry.register(
      group([{ key: 'sale.create', defaultRoles: ['manager'] }, { key: 'ledger.view' }]),
    );
    expect(registry.get('sale.create')).toMatchObject({
      module: 'test',
      ownerOnly: false,
      defaultRoles: ['manager'],
    });
    expect(registry.all().map((permission) => permission.key)).toEqual([
      'sale.create',
      'ledger.view',
    ]);
  });

  it.each(['sale', 'Sale.Create', 'sale..create', 'sale.create!', '', '.sale', 'sale.'])(
    'rejects the key "%s"',
    (key) => {
      expect(() => {
        new PermissionRegistry().register(group([{ key }]));
      }).toThrow('Invalid permission key');
    },
  );

  it('rejects a permission registered twice, even from different modules', () => {
    const registry = new PermissionRegistry();
    registry.register(group([{ key: 'sale.create' }]));
    expect(() => {
      registry.register({ module: 'other', permissions: [{ key: 'sale.create' }] });
    }).toThrow('registered twice');
  });

  it('refuses to start when a commission or profit permission is not owner-only', () => {
    for (const key of [
      'commission.view',
      'commission.anything.new',
      'profit.view',
      'profit.export',
    ]) {
      expect(() => {
        new PermissionRegistry().register(group([{ key }]));
      }).toThrow('must be ownerOnly');
      expect(() => {
        new PermissionRegistry().register(group([{ key, ownerOnly: true }]));
      }).not.toThrow();
    }
  });

  it('refuses default roles on an owner-only permission', () => {
    expect(() => {
      new PermissionRegistry().register(
        group([{ key: 'commission.view', ownerOnly: true, defaultRoles: ['manager'] }]),
      );
    }).toThrow('cannot have default roles');
  });

  it('limits a module’s permissions to businesses of its type', () => {
    const registry = new PermissionRegistry();
    registry.register(CORE_PERMISSIONS);
    registry.register(DEALERSHIP_PERMISSIONS);

    const dealership = registry.applicableTo('dealership').map((permission) => permission.key);
    const factory = registry.applicableTo('manufacturing').map((permission) => permission.key);
    expect(dealership).toContain('sale.create');
    expect(dealership).toContain('settings.view');
    expect(factory).toContain('settings.view');
    expect(factory).not.toContain('sale.create');
  });
});

describe('the declared permissions', () => {
  const registry = new PermissionRegistry();
  registry.register(CORE_PERMISSIONS);
  registry.register(DEALERSHIP_PERMISSIONS);

  it('are exactly these owner-only ones: commission, profit and management', () => {
    const ownerOnly = registry
      .all()
      .filter((permission) => permission.ownerOnly)
      .map((permission) => permission.key)
      .sort();
    expect(ownerOnly).toEqual(
      [
        'audit.view',
        'commission.manage',
        'commission.view',
        'profit.view',
        'roles.manage',
        'settings.manage',
        'users.manage',
      ].sort(),
    );
  });

  it('never give a default to the owner-only ones, or money summaries to the staff roles', () => {
    for (const permission of registry.all()) {
      if (permission.ownerOnly) {
        expect(permission.defaultRoles).toEqual([]);
      }
    }
    for (const key of [
      'summary.finance.view',
      'reports.finance.view',
      'sale.void',
      'purchase.void',
    ]) {
      expect(registry.get(key)?.defaultRoles, key).toEqual([]);
    }
  });

  it('give the salesman stock quantities but not cost prices', () => {
    expect(registry.get('stock.view')?.defaultRoles).toContain('salesman');
    expect(registry.get('product.cost.view')?.defaultRoles).not.toContain('salesman');
  });
});
