import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const ROLE_HOME: Record<string, string> = {
  admin: '/admin',
  doctor: '/doctor',
  reception: '/reception',
  pharmacy: '/pharmacy',
  insurance: '/insurance',
};

/** Mirrors the reference app's `/` dispatch-by-role behavior. */
export function HomeRedirect() {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOME[user.role] ?? '/login'} replace />;
}
