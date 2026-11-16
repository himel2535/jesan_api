import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PermissionRegistry } from './permission-registry';

/**
 * Mirrors the permissions declared in code into the `permissions` table and
 * hands out default grants. The owner's later changes are never overwritten:
 * defaults are only added for permissions that are new, or for a business that
 * has no grants at all yet.
 */
@Injectable()
export class PermissionSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PermissionRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.prisma.isConfigured) {
      return;
    }
    try {
      await this.sync();
    } catch (error) {
      // Do not take the whole API down; the previous grants stay in force.
      this.logger.error('Permission sync failed', error instanceof Error ? error.stack : error);
    }
  }

  async sync(): Promise<void> {
    const declared = this.registry.all();

    await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.permission.findMany({ select: { key: true, ownerOnly: true } });
      const existingByKey = new Map(existing.map((row) => [row.key, row]));

      const added = declared.filter((permission) => !existingByKey.has(permission.key));
      const becameOwnerOnly = declared.filter(
        (permission) =>
          permission.ownerOnly && existingByKey.get(permission.key)?.ownerOnly === false,
      );

      // A permission that turns owner-only loses its grants first, or the
      // database constraint would (rightly) refuse the change.
      if (becameOwnerOnly.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { permissionKey: { in: becameOwnerOnly.map((permission) => permission.key) } },
        });
      }
      await tx.permission.createMany({
        data: added.map((permission) => ({
          key: permission.key,
          module: permission.module,
          ownerOnly: permission.ownerOnly,
        })),
        skipDuplicates: true,
      });
      await Promise.all(
        declared
          .filter((permission) => existingByKey.has(permission.key))
          .map((permission) =>
            tx.permission.update({
              where: { key: permission.key },
              data: {
                module: permission.module,
                ownerOnly: permission.ownerOnly,
                isActive: true,
              },
            }),
          ),
      );
      await tx.permission.updateMany({
        where: { key: { notIn: declared.map((permission) => permission.key) }, isActive: true },
        data: { isActive: false },
      });

      await this.grantDefaults(tx, new Set(added.map((permission) => permission.key)));
    });
  }

  /** Gives a business its default grants. Call it when a business is created. */
  async applyDefaultsToBusiness(businessId: string): Promise<void> {
    await this.prisma.client.$transaction((tx) => this.grantDefaults(tx, null, businessId));
  }

  /**
   * @param newKeys permissions added this run (null: all of them)
   * @param onlyBusinessId limit to one business, and treat it as fresh
   */
  private async grantDefaults(
    tx: Prisma.TransactionClient,
    newKeys: Set<string> | null,
    onlyBusinessId?: string,
  ): Promise<void> {
    const [businesses, roles, businessesWithGrants] = await Promise.all([
      tx.business.findMany({
        where: onlyBusinessId ? { id: onlyBusinessId } : {},
        select: { id: true, type: true },
      }),
      tx.role.findMany({ select: { id: true, key: true } }),
      tx.rolePermission.groupBy({ by: ['businessId'], _count: { _all: true } }),
    ]);
    const roleIdByKey = new Map(roles.map((role) => [role.key, role.id]));
    const hasGrants = new Set(businessesWithGrants.map((row) => row.businessId));

    const rows: Prisma.RolePermissionCreateManyInput[] = [];
    for (const business of businesses) {
      const fresh = onlyBusinessId !== undefined || !hasGrants.has(business.id);
      for (const permission of this.registry.applicableTo(business.type)) {
        if (permission.ownerOnly || !(fresh || (newKeys?.has(permission.key) ?? true))) {
          continue;
        }
        for (const roleKey of permission.defaultRoles) {
          const roleId = roleIdByKey.get(roleKey);
          if (roleId) {
            rows.push({
              businessId: business.id,
              roleId,
              permissionKey: permission.key,
              permissionOwnerOnly: false,
            });
          }
        }
      }
    }
    await tx.rolePermission.createMany({ data: rows, skipDuplicates: true });
  }
}
