'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';

/**
 * Shared plumbing for the operator console's sections.
 *
 * Every section loads from a staff-gated endpoint that answers 404 to a
 * non-staff caller, so a load failure is far more likely to mean "you are
 * not staff" than "the console is broken". That distinction is made once,
 * here, rather than re-derived in twelve places.
 */

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** True only on the FIRST load; a refresh keeps the last data on screen. */
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
}

export function useAdminResource<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (!path) return;
      if (isRefresh) setRefreshing(true);
      setError(null);
      const res = await apiFetch<T>(path);
      if (!res.ok || !res.data) {
        setError(
          res.status === 404
            ? 'This section is limited to CloudNivo staff.'
            : (res.error ?? 'Could not load this section'),
        );
      } else {
        setData(res.data);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [path],
  );

  useEffect(() => {
    setLoading(true);
    void load(false);
  }, [load]);

  return useMemo(
    () => ({ data, error, loading, refreshing, reload: () => void load(true) }),
    [data, error, loading, refreshing, load],
  );
}

/** A section that the platform cannot answer yet, said plainly. */
export function NotWired({
  title,
  what,
  why,
}: {
  title: string;
  what: string;
  why: string;
}): React.JSX.Element {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="muted">{what}</p>
      <p className="muted" style={{ marginTop: 8 }}>
        <strong>Not available yet.</strong> {why}
      </p>
    </div>
  );
}

/** Dense key/value strip used by the configuration-style sections. */
export function FactRow({
  k,
  children,
}: {
  k: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="fact-row">
      <span className="fact-k">{k}</span>
      <span className="fact-v">{children}</span>
    </div>
  );
}

export function Toolbar({
  value,
  onChange,
  placeholder,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="toolbar" role="search">
      <div className="search">
        <input
          type="search"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      {children}
    </div>
  );
}
