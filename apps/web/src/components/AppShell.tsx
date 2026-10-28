import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h2>{title}</h2>
        <div className="app-shell__nav">
          {/* Doctors open it per patient (Open patient monitor), not from the header. */}
          {user && ['admin', 'superuser'].includes(user.role) && (
            <Link className="app-shell__link" to="/central-station">
              Central station
            </Link>
          )}
          {user && <span className="app-shell__user">{user.loginId} · {user.role}</span>}
          <button type="button" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>
      <main className="app-shell__content">{children}</main>
      <footer className="app-shell__footer">
        <p>0dh.in — ICU patient monitoring</p>
      </footer>
    </div>
  );
}
