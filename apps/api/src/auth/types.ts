import type { Role } from '@infusion/shared-types';

export interface AuthenticatedUser {
  id: string;
  loginId: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface AccessTokenPayload {
  sub: string;
  loginId: string;
  role: Role;
  mustChangePassword: boolean;
}
