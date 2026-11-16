import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface HealthResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  database: 'up' | 'down' | 'not_configured';
}

const DATABASE_CHECK_TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness: the process is up. No I/O, so it is always fast and the host
   * never restarts the app because a dependency is slow.
   */
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: can the app reach its database? 503 when it cannot. */
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    if (!this.prisma.isConfigured) {
      return { status: 'ok', database: 'not_configured' };
    }
    if (await this.prisma.isReachable(DATABASE_CHECK_TIMEOUT_MS)) {
      return { status: 'ok', database: 'up' };
    }
    const body: ReadinessResponse = { status: 'error', database: 'down' };
    throw new ServiceUnavailableException(body);
  }
}
