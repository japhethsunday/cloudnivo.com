'use client';

import { use } from 'react';
import { StoragePanel } from '../../../../components/StoragePanel';

export default function ProjectStoragePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Storage</h2>
        <p>
          Buckets, files, usage, and policies. Bytes persist through the configured provider; metadata
          stays tenant-scoped.
        </p>
      </div>
      <StoragePanel projectId={id} />
    </div>
  );
}
