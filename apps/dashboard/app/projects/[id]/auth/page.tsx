'use client';

import { use } from 'react';
import { AuthPanel } from '../../../../components/AuthPanel';
import { AuthFlowsPanel } from '../../../../components/AuthFlows';

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
        <p>
          Per-project application users — directory, sessions, email OTP, magic links, phone/SMS,
          anonymous conversion and customer TOTP two-factor. You are signed in with your platform
          session; customer secrets are never displayed.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <AuthPanel projectId={id} />
        <AuthFlowsPanel projectId={id} />
      </div>
    </div>
  );
}
