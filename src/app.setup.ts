import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { EnvironmentVariables, parseCorsOrigins } from './core/config/env.validation';

/**
 * Global HTTP configuration, shared by main.ts and the e2e tests so that
 * tests exercise the same prefix, versioning, validation and CORS as production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  if (trustProxy > 0) {
    // Behind a reverse proxy: use the real client IP (rate limiting, audit log).
    (app as NestExpressApplication).set('trust proxy', trustProxy);
  }

  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({
    origin: parseCorsOrigins(config.get('CORS_ORIGIN', { infer: true })),
    // Needed so the browser sends the sign-in cookies on cross-origin requests.
    credentials: true,
  });
}
