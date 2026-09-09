'use client';

import Link from 'next/link';
import { use } from 'react';
import { StoragePanel } from '../../../../components/StoragePanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectStoragePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="storage-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link> ·{' '}
        <Link href={`/projects/${id}/api`}>API console</Link> ·{' '}
        <Link href={`/projects/${id}/auth`}>Authentication</Link>
      </p>
      <h1 id="storage-title">Storage</h1>
      <p className="muted">
        Buckets, files, usage, and policies. Bytes persist through the configured provider; metadata
        stays tenant-scoped.
      </p>
      <TokenBar onChange={() => undefined} />
      <StoragePanel projectId={id} />
    </section>
  );
}
