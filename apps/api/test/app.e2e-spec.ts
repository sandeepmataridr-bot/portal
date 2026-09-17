// KNOWN ISSUE: this suite currently fails to boot under Jest's experimental
// VM-modules ESM support — @nestjs/throttler@6.6.0's package resolves in a
// way that trips "Must use import to load ES Module" for @nestjs/common deep
// in the DI graph, once the full AppModule (which pulls in every feature
// module) is instantiated. This is a Jest+ESM+third-party-package interop
// issue, not an application bug: the exact same auth flow (login, refresh
// rotation/reuse-detection, change-password + session revocation, lockout,
// RBAC deny-by-default) was manually verified end-to-end against the real
// running server (`pnpm start` + curl) and confirmed fully working. Options
// to revisit: try Nest's official Jest+ESM guidance for this version, or
// switch this suite to spawn a real server process and hit it over HTTP
// instead of bootstrapping AppModule in-process.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(() => {
    process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/infusion_test';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-please-override-min-32-chars';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-please-override-min-32-chars';
    process.env.CORS_ORIGINS ??= 'http://localhost:5173';
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
