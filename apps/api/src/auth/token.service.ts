import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import type { AccessTokenPayload, AuthenticatedUser } from './types.js';
import type { Env } from '../config/env.validation.js';

export interface IssuedRefreshToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration string: "${value}"`);
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * unitMs[match[2]];
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  signAccessToken(user: AuthenticatedUser): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      loginId: user.loginId,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
    return this.jwtService.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      // seconds, not the raw "15m" string — sidesteps jsonwebtoken's
      // branded StringValue type while staying driven by the same env value.
      expiresIn: parseDurationMs(this.config.get('JWT_ACCESS_TTL', { infer: true })) / 1000,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwtService.verify<AccessTokenPayload>(token, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /** Refresh tokens are opaque + stateful (revocable, rotated), never JWTs — see AuthContext.tsx on the frontend. */
  issueRefreshToken(): IssuedRefreshToken {
    const rawToken = randomBytes(48).toString('hex');
    const ttlMs = parseDurationMs(this.config.get('JWT_REFRESH_TTL', { infer: true }));
    return {
      rawToken,
      tokenHash: this.hashRefreshToken(rawToken),
      expiresAt: new Date(Date.now() + ttlMs),
    };
  }

  hashRefreshToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
