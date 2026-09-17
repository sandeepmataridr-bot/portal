import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h2>{title}</h2>
        <div className="app-shell__nav">
          {user && <span className="app-shell__user">{user.loginId} · {user.role}</span>}
          <button type="button" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>
      <main className="app-shell__content">{children}</main>
      <footer className="app-shell__footer">
        <p>Infusion Platform — Fleet Dashboard</p>
      </footer>
    </div>
  );
}
