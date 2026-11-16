import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from './prisma.service';

// A stub instead of the real ConfigService, which would fall back to process.env.
function serviceFor(databaseUrl: string | undefined): PrismaService {
  const config = { get: () => databaseUrl } as unknown as ConfigService<EnvironmentVariables, true>;
  return new PrismaService(config);
}

describe('PrismaService', () => {
  it('is not configured without DATABASE_URL and refuses to hand out a client', async () => {
    const service = serviceFor(undefined);
    expect(service.isConfigured).toBe(false);
    expect(() => service.client).toThrow('DATABASE_URL');
    expect(await service.isReachable(100)).toBe(false);
    await service.onModuleDestroy();
  });

  it('reports an unreachable database as not reachable instead of throwing', async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused.
    const service = serviceFor('postgresql://nobody:nothing@127.0.0.1:1/none');
    expect(service.isConfigured).toBe(true);
    expect(await service.isReachable(2000)).toBe(false);
    await service.onModuleDestroy();
  });
});
