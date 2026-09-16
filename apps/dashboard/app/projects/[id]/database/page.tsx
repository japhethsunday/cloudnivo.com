'use client';

import { use } from 'react';
import { ProjectDatabase, SchemaPanel } from '../../../../components/ProjectDatabase';
import {
  BackupsPanel,
  ExtensionsPanel,
  ReplicasPanel,
  RlsSimulator,
  RoutinesPanel,
  TableEditor,
} from '../../../../components/DatabaseSections';
import { SectionTabs } from '../../../../components/SectionTabs';

/**
 * One view at a time.
 *
 * This page used to render all seven panels at once — table editor,
 * connection, routines, extensions, RLS simulator, replicas, backups — down a
 * single scroll, with a "Jump to" strip on top to cope with the length and
 * sidebar links that were anchors into the same dump. Authentication already
 * had the answer in this codebase: `?tab=` sections, deep-linkable, one
 * subject on screen. Database now uses the same grammar, so the two sections
 * stop behaving like two different products.
 */
const TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'tables', label: 'Table editor' },
  { id: 'routines', label: 'Routines' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'rls', label: 'Row-level security' },
  { id: 'replicas', label: 'Replicas' },
  { id: 'backups', label: 'Backups' },
];

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
        <p>A Postgres instance of your own, with its schema, policies and backups.</p>
      </div>
      <SectionTabs
        tabs={TABS}
        initial="connection"
        param="tab"
        label="Database sections"
        render={active => {
          if (active === 'tables')
            return (
              <div style={{ display: 'grid', gap: 12 }}>
                <TableEditor projectId={id} />
                <SchemaPanel projectId={id} />
              </div>
            );
          if (active === 'routines') return <RoutinesPanel projectId={id} />;
          if (active === 'extensions') return <ExtensionsPanel projectId={id} />;
          if (active === 'rls') return <RlsSimulator projectId={id} />;
          if (active === 'replicas') return <ReplicasPanel projectId={id} />;
          if (active === 'backups') return <BackupsPanel projectId={id} />;
          return <ProjectDatabase projectId={id} mode="connection" />;
        }}
      />
    </div>
  );
}
