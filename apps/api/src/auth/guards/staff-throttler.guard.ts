import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerStorage } from '@nestjs/throttler';
import { TokenService } from '../token.service.js';

/**
 * Rate limits per person for signed-in staff, per address for everything else.
 *
 * A hospital's staff usually share one public address, so per-address limits on signed-in
 * traffic would let a few open central station screens (each polls once a second) lock out
 * the whole ward. The person comes from a verified access token, which can't be forged;
 * without one (sign-in, refresh, machines) the request counts against its address.
 */
@Injectable()
export class StaffThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokenService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const auth: unknown = req.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      try {
        return `user:${this.tokens.verifyAccessToken(auth.slice('Bearer '.length)).sub}`;
      } catch {
        // expired or invalid: counted by address, and refused by JwtAuthGuard anyway
      }
    }
    return req.ip as string;
  }
}
