import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsString, Max, Min, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

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
}

const ENV_KEYS = ['PORT', 'NODE_ENV', 'CORS_ORIGIN'] as const;

/**
 * Validates the process environment at startup. The app refuses to boot on
 * invalid values instead of failing later at runtime.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const picked: Record<string, unknown> = {};
  for (const key of ENV_KEYS) {
    if (config[key] !== undefined) {
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

  return validated;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
