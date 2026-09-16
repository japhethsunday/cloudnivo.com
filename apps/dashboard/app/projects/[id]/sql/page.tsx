'use client';

import { use } from 'react';
import { ProjectDatabase } from '../../../../components/ProjectDatabase';
import { SectionCapabilities } from '../../../../components/SectionCapabilities';

export default function ProjectSqlPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <h2>SQL editor</h2>
        <p>Guarded execution against this project&apos;s database. Results never leave your session.</p>
      </div>
      <ProjectDatabase projectId={id} mode="query" />
      <SectionCapabilities category="Database" projectId={id} />
    </div>
  );
}
