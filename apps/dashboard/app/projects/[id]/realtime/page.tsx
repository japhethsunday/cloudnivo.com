'use client';

import Link from 'next/link';
import { use } from 'react';
import { RealtimePanel } from '../../../../components/RealtimePanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectRealtimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="realtime-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link> ·{' '}
        <Link href={`/projects/${id}/api`}>API console</Link> ·{' '}
        <Link href={`/projects/${id}/auth`}>Authentication</Link> ·{' '}
        <Link href={`/projects/${id}/storage`}>Storage</Link>
      </p>
      <h1 id="realtime-title">Realtime</h1>
      <p className="muted">
        Live connections, channels, events, presence, and usage. Events travel over real WebSocket
        connections scoped to this project — never across projects.
      </p>
      <TokenBar onChange={() => undefined} />
      <RealtimePanel projectId={id} />
    </section>
  );
}
