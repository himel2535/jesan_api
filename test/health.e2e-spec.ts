import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/core/database/prisma.service';
import { hasDatabase } from './database';

interface FakeDatabase {
  isConfigured: boolean;
  isReachable: () => Promise<boolean>;
}

describe('health endpoints', () => {
  let app: INestApplication<App> | undefined;

  /** Boots the real app; optionally swaps the database service for a fake. */
  async function createApp(fakeDatabase?: FakeDatabase): Promise<INestApplication<App>> {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (fakeDatabase) {
      builder.overrideProvider(PrismaService).useValue(fakeDatabase);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('GET /api/v1/health (liveness)', () => {
    it('returns 200 with status ok', async () => {
      const server = (await createApp()).getHttpServer();
      const response = await request(server).get('/api/v1/health').expect(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('stays 200 and never touches the database, even when it is down', async () => {
      let databaseCalls = 0;
      const server = (
        await createApp({
          isConfigured: true,
          isReachable: () => {
            databaseCalls += 1;
            return Promise.resolve(false);
          },
        })
      ).getHttpServer();
      await request(server).get('/api/v1/health').expect(200);
      expect(databaseCalls).toBe(0);
    });

    it('is not served without the version prefix', async () => {
      const server = (await createApp()).getHttpServer();
      await request(server).get('/api/health').expect(404);
    });

    it('sends the CORS header for the configured origin', async () => {
      const server = (await createApp()).getHttpServer();
      const response = await request(server)
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
  });

  describe('GET /api/v1/health/ready (readiness)', () => {
    it('returns 200 not_configured when there is no database URL', async () => {
      const server = (
        await createApp({ isConfigured: false, isReachable: () => Promise.resolve(false) })
      ).getHttpServer();
      const response = await request(server).get('/api/v1/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ok', database: 'not_configured' });
    });

    it('returns 200 up when the database answers', async () => {
      const server = (
        await createApp({ isConfigured: true, isReachable: () => Promise.resolve(true) })
      ).getHttpServer();
      const response = await request(server).get('/api/v1/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ok', database: 'up' });
    });

    it('returns 503 down when the database does not answer', async () => {
      const server = (
        await createApp({ isConfigured: true, isReachable: () => Promise.resolve(false) })
      ).getHttpServer();
      const response = await request(server).get('/api/v1/health/ready').expect(503);
      expect(response.body).toEqual({ status: 'error', database: 'down' });
    });

    it.skipIf(!hasDatabase)('returns 200 up against the real database', async () => {
      const server = (await createApp()).getHttpServer();
      const response = await request(server).get('/api/v1/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ok', database: 'up' });
    });
  });
});
