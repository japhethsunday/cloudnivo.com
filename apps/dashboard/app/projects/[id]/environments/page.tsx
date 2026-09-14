'use client';

import { use } from 'react';
import { BranchesPanel, VaultPanel } from '../../../../components/AdvancedPanels';

export default function ProjectEnvironmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project · Environments</p>
        <h2>Environments</h2>
        <p>
          Full-database branches, preview environments with auto-branch, and the project vault for
          secrets — all scoped to this project. The header switcher keeps production styling
          distinct from previews.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <BranchesPanel projectId={id} />
        <VaultPanel projectId={id} />
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Manage pointers in Settings</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Environment pointers (name, slug, branch pin) live under{' '}
            <a href={`/projects/${id}/settings#environments`}>Project Settings → Environments</a>.
            Database power tools (extensions, advisors, types, diff, restore, import, RLS
            simulation) live under <a href={`/projects/${id}/database`}>Database</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
