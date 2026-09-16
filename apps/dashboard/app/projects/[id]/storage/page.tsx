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
      {/* The description used to list the feature set back to the operator
          ("buckets, files, upload/download, move/copy, policies and signed
          URLs"). It says what the page is for instead. Move and copy now live
          on the file they act on, so the standalone path-form panel is gone. */}
      <div className="section-head">
        <h2>Storage</h2>
        <p>Files for this project, kept in buckets you control access to.</p>
      </div>
      <StoragePanel projectId={id} />
    </div>
  );
}
