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
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>SQL editor</h2>
        <p>Guarded execution against this project&apos;s database. Results never leave your session.</p>
      </div>
      <ProjectDatabase projectId={id} mode="query" />
    </div>
  );
}
