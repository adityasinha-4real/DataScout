import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api } from './api';
import type { User } from './types';

/**
 * The session lives in an HttpOnly cookie the API sets at login, so there is
 * no token here to keep: nothing in this file, or anywhere else in the client,
 * can read it, which is the point. "Signed in" means /me answered with a user.
 */
interface AuthState {
  user: User | null;
  ready: boolean;
  register: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // On load, ask who the cookie belongs to. No cookie, or an expired one, is
  // a 401 and simply means signed out.
  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    setUser((await api.register(email, password)).user);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser((await api.login(email, password)).user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Signed out locally even if the request failed: the UI must never
      // keep showing an account the user asked to leave.
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, ready, register, login, logout }),
    [user, ready, register, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}
