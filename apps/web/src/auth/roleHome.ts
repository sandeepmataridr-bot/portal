import type { Role } from '@infusion/shared-types';

/** Each role's own dashboard: where a signed-in user lands. */
export const ROLE_HOME: Record<Role, string> = {
  admin: '/admin',
  doctor: '/doctor',
  reception: '/reception',
  pharmacy: '/pharmacy',
  insurance: '/insurance',
  superuser: '/super',
};
