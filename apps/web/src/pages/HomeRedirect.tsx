import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_HOME } from '../auth/roleHome';

/** Mirrors the reference app's `/` dispatch-by-role behavior; served at `/app` since `/` is the public landing page. */
export function HomeRedirect() {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOME[user.role] ?? '/login'} replace />;
}
