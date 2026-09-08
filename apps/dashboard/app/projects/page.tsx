import { EmptyState } from '../../components/States';

export default function ProjectsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="projects-title">
      <div className="topbar">
        <div>
          <h1 id="projects-title" style={{ margin: 0 }}>
            Projects
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Each project gets isolated infrastructure per environment.
          </p>
        </div>
        <button type="button" className="btn btn-primary">
          New project
        </button>
      </div>
      <EmptyState
        title="No projects in this organization"
        hint="Projects are always scoped to an organization — you can never see another org's projects."
      />
    </section>
  );
}
