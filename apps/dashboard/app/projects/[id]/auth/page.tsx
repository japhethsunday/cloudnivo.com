'use client';

import { use } from 'react';
import { AuthPanel } from '../../../../components/AuthPanel';

export default function ProjectAuthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Authentication</h2>
        <p>
          Per-project application users. You are signed in with your platform session — customer
          passwords and secrets are never displayed.
        </p>
      </div>
      <AuthPanel projectId={id} />
    </div>
  );
}
