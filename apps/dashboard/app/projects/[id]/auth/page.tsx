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
      <h2 style={{ marginTop: 0 }}>Authentication</h2>
      <p className="muted">
        Per-project application users. You are signed in with your platform session — customer
        passwords and secrets are never displayed.
      </p>
      <AuthPanel projectId={id} />
    </div>
  );
}
