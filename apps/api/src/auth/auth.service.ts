import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { LoginInput, ChangePasswordInput, Role } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import type { AuthenticatedUser } from './types.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: AuthenticatedUser;
}

export interface RefreshContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(input: LoginInput, ctx: RefreshContext): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { loginId: input.loginId } });

    if (!user) {
      // Still run a hash verify against a dummy value so failed lookups take
      // roughly the same time as a real failed password check (no user-enumeration timing tell).
      await this.passwords.verify(
        '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        input.password,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account temporarily locked due to too many failed attempts');
    }

    const passwordValid = await this.passwords.verify(user.passwordHash, input.password);
    if (!passwordValid) {
      const failedCount = user.failedLoginCount + 1;
      const lockingNow = failedCount >= MAX_FAILED_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lockingNow ? 0 : failedCount,
          lockedUntil: lockingNow ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });
      await this.audit.log({
        actorUserId: user.id,
        actorType: 'user',
        action: lockingNow ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        entityTable: 'users',
        entityId: user.id,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      loginId: user.loginId,
      role: user.role as Role,
      mustChangePassword: user.mustChangePassword,
    };

    const { rawToken, tokenHash, expiresAt } = this.tokens.issueRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      },
    });

    await this.audit.log({
      actorUserId: user.id,
      actorType: 'user',
      action: 'LOGIN_SUCCESS',
      entityTable: 'users',
      entityId: user.id,
    });

    return {
      accessToken: this.tokens.signAccessToken(authenticatedUser),
      refreshToken: rawToken,
      refreshExpiresAt: expiresAt,
      user: authenticatedUser,
    };
  }

  async refresh(rawRefreshToken: string, ctx: RefreshContext): Promise<LoginResult> {
    const tokenHash = this.tokens.hashRefreshToken(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findFirst({ where: { tokenHash } });

    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    const { rawToken, tokenHash: newHash, expiresAt } = this.tokens.issueRefreshToken();

    await this.prisma.$transaction([
      this.prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: newHash, expiresAt, userAgent: ctx.userAgent, ip: ctx.ip },
      }),
      this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      }),
    ]);

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      loginId: user.loginId,
      role: user.role as Role,
      mustChangePassword: user.mustChangePassword,
    };

    return {
      accessToken: this.tokens.signAccessToken(authenticatedUser),
      refreshToken: rawToken,
      refreshExpiresAt: expiresAt,
      user: authenticatedUser,
    };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = this.tokens.hashRefreshToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Forces re-login everywhere else, but NOT for the session performing the
   * change — that session gets a rotated refresh token + a fresh access
   * token (with mustChangePassword now false baked in), so the user isn't
   * logged out of their own password-change flow. `currentRawRefreshToken`
   * is optional only so this method still works if ever called without an
   * active session (e.g. an admin-triggered reset elsewhere).
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentRawRefreshToken: string | undefined,
    ctx: RefreshContext,
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const currentValid = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!currentValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const newHash = await this.passwords.hash(input.newPassword);
    const currentTokenHash = currentRawRefreshToken ? this.tokens.hashRefreshToken(currentRawRefreshToken) : null;
    const { rawToken, tokenHash, expiresAt } = this.tokens.issueRefreshToken();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newHash, mustChangePassword: false },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null, ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {}) },
        data: { revokedAt: new Date() },
      }),
      // Rotate rather than reuse the current session's own refresh token.
      ...(currentTokenHash
        ? [this.prisma.refreshToken.updateMany({ where: { tokenHash: currentTokenHash }, data: { revokedAt: new Date() } })]
        : []),
      this.prisma.refreshToken.create({
        data: { userId, tokenHash, expiresAt, userAgent: ctx.userAgent, ip: ctx.ip },
      }),
    ]);

    await this.audit.log({
      actorUserId: userId,
      actorType: 'user',
      action: 'PASSWORD_CHANGED',
      entityTable: 'users',
      entityId: userId,
    });

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      loginId: user.loginId,
      role: user.role as Role,
      mustChangePassword: false,
    };

    return {
      accessToken: this.tokens.signAccessToken(authenticatedUser),
      refreshToken: rawToken,
      refreshExpiresAt: expiresAt,
      user: authenticatedUser,
    };
  }
}
