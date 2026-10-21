import { Navigate } from 'react-router-dom';
import type { Role } from '@infusion/shared-types';
import { useAuth } from './AuthContext';

/**
 * Client-side route guard for navigation/UX only. The actual access-control
 * decision is always re-checked server-side (deny-by-default RolesGuard) —
 * this component just avoids flashing a dashboard the user can't act on.
 */
export function RequireRole({ allow, children }: { allow: Role[]; children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!allow.includes(user.role)) return <Navigate to="/app" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;

  return <>{children}</>;
}
