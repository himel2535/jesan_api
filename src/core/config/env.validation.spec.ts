import { describe, expect, it } from 'vitest';
import { NodeEnv, parseCorsOrigins, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(validateEnv({})).toEqual({
      PORT: 4000,
      NODE_ENV: NodeEnv.Development,
      CORS_ORIGIN: 'http://localhost:3000',
    });
  });

  it('converts and accepts valid values, ignoring unrelated variables', () => {
    const env = validateEnv({
      PORT: '5000',
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      PORT: 5000,
      NODE_ENV: NodeEnv.Production,
      CORS_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    });
  });

  it.each([
    ['PORT', { PORT: 'abc' }],
    ['PORT', { PORT: '0' }],
    ['PORT', { PORT: '70000' }],
    ['NODE_ENV', { NODE_ENV: 'staging' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: '' }],
  ])('rejects an invalid %s', (name, input) => {
    expect(() => validateEnv(input)).toThrow(name);
  });
});

describe('validateEnv: database URLs', () => {
  const url = 'postgresql://user:pass@localhost:5432/db';

  it('leaves the database optional outside production', () => {
    expect(validateEnv({ NODE_ENV: 'development' }).DATABASE_URL).toBeUndefined();
    expect(validateEnv({ NODE_ENV: 'test', DATABASE_URL: '' }).DATABASE_URL).toBeUndefined();
  });

  it('accepts postgresql URLs', () => {
    const env = validateEnv({ DATABASE_URL: url, DIRECT_URL: url });
    expect(env.DATABASE_URL).toBe(url);
    expect(env.DIRECT_URL).toBe(url);
  });

  it('requires DATABASE_URL in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow('DATABASE_URL is required');
    expect(() => validateEnv({ NODE_ENV: 'production', DATABASE_URL: '' })).toThrow(
      'DATABASE_URL is required',
    );
    expect(validateEnv({ NODE_ENV: 'production', DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('rejects a non-postgres URL without echoing its value', () => {
    const secret = 'mysql://user:top-secret@host/db';
    expect(() => validateEnv({ DATABASE_URL: secret })).toThrow('DATABASE_URL must be');
    expect(() => validateEnv({ DATABASE_URL: secret })).not.toThrow('top-secret');
  });
});

describe('parseCorsOrigins', () => {
  it('splits a comma-separated list and trims blanks', () => {
    expect(parseCorsOrigins('http://a.test, http://b.test,')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });
});
