import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { normalizeEmail, normalizePhone } from '../auth/identifier';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { BusinessAccess } from '../common/request-context';
import { PrismaService } from '../database/prisma.service';
import { AccessResolver } from '../permissions/access-resolver.service';
import { OWNER_ROLE_KEY, PermissionRegistry } from '../permissions/permission-registry';
import { CreateUserDto } from './dto/access.dto';

export const USERS_PAGE_SIZE = 10;

export interface ActorInfo {
  userId: string;
  ip?: string | undefined;
}

const roleSelect = { id: true, key: true, nameEn: true, nameBn: true } as const;

/** Settings: who may enter a business, with which role, and what each role may do. */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PermissionRegistry,
    private readonly resolver: AccessResolver,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  /** The role-by-permission table for one business. */
  async getRoleMatrix(access: BusinessAccess) {
    const db = this.prisma.client;
    const [roles, grants] = await Promise.all([
      db.role.findMany({ orderBy: { sortOrder: 'asc' }, select: roleSelect }),
      db.rolePermission.findMany({
        where: { businessId: access.businessId },
        select: { roleId: true, permissionKey: true },
      }),
    ]);
    const applicable = this.registry.applicableTo(access.businessType);

    return {
      permissions: applicable.map(({ key, module, ownerOnly }) => ({ key, module, ownerOnly })),
      roles: roles.map((role) => {
        const isOwnerRole = role.key === OWNER_ROLE_KEY;
        return {
          key: role.key,
          nameEn: role.nameEn,
          nameBn: role.nameBn,
          // The business-level owner role always has every non-owner-only permission.
          locked: isOwnerRole,
          permissions: isOwnerRole
            ? [...this.resolver.ownerRolePermissions(access.businessType)].sort()
            : grants
                .filter((grant) => grant.roleId === role.id)
                .map((grant) => grant.permissionKey)
                .sort(),
        };
      }),
    };
  }

  async setRolePermissions(
    access: BusinessAccess,
    roleKey: string,
    requested: string[],
    actor: ActorInfo,
  ) {
    if (roleKey === OWNER_ROLE_KEY) {
      throw new BadRequestException('The owner role always has every non-owner-only permission');
    }
    const wanted = [...new Set(requested)];
    for (const key of wanted) {
      const permission = this.registry.get(key);
      const applies =
        permission !== undefined &&
        (permission.businessType === undefined || permission.businessType === access.businessType);
      if (!permission || !applies) {
        throw new BadRequestException(`Unknown permission: ${key}`);
      }
      if (permission.ownerOnly) {
        throw new BadRequestException(`"${key}" is owner-only and cannot be given to a role`);
      }
    }

    const db = this.prisma.client;
    const role = await db.role.findUnique({ where: { key: roleKey }, select: { id: true } });
    if (!role) {
      throw new NotFoundException('Unknown role');
    }

    const changes = await db.$transaction(async (tx) => {
      const current = await tx.rolePermission.findMany({
        where: { businessId: access.businessId, roleId: role.id },
        select: { permissionKey: true },
      });
      const before = new Set(current.map((row) => row.permissionKey));
      const added = wanted.filter((key) => !before.has(key)).sort();
      const removed = [...before].filter((key) => !wanted.includes(key)).sort();

      if (removed.length > 0) {
        await tx.rolePermission.deleteMany({
          where: {
            businessId: access.businessId,
            roleId: role.id,
            permissionKey: { in: removed },
          },
        });
      }
      if (added.length > 0) {
        await tx.rolePermission.createMany({
          data: added.map((permissionKey) => ({
            businessId: access.businessId,
            roleId: role.id,
            permissionKey,
            permissionOwnerOnly: false,
          })),
        });
      }
      if (added.length > 0 || removed.length > 0) {
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'role_permissions.updated',
            entityType: 'role',
            entityId: role.id,
            changes: { role: roleKey, added, removed },
            ip: actor.ip ?? null,
          },
          tx,
        );
      }
      return { added, removed };
    });

    this.resolver.invalidateBusiness(access.businessSlug);
    return { role: roleKey, ...changes };
  }

  async listUsers(access: BusinessAccess, page: number) {
    const db = this.prisma.client;
    const where = { businessId: access.businessId };
    const [rows, total] = await Promise.all([
      db.userBusinessAccess.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * USERS_PAGE_SIZE,
        take: USERS_PAGE_SIZE,
        select: {
          role: { select: roleSelect },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
              lastLoginAt: true,
            },
          },
        },
      }),
      db.userBusinessAccess.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({ ...row.user, role: row.role.key })),
      page,
      pageSize: USERS_PAGE_SIZE,
      total,
    };
  }

  async createUser(access: BusinessAccess, dto: CreateUserDto, actor: ActorInfo) {
    const email = dto.email ? normalizeEmail(dto.email) : null;
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) {
      throw new BadRequestException('Phone number is not valid');
    }
    if (!email && !phone) {
      throw new BadRequestException('An email or a phone number is required');
    }
    this.passwords.assertAcceptable(dto.password, { email, phone });
    const role = await this.requireRole(dto.roleKey);
    const passwordHash = await this.passwords.hash(dto.password);

    try {
      const user = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: dto.name.trim(),
            email,
            phone,
            passwordHash,
            passwordChangedAt: new Date(),
          },
          select: { id: true },
        });
        await tx.userBusinessAccess.create({
          data: { userId: created.id, businessId: access.businessId, roleId: role.id },
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'user.created',
            entityType: 'user',
            entityId: created.id,
            changes: { email, phone, role: role.key },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return created;
      });
      return { id: user.id, role: role.key };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          'A user with this email or phone already exists; grant them access instead',
        );
      }
      throw error;
    }
  }

  /** Gives an existing user access to this business (or changes their role here). */
  async grantAccess(access: BusinessAccess, userId: string, roleKey: string, actor: ActorInfo) {
    await this.requireManageableUser(userId);
    const role = await this.requireRole(roleKey);
    const db = this.prisma.client;

    const previous = await db.userBusinessAccess.findUnique({
      where: { userId_businessId: { userId, businessId: access.businessId } },
      select: { role: { select: { key: true } } },
    });
    await db.$transaction(async (tx) => {
      await tx.userBusinessAccess.upsert({
        where: { userId_businessId: { userId, businessId: access.businessId } },
        create: { userId, businessId: access.businessId, roleId: role.id },
        update: { roleId: role.id },
      });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: previous ? 'user.role_changed' : 'user.access_granted',
          entityType: 'user',
          entityId: userId,
          changes: { role: { before: previous?.role.key ?? null, after: role.key } },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    this.resolver.invalidateUser(userId);
    return { id: userId, role: role.key };
  }

  async removeAccess(access: BusinessAccess, userId: string, actor: ActorInfo): Promise<void> {
    await this.requireManageableUser(userId, access);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.userBusinessAccess.delete({
        where: { userId_businessId: { userId, businessId: access.businessId } },
      });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'user.access_removed',
          entityType: 'user',
          entityId: userId,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    this.resolver.invalidateUser(userId);
  }

  async setStatus(
    access: BusinessAccess,
    userId: string,
    isActive: boolean,
    actor: ActorInfo,
  ): Promise<void> {
    if (userId === actor.userId) {
      throw new BadRequestException('You cannot change your own status');
    }
    await this.requireManageableUser(userId, access);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { isActive } });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'user.status_changed',
          entityType: 'user',
          entityId: userId,
          changes: { isActive: { after: isActive } },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    if (!isActive) {
      await this.sessions.revokeAllForUser(userId, 'user_deactivated');
    }
    this.resolver.invalidateUser(userId);
  }

  /** Sets a new password, signs the user out everywhere and lifts any lock. */
  async resetPassword(
    access: BusinessAccess,
    userId: string,
    newPassword: string,
    actor: ActorInfo,
  ): Promise<void> {
    const target = await this.requireManageableUser(userId, access);
    this.passwords.assertAcceptable(newPassword, target);
    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'user.password_reset',
          entityType: 'user',
          entityId: userId,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    await this.sessions.revokeAllForUser(userId, 'password_reset');
  }

  private async requireRole(roleKey: string): Promise<{ id: string; key: string }> {
    const role = await this.prisma.client.role.findUnique({
      where: { key: roleKey },
      select: { id: true, key: true },
    });
    if (!role) {
      throw new BadRequestException('Unknown role');
    }
    return role;
  }

  /**
   * The user must exist (and, when `access` is given, belong to that business).
   * Platform owners are managed outside this API.
   */
  private async requireManageableUser(userId: string, access?: BusinessAccess) {
    const db = this.prisma.client;
    const [user, membership] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, phone: true, isPlatformOwner: true },
      }),
      access
        ? db.userBusinessAccess.findUnique({
            where: { userId_businessId: { userId, businessId: access.businessId } },
            select: { id: true },
          })
        : Promise.resolve({ id: 'not-checked' }),
    ]);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.isPlatformOwner) {
      throw new BadRequestException('Platform owner accounts cannot be changed here');
    }
    if (!membership) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
