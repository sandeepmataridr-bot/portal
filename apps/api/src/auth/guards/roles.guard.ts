import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@infusion/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../types.js';

/**
 * Deny-by-default: a route with neither @Public() nor @Roles(...) is
 * rejected, not silently reachable by any authenticated user — this is the
 * mechanism behind the plan's "Strict Role-Based Access & Workflow
 * Enforcement" permission matrix. `admin` and `superuser` always pass —
 * superuser is the new (M7) role built specifically to do every other
 * role's day-to-day work from one login, with every action still
 * attributed to its own real identity (never anonymized as "reception did
 * this"); admin's bypass predates M7 and has simply never had a UI surface
 * to exercise it beyond fleet/doctor management.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      throw new ForbiddenException(
        'Route has no @Roles() or @Public() decorator — access denied by default. Add one to classify this route.',
      );
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    if (user.role === 'admin' || user.role === 'superuser' || requiredRoles.includes(user.role)) {
      return true;
    }

    throw new ForbiddenException(`Role "${user.role}" is not permitted for this action`);
  }
}
