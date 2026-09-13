'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  envKind,
  envKindLabel,
  getActiveEnvironmentId,
  listEnvironments,
  resolveActive,
  setActiveEnvironmentId,
  type DbEnvironment,
} from '../lib/environments';
import { Menu, StatusDot } from './ui';
import { IconCheck, IconChevronDown } from './icons';

/**
 * Workspace environment indicator + switcher (spec: project context must
 * always show Org → Project → Environment, and production must never look
 * identical to development).
 *
 * Real `database/environments` rows only — no invented environments. When
 * the backend predates the route (404) or no environments exist yet, this
 * renders the legacy `Env · region` text so old backends keep working.
 */

function kindTone(kind: 'production' | 'preview' | 'standard'): string {
  if (kind === 'production') return 'bad';
  if (kind === 'preview') return 'warn';
  return 'ok';
}

export function EnvSwitcher({
  projectId,
  region,
}: {
  projectId: string;
  region: string;
}): React.JSX.Element {
  const [envs, setEnvs] = useState<DbEnvironment[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const r = await listEnvironments(projectId);
    if (!r.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    const rows = r.envs ?? [];
    setEnvs(rows);
    setActiveId(resolveActive(rows, projectId)?.id ?? null);
  }, [projectId]);

  useEffect(() => {
    setEnvs(null);
    setActiveId(getActiveEnvironmentId(projectId));
    void load();
  }, [projectId, load]);

  if (failed || (envs !== null && envs.length === 0)) {
    return <span title="Environment / region">Env · {region}</span>;
  }
  if (envs === null) {
    return (
      <span className="muted" aria-live="polite">
        Env · …
      </span>
    );
  }

  const active = envs.find(e => e.id === activeId) ?? envs[0] ?? null;
  if (!active) return <span title="Environment / region">Env · {region}</span>;
  const kind = envKind(active);

  const pick = (id: string): void => {
    setActiveEnvironmentId(projectId, id);
    setActiveId(id);
  };

  return (
    <Menu
      label={`Switch environment (active: ${active.name})`}
      button={
        <>
          <StatusDot tone={kindTone(kind)} />
          <span
            className={`badge env-${kind}`}
            title={`Environment: ${active.name} (${envKindLabel(kind)})`}
          >
            {active.name}
          </span>
          <IconChevronDown size={13} />
        </>
      }
    >
      {envs.map(e => {
        const k = envKind(e);
        return (
          <button
            key={e.id}
            type="button"
            role="menuitemradio"
            aria-checked={e.id === active.id}
            onClick={() => pick(e.id)}
          >
            <span className="grow">
              {e.name}
              <span className="sub">
                {e.slug} · {envKindLabel(k)}
                {e.branchId ? ' · branched' : ' · main'}
              </span>
            </span>
            {e.id === active.id ? (
              <span className="sel" aria-hidden>
                <IconCheck size={13} />
              </span>
            ) : null}
          </button>
        );
      })}
      <Link href={`/projects/${projectId}/settings#environments`}>Manage environments</Link>
    </Menu>
  );
}
