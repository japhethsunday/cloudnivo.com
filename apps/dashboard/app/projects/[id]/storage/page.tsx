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
      <h2 style={{ marginTop: 0 }}>Storage</h2>
      <p className="muted">
        Buckets, files, usage, and policies. Bytes persist through the configured provider; metadata
        stays tenant-scoped.
      </p>
      <StoragePanel projectId={id} />
    </div>
  );
}
