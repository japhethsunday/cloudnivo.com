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
      <h2 style={{ marginTop: 0 }}>Realtime</h2>
      <p className="muted">
        Live connections, channels, events, presence, and usage. Events travel over real WebSocket
        connections scoped to this project — never across projects.
      </p>
      <RealtimePanel projectId={id} />
    </div>
  );
}
