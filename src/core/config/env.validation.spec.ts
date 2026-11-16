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
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      PORT: 5000,
      NODE_ENV: NodeEnv.Production,
      CORS_ORIGIN: 'https://example.com',
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

describe('parseCorsOrigins', () => {
  it('splits a comma-separated list and trims blanks', () => {
    expect(parseCorsOrigins('http://a.test, http://b.test,')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });
});
