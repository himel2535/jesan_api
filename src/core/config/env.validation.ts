import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MinLength,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;

export class EnvironmentVariables {
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  /** Comma-separated list of allowed origins. */
  @IsString()
  @IsNotEmpty()
  CORS_ORIGIN: string = 'http://localhost:3000';

  /** Pooled connection used by the running app. Required in production. */
  @IsOptional()
  @Matches(POSTGRES_URL_PATTERN, { message: 'DATABASE_URL must be a postgresql:// URL' })
  DATABASE_URL?: string;

  /** Direct (non-pooled) connection used only by the Prisma CLI for migrations. */
  @IsOptional()
  @Matches(POSTGRES_URL_PATTERN, { message: 'DIRECT_URL must be a postgresql:// URL' })
  DIRECT_URL?: string;

  /**
   * Secret that signs access tokens (at least 32 characters). Required in
   * production. Elsewhere a random one is generated at startup, so sign-ins
   * do not survive a restart.
   */
  @IsOptional()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET?: string;

  /** Cookie domain, e.g. `example.com` so `app.` and `api.` subdomains share it. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9.-]+$/, {
    message: 'COOKIE_DOMAIN must be a bare domain such as example.com',
  })
  COOKIE_DOMAIN?: string;

  /** Number of reverse proxies in front of the API, so the real client IP is used. */
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY: number = 0;

  /** Sign-in attempts allowed per IP address per minute. */
  @IsInt()
  @Min(1)
  @Max(100000)
  LOGIN_RATE_LIMIT: number = 10;
}

/** Keys where an empty value (e.g. `DATABASE_URL=` in .env) counts as not set. */
const OPTIONAL_KEYS = new Set<string>([
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_ACCESS_SECRET',
  'COOKIE_DOMAIN',
  'TRUST_PROXY',
  'LOGIN_RATE_LIMIT',
]);
const ENV_KEYS = [
  'PORT',
  'NODE_ENV',
  'CORS_ORIGIN',
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_ACCESS_SECRET',
  'COOKIE_DOMAIN',
  'TRUST_PROXY',
  'LOGIN_RATE_LIMIT',
] as const;

/**
 * Validates the process environment at startup. The app refuses to boot on
 * invalid values instead of failing later at runtime.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const picked: Record<string, unknown> = {};
  for (const key of ENV_KEYS) {
    const isEmptyOptional = OPTIONAL_KEYS.has(key) && config[key] === '';
    if (config[key] !== undefined && !isEmptyOptional) {
      picked[key] = config[key];
    }
  }

  const validated = plainToInstance(EnvironmentVariables, picked, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  if (validated.NODE_ENV === NodeEnv.Production) {
    if (!validated.DATABASE_URL) {
      throw new Error('Invalid environment configuration: DATABASE_URL is required in production');
    }
    if (!validated.JWT_ACCESS_SECRET) {
      throw new Error(
        'Invalid environment configuration: JWT_ACCESS_SECRET is required in production',
      );
    }
  }

  return validated;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
