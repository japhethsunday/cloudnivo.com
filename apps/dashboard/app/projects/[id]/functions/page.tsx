'use client';

import Link from 'next/link';
import { use } from 'react';
import { FunctionsPanel } from '../../../../components/FunctionsPanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectFunctionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="functions-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link> ·{' '}
        <Link href={`/projects/${id}/api`}>API console</Link> ·{' '}
        <Link href={`/projects/${id}/auth`}>Authentication</Link> ·{' '}
        <Link href={`/projects/${id}/storage`}>Storage</Link> ·{' '}
        <Link href={`/projects/${id}/realtime`}>Realtime</Link>
      </p>
      <h1 id="functions-title">Functions</h1>
      <p className="muted">
        Serverless functions run your backend code in isolated runtimes — scoped to this project,
        versioned on every deploy, never across projects.
      </p>
      <TokenBar onChange={() => undefined} />
      <FunctionsPanel projectId={id} />
    </section>
  );
}
