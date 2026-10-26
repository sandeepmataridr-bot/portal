import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadVigilConfig } from '@infusion/vigil';
import type { TestLogin } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.validation.js';
import { PasswordService } from './password.service.js';

/**
 * One ready-made account per role, listed with its password in the login
 * screen's quick sign-in table so every part of the portal can be tried in a
 * click. The names are ordinary staff-style IDs because the portal shows
 * nothing as "test". Their passwords are public by design, so they exist only
 * while it is safe (see TestLoginsService).
 */
export const TEST_ACCOUNTS: readonly TestLogin[] = [
  { role: 'admin', loginId: 'admin1', password: 'Admin1-0dh-2026' },
  { role: 'doctor', loginId: 'doctor1', password: 'Doctor1-0dh-2026' },
  { role: 'reception', loginId: 'reception1', password: 'Reception1-0dh-2026' },
  { role: 'pharmacy', loginId: 'pharmacy1', password: 'Pharmacy1-0dh-2026' },
  { role: 'insurance', loginId: 'insurance1', password: 'Insurance1-0dh-2026' },
  { role: 'superuser', loginId: 'superuser1', password: 'Superuser1-0dh-2026' },
];

/** Earlier names of these accounts; always switched off. */
export const RETIRED_LOGIN_IDS: readonly string[] = [
  'test.admin',
  'test.doctor',
  'test.reception',
  'test.pharmacy',
  'test.insurance',
  'test.superuser',
];

/**
 * Enabled when TEST_LOGINS=true and either Vigil runs in TEST mode (simulated
 * patients, ADR-005; a Vigil configuration that fails to load counts as not
 * TEST) or the API is not a production build (a developer's own machine,
 * where LIVE mode carries only dummy device data). A production server in
 * LIVE mode never serves them. When enabled, start-up (re)creates the
 * accounts, ready to use with no forced password change. Otherwise start-up
 * switches any existing ones off, which also ends their sessions (refresh
 * rejects inactive users), so the published passwords never work on a
 * deployment that holds real data.
 */
@Injectable()
export class TestLoginsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TestLoginsService.name);
  readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService<Env, true>,
  ) {
    const devBuild = config.get('NODE_ENV', { infer: true }) !== 'production';
    this.enabled = config.get('TEST_LOGINS', { infer: true }) && (devBuild || vigilTestMode());
  }

  async onApplicationBootstrap(): Promise<void> {
    const loginIds = TEST_ACCOUNTS.map((a) => a.loginId);
    const switchOff = this.enabled ? RETIRED_LOGIN_IDS : [...loginIds, ...RETIRED_LOGIN_IDS];
    const { count } = await this.prisma.user.updateMany({
      where: { loginId: { in: [...switchOff] }, isActive: true },
      data: { isActive: false },
    });
    if (!this.enabled) {
      if (count) this.logger.log(`Quick sign-in accounts switched off (${count}); TEST_LOGINS is off, or this is production in Vigil LIVE mode`);
      return;
    }
    for (const account of TEST_ACCOUNTS) {
      const passwordHash = await this.passwords.hash(account.password);
      const user = await this.prisma.user.upsert({
        where: { loginId: account.loginId },
        update: { role: account.role, passwordHash, isActive: true, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
        create: { loginId: account.loginId, role: account.role, passwordHash, mustChangePassword: false },
      });
      if (account.role === 'doctor') {
        await this.prisma.doctorProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id, name: 'Duty Doctor', specialty: 'Critical Care', qualification: 'MD' },
        });
      }
    }
    this.logger.warn(`TEST_LOGINS on: ${loginIds.join(', ')} are active and listed on the login screen`);
  }
}

function vigilTestMode(): boolean {
  try {
    return !loadVigilConfig().liveMode;
  } catch {
    return false;
  }
}
