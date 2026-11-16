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
}

const OPTIONAL_URL_KEYS = new Set<string>(['DATABASE_URL', 'DIRECT_URL']);
const ENV_KEYS = ['PORT', 'NODE_ENV', 'CORS_ORIGIN', 'DATABASE_URL', 'DIRECT_URL'] as const;

/**
 * Validates the process environment at startup. The app refuses to boot on
 * invalid values instead of failing later at runtime.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const picked: Record<string, unknown> = {};
  for (const key of ENV_KEYS) {
    // An empty URL (e.g. `DATABASE_URL=` in .env) counts as not set.
    const isEmptyUrl = OPTIONAL_URL_KEYS.has(key) && config[key] === '';
    if (config[key] !== undefined && !isEmptyUrl) {
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

  if (validated.NODE_ENV === NodeEnv.Production && !validated.DATABASE_URL) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required in production');
  }

  return validated;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
