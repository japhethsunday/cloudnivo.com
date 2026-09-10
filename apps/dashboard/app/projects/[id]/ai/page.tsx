'use client';

import Link from 'next/link';
import { use } from 'react';
import { AIBuilderPanel } from '../../../../components/AIBuilderPanel';
import { TokenBar } from '../../../../components/ProjectForms';

export default function ProjectAIPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="ai-title">
      <p>
        <Link href={`/projects/${id}`}>← Project database</Link> ·{' '}
        <Link href={`/projects/${id}/api`}>API console</Link> ·{' '}
        <Link href={`/projects/${id}/auth`}>Authentication</Link> ·{' '}
        <Link href={`/projects/${id}/storage`}>Storage</Link> ·{' '}
        <Link href={`/projects/${id}/realtime`}>Realtime</Link> ·{' '}
        <Link href={`/projects/${id}/functions`}>Functions</Link>
      </p>
      <h1 id="ai-title">AI Builder</h1>
      <p className="muted">
        Describe the backend you need — CloudNivo drafts a validated plan, shows every change, and
        applies it only after your approval. Nothing executes silently.
      </p>
      <TokenBar onChange={() => undefined} />
      <AIBuilderPanel projectId={id} />
    </section>
  );
}
