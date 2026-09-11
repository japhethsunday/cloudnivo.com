'use client';

import { use } from 'react';
import { FunctionsPanel } from '../../../../components/FunctionsPanel';

export default function ProjectFunctionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Functions</h2>
      <p className="muted">
        Serverless functions run your backend code in isolated runtimes — scoped to this project,
        versioned on every deploy, never across projects.
      </p>
      <FunctionsPanel projectId={id} />
    </div>
  );
}
