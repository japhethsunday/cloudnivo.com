'use client';

import Link from 'next/link';
import { timeAgo } from '../lib/format';
import { Badge, StatusDot, statusTone } from './ui';

export interface ProjectCardData {
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
 * Project card with a stretched primary link: the whole card surface opens
 * the project (mouse, touch, keyboard via the anchor), so clickability never
 * depends on hitting a small inline link. Secondary content stays outside
 * the anchor to keep semantics valid.
 */
export function ProjectCard({ project }: { project: ProjectCardData }): React.JSX.Element {
  const status = project.database?.status ?? 'provisioning';
  const health = project.database?.health ?? 'unknown';
  const initial = (project.name.trim()[0] ?? '•').toUpperCase();
  const stamped = project.updatedAt ?? project.createdAt;

  return (
    <article className="proj-card" aria-labelledby={`proj-${project.id}`}>
      <div className="proj-card-top">
        <span className="proj-id-badge" aria-hidden>
          {initial}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Link id={`proj-${project.id}`} className="proj-name stretch" href={`/projects/${project.id}`}>
            {project.name}
          </Link>
          <div className="proj-sub" title={project.id}>
            {project.slug} · {project.id.slice(0, 8)}
          </div>
        </div>
        <Badge tone={statusTone(status)}>{status}</Badge>
      </div>

      <div className="proj-health" aria-label="Infrastructure health">
        <span>
          <StatusDot tone={statusTone(status)} pulse={status === 'provisioning' || status === 'pending'} />
          DB {status}
        </span>
        <span>
          <StatusDot tone={statusTone(health)} />
          {health === 'unknown' ? 'health —' : health}
        </span>
        <span title="Region">{project.region}</span>
      </div>

      <div className="proj-foot">
        <span>{project.orgName ?? project.region}</span>
        {stamped ? <span>Updated {timeAgo(stamped)}</span> : <span>Open workspace →</span>}
      </div>
    </article>
  );
}
