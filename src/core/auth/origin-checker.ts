import { Injectable } from '@nestjs/common';
import { forbidden } from '../errors';
import { Request } from 'express';
import { AuthSettings } from './auth.settings';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense for cookie-based sign-in: a state-changing request whose Origin
 * header names a site we do not trust is refused. Requests without an Origin
 * header (curl, server-to-server) are not browser cross-site requests.
 */
@Injectable()
export class OriginChecker {
  constructor(private readonly settings: AuthSettings) {}

  assertAllowed(request: Request): void {
    if (SAFE_METHODS.has(request.method)) {
      return;
    }
    const origin = request.get('origin');
    if (origin !== undefined && !this.settings.allowedOrigins.includes(origin)) {
      throw forbidden('ORIGIN_NOT_ALLOWED', 'Origin not allowed');
    }
  }
}
