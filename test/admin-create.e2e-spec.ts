import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl, hasDatabase } from './database';
import { TestApp, TestData, createTestApp, login, runSeed, uniqueTag } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

const exec = promisify(execFile);

interface Outcome {
  code: number;
  output: string;
}

/** Runs the one-time command with exactly the environment given. */
async function adminCreate(env: Record<string, string>): Promise<Outcome> {
  try {
    const { stdout, stderr } = await exec('node', ['prisma/admin-create.mjs'], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: databaseUrl ?? '', ...env },
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe.skipIf(!hasDatabase)('npm run admin:create', () => {
  let t: TestApp;
  let data: TestData;
  const password = randomBytes(12).toString('base64url');
  const email = `owner-${uniqueTag()}@example.test`;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
  });

  afterAll(async () => {
    const user = await t.prisma.client.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      data.userIds.push(user.id);
    }
    await data.cleanup();
    await t.app.close();
  });

  it('creates a platform owner who can sign in, without ever printing the password', async () => {
    const outcome = await adminCreate({
      ADMIN_EMAIL: email.toUpperCase(),
      ADMIN_PASSWORD: password,
      ADMIN_NAME: 'First Owner',
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain('Platform owner created');
    expect(outcome.output).not.toContain(password);

    const user = await t.prisma.client.user.findUniqueOrThrow({ where: { email } });
    expect(user.isPlatformOwner).toBe(true);
    expect(user.name).toBe('First Owner');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(password);
    expect((await login(t.server, email, password)).status).toBe(200);
  });

  it('can be run again safely and changes nothing', async () => {
    const before = await t.prisma.client.user.findUniqueOrThrow({ where: { email } });
    const outcome = await adminCreate({
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: `${password}-different`,
      ADMIN_NAME: 'Someone Else',
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain('already exists');

    const after = await t.prisma.client.user.findUniqueOrThrow({ where: { email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe('First Owner');
  });

  it('refuses a missing identifier or a short password and does not echo the password', async () => {
    const noIdentifier = await adminCreate({ ADMIN_PASSWORD: password });
    expect(noIdentifier.code).toBe(1);

    const short = await adminCreate({
      ADMIN_EMAIL: `short-${uniqueTag()}@example.test`,
      ADMIN_PASSWORD: 'tiny',
    });
    expect(short.code).toBe(1);
    expect(short.output).not.toContain('tiny');

    const noPassword = await adminCreate({ ADMIN_EMAIL: `none-${uniqueTag()}@example.test` });
    expect(noPassword.code).toBe(1);
  });
});
