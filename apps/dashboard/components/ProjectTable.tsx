'use client';

import Link from 'next/link';
import { timeAgo } from '../lib/format';
import { IconArrowRight } from './icons';
import { statusTone } from './ui';
import { databaseState, type ProvisionJobLike } from '../lib/dbstate';

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
  orgName?: string;
  updatedAt?: string;
  createdAt?: string;
  database: { status: string; health?: string } | null;
  /** Present only when there is no database: why it is missing. */
  provisionJob?: ProvisionJobLike | null;
}

/**
 * Dense project list. The name and the trailing chevron are real links, so
 * every row stays keyboard- and screen-reader-operable with no row-level
 * click handlers to break.
 */
export function ProjectTable({ projects }: { projects: ProjectRow[] }): React.JSX.Element {
  return (
    <div className="table-wrap" style={{ border: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Status</th>
            <th scope="col">Health</th>
            <th scope="col" className="hide-sm">
              Region
            </th>
            <th scope="col" className="hide-sm">
              Updated
            </th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map(p => {
            const status = databaseState(p.database, p.provisionJob).label;
            const health = p.database?.health ?? 'unknown';
            const stamped = p.updatedAt ?? p.createdAt;
            return (
              <tr key={p.id} className={`state-row state-${statusTone(health)}`}>
                <td>
                  <Link href={`/projects/${p.id}`} className="row-link">
                    {p.name}
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.slug} · {p.id.slice(0, 8)}
                    {p.orgName ? ` · ${p.orgName}` : ''}
                  </div>
                </td>
                {/* The row already carries its condition on its own edge, so
                    state is a word in the state's colour, not a capsule and a
                    repeated dot. */}
                <td>
                  <span className={`state-word state-${statusTone(status)}`}>{status}</span>
                </td>
                <td>
                  <span className={`state-word state-${statusTone(health)}`}>
                    {health === 'unknown' ? 'unknown' : health}
                  </span>
                </td>
                <td className="reading hide-sm">{p.region}</td>
                <td className="reading hide-sm">{stamped ? timeAgo(stamped) : '—'}</td>
                <td style={{ width: 36 }}>
                  <Link
                    href={`/projects/${p.id}`}
                    aria-hidden="true"
                    className="row-open"
                    tabIndex={-1}
                  >
                    <IconArrowRight size={16} />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
