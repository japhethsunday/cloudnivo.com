'use client';

import { use } from 'react';
import { RealtimePanel } from '../../../../components/RealtimePanel';
import { RealtimeComposer } from '../../../../components/IntegrationSections';

export default function ProjectRealtimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <h2>Realtime</h2>
        <p>Live channels for this project, and who is currently on them.</p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <RealtimeComposer projectId={id} />
        <RealtimePanel projectId={id} />
      </div>
    </div>
  );
}
