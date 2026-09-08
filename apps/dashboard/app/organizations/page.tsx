import { EmptyState } from '../../components/States';

export default function OrganizationsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="orgs-title">
      <div className="topbar">
        <div>
          <h1 id="orgs-title" style={{ margin: 0 }}>
            Organizations
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Tenancy boundary: memberships grant access, nothing else does.
          </p>
        </div>
        <button type="button" className="btn btn-primary">
          New organization
        </button>
      </div>
      <EmptyState
        title="You are not in an organization yet"
        hint="Create one to start inviting members with owner / admin / member / viewer roles."
      />
    </section>
  );
}
