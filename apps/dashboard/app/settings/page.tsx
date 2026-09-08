export default function SettingsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <p className="muted">Workspace preferences, CORS origins, and rate-limit defaults.</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Environment</h2>
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">API base</th>
              <td>
                <code>/api/v1</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Health</th>
              <td>
                <code>/api/v1/health</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Theme</th>
              <td>System / Light / Dark (toggle in sidebar)</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
