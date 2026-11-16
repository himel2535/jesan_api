import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, parseCorsOrigins } from './core/config/env.validation';

/**
 * Global HTTP configuration, shared by main.ts and the e2e tests so that
 * tests exercise the same prefix, versioning, validation and CORS as production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({ origin: parseCorsOrigins(config.get('CORS_ORIGIN', { infer: true })) });
}
