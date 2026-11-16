import { Injectable } from '@nestjs/common';

/** Roles that can receive default grants. `owner` is computed, never granted row by row. */
export const DEFAULT_ROLE_KEYS = ['manager', 'accountant', 'salesman'] as const;
export type DefaultRoleKey = (typeof DEFAULT_ROLE_KEYS)[number];

export const OWNER_ROLE_KEY = 'owner';

export interface PermissionDefinition {
  /** Dotted lowercase key such as `sale.create`. */
  key: string;
  /** Held by the platform owner only; can never be granted to a role. */
  ownerOnly?: boolean;
  /** Roles that get this permission by default (the owner can change it later). */
  defaultRoles?: readonly DefaultRoleKey[];
}

/** What one module declares, like a module manifest. */
export interface PermissionGroup {
  module: string;
  /** Applies only to businesses of this type; omitted for core permissions. */
  businessType?: string;
  permissions: readonly PermissionDefinition[];
}

export interface RegisteredPermission {
  key: string;
  module: string;
  businessType: string | undefined;
  ownerOnly: boolean;
  defaultRoles: readonly DefaultRoleKey[];
}

const KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
/** Commission and profit data is the owner's alone, whatever a module says. */
const OWNER_ONLY_PREFIXES = ['commission.', 'profit.'];

@Injectable()
export class PermissionRegistry {
  private readonly byKey = new Map<string, RegisteredPermission>();

  /** Throws on a bad declaration, so the app refuses to start. */
  register(group: PermissionGroup): void {
    for (const definition of group.permissions) {
      const { key } = definition;
      const ownerOnly = definition.ownerOnly ?? false;
      const defaultRoles = definition.defaultRoles ?? [];

      if (!KEY_PATTERN.test(key)) {
        throw new Error(`Invalid permission key "${key}": use dotted lowercase words`);
      }
      if (this.byKey.has(key)) {
        throw new Error(`Permission "${key}" is registered twice`);
      }
      if (!ownerOnly && OWNER_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        throw new Error(`Permission "${key}" must be ownerOnly`);
      }
      if (ownerOnly && defaultRoles.length > 0) {
        throw new Error(`Owner-only permission "${key}" cannot have default roles`);
      }

      this.byKey.set(key, {
        key,
        module: group.module,
        businessType: group.businessType,
        ownerOnly,
        defaultRoles,
      });
    }
  }

  get(key: string): RegisteredPermission | undefined {
    return this.byKey.get(key);
  }

  all(): RegisteredPermission[] {
    return [...this.byKey.values()];
  }

  /** Permissions that apply to a business of the given type. */
  applicableTo(businessType: string): RegisteredPermission[] {
    return this.all().filter(
      (permission) =>
        permission.businessType === undefined || permission.businessType === businessType,
    );
  }
}
