import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { EnvironmentVariables } from '../config/env.validation';

const POOL_MAX_CONNECTIONS = 10;
const POOL_CONNECTION_TIMEOUT_MS = 5000;

/**
 * Owns the single PrismaClient (and its connection pool) for the app.
 * The database is optional outside production, so the client only exists
 * when DATABASE_URL is set. It connects lazily on the first query.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly prisma: PrismaClient | null;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const url = config.get('DATABASE_URL', { infer: true });
    this.prisma = url
      ? new PrismaClient({
          adapter: new PrismaPg({
            connectionString: url,
            max: POOL_MAX_CONNECTIONS,
            connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
          }),
        })
      : null;
  }

  get isConfigured(): boolean {
    return this.prisma !== null;
  }

  /** The Prisma client. Throws when DATABASE_URL is not configured. */
  get client(): PrismaClient {
    if (!this.prisma) {
      throw new Error('Database is not configured: set DATABASE_URL');
    }
    return this.prisma;
  }

  /** True when a trivial query succeeds within the timeout. Never throws. */
  async isReachable(timeoutMs: number): Promise<boolean> {
    if (!this.prisma) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    const query = this.prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma?.$disconnect();
  }
}
