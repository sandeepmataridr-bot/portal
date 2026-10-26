import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  loginSchema,
  changePasswordSchema,
  ROLES,
  type LoginInput,
  type ChangePasswordInput,
  type TestLoginsResponse,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { Env } from '../config/env.validation.js';
import { AuthService, type LoginResult } from './auth.service.js';
import { TEST_ACCOUNTS, TestLoginsService } from './test-logins.service.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthenticatedUser } from './types.js';

const REFRESH_COOKIE_NAME = 'refreshToken';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly testLogins: TestLoginsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The quick sign-in accounts for the login screen; 404 unless TestLoginsService is enabled. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('test-logins')
  getTestLogins(): TestLoginsResponse {
    if (!this.testLogins.enabled) throw new NotFoundException();
    return { accounts: [...TEST_ACCOUNTS] };
  }

  @Public()
  // Tighter than the global default (100/min) — login is the highest-value
  // brute-force target. This is IP-based and complements, not replaces, the
  // per-account lockout in AuthService (5 failed attempts / 15min).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  // Refresh is unauthenticated (relies on the httpOnly cookie) — throttle it
  // too, since it's still a token-validation endpoint an attacker could
  // hammer with stolen/guessed cookies.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!rawToken) {
      res.clearCookie(REFRESH_COOKIE_NAME, { path: this.cookiePath });
      return res.status(HttpStatus.UNAUTHORIZED).json({ message: 'No refresh token' });
    }

    const result = await this.authService.refresh(rawToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
    await this.authService.logout(rawToken);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: this.cookiePath });
  }

  @Roles(...ROLES)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
    const result = await this.authService.changePassword(user.id, body, rawToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  private get cookiePath(): string {
    return this.config.get('REFRESH_COOKIE_PATH', { infer: true });
  }

  private setRefreshCookie(res: Response, result: LoginResult) {
    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'strict',
      path: this.cookiePath,
      expires: result.refreshExpiresAt,
    });
  }
}
