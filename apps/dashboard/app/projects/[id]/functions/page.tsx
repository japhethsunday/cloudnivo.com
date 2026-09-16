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
      <div className="section-head">
        <h2>Functions</h2>
        <p>Your code, running on demand. Every deploy keeps its own version.</p>
      </div>
      <FunctionsPanel projectId={id} />
    </div>
  );
}
