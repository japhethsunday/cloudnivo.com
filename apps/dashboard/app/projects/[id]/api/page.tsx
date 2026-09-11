'use client';

import { use } from 'react';
import { ApiPanel } from '../../../../components/ApiPanel';

export default function ProjectApiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>API &amp; keys</h2>
      <p className="muted">
        Auto-generated REST over your Postgres tables. Responses follow the platform envelope{' '}
        <code>{'{ data, meta }'}</code> / <code>{'{ error }'}</code>.
      </p>
      <ApiPanel projectId={id} />
    </div>
  );
}
