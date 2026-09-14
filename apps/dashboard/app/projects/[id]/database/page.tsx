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
        <p className="eyebrow">Project · Database</p>
        <h2>Database</h2>
        <p>
          Isolated PostgreSQL per project — table editor, schemas, routines, extensions, RLS
          simulation, replicas and backups, all against the live database.
        </p>
      </div>
      <nav aria-label="Database sections" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {[
          ['Table Editor', '#table-editor'],
          ['Routines', '#routines'],
          ['Extensions', '#extensions'],
          ['RLS', '#rls'],
          ['Replicas', '#replicas'],
          ['Backups', '#backups'],
        ].map(([label, href]) => (
          <a key={href} className="btn btn-sm" href={href}>{label}</a>
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
