'use client';

import { use } from 'react';
import { AIBuilderPanel } from '../../../../components/AIBuilderPanel';

export default function ProjectAIPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <h2>AI Builder</h2>
        <p>Describe what you need. Nothing runs until you approve the plan.</p>
      </div>
      <AIBuilderPanel projectId={id} />
    </div>
  );
}
