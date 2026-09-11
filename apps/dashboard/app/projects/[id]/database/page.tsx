'use client';

import { use } from 'react';
import { ProjectDatabase } from '../../../../components/ProjectDatabase';

export default function ProjectDatabasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Database</h2>
      <p className="muted">Isolated PostgreSQL with live status, schema inspection, and guarded queries.</p>
      <ProjectDatabase projectId={id} />
    </div>
  );
}
