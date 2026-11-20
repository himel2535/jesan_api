import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordService } from '../src/core/auth/password.service';
import { PrismaService } from '../src/core/database/prisma.service';
import { AccessResolver } from '../src/core/permissions/access-resolver.service';
import { PermissionRegistry } from '../src/core/permissions/permission-registry';
import { PermissionSyncService } from '../src/core/permissions/permission-sync.service';
import { databaseUrl } from './database';

const run = promisify(execFile);

/** A fresh random password for each test run; nothing secret is hard-coded. */
export const TEST_PASSWORD = randomBytes(12).toString('base64url');

export interface TestApp {
  app: INestApplication<App>;
  server: App;
  prisma: PrismaService;
  passwords: PasswordService;
  resolver: AccessResolver;
  registry: PermissionRegistry;
  sync: PermissionSyncService;
}

/** Boots the real app (all guards, cookies, CORS) against the test database. */
export async function createTestApp(controllers: Type[] = []): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers,
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return {
    app,
    server: app.getHttpServer(),
    prisma: app.get(PrismaService),
    passwords: app.get(PasswordService),
    resolver: app.get(AccessResolver),
    registry: app.get(PermissionRegistry),
    sync: app.get(PermissionSyncService),
  };
}

/** Roles and the first business come from the seed; it is safe to run repeatedly. */
export async function runSeed(): Promise<void> {
  await run('node', ['prisma/seed.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: '' },
  });
}

export function uniqueTag(): string {
  return randomBytes(4).toString('hex');
}

export type Cookies = Record<string, string>;

/** Reads the cookies a response sets (an empty value means "cleared"). */
export function cookiesOf(response: request.Response): Cookies {
  const cookies: Cookies = {};
  for (const line of response.get('Set-Cookie') ?? []) {
    const pair = line.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    cookies[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return cookies;
}

export function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export interface Session {
  status: number;
  body: unknown;
  cookies: Cookies;
}

export async function login(server: App, identifier: string, password: string): Promise<Session> {
  const response = await request(server).post('/api/v1/auth/login').send({ identifier, password });
  return { status: response.status, body: response.body, cookies: cookiesOf(response) };
}

/** GET with a signed-in session's cookies. */
export function get(server: App, path: string, cookies: Cookies): request.Test {
  return request(server).get(`/api/v1${path}`).set('Cookie', cookieHeader(cookies));
}

export function send(
  server: App,
  method: 'post' | 'put' | 'patch' | 'delete',
  path: string,
  cookies: Cookies,
  body?: object,
): request.Test {
  const call = request(server)[method](`/api/v1${path}`).set('Cookie', cookieHeader(cookies));
  return body ? call.send(body) : call;
}

/** Creates test data and removes exactly that data afterwards, in foreign-key order. */
export class TestData {
  readonly userIds: string[] = [];
  readonly businessIds: string[] = [];
  readonly tag = uniqueTag();

  constructor(private readonly t: TestApp) {}

  async createUser(
    options: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      password?: string;
      isPlatformOwner?: boolean;
      isActive?: boolean;
    } = {},
  ): Promise<{ id: string; email: string | null; phone: string | null; password: string }> {
    const password = options.password ?? TEST_PASSWORD;
    const email = options.email === undefined ? `u-${uniqueTag()}@example.test` : options.email;
    const phone = options.phone ?? null;
    const user = await this.t.prisma.client.user.create({
      data: {
        name: options.name ?? 'Test User',
        email,
        phone,
        passwordHash: await this.t.passwords.hash(password),
        isPlatformOwner: options.isPlatformOwner ?? false,
        isActive: options.isActive ?? true,
      },
      select: { id: true },
    });
    this.userIds.push(user.id);
    return { id: user.id, email, phone, password };
  }

  /** A dealership business (sold in bags by default) with the default permission grants. */
  async createBusiness(
    label: string,
    config: object = {
      units: [{ key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 }],
      defaultUnit: 'bag',
      principalSupplier: { nameEn: 'Principal Co', nameBn: 'প্রধান কোম্পানি' },
    },
  ): Promise<{ id: string; slug: string }> {
    const slug = `${label}-${this.tag}-${uniqueTag()}`;
    const business = await this.t.prisma.client.business.create({
      data: { slug, nameEn: `Shop ${label}`, nameBn: `দোকান ${label}`, type: 'dealership', config },
      select: { id: true },
    });
    this.businessIds.push(business.id);
    await this.t.sync.applyDefaultsToBusiness(business.id);
    return { id: business.id, slug };
  }

  async giveAccess(userId: string, businessId: string, roleKey: string): Promise<void> {
    const role = await this.t.prisma.client.role.findUniqueOrThrow({
      where: { key: roleKey },
      select: { id: true },
    });
    await this.t.prisma.client.userBusinessAccess.create({
      data: { userId, businessId, roleId: role.id },
    });
    this.t.resolver.clear();
  }

  async cleanup(): Promise<void> {
    const db = this.t.prisma.client;
    const userIds = this.userIds;
    const businessIds = this.businessIds;
    await db.auditLog.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { businessId: { in: businessIds } },
          { entityId: { in: userIds } },
        ],
      },
    });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    // Business data is removed with raw SQL on purpose: the Prisma client refuses
    // business-data queries that are not limited to one business.
    // The stock ledger is append-only: only a purge inside a transaction may delete.
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL jesan.allow_purge = 'on'`),
      db.$executeRawUnsafe(
        'DELETE FROM stock_movements WHERE business_id = ANY($1::uuid[])',
        businessIds,
      ),
      db.$executeRawUnsafe(
        'DELETE FROM customer_ledger_entries WHERE business_id = ANY($1::uuid[])',
        businessIds,
      ),
    ]);
    for (const table of [
      'change_requests',
      'business_ledger_entries',
      'commission_receipts',
      'commission_entries',
      'commission_schemes',
      'expenses',
      'expense_categories',
      'collections',
      'delivery_items',
      'deliveries',
      'sales_order_items',
      'sales_orders',
      'purchase_items',
      'purchases',
      'monthly_purchase_counters',
      'products',
      'product_categories',
      'customers',
      'suppliers',
      'document_counters',
    ]) {
      await db.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE business_id = ANY($1::uuid[])`,
        businessIds,
      );
    }
    await db.rolePermission.deleteMany({ where: { businessId: { in: businessIds } } });
    await db.userBusinessAccess.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { businessId: { in: businessIds } }] },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.business.deleteMany({ where: { id: { in: businessIds } } });
  }
}
