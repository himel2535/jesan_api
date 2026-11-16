import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { TEST_PASSWORD, TestApp, TestData, createTestApp, login, runSeed } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '3';
});

describe.skipIf(!hasDatabase)('login rate limit', () => {
  let t: TestApp;
  let data: TestData;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  it('answers 429 once one address makes more sign-in attempts than allowed per minute', async () => {
    const user = await data.createUser();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await login(t.server, user.email ?? '', TEST_PASSWORD)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});
