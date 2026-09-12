'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, getToken, setToken } from '../lib/api';

export interface SessionUser {
  id: string;
  email: string;
  displayName?: string | null;
}

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface MeData {
  user: SessionUser;
  organizations: OrgMembership[];
}

interface SessionValue {
  token: string | null;
  user: SessionUser | null;
  orgs: OrgMembership[];
  /** True once the stored session (if any) has been validated. */
  ready: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  signup: (email: string, password: string, displayName?: string) => Promise<string | null>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function readMeData(json: unknown): MeData | null {
  const data = (json as { data?: unknown })?.data ?? json;
  const d = data as { user?: SessionUser; organizations?: OrgMembership[] };
  if (!d || typeof d !== 'object' || !d.user || typeof d.user.id !== 'string') return null;
  return { user: d.user, organizations: Array.isArray(d.organizations) ? d.organizations : [] };
}

function readToken(json: unknown): string | null {
  const data = (json as { data?: unknown })?.data ?? json;
  const d = data as { token?: unknown; user?: SessionUser };
  return typeof d?.token === 'string' ? d.token : null;
}

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const stored = getToken();
    if (!stored) {
      setTokenState(null);
      setUser(null);
      setOrgs([]);
      setReady(true);
      return;
    }
    const r = await apiFetch<MeData>('/api/v1/me');
    if (r.status === 401 || r.status === 403) {
      // Genuinely invalid session — forget it so the user can sign in again.
      setToken('');
      setTokenState(null);
      setUser(null);
      setOrgs([]);
      setReady(true);
      return;
    }
    if (!r.ok || !r.data) {
      // Transient failure (rate limit, network, server error): keep the
      // stored session. Wiping it here used to log users out at random and
      // strand them on the login page mid-workflow.
      setTokenState(prev => prev ?? stored);
      setReady(true);
      return;
    }
    const me = readMeData(r.data);
    if (!me) {
      setToken('');
      setTokenState(null);
      setUser(null);
      setOrgs([]);
    } else {
      setTokenState(stored);
      setUser(me.user);
      setOrgs(me.organizations);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyToken = useCallback(
    async (next: string | null): Promise<void> => {
      if (!next) {
        setToken('');
        setTokenState(null);
        setUser(null);
        setOrgs([]);
        return;
      }
      setToken(next);
      setTokenState(next);
      await refresh();
    },
    [refresh],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      const r = await apiFetch<unknown>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (!r.ok || !r.data) return r.error ?? 'Login failed';
      const next = readToken(r.data);
      if (!next) return 'Login failed';
      await applyToken(next);
      return null;
    },
    [applyToken],
  );

  const signup = useCallback(
    async (email: string, password: string, displayName?: string): Promise<string | null> => {
      const r = await apiFetch<unknown>('/api/v1/auth/signup', {
        method: 'POST',
        body: displayName ? { email, password, displayName } : { email, password },
      });
      if (!r.ok || !r.data) return r.error ?? 'Signup failed';
      const next = readToken(r.data);
      if (!next) return 'Signup failed';
      await applyToken(next);
      return null;
    },
    [applyToken],
  );

  const logout = useCallback(() => {
    // Tell the server (clears the httpOnly session cookie, records audit);
    // local state is cleared regardless so logout never hangs on network.
    void apiFetch<unknown>('/api/v1/auth/logout', { method: 'POST' }).catch(() => null);
    setToken('');
    setTokenState(null);
    setUser(null);
    setOrgs([]);
  }, []);

  const value = useMemo(
    () => ({ token, user, orgs, ready, login, signup, logout, refresh }),
    [token, user, orgs, ready, login, signup, logout, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
