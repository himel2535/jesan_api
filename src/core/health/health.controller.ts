import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  /** Liveness check: no I/O, so it stays fast and never depends on other services. */
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
