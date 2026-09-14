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
        <p className="eyebrow">Project · Realtime</p>
        <h2>Realtime</h2>
        <p>
          Project-scoped channels, broadcast, presence and monitoring — over one authenticated
          socket per project. Postgres change feeds fan out on subscribe.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <RealtimeComposer projectId={id} />
        <RealtimePanel projectId={id} />
      </div>
    </div>
  );
}
