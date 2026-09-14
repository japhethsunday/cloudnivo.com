'use client';

import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { ErrorState } from './States';

/** Real auth-flow testers: OTP, magic link, phone/SMS, anonymous, TOTP MFA, verify/reset. */
export function AuthFlowsPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/auth`;
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [out, setOut] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function call(kind: string, body: unknown): Promise<void> {
    setBusy(kind);
    setError(null);
    setOut(null);
    const r = await apiFetch(`${base}/${kind}`, { method: 'POST', body });
    setBusy(null);
    if (!r.ok) setError(r.error ?? `${kind} failed`);
    else setOut(r.data ?? null);
  }

  return (
    <div className="card" id="auth-flows">
      <div className="section-head">
        <p className="eyebrow">Authentication · Flows</p>
        <h2 style={{ fontSize: 15 }}>OTP, magic link, phone, anonymous, MFA</h2>
        <p>
          Real OTP generation, expiry, verification and rate limiting over the configured email
          driver (memory outbox locally, Resend in production). Every action below hits the live
          project auth API.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '2 1 200px', margin: 0 }}>
            <label htmlFor="flows-email">End-user email</label>
            <input id="flows-email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" autoComplete="off" />
          </div>
          <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
            <label htmlFor="flows-phone">Phone (E.164)</label>
            <input id="flows-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" autoComplete="off" />
          </div>
          <div className="field" style={{ flex: '1 1 120px', margin: 0 }}>
            <label htmlFor="flows-code">Code / token</label>
            <input id="flows-code" value={code} onChange={e => setCode(e.target.value)} placeholder="123456" autoComplete="off" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email} onClick={() => void call('otp-request', { email })}>Send email OTP</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email || !code} onClick={() => void call('otp-verify', { email, code })}>Verify OTP</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email} onClick={() => void call('magic-request', { email })}>Send magic link</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !phone} onClick={() => void call('phone-request', { phone })}>Send SMS code</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !phone || !code} onClick={() => void call('phone-verify', { phone, code })}>Verify SMS</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void call('anonymous', {})}>Create anonymous user</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email} onClick={() => void call('mfa-enroll', { email })}>Enroll TOTP</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email || !code} onClick={() => void call('mfa-verify', { email, code })}>Verify TOTP</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email} onClick={() => void call('reset-request', { email })}>Password reset</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !email} onClick={() => void call('verify-request', { email })}>Resend verification</button>
        </div>
        {busy ? <p className="muted" role="status" style={{ fontSize: 13 }}>Calling {busy}…</p> : null}
        {error ? <ErrorState message={error} /> : null}
        {out ? <pre className="codeblock" style={{ maxHeight: 260 }}>{JSON.stringify(out, null, 2)}</pre> : null}
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Unknown action names return 404 from the API — the panel surfaces the real error so only
          working flows are exercised. Delivery status: <code>{base}/email/status</code>.
        </p>
      </div>
    </div>
  );
}
