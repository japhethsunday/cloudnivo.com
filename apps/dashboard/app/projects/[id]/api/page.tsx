'use client';

import Link from 'next/link';
import { use } from 'react';
import { ApiPanel } from '../../../../components/ApiPanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectApiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="api-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link>
      </p>
      <h1 id="api-title">Project API</h1>
      <p className="muted">
        Auto-generated REST over your Postgres tables. Responses follow the platform envelope{' '}
        <code>{'{ data, meta }'}</code> / <code>{'{ error }'}</code>.
      </p>
      <TokenBar onChange={() => undefined} />
      <ApiPanel projectId={id} />
    </section>
  );
}
