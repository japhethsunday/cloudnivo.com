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
        <h2>API</h2>
        <p>REST endpoints, generated from your tables as you change them.</p>
      </div>
      <ApiPanel projectId={id} />
    </div>
  );
}
