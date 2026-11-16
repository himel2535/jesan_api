import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvironmentVariables } from '../src/core/config/env.validation';
import { PrismaService } from '../src/core/database/prisma.service';
import { databaseUrl, hasDatabase } from './database';

const run = promisify(execFile);

/** Runs the seed script against the test database. */
async function seed(): Promise<void> {
  await run('node', ['prisma/seed.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: '' },
  });
}

// Requires migrations to be applied first (`npm run db:deploy`).
describe.skipIf(!hasDatabase)('core database tables', () => {
  let service: PrismaService;
  const tag = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  beforeAll(() => {
    const config = { get: () => databaseUrl } as unknown as ConfigService<
      EnvironmentVariables,
      true
    >;
    service = new PrismaService(config);
  });

  afterAll(async () => {
    const db = service.client;
    await db.userBusinessAccess.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await service.onModuleDestroy();
  });

  async function createUser(data: { email?: string; phone?: string }): Promise<string> {
    const user = await service.client.user.create({
      data: { name: 'Test User', passwordHash: 'not-a-real-hash', ...data },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  it('answers the reachability check', async () => {
    expect(await service.isReachable(2000)).toBe(true);
  });

  it('seeds the default roles and first business, and is idempotent', async () => {
    await seed();
    const db = service.client;
    const [rolesBefore, businessesBefore, usersBefore] = await Promise.all([
      db.role.count(),
      db.business.count(),
      db.user.count(),
    ]);
    await seed();
    const [roles, businessesAfter, business, usersAfter] = await Promise.all([
      db.role.findMany({ orderBy: { sortOrder: 'asc' }, select: { key: true, isSystem: true } }),
      db.business.count(),
      db.business.findUnique({ where: { slug: 'akij-cement' } }),
      db.user.count(),
    ]);

    expect(roles.length).toBe(rolesBefore);
    expect(businessesAfter).toBe(businessesBefore);
    expect(roles.map((role) => role.key)).toEqual(['owner', 'manager', 'accountant', 'salesman']);
    expect(roles.every((role) => role.isSystem)).toBe(true);
    expect(business).toMatchObject({
      nameEn: 'Akij Cement',
      nameBn: 'আকিজ সিমেন্ট',
      type: 'dealership',
      isActive: true,
    });
    // The seed never creates users or passwords.
    expect(usersAfter).toBe(usersBefore);
  });

  it('generates time-ordered UUID v7 ids', async () => {
    const id = await createUser({ email: `uuid-${tag}@example.test` });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('accepts a user with only an email or only a phone', async () => {
    await createUser({ email: `only-email-${tag}@example.test` });
    await createUser({ phone: `+8801${tag}` });
  });

  it('rejects a user with neither email nor phone', async () => {
    await expect(createUser({})).rejects.toThrow(/users_email_or_phone_check/);
  });

  it('rejects an email that is not lowercase', async () => {
    await expect(createUser({ email: `Mixed-${tag}@Example.test` })).rejects.toThrow(
      /users_email_lowercase_check/,
    );
  });

  it('rejects duplicate emails and duplicate phones', async () => {
    const email = `dup-${tag}@example.test`;
    const phone = `+8809${tag}`;
    await createUser({ email, phone });
    await expect(createUser({ email })).rejects.toThrow(/[Uu]nique/);
    await expect(createUser({ phone })).rejects.toThrow(/[Uu]nique/);
  });

  it('allows one role per user per business and blocks deleting referenced rows', async () => {
    await seed();
    const db = service.client;
    const [userId, business, owner, manager] = await Promise.all([
      createUser({ email: `access-${tag}@example.test` }),
      db.business.findUniqueOrThrow({ where: { slug: 'akij-cement' }, select: { id: true } }),
      db.role.findUniqueOrThrow({ where: { key: 'owner' }, select: { id: true } }),
      db.role.findUniqueOrThrow({ where: { key: 'manager' }, select: { id: true } }),
    ]);

    await db.userBusinessAccess.create({
      data: { userId, businessId: business.id, roleId: owner.id },
    });
    await expect(
      db.userBusinessAccess.create({
        data: { userId, businessId: business.id, roleId: manager.id },
      }),
    ).rejects.toThrow(/[Uu]nique/);

    // ON DELETE RESTRICT: nothing that is still referenced can be deleted.
    await expect(db.user.delete({ where: { id: userId } })).rejects.toThrow();
    await expect(db.role.delete({ where: { id: owner.id } })).rejects.toThrow();
    await expect(db.business.delete({ where: { id: business.id } })).rejects.toThrow();
  });
});
