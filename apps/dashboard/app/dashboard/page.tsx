import Link from 'next/link';
import { EmptyState } from '../../components/States';

export default function DashboardPage(): React.JSX.Element {
  // Phase 1: static shell with empty states. Live data wiring lands with DB auth (Phase 2).
  const stats = [
    { label: 'Projects', value: '0' },
    { label: 'Organizations', value: '0' },
    { label: 'API keys', value: '0' },
    { label: 'Environments', value: '0' },
  ];
  return (
    <section aria-labelledby="dashboard-title">
      <div className="topbar">
        <div>
          <h1 id="dashboard-title" style={{ margin: 0 }}>
            Dashboard
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Overview of your backend infrastructure.
          </p>
        </div>
        <Link className="btn btn-primary" href="/projects">
          New project
        </Link>
      </div>
      <div className="grid" role="list" aria-label="Resource totals">
        {stats.map(s => (
          <div className="card" role="listitem" key={s.label}>
            <div className="muted">{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{s.value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <EmptyState
          title="No projects yet"
          hint="Create your first project to provision an isolated environment."
          action={
            <Link className="btn btn-primary" href="/projects">
              Create project
            </Link>
          }
        />
      </div>
    </section>
  );
}
