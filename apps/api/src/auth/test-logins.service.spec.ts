import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PasswordService } from './password.service.js';
import { TEST_ACCOUNTS, TestLoginsService } from './test-logins.service.js';

/** Records what the service asks the database to do. */
function fakePrisma() {
  const calls = { deactivated: [] as unknown[], upserted: [] as Record<string, unknown>[], doctorProfiles: 0 };
  const prisma = {
    user: {
      updateMany: async (args: unknown) => {
        calls.deactivated.push(args);
        return { count: 2 };
      },
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        calls.upserted.push(args.update);
        return { id: `id-${String(args.create.loginId)}` };
      },
    },
    doctorProfile: {
      upsert: async () => {
        calls.doctorProfiles++;
        return {};
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

const passwords = { hash: async (plain: string) => `hash:${plain}` } as unknown as PasswordService;
const config = (testLogins: boolean) => ({ get: () => testLogins }) as unknown as ConfigService<Env, true>;

describe('TestLoginsService', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('creates ready-to-use accounts when TEST_LOGINS is on in Vigil TEST mode', async () => {
    process.env.VIGIL_LIVE_MODE = 'false';
    const { prisma, calls } = fakePrisma();
    const service = new TestLoginsService(prisma, passwords, config(true));

    await service.onApplicationBootstrap();

    expect(service.enabled).toBe(true);
    expect(calls.deactivated).toHaveLength(0);
    expect(calls.upserted).toHaveLength(TEST_ACCOUNTS.length);
    for (const update of calls.upserted) {
      expect(update).toMatchObject({ isActive: true, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null });
    }
    expect(calls.doctorProfiles).toBe(1);
  });

  it('switches the accounts off in Vigil LIVE mode, even with TEST_LOGINS on', async () => {
    Object.assign(process.env, { VIGIL_LIVE_MODE: 'true', VIGIL_LIVE_TENANT_ID: 'general-hospital', VIGIL_LIVE_UNIT_ID: 'cvicu-3' });
    const { prisma, calls } = fakePrisma();
    const service = new TestLoginsService(prisma, passwords, config(true));

    await service.onApplicationBootstrap();

    expect(service.enabled).toBe(false);
    expect(calls.upserted).toHaveLength(0);
    expect(calls.deactivated).toEqual([
      { where: { loginId: { in: TEST_ACCOUNTS.map((a) => a.loginId) }, isActive: true }, data: { isActive: false } },
    ]);
  });

  it('switches the accounts off when TEST_LOGINS is off', async () => {
    process.env.VIGIL_LIVE_MODE = 'false';
    const { prisma, calls } = fakePrisma();
    const service = new TestLoginsService(prisma, passwords, config(false));

    await service.onApplicationBootstrap();

    expect(service.enabled).toBe(false);
    expect(calls.upserted).toHaveLength(0);
    expect(calls.deactivated).toHaveLength(1);
  });

  it('treats an invalid Vigil configuration as not TEST mode', () => {
    process.env.VIGIL_LIVE_MODE = 'sometimes';
    const { prisma } = fakePrisma();
    expect(new TestLoginsService(prisma, passwords, config(true)).enabled).toBe(false);
  });

  it('lists exactly one account per role', () => {
    expect(new Set(TEST_ACCOUNTS.map((a) => a.role)).size).toBe(TEST_ACCOUNTS.length);
    expect(TEST_ACCOUNTS.map((a) => a.role).sort()).toEqual(['admin', 'doctor', 'insurance', 'pharmacy', 'reception', 'superuser']);
  });
});
