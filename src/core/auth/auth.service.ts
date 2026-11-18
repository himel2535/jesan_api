import { Injectable, UnauthorizedException } from '@nestjs/common';
import { badRequest, unauthorized } from '../errors';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AccessResolver, UserOverview } from '../permissions/access-resolver.service';
import { GENERIC_LOGIN_ERROR, LOCK_DURATION_MS, MAX_FAILED_LOGINS } from './auth.constants';
import { parseLoginIdentifier } from './identifier';
import { PasswordService } from './password.service';
import { ClientMeta, IssuedSession, SessionService } from './session.service';
import { TokenService } from './token.service';

export interface PublicUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isPlatformOwner: boolean;
}

export interface LoginResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  isPlatformOwner: true,
  passwordHash: true,
  failedLoginCount: true,
  lockedUntil: true,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly resolver: AccessResolver,
  ) {}

  /**
   * Every kind of failure (unknown user, wrong password, inactive, locked)
   * gives the same error and takes about the same time.
   */
  async login(identifier: string, password: string, meta: ClientMeta): Promise<LoginResult> {
    const parsed = parseLoginIdentifier(identifier);
    const db = this.prisma.client;
    const user = parsed
      ? await db.user.findUnique({
          where: 'email' in parsed ? { email: parsed.email } : { phone: parsed.phone },
          select: userSelect,
        })
      : null;

    if (!user) {
      await this.passwords.verifyDummy(password);
      throw unauthorized('INVALID_CREDENTIALS', GENERIC_LOGIN_ERROR);
    }

    const now = new Date();
    const locked = user.lockedUntil !== null && user.lockedUntil > now;
    const passwordOk = await this.passwords.verify(user.passwordHash, password);

    if (locked || !user.isActive) {
      throw unauthorized('INVALID_CREDENTIALS', GENERIC_LOGIN_ERROR);
    }
    if (!passwordOk) {
      await this.recordFailedLogin(user.id, meta);
      throw unauthorized('INVALID_CREDENTIALS', GENERIC_LOGIN_ERROR);
    }

    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    const session = await this.sessions.create(user.id, meta);
    return {
      user: this.toPublicUser(user),
      accessToken: this.tokens.signAccessToken(user.id, session.sessionId),
      refreshToken: session.refreshToken,
    };
  }

  /** Trades a refresh token for a new pair of tokens. */
  async refresh(
    refreshToken: string,
    meta: ClientMeta,
  ): Promise<{ accessToken: string } & Pick<IssuedSession, 'refreshToken'>> {
    const issued = await this.sessions.rotate(refreshToken, meta);
    return {
      accessToken: this.tokens.signAccessToken(issued.userId, issued.sessionId),
      refreshToken: issued.refreshToken,
    };
  }

  async me(userId: string): Promise<UserOverview> {
    const overview = await this.resolver.overview(userId);
    if (!overview) {
      throw new UnauthorizedException();
    }
    return overview;
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
    meta: ClientMeta,
  ): Promise<void> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, passwordHash: true, isActive: true },
    });
    if (!user?.isActive) {
      throw new UnauthorizedException();
    }
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw badRequest(
        'CURRENT_PASSWORD_INCORRECT',
        'Current password is incorrect',
        'currentPassword',
      );
    }
    this.passwords.assertAcceptable(newPassword, user, 'newPassword');

    await db.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date() },
    });
    // Every other device is signed out; this one stays.
    await this.sessions.revokeAllForUser(userId, 'password_changed', currentSessionId);
    await this.audit.record({
      actorUserId: userId,
      action: 'user.password_changed',
      entityType: 'user',
      entityId: userId,
      ip: meta.ip ?? null,
    });
  }

  private async recordFailedLogin(userId: string, meta: ClientMeta): Promise<void> {
    const db = this.prisma.client;
    const updated = await db.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      await db.user.update({
        where: { id: userId },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
      });
      await this.audit.record({
        actorUserId: userId,
        action: 'auth.account_locked',
        entityType: 'user',
        entityId: userId,
        ip: meta.ip ?? null,
      });
    }
  }

  private toPublicUser(user: PublicUser): PublicUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isPlatformOwner: user.isPlatformOwner,
    };
  }
}
