'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, getToken, setToken } from '../lib/api';

export interface SessionUser {
  id: string;
  email: string;
  displayName?: string | null;
  /** Platform staff. Gates the operator console in the sidebar and at /admin. */
  isPlatformAdmin?: boolean;
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

/**
 * What a sign-in attempt actually ends in.
 *
 * `login` used to return `string | null` — an error or success. That could
 * not represent the MFA branch, so the API's `{ mfaRequired: true }` answer
 * (which carries no token) fell through to the generic "Login failed", and
 * every account with MFA enabled was locked out of the dashboard. The result
 * is a union now so the caller has to handle the challenge.
 */
export type LoginResult =
  | { kind: 'ok' }
  /** TOTP (or a backup code) is required; spend the ticket on mfa-verify. */
  | { kind: 'mfa'; ticket: string }
  /** The account must enrol before it can sign in. */
  | { kind: 'mfa-setup'; ticket: string }
  | { kind: 'error'; message: string };

interface SessionValue {
  token: string | null;
  user: SessionUser | null;
  orgs: OrgMembership[];
  /** True once the stored session (if any) has been validated. */
  ready: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  /** Completes a challenge from `login`. Returns null on success. */
  verifyMfa: (ticket: string, code: string) => Promise<string | null>;
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

/** Reads the MFA branch of a 200 login response, if that is what came back. */
function readChallenge(json: unknown): { kind: 'mfa' | 'mfa-setup'; ticket: string } | null {
  const data = (json as { data?: unknown })?.data ?? json;
  const d = data as { mfaRequired?: unknown; mfaTicket?: unknown; mfaSetupRequired?: unknown; setupTicket?: unknown };
  if (!d || typeof d !== 'object') return null;
  if (d.mfaRequired === true && typeof d.mfaTicket === 'string') {
    return { kind: 'mfa', ticket: d.mfaTicket };
  }
  if (d.mfaSetupRequired === true && typeof d.setupTicket === 'string') {
    return { kind: 'mfa-setup', ticket: d.setupTicket };
  }
  return null;
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
    async (email: string, password: string): Promise<LoginResult> => {
      const r = await apiFetch<unknown>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (!r.ok || !r.data) return { kind: 'error', message: r.error ?? 'Login failed' };

      // A 200 without a token is not a failure — it is a challenge.
      const challenge = readChallenge(r.data);
      if (challenge) return challenge;

      const next = readToken(r.data);
      if (!next) return { kind: 'error', message: 'Login failed' };
      await applyToken(next);
      return { kind: 'ok' };
    },
    [applyToken],
  );

  const verifyMfa = useCallback(
    async (ticket: string, code: string): Promise<string | null> => {
      const r = await apiFetch<unknown>('/api/v1/auth/mfa-verify', {
        method: 'POST',
        body: { mfaTicket: ticket, code },
      });
      if (!r.ok || !r.data) return r.error ?? 'Verification failed';
      const next = readToken(r.data);
      if (!next) return 'Verification failed';
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
    () => ({ token, user, orgs, ready, login, verifyMfa, signup, logout, refresh }),
    [token, user, orgs, ready, login, verifyMfa, signup, logout, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
