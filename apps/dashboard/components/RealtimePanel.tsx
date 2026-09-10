'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase, apiFetch, getToken } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

interface RealtimeInfo {
  ws: string;
  drivers: { bus: string; presence: string };
  degraded: boolean;
}

interface RealtimeStats {
  connections: number;
  subscriptions: number;
  eventsPublished: number;
  eventsDelivered: number;
  eventsDropped: number;
  broadcasts: number;
  presenceEntries: number;
  connectionErrors: number;
  authFailures: number;
  totalLatencyMs: number;
  deliveredCount: number;
  channelCount: number;
  channels: string[];
}

interface ChannelRow {
  channel: string;
  subscribers: number;
}

function avgLatency(s: RealtimeStats): string {
  if (!s.deliveredCount) return '—';
  return `${(s.totalLatencyMs / s.deliveredCount).toFixed(1)} ms`;
}

function wsUrl(path: string, token: string): string {
  const base = apiBase().replace(/^http/, 'ws');
  const url = new URL(`${base}${path}`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export function RealtimePanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/realtime`;
  const [info, setInfo] = useState<RealtimeInfo | null>(null);
  const [stats, setStats] = useState<RealtimeStats | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [presence, setPresence] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [smoke, setSmoke] = useState<string>('Not run yet.');
  const [smokeBusy, setSmokeBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  const load = useCallback(async () => {
    const [i, s, c, p] = await Promise.all([
      apiFetch<RealtimeInfo>(`${base}`),
      apiFetch<{ stats: RealtimeStats }>(`${base}/stats`),
      apiFetch<{ channels: ChannelRow[] }>(`${base}/channels`),
      apiFetch<{ presence: Record<string, unknown> }>(`${base}/presence`),
    ]);
    if (!i.ok) {
      setError(i.error);
      setLoaded(true);
      return;
    }
    setInfo(i.data);
    if (s.ok && s.data) setStats(s.data.stats);
    if (c.ok && c.data) setChannels(c.data.channels);
    if (p.ok && p.data) setPresence(p.data.presence);
    setError(null);
    setLoaded(true);
  }, [base]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    return () => {
      try {
        socketRef.current?.close(1000, 'done');
      } catch {
        // Already gone.
      }
      socketRef.current = null;
    };
  }, []);

  /** Live smoke test: real WS connect → subscribe → ping against this project. */
  async function runSmoke(): Promise<void> {
    if (!info) return;
    setSmokeBusy(true);
    setSmoke('Connecting…');
    try {
      socketRef.current?.close(1000, 'done');
    } catch {
      // Ignore.
    }
    const url = wsUrl(info.ws, getToken());
    const socket = new WebSocket(url);
    socketRef.current = socket;
    const channel = `project:${projectId}:smoke`;
    const timer = setTimeout(() => {
      setSmoke('Timed out waiting for pong — is the API running?');
      try {
        socket.close(1000, 'done');
      } catch {
        // Ignore.
      }
      setSmokeBusy(false);
    }, 8000);
    socket.onopen = () => {
      setSmoke('Connected. Subscribing…');
      socket.send(JSON.stringify({ id: 'smoke-sub', type: 'subscribe', channel }));
    };
    socket.onmessage = ev => {
      let msg: { id?: string; type?: string };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id === 'smoke-sub' && msg.type === 'subscribed') {
        setSmoke('Subscribed. Pinging…');
        socket.send(JSON.stringify({ id: 'smoke-ping', type: 'ping' }));
      } else if (msg.id === 'smoke-ping' && msg.type === 'pong') {
        clearTimeout(timer);
        setSmoke('OK: connected, subscribed, heartbeat answered. Realtime is live.');
        setSmokeBusy(false);
        try {
          socket.close(1000, 'done');
        } catch {
          // Ignore.
        }
        void load();
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        setSmoke(`Server rejected the smoke test: ${String(ev.data).slice(0, 160)}`);
        setSmokeBusy(false);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      setSmoke('WebSocket error — check the API URL and your token.');
      setSmokeBusy(false);
    };
  }

  if (!loaded) return <LoadingSkeleton label="Loading realtime" />;
  if (error && !info) return <ErrorState message={error} />;

  return (
    <div>
      {error ? <ErrorState message={error} /> : null}

      <h2>Overview</h2>
      {info ? (
        <dl>
          <div>
            <dt>WebSocket endpoint</dt>
            <dd>
              <code>{info.ws}</code>
            </dd>
          </div>
          <div>
            <dt>Event bus / presence drivers</dt>
            <dd>
              <code>
                {info.drivers.bus} / {info.drivers.presence}
              </code>
              {info.degraded ? ' (Redis degraded — local-only delivery)' : ''}
            </dd>
          </div>
        </dl>
      ) : (
        <EmptyState title="No realtime info" hint="The realtime service did not answer." />
      )}

      <h2>Connections</h2>
      {stats ? (
        <p role="status">
          {stats.connections} active connection{stats.connections === 1 ? '' : 's'} ·{' '}
          {stats.subscriptions} subscription{stats.subscriptions === 1 ? '' : 's'} ·{' '}
          {stats.channelCount} channel{stats.channelCount === 1 ? '' : 's'} · avg fan-out latency{' '}
          {avgLatency(stats)}
        </p>
      ) : (
        <EmptyState title="No connection data" hint="Connect a client to see live connections." />
      )}

      <h2>Channels</h2>
      {channels && channels.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Subscribers</th>
            </tr>
          </thead>
          <tbody>
            {channels.map(c => (
              <tr key={c.channel}>
                <td>
                  <code>{c.channel}</code>
                </td>
                <td>{c.subscribers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No active channels"
          hint="Channels appear when a client subscribes, e.g. project:<id>:chat or project:<id>:table:messages."
        />
      )}

      <h2>Events</h2>
      {stats ? (
        <dl>
          <div>
            <dt>Published / delivered / dropped</dt>
            <dd>
              {stats.eventsPublished} / {stats.eventsDelivered} / {stats.eventsDropped}
            </dd>
          </div>
          <div>
            <dt>Broadcasts</dt>
            <dd>{stats.broadcasts}</dd>
          </div>
          <div>
            <dt>Presence entries</dt>
            <dd>{stats.presenceEntries}</dd>
          </div>
          <div>
            <dt>Connection errors / auth failures</dt>
            <dd>
              {stats.connectionErrors} / {stats.authFailures}
            </dd>
          </div>
        </dl>
      ) : (
        <EmptyState title="No event data" hint="Publish a broadcast to see volume here." />
      )}
      {presence && Object.keys(presence).length > 0 ? (
        <details>
          <summary>Presence state ({Object.keys(presence).length} channels)</summary>
          <pre>{JSON.stringify(presence, null, 2).slice(0, 4000)}</pre>
        </details>
      ) : null}

      <h2>Usage</h2>
      <p className="muted">
        Server-enforced limits (configurable via environment): 500 connections per project, 50
        subscriptions per connection, 64 KB max payload, 20 messages/second per connection, 60
        broadcasts/minute per sender. Upgrade floods are rate-limited per IP.
      </p>

      <h2>Settings</h2>
      <p className="muted">
        Driver: <code>REALTIME_DRIVER</code> (<code>memory</code> for local dev, <code>redis</code>{' '}
        for multi-instance production with <code>REDIS_URL</code>). Standalone service on{' '}
        <code>REALTIME_PORT</code> (set <code>REALTIME_STANDALONE=true</code> for an independent
        Railway service). Heartbeats, payload caps, and broadcast budgets are environment-driven —
        see <code>docs/realtime.md</code>.
      </p>

      <h2>Live check</h2>
      <p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => void runSmoke()}
          disabled={smokeBusy || !info}
        >
          {smokeBusy ? 'Testing…' : 'Run connection smoke test'}
        </button>
      </p>
      <p role="status" className="muted">
        {smoke}
      </p>
    </div>
  );
}
