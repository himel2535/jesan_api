import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { REVOCATION_TTL_MS } from './auth.constants';

/**
 * Sessions revoked in the last few minutes. An access token stays valid until it
 * expires, so this makes logout and "revoke everything" take effect at once
 * without a database lookup on every request. Rebuilt from the database on start.
 */
@Injectable()
export class RevocationList implements OnModuleInit {
  private readonly logger = new Logger(RevocationList.name);
  private readonly revoked = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (!this.prisma.isConfigured) {
      return;
    }
    try {
      const rows = await this.prisma.client.session.findMany({
        where: { revokedAt: { gte: new Date(Date.now() - REVOCATION_TTL_MS) } },
        select: { id: true },
      });
      for (const row of rows) {
        this.add(row.id);
      }
    } catch (error) {
      this.logger.error(
        'Could not load recently revoked sessions',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  add(sessionId: string): void {
    this.purge();
    this.revoked.set(sessionId, Date.now() + REVOCATION_TTL_MS);
  }

  has(sessionId: string): boolean {
    const expiresAt = this.revoked.get(sessionId);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private purge(): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.revoked) {
      if (expiresAt <= now) {
        this.revoked.delete(sessionId);
      }
    }
  }
}
