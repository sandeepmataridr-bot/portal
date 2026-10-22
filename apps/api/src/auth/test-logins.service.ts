import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadVigilConfig } from '@infusion/vigil';
import type { TestLogin } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.validation.js';
import { PasswordService } from './password.service.js';

/**
 * One ready-made account per role, listed with its password on the login
 * screen so every part of the portal can be tried in a click. Their
 * passwords are public by design, so they exist only while it is safe:
 */
export const TEST_ACCOUNTS: readonly TestLogin[] = [
  { role: 'admin', loginId: 'test.admin', password: 'Test-Admin-2026' },
  { role: 'doctor', loginId: 'test.doctor', password: 'Test-Doctor-2026' },
  { role: 'reception', loginId: 'test.reception', password: 'Test-Reception-2026' },
  { role: 'pharmacy', loginId: 'test.pharmacy', password: 'Test-Pharmacy-2026' },
  { role: 'insurance', loginId: 'test.insurance', password: 'Test-Insurance-2026' },
  { role: 'superuser', loginId: 'test.superuser', password: 'Test-Superuser-2026' },
];

/**
 * Enabled only when TEST_LOGINS=true AND Vigil runs in TEST mode (simulated
 * patients, ADR-005); a Vigil configuration that fails to load counts as not
 * TEST. When enabled, start-up (re)creates the accounts, ready to use with no
 * forced password change. Otherwise start-up switches any existing ones off,
 * which also ends their sessions (refresh rejects inactive users), so the
 * published passwords never work on a deployment that holds real data.
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
    this.enabled = config.get('TEST_LOGINS', { infer: true }) && vigilTestMode();
  }

  async onApplicationBootstrap(): Promise<void> {
    const loginIds = TEST_ACCOUNTS.map((a) => a.loginId);
    if (!this.enabled) {
      const { count } = await this.prisma.user.updateMany({
        where: { loginId: { in: loginIds }, isActive: true },
        data: { isActive: false },
      });
      if (count) this.logger.log(`Test accounts switched off (${count}); TEST_LOGINS is off or Vigil is not in TEST mode`);
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
          create: { userId: user.id, name: 'Test Doctor', specialty: 'Critical Care', qualification: 'MD' },
        });
      }
    }
    this.logger.warn(`TEST_LOGINS on: ${loginIds.join(', ')} are active and listed on the login screen (Vigil TEST mode)`);
  }
}

function vigilTestMode(): boolean {
  try {
    return !loadVigilConfig().liveMode;
  } catch {
    return false;
  }
}
