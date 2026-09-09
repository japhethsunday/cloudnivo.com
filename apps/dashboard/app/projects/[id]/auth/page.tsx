'use client';

import Link from 'next/link';
import { use } from 'react';
import { AuthPanel } from '../../../../components/AuthPanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectAuthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="auth-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link> ·{' '}
        <Link href={`/projects/${id}/api`}>API console</Link>
      </p>
      <h1 id="auth-title">Authentication</h1>
      <p className="muted">
        Per-project application users. Sign in here with your platform session — customer passwords
        and secrets are never displayed.
      </p>
      <TokenBar onChange={() => undefined} />
      <AuthPanel projectId={id} />
    </section>
  );
}
