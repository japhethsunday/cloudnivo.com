export default function AccountPage(): React.JSX.Element {
  return (
    <section aria-labelledby="account-title">
      <h1 id="account-title">Account</h1>
      <p className="muted">Session, memberships, and API keys for your user.</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Session</h2>
        <p className="muted">
          Signed in via control-plane session (JWT). Authorization is verified server-side on every
          request.
        </p>
      </div>
    </section>
  );
}
