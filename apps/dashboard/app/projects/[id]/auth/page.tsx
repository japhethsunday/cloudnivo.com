'use client';

import { use } from 'react';
import { AuthWorkspace } from '../../../../components/AuthWorkspace';

export default function ProjectAuthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project · Authentication</p>
        <h2>Authentication</h2>
        <p>Manage users, sign-in methods, security policies and sessions.</p>
      </div>
      <AuthWorkspace projectId={id} />
    </div>
  );
}
