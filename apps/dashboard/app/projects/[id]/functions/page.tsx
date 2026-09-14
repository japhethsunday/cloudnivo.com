'use client';

import { use } from 'react';
import { FunctionsPanel } from '../../../../components/FunctionsPanel';
import { SectionCapabilities } from '../../../../components/SectionCapabilities';

export default function ProjectFunctionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Functions</h2>
        <p>
          Serverless functions run your backend code in isolated runtimes — scoped to this project,
          versioned on every deploy, never across projects.
        </p>
      </div>
      <FunctionsPanel projectId={id} />
      <SectionCapabilities category="Functions" projectId={id} />
    </div>
  );
}
