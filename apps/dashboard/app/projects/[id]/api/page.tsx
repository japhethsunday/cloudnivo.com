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
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>API</h2>
        <p>
          Auto-generated REST over your Postgres tables. Responses follow the platform envelope{' '}
          <code>{'{ data, meta }'}</code> / <code>{'{ error }'}</code>.
        </p>
      </div>
      <ApiPanel projectId={id} />
    </div>
  );
}
