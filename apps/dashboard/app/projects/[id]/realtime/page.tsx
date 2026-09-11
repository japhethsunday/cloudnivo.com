'use client';

import { use } from 'react';
import { RealtimePanel } from '../../../../components/RealtimePanel';

export default function ProjectRealtimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Realtime</h2>
        <p>
          Live connections, channels, events, presence, and usage. Events travel over real WebSocket
          connections scoped to this project — never across projects.
        </p>
      </div>
      <RealtimePanel projectId={id} />
    </div>
  );
}
