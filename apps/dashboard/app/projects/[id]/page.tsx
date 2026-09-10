'use client';

import Link from 'next/link';
import { use } from 'react';
import { ProjectDatabase } from '../../../components/ProjectDatabase';
import { TokenBar } from '../../../components/ProjectForms';

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <section aria-labelledby="project-title">
      <p>
        <Link href="/projects">← Projects</Link>
      </p>
      <h1 id="project-title">Project database</h1>
      <p>
        <Link className="btn btn-primary" href={`/projects/${id}/api`}>
          Open API console
        </Link>{' '}
        <Link className="btn" href={`/projects/${id}/auth`}>
          Authentication
        </Link>{' '}
        <Link className="btn" href={`/projects/${id}/storage`}>
          Storage
        </Link>{' '}
        <Link className="btn" href={`/projects/${id}/realtime`}>
          Realtime
        </Link>{' '}
        <Link className="btn" href={`/projects/${id}/functions`}>
          Functions
        </Link>{' '}
        <Link className="btn btn-primary" href={`/projects/${id}/ai`}>
          AI Builder
        </Link>
      </p>
      <TokenBar onChange={() => undefined} />
      <ProjectDatabase projectId={id} />
    </section>
  );
}
