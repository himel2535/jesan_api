import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import {
  TEST_PASSWORD,
  TestApp,
  TestData,
  cookieHeader,
  cookiesOf,
  createTestApp,
  get,
  login,
  runSeed,
  send,
  uniqueTag,
} from './helpers';

// Many sign-ins come from one address here; the rate limit has its own test file.
vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

const ALLOWED_ORIGIN = 'http://localhost:3000';

describe.skipIf(!hasDatabase)('auth', () => {
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

  const refreshWith = (refreshToken: string) =>
    request(t.server).post('/api/v1/auth/refresh').set('Cookie', `jesan_rt=${refreshToken}`);

  describe('login', () => {
    it('signs in with an email, ignoring case and spaces, and sets httpOnly cookies', async () => {
      const user = await data.createUser();
      const response = await request(t.server)
        .post('/api/v1/auth/login')
        .send({ identifier: ` ${user.email?.toUpperCase() ?? ''} `, password: user.password });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user: {
          id: user.id,
          name: 'Test User',
          email: user.email,
          phone: null,
          isPlatformOwner: false,
        },
      });

      const cookies = cookiesOf(response);
      expect(cookies['jesan_at']).toBeTruthy();
      expect(cookies['jesan_rt']).toBeTruthy();
      // Tokens travel in cookies only, never in the response body.
      expect(JSON.stringify(response.body)).not.toContain(cookies['jesan_at']);

      const lines = response.get('Set-Cookie') ?? [];
      const access = lines.find((line) => line.startsWith('jesan_at=')) ?? '';
      const refresh = lines.find((line) => line.startsWith('jesan_rt=')) ?? '';
      for (const line of [access, refresh]) {
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Lax');
      }
      expect(access).toContain('Path=/;');
      expect(refresh).toContain('Path=/api/v1/auth');
    });

    it('signs in with a phone number written either way', async () => {
      const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const user = await data.createUser({ email: null, phone: `+8801${digits}` });
      const local = await login(t.server, `01${digits}`, user.password);
      const international = await login(t.server, `+8801${digits}`, user.password);
      expect(local.status).toBe(200);
      expect(international.status).toBe(200);
    });

    it('gives the same answer for an unknown user, a wrong password, an inactive user and a bad phone', async () => {
      const real = await data.createUser();
      const inactive = await data.createUser({ isActive: false });
      const attempts = await Promise.all([
        login(t.server, `nobody-${uniqueTag()}@example.test`, TEST_PASSWORD),
        login(t.server, real.email ?? '', 'not-the-password-123'),
        login(t.server, inactive.email ?? '', inactive.password),
        login(t.server, 'not a phone number', TEST_PASSWORD),
      ]);
      for (const attempt of attempts) {
        expect(attempt.status).toBe(401);
        expect(attempt.body).toEqual(attempts[0].body);
        expect(attempt.cookies).toEqual({});
      }
      expect(attempts[0].body).toMatchObject({ message: 'Invalid credentials' });
    });

    it('rejects a malformed request body', async () => {
      await request(t.server)
        .post('/api/v1/auth/login')
        .send({ identifier: 'a@b.test' })
        .expect(400);
      await request(t.server)
        .post('/api/v1/auth/login')
        .send({ identifier: 'a@b.test', password: 'x', extra: 1 })
        .expect(400);
    });

    it('locks the account after five wrong passwords, with the same answer, then unlocks', async () => {
      const user = await data.createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await login(t.server, user.email ?? '', 'wrong-password-123');
        expect(failed.status).toBe(401);
      }

      const stored = await t.prisma.client.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { lockedUntil: true },
      });
      expect(stored.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

      // Even the right password is refused while locked, and nothing tells the caller why.
      const locked = await login(t.server, user.email ?? '', user.password);
      expect(locked.status).toBe(401);
      expect(locked.body).toMatchObject({ message: 'Invalid credentials' });

      const audit = await t.prisma.client.auditLog.count({
        where: { actorUserId: user.id, action: 'auth.account_locked' },
      });
      expect(audit).toBe(1);

      await t.prisma.client.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect((await login(t.server, user.email ?? '', user.password)).status).toBe(200);
    });

    it('resets the failure counter and records the sign-in time on success', async () => {
      const user = await data.createUser();
      await login(t.server, user.email ?? '', 'wrong-password-123');
      await login(t.server, user.email ?? '', user.password);
      const stored = await t.prisma.client.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { failedLoginCount: true, lastLoginAt: true },
      });
      expect(stored.failedLoginCount).toBe(0);
      expect(stored.lastLoginAt).not.toBeNull();
    });
  });

  describe('access token', () => {
    it('is required, and accepted from a cookie or a Bearer header', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);

      await request(t.server).get('/api/v1/auth/me').expect(401);
      await get(t.server, '/auth/me', session.cookies).expect(200);
      await request(t.server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${session.cookies['jesan_at'] ?? ''}`)
        .expect(200);
    });

    it('is refused when expired, tampered with, or unsigned', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);
      const jwt = t.app.get(JwtService, { strict: false });
      const sessionRow = await t.prisma.client.session.findFirstOrThrow({
        where: { userId: user.id },
        select: { id: true },
      });

      const expired = jwt.sign({ sub: user.id, sid: sessionRow.id }, { expiresIn: -10 });
      const tampered = `${session.cookies['jesan_at'] ?? ''}x`;
      const unsigned = [
        Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
        Buffer.from(JSON.stringify({ sub: user.id, sid: sessionRow.id })).toString('base64url'),
        '',
      ].join('.');

      for (const token of [expired, tampered, unsigned, 'garbage']) {
        await request(t.server)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      }
    });

    it('does not say what the signed-in user can reach beyond their own businesses', async () => {
      const user = await data.createUser();
      const business = await data.createBusiness('me');
      await data.giveAccess(user.id, business.id, 'salesman');
      const session = await login(t.server, user.email ?? '', user.password);

      const response = await get(t.server, '/auth/me', session.cookies).expect(200);
      const body = response.body as {
        user: { id: string };
        businesses: { slug: string; role: { key: string }; permissions: string[] }[];
      };
      expect(body.user.id).toBe(user.id);
      expect(body.businesses.map((entry) => entry.slug)).toEqual([business.slug]);
      expect(body.businesses[0]?.role.key).toBe('salesman');
      expect(body.businesses[0]?.permissions).toContain('sale.create');
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });
  });

  describe('refresh token rotation', () => {
    it('issues new tokens and stops the old refresh token from working', async () => {
      const user = await data.createUser();
      const first = await login(t.server, user.email ?? '', user.password);
      const oldRefresh = first.cookies['jesan_rt'] ?? '';

      const rotated = await refreshWith(oldRefresh).expect(200);
      const second = cookiesOf(rotated);
      expect(second['jesan_rt']).toBeTruthy();
      expect(second['jesan_rt']).not.toBe(oldRefresh);
      await get(t.server, '/auth/me', second).expect(200);

      await refreshWith(oldRefresh).expect(401);
      // Only the hash is stored, never the token itself.
      const stored = await t.prisma.client.session.findFirstOrThrow({
        where: { userId: user.id },
        select: { refreshTokenHash: true },
      });
      expect(stored.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.refreshTokenHash).not.toBe(second['jesan_rt']);
    });

    it('needs the refresh cookie', async () => {
      await request(t.server).post('/api/v1/auth/refresh').expect(401);
      await refreshWith('not-a-real-token').expect(401);
    });

    it('treats a replayed old token as theft: the whole session is revoked', async () => {
      const user = await data.createUser();
      const first = await login(t.server, user.email ?? '', user.password);
      const stolen = first.cookies['jesan_rt'] ?? '';
      const rotated = cookiesOf(await refreshWith(stolen).expect(200));

      // Outside the short grace window, the old token coming back means it was copied.
      await t.prisma.client.session.updateMany({
        where: { userId: user.id },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
      await refreshWith(stolen).expect(401);

      // The legitimate holder is signed out too, at once, access token included.
      await refreshWith(rotated['jesan_rt'] ?? '').expect(401);
      await get(t.server, '/auth/me', first.cookies).expect(401);
      await get(t.server, '/auth/me', rotated).expect(401);

      const session = await t.prisma.client.session.findFirstOrThrow({
        where: { userId: user.id },
        select: { revokedAt: true, revokedReason: true },
      });
      expect(session.revokedAt).not.toBeNull();
      expect(session.revokedReason).toBe('token_reuse');
      expect(
        await t.prisma.client.auditLog.count({
          where: { actorUserId: user.id, action: 'auth.session_reuse_detected' },
        }),
      ).toBe(1);
    });

    it('does not end the session when two tabs refresh at the same moment', async () => {
      const user = await data.createUser();
      const first = await login(t.server, user.email ?? '', user.password);
      const old = first.cookies['jesan_rt'] ?? '';
      const rotated = cookiesOf(await refreshWith(old).expect(200));

      await refreshWith(old).expect(401); // the slower tab loses the race
      await get(t.server, '/auth/me', rotated).expect(200); // the session lives on
    });
  });

  describe('logout', () => {
    it('ends the session at once and is safe to repeat', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);

      const response = await send(t.server, 'post', '/auth/logout', session.cookies).expect(204);
      expect(cookiesOf(response)['jesan_at']).toBe('');
      expect(cookiesOf(response)['jesan_rt']).toBe('');

      await get(t.server, '/auth/me', session.cookies).expect(401);
      await refreshWith(session.cookies['jesan_rt'] ?? '').expect(401);
      await send(t.server, 'post', '/auth/logout', session.cookies).expect(204);
      await request(t.server).post('/api/v1/auth/logout').expect(204);
    });

    it('also works with only a Bearer token', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);
      const bearer = `Bearer ${session.cookies['jesan_at'] ?? ''}`;
      await request(t.server).post('/api/v1/auth/logout').set('Authorization', bearer).expect(204);
      await request(t.server).get('/api/v1/auth/me').set('Authorization', bearer).expect(401);
    });
  });

  describe('browser protections', () => {
    it('refuses state-changing requests from an untrusted origin', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);
      const evil = 'https://evil.example';

      await request(t.server)
        .post('/api/v1/auth/login')
        .set('Origin', evil)
        .send({ identifier: user.email, password: user.password })
        .expect(403);
      await request(t.server)
        .post('/api/v1/auth/logout')
        .set('Origin', evil)
        .set('Cookie', cookieHeader(session.cookies))
        .expect(403);
      await request(t.server)
        .post('/api/v1/auth/change-password')
        .set('Origin', evil)
        .set('Cookie', cookieHeader(session.cookies))
        .send({ currentPassword: user.password, newPassword: `${user.password}-new` })
        .expect(403);

      // Reading is fine, and so is the real web app's origin.
      await get(t.server, '/auth/me', session.cookies).set('Origin', evil).expect(200);
      await request(t.server)
        .post('/api/v1/auth/logout')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader(session.cookies))
        .expect(204);
    });

    it('allows credentials only for the configured origin', async () => {
      const allowed = await request(t.server)
        .get('/api/v1/health')
        .set('Origin', ALLOWED_ORIGIN)
        .expect(200);
      expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const other = await request(t.server)
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sends security headers', async () => {
      const response = await request(t.server).get('/api/v1/health').expect(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('change password', () => {
    it('signs out the other devices, keeps this one, and switches to the new password', async () => {
      const user = await data.createUser();
      const phone = await login(t.server, user.email ?? '', user.password);
      const laptop = await login(t.server, user.email ?? '', user.password);
      const newPassword = `${TEST_PASSWORD}-changed`;

      await send(t.server, 'post', '/auth/change-password', laptop.cookies, {
        currentPassword: user.password,
        newPassword,
      }).expect(204);

      await get(t.server, '/auth/me', laptop.cookies).expect(200);
      await get(t.server, '/auth/me', phone.cookies).expect(401);
      expect((await login(t.server, user.email ?? '', user.password)).status).toBe(401);
      expect((await login(t.server, user.email ?? '', newPassword)).status).toBe(200);

      const logged = await t.prisma.client.auditLog.findFirstOrThrow({
        where: { actorUserId: user.id, action: 'user.password_changed' },
      });
      expect(JSON.stringify(logged)).not.toContain(newPassword);
    });

    it('rejects a wrong current password and a weak or personal new password', async () => {
      const user = await data.createUser();
      const session = await login(t.server, user.email ?? '', user.password);
      const change = (currentPassword: string, newPassword: string) =>
        send(t.server, 'post', '/auth/change-password', session.cookies, {
          currentPassword,
          newPassword,
        });

      await change('wrong-current-password', `${TEST_PASSWORD}-x`).expect(400);
      await change(user.password, 'short').expect(400);
      await change(user.password, user.email ?? '').expect(400);
      await change(user.password, 'x'.repeat(129)).expect(400);
    });
  });
});
