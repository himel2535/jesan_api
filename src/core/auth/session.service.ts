import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_TTL_MS } from './auth.constants';
import { RevocationList } from './revocation-list';
import { generateRefreshToken, hashToken } from './token.service';

export interface ClientMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedSession {
  userId: string;
  sessionId: string;
  refreshToken: string;
}

function clip(value: string | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

/** One session per signed-in device; refresh tokens rotate on every use. */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revocation: RevocationList,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, meta: ClientMeta): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const session = await this.prisma.client.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: clip(meta.userAgent, 255),
        ip: clip(meta.ip, 45),
      },
      select: { id: true },
    });
    return { userId, sessionId: session.id, refreshToken };
  }

  /**
   * Swaps a refresh token for a new one. The old token stops working at once.
   * Every failure is the same 401, so a caller learns nothing about why.
   */
  async rotate(refreshToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const db = this.prisma.client;
    const presentedHash = hashToken(refreshToken);
    const now = new Date();

    const current = await db.session.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { isActive: true } },
      },
    });

    if (current) {
      if (current.revokedAt || current.expiresAt <= now || !current.user.isActive) {
        throw new UnauthorizedException();
      }
      const newToken = generateRefreshToken();
      // Conditional update: if two requests rotate the same token at once, only one wins.
      const result = await db.session.updateMany({
        where: { id: current.id, refreshTokenHash: presentedHash, revokedAt: null },
        data: {
          refreshTokenHash: hashToken(newToken),
          previousTokenHash: presentedHash,
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
          userAgent: clip(meta.userAgent, 255),
          ip: clip(meta.ip, 45),
        },
      });
      if (result.count !== 1) {
        throw new UnauthorizedException();
      }
      return { userId: current.userId, sessionId: current.id, refreshToken: newToken };
    }

    // Not a current token. If it is a *previous* one, somebody is replaying it.
    const replayed = await db.session.findFirst({
      where: { previousTokenHash: presentedHash },
      select: { id: true, userId: true, rotatedAt: true, revokedAt: true },
    });
    if (replayed && !replayed.revokedAt) {
      const withinGrace =
        replayed.rotatedAt !== null &&
        now.getTime() - replayed.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
      if (!withinGrace) {
        await this.revoke(replayed.id, 'token_reuse');
        await this.audit.record({
          actorUserId: replayed.userId,
          action: 'auth.session_reuse_detected',
          entityType: 'session',
          entityId: replayed.id,
          ip: meta.ip ?? null,
        });
      }
    }
    throw new UnauthorizedException();
  }

  /** Revokes the session that owns this refresh token; returns its id, if any. */
  async revokeByRefreshToken(refreshToken: string, reason: string): Promise<string | null> {
    const session = await this.prisma.client.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      select: { id: true },
    });
    if (!session) {
      return null;
    }
    await this.revoke(session.id, reason);
    return session.id;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    this.revocation.add(sessionId);
  }

  /** Ends every session of a user, optionally keeping one (the current one). */
  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const revoked = await this.prisma.client.session.updateManyAndReturn({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
      select: { id: true },
    });
    for (const session of revoked) {
      this.revocation.add(session.id);
    }
    return revoked.length;
  }
}
