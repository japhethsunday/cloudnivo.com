'use client';

import { use } from 'react';
import { ProjectDatabase } from '../../../../components/ProjectDatabase';
import {
  BackupsPanel,
  ExtensionsPanel,
  ReplicasPanel,
  RlsSimulator,
  RoutinesPanel,
  TableEditor,
} from '../../../../components/DatabaseSections';

export default function ProjectDatabasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <h2>Database</h2>
        <p>
          Isolated PostgreSQL per project — table editor, schemas, routines, extensions, RLS
          simulation, replicas and backups, all against the live database.
        </p>
      </div>
      {/* A jump list, not a tab bar: every panel below is on this page, and
          the sidebar's nested links target the same anchors. Styled as links
          so it stops reading like the action buttons inside the panels. */}
      <nav className="jump-nav" aria-label="Jump to database section">
        <span className="jump-nav-label">Jump to</span>
        {[
          ['Table Editor', '#table-editor'],
          ['Connection', '#connection'],
          ['Routines', '#routines'],
          ['Extensions', '#extensions'],
          ['RLS', '#rls'],
          ['Replicas', '#replicas'],
          ['Backups', '#backups'],
        ].map(([label, href]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <div style={{ display: 'grid', gap: 12 }}>
        <TableEditor projectId={id} />
        <ProjectDatabase projectId={id} />
        <RoutinesPanel projectId={id} />
        <ExtensionsPanel projectId={id} />
        <RlsSimulator projectId={id} />
        <ReplicasPanel projectId={id} />
        <BackupsPanel projectId={id} />
      </div>
    </div>
  );
}
