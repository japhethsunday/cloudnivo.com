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
        <p className="eyebrow">Project</p>
        <h2>AI Builder</h2>
        <p>
          Describe → plan → review → approve → apply. CloudNivo drafts a validated plan, shows every
          change, and applies it only after your approval. Nothing executes silently.
        </p>
      </div>
      <AIBuilderPanel projectId={id} />
    </div>
  );
}
