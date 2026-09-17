import { SetMetadata } from '@nestjs/common';
import type { Role } from '@infusion/shared-types';

export const ROLES_KEY = 'roles';

/**
 * Declares which roles may reach this route — the policy encoded here must
 * match the permission matrix in the plan's "Strict Role-Based Access &
 * Workflow Enforcement" section. `admin` always passes (see RolesGuard)
 * regardless of what's listed here.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
