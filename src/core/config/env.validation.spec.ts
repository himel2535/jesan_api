import { describe, expect, it } from 'vitest';
import { NodeEnv, parseCorsOrigins, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(validateEnv({})).toEqual({
      PORT: 4000,
      NODE_ENV: NodeEnv.Development,
      CORS_ORIGIN: 'http://localhost:3000',
      TRUST_PROXY: 0,
      LOGIN_RATE_LIMIT: 10,
    });
  });

  it('converts and accepts valid values, ignoring unrelated variables', () => {
    const env = validateEnv({
      PORT: '5000',
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 's'.repeat(32),
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      PORT: 5000,
      NODE_ENV: NodeEnv.Production,
      CORS_ORIGIN: 'https://example.com',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 's'.repeat(32),
      TRUST_PROXY: 0,
      LOGIN_RATE_LIMIT: 10,
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
    expect(
      validateEnv({ NODE_ENV: 'production', DATABASE_URL: url, JWT_ACCESS_SECRET: 's'.repeat(32) })
        .DATABASE_URL,
    ).toBe(url);
  });

  it('rejects a non-postgres URL without echoing its value', () => {
    const secret = 'mysql://user:top-secret@host/db';
    expect(() => validateEnv({ DATABASE_URL: secret })).toThrow('DATABASE_URL must be');
    expect(() => validateEnv({ DATABASE_URL: secret })).not.toThrow('top-secret');
  });
});

describe('validateEnv: sign-in settings', () => {
  const url = 'postgresql://user:pass@localhost:5432/db';
  const secret = 'a-long-enough-secret-for-signing-tokens';

  it('does not need a signing secret outside production', () => {
    expect(validateEnv({ NODE_ENV: 'development' }).JWT_ACCESS_SECRET).toBeUndefined();
    expect(validateEnv({ JWT_ACCESS_SECRET: '' }).JWT_ACCESS_SECRET).toBeUndefined();
  });

  it('requires a signing secret in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production', DATABASE_URL: url })).toThrow(
      'JWT_ACCESS_SECRET is required',
    );
    expect(
      validateEnv({ NODE_ENV: 'production', DATABASE_URL: url, JWT_ACCESS_SECRET: secret })
        .JWT_ACCESS_SECRET,
    ).toBe(secret);
  });

  it('rejects a short secret without echoing it', () => {
    const short = 'too-short-secret';
    expect(() => validateEnv({ JWT_ACCESS_SECRET: short })).toThrow('at least 32 characters');
    expect(() => validateEnv({ JWT_ACCESS_SECRET: short })).not.toThrow(short);
  });

  it('reads the cookie domain, proxy count and login limit', () => {
    const env = validateEnv({
      COOKIE_DOMAIN: 'example.com',
      TRUST_PROXY: '1',
      LOGIN_RATE_LIMIT: '5',
    });
    expect(env.COOKIE_DOMAIN).toBe('example.com');
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.LOGIN_RATE_LIMIT).toBe(5);
  });

  it.each([
    { COOKIE_DOMAIN: 'https://example.com' },
    { TRUST_PROXY: '-1' },
    { TRUST_PROXY: 'many' },
    { LOGIN_RATE_LIMIT: '0' },
  ])('rejects %j', (input) => {
    expect(() => validateEnv(input)).toThrow('Invalid environment configuration');
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
