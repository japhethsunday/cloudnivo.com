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
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Database</h2>
        <p>Isolated PostgreSQL with live status, schema inspection, and guarded queries.</p>
      </div>
      <ProjectDatabase projectId={id} />
    </div>
  );
}
