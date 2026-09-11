'use client';

import { useRouter } from 'next/navigation';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState } from '../../components/States';
import { Badge } from '../../components/ui';

export default function AccountPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AccountBody />
    </RequireAuth>
  );
}

function AccountBody(): React.JSX.Element {
  const { user, orgs, logout } = useSession();
  const router = useRouter();

  function doLogout(): void {
    logout();
    router.replace('/login');
  }

  return (
    <section aria-labelledby="account-title">
      <div className="page-head">
        <div>
          <h1 id="account-title">Account</h1>
          <p className="sub muted">Session, memberships, and sign-out.</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={doLogout}>
          Log out
        </button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Profile</h2>
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">Email</th>
              <td>{user?.email ?? '—'}</td>
            </tr>
            {user?.displayName ? (
              <tr>
                <th scope="row">Display name</th>
                <td>{user.displayName}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">User ID</th>
              <td>
                <code>{user?.id ?? '—'}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Session</th>
              <td>
                <Badge tone="ok">active</Badge>{' '}
                <span className="muted" style={{ fontSize: 13 }}>
                  Short-lived signed token, stored only in this browser. Authorization is verified
                  server-side on every request.
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Organization memberships</h2>
        {orgs.length === 0 ? (
          <EmptyState title="No memberships" hint="Create or join an organization to get started." />
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map(o => (
                  <tr key={o.id}>
                    <td>
                      {o.name}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {o.slug}
                      </div>
                    </td>
                    <td>
                      <Badge tone={o.role === 'owner' ? 'info' : 'muted'}>{o.role}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
