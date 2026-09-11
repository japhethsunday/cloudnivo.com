'use client';

import Link from 'next/link';
import { timeAgo } from '../lib/format';
import { IconArrowRight } from './icons';
import { Badge, StatusDot, statusTone } from './ui';

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
            const status = p.database?.status ?? 'provisioning';
            const health = p.database?.health ?? 'unknown';
            const stamped = p.updatedAt ?? p.createdAt;
            return (
              <tr key={p.id}>
                <td>
                  <Link href={`/projects/${p.id}`} className="row-link">
                    {p.name}
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.slug} · {p.id.slice(0, 8)}
                    {p.orgName ? ` · ${p.orgName}` : ''}
                  </div>
                </td>
                <td>
                  <Badge tone={statusTone(status)}>{status}</Badge>
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot
                      tone={statusTone(health)}
                      pulse={status === 'provisioning' || status === 'pending'}
                    />
                    {health === 'unknown' ? '—' : health}
                  </span>
                </td>
                <td className="muted hide-sm">{p.region}</td>
                <td className="muted hide-sm">{stamped ? timeAgo(stamped) : '—'}</td>
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
