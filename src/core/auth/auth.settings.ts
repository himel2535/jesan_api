import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { EnvironmentVariables, NodeEnv, parseCorsOrigins } from '../config/env.validation';

/** Auth-related configuration read once from the validated environment. */
@Injectable()
export class AuthSettings {
  readonly jwtSecret: string;
  readonly cookieDomain: string | undefined;
  readonly secureCookies: boolean;
  readonly allowedOrigins: string[];
  readonly loginRateLimit: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    if (secret) {
      this.jwtSecret = secret;
    } else {
      // Production refuses to start without a secret (see validateEnv).
      this.jwtSecret = randomBytes(48).toString('hex');
      new Logger(AuthSettings.name).warn(
        'JWT_ACCESS_SECRET is not set: using a temporary secret, sign-ins end when the app restarts',
      );
    }
    this.cookieDomain = config.get('COOKIE_DOMAIN', { infer: true });
    this.secureCookies = config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
    this.allowedOrigins = parseCorsOrigins(config.get('CORS_ORIGIN', { infer: true }));
    this.loginRateLimit = config.get('LOGIN_RATE_LIMIT', { infer: true });
  }
}
