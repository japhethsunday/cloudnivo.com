'use client';

import { use } from 'react';
import { StoragePanel } from '../../../../components/StoragePanel';
import { StorageOps } from '../../../../components/IntegrationSections';

export default function ProjectStoragePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project · Storage</p>
        <h2>Storage</h2>
        <p>
          Buckets, files, upload/download, move/copy, policies and signed URLs. Bytes persist
          through the configured provider; metadata stays tenant-scoped.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <StoragePanel projectId={id} />
        <StorageOps projectId={id} />
      </div>
    </div>
  );
}
