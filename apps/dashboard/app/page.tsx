import Link from 'next/link';

export default function Home(): React.JSX.Element {
  return (
    <section aria-labelledby="home-title">
      <p className="muted">Backend-as-a-Service control plane · Phase 1</p>
      <h1 id="home-title">Ship backends without managing infrastructure</h1>
      <p className="muted">
        CloudNivo gives every project isolated Postgres, auth, storage, realtime, and versioned APIs
        — starting local-first with Docker, portable to any cloud later.
      </p>
      <p style={{ display: 'flex', gap: 8 }}>
        <Link className="btn btn-primary" href="/dashboard">
          Open dashboard
        </Link>
        <Link className="btn" href="/projects">
          View projects
        </Link>
      </p>
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <strong>Multi-tenant by design</strong>
          <p className="muted">User → Organization → Project → Infrastructure.</p>
        </div>
        <div className="card">
          <strong>Versioned API</strong>
          <p className="muted">Consistent envelope, validation, and audit logging.</p>
        </div>
        <div className="card">
          <strong>Local-first</strong>
          <p className="muted">Postgres + Redis via Docker. No paid services required.</p>
        </div>
      </div>
    </section>
  );
}
