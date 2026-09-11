'use client';

import { apiBase } from '../../lib/api';
import { useTheme } from '../../components/ThemeProvider';
import { RequireAuth } from '../../components/RequireAuth';

export default function SettingsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <section aria-labelledby="settings-title">
        <div className="page-head">
          <div>
            <h1 id="settings-title">Settings</h1>
            <p className="sub muted">Workspace preferences and environment information.</p>
          </div>
        </div>
        <div className="card" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0 }}>Appearance</h2>
          <ThemeSetting />
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Environment</h2>
          <table className="table">
            <tbody>
              <tr>
                <th scope="row">API base</th>
                <td>
                  <code>{apiBase()}/api/v1</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Health</th>
                <td>
                  <code>{apiBase()}/api/v1/health</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 13 }}>
            Quotas, CORS origins, and rate limits are enforced server-side and are not configurable
            from the dashboard.
          </p>
        </div>
      </section>
    </RequireAuth>
  );
}

function ThemeSetting(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div className="field" style={{ maxWidth: 280 }}>
      <label htmlFor="theme-select">Theme</label>
      <select id="theme-select" value={theme} onChange={e => setTheme(e.target.value as 'light' | 'dark' | 'system')}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}
