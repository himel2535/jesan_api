import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AccessRole, BusinessAccess } from '../common/request-context';
import { OWNER_ROLE_KEY, PermissionRegistry } from './permission-registry';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5000;

const roleSelect = { id: true, key: true, nameEn: true, nameBn: true } as const;

export interface UserBusinessSummary {
  id: string;
  slug: string;
  nameEn: string;
  nameBn: string;
  type: string;
  role: AccessRole;
  permissions: string[];
}

export interface UserOverview {
  user: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    isActive: boolean;
    isPlatformOwner: boolean;
  };
  businesses: UserBusinessSummary[];
}

interface CacheEntry {
  expiresAt: number;
  access: BusinessAccess;
}

/**
 * Works out what a user may do in a business. Results are cached in memory for
 * a short time so ordinary requests need no database query for permissions;
 * every change to roles, permissions or access clears the affected entries.
 * The cache is per process, which is correct while the API runs as one instance.
 */
@Injectable()
export class AccessResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PermissionRegistry,
  ) {}

  /** Null when the user has no access (unknown business, inactive user, not a member). */
  async resolve(userId: string, businessSlug: string): Promise<BusinessAccess | null> {
    const cacheKey = `${userId}:${businessSlug}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.access;
    }

    const db = this.prisma.client;
    const [user, business] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { isActive: true, isPlatformOwner: true },
      }),
      db.business.findUnique({
        where: { slug: businessSlug },
        select: { id: true, slug: true, type: true, isActive: true },
      }),
    ]);
    if (!user?.isActive || !business?.isActive) {
      return null;
    }

    const applicable = this.registry.applicableTo(business.type);
    let role: AccessRole;
    let permissions: Set<string>;

    if (user.isPlatformOwner) {
      // Every permission, owner-only ones included, in every business.
      role = await db.role.findUniqueOrThrow({
        where: { key: OWNER_ROLE_KEY },
        select: roleSelect,
      });
      permissions = new Set(applicable.map((permission) => permission.key));
    } else {
      const membership = await db.userBusinessAccess.findUnique({
        where: { userId_businessId: { userId, businessId: business.id } },
        select: { role: { select: roleSelect } },
      });
      if (!membership) {
        return null;
      }
      role = membership.role;
      permissions =
        role.key === OWNER_ROLE_KEY
          ? this.ownerRolePermissions(business.type)
          : await this.grantedPermissions(business.id, role.id, business.type);
    }

    const access: BusinessAccess = {
      businessId: business.id,
      businessSlug: business.slug,
      businessType: business.type,
      role,
      isPlatformOwner: user.isPlatformOwner,
      permissions,
    };
    this.remember(cacheKey, access);
    return access;
  }

  /** The user, plus every business they may enter with their role and permissions. */
  async overview(userId: string): Promise<UserOverview | null> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isPlatformOwner: true,
      },
    });
    if (!user?.isActive) {
      return null;
    }

    if (user.isPlatformOwner) {
      const [businesses, ownerRole] = await Promise.all([
        db.business.findMany({
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
          select: { id: true, slug: true, nameEn: true, nameBn: true, type: true },
        }),
        db.role.findUniqueOrThrow({ where: { key: OWNER_ROLE_KEY }, select: roleSelect }),
      ]);
      return {
        user,
        businesses: businesses.map((business) => ({
          ...business,
          role: ownerRole,
          permissions: this.registry
            .applicableTo(business.type)
            .map((permission) => permission.key)
            .sort(),
        })),
      };
    }

    const memberships = await db.userBusinessAccess.findMany({
      where: { userId, business: { isActive: true } },
      orderBy: [{ business: { sortOrder: 'asc' } }, { business: { nameEn: 'asc' } }],
      select: {
        business: { select: { id: true, slug: true, nameEn: true, nameBn: true, type: true } },
        role: { select: roleSelect },
      },
    });

    // One query for the grants of all (business, role) pairs, not one per business.
    const grants = await db.rolePermission.findMany({
      where: {
        businessId: { in: memberships.map((membership) => membership.business.id) },
        roleId: { in: memberships.map((membership) => membership.role.id) },
      },
      select: { businessId: true, roleId: true, permissionKey: true },
    });
    const grantedByPair = new Map<string, string[]>();
    for (const grant of grants) {
      const pair = `${grant.businessId}:${grant.roleId}`;
      grantedByPair.set(pair, [...(grantedByPair.get(pair) ?? []), grant.permissionKey]);
    }

    return {
      user,
      businesses: memberships.map(({ business, role }) => ({
        ...business,
        role,
        permissions: [
          ...(role.key === OWNER_ROLE_KEY
            ? this.ownerRolePermissions(business.type)
            : this.usable(grantedByPair.get(`${business.id}:${role.id}`) ?? [], business.type)),
        ].sort(),
      })),
    };
  }

  /** Forget everything cached for a business (its roles or permissions changed). */
  invalidateBusiness(businessSlug: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${businessSlug}`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Forget everything cached for a user (their access, role or status changed). */
  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  /** The business-level owner role: every permission except the owner-only ones. */
  ownerRolePermissions(businessType: string): Set<string> {
    return new Set(
      this.registry
        .applicableTo(businessType)
        .filter((permission) => !permission.ownerOnly)
        .map((permission) => permission.key),
    );
  }

  private async grantedPermissions(
    businessId: string,
    roleId: string,
    businessType: string,
  ): Promise<Set<string>> {
    const rows = await this.prisma.client.rolePermission.findMany({
      where: { businessId, roleId },
      select: { permissionKey: true },
    });
    return this.usable(
      rows.map((row) => row.permissionKey),
      businessType,
    );
  }

  /**
   * Keeps only permissions that are declared, apply to the business type and are
   * not owner-only. Defense in depth: the database already forbids owner-only rows.
   */
  private usable(keys: string[], businessType: string): Set<string> {
    const allowed = new Set(
      this.registry
        .applicableTo(businessType)
        .filter((permission) => !permission.ownerOnly)
        .map((permission) => permission.key),
    );
    return new Set(keys.filter((key) => allowed.has(key)));
  }

  private remember(cacheKey: string, access: BusinessAccess): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, access });
  }
}
