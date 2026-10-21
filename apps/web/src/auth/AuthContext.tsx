import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoginInput, SessionUser } from '@infusion/shared-types';
import { apiFetch, setAccessToken } from '../lib/api';
import { connectRealtime, disconnectRealtime } from '../lib/realtime';

interface LoginResponse {
  accessToken: string;
  user: SessionUser;
}

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Adopts a fresh {accessToken, user} pair without a full login round-trip — e.g. after change-password rotates the session. */
  setSession: (accessToken: string, user: SessionUser) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, try to silently exchange the httpOnly refresh-token cookie for
  // a fresh access token — this is what survives a hard page reload, since
  // the access token itself is memory-only.
  useEffect(() => {
    apiFetch<LoginResponse>('/auth/refresh', { method: 'POST' })
      .then((res) => {
        setAccessToken(res.accessToken);
        setUser(res.user);
      })
      .catch(() => {
        setAccessToken(null);
        setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const res = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    setAccessToken(res.accessToken);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

  const setSession = useCallback((accessToken: string, sessionUser: SessionUser) => {
    setAccessToken(accessToken);
    setUser(sessionUser);
  }, []);

  // One socket for the whole app, tied to session presence — covers login,
  // silent refresh-on-reload, and change-password's setSession the same way.
  useEffect(() => {
    if (user) {
      connectRealtime();
    } else {
      disconnectRealtime();
    }
  }, [user]);

  return <AuthContext.Provider value={{ user, isLoading, login, logout, setSession }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
