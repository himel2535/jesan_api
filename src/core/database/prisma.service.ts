import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { EnvironmentVariables } from '../config/env.validation';
import { assertTenantScoped, isTenantModel, scopeTenantArgs } from './tenant-scope';

const POOL_MAX_CONNECTIONS = 10;
const POOL_CONNECTION_TIMEOUT_MS = 5000;
const SCOPED_CLIENT_CACHE_SIZE = 1000;

/**
 * Owns the single PrismaClient (and its connection pool) for the app.
 * The database is optional outside production, so the client only exists
 * when DATABASE_URL is set. It connects lazily on the first query.
 *
 * `client` refuses unscoped queries on business data; use `forBusiness(id)`
 * for those (see tenant-scope.ts).
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly raw: PrismaClient | null;
  private readonly guarded: PrismaClient | null;
  private readonly scoped = new Map<string, PrismaClient>();

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const url = config.get('DATABASE_URL', { infer: true });
    this.raw = url
      ? new PrismaClient({
          adapter: new PrismaPg({
            connectionString: url,
            max: POOL_MAX_CONNECTIONS,
            connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
          }),
        })
      : null;
    // A query-only extension keeps the client's API, so the cast is safe.
    this.guarded = this.raw
      ? (this.raw.$extends({
          name: 'tenant-guard',
          query: {
            $allModels: {
              $allOperations({ model, operation, args, query }) {
                if (isTenantModel(model)) {
                  assertTenantScoped(model, operation, args);
                }
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient)
      : null;
  }

  get isConfigured(): boolean {
    return this.raw !== null;
  }

  /**
   * The Prisma client for platform tables. Throws a 503 when DATABASE_URL is
   * not configured. Business data queries without a businessId are refused.
   */
  get client(): PrismaClient {
    if (!this.guarded) {
      throw new ServiceUnavailableException('Database is not configured: set DATABASE_URL');
    }
    return this.guarded;
  }

  /**
   * A client limited to one business: every query on business data gets this
   * businessId added, and a query naming another business is refused.
   * Pass the id from the request's BusinessAccess (set by BusinessAccessGuard).
   */
  forBusiness(businessId: string): PrismaClient {
    if (!this.raw) {
      throw new ServiceUnavailableException('Database is not configured: set DATABASE_URL');
    }
    const cached = this.scoped.get(businessId);
    if (cached) {
      return cached;
    }
    const client = this.raw.$extends({
      name: 'tenant-scope',
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            if (!isTenantModel(model)) {
              return query(args);
            }
            const scopedArgs = scopeTenantArgs(businessId, model, operation, args);
            assertTenantScoped(model, operation, scopedArgs);
            return query(scopedArgs);
          },
        },
      },
    }) as unknown as PrismaClient;

    if (this.scoped.size >= SCOPED_CLIENT_CACHE_SIZE) {
      const oldest = this.scoped.keys().next();
      if (!oldest.done) {
        this.scoped.delete(oldest.value);
      }
    }
    this.scoped.set(businessId, client);
    return client;
  }

  /** True when a trivial query succeeds within the timeout. Never throws. */
  async isReachable(timeoutMs: number): Promise<boolean> {
    if (!this.raw) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    const query = this.raw.$queryRaw`SELECT 1`.then(
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
    await this.raw?.$disconnect();
  }
}
