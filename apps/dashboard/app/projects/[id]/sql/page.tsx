'use client';

import { use } from 'react';
import { ProjectDatabase } from '../../../../components/ProjectDatabase';

export default function ProjectSqlPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>SQL editor</h2>
      <p className="muted">Guarded execution against this project&apos;s database. Results never leave your session.</p>
      <ProjectDatabase projectId={id} mode="query" />
    </div>
  );
}
