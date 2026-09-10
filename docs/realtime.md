# CloudNivo Realtime (Phase 6)

Real WebSocket infrastructure: authenticated connections, project-isolated
channels, PostgreSQL change events (no polling), application broadcasts,
presence, heartbeats, Redis multi-instance fan-out, rate/size limits, and a
dashboard console. No simulated UI — events travel over real sockets between
real clients and reflect real database/application events.

## Architecture

```text
Client ──► WebSocket ──► RealtimeServer ──► RealtimeGateway ──► EventBus ──► other instances
                          (transport)        (auth/routing/       (memory local,
                                              fan-out/limits)     Redis pub/sub prod)
                                │                    │
                                │                    ├── PresenceManager (memory/Redis)
                                │                    └── DatabaseChangeListener ──► PostgreSQL LISTEN
                                └── upgrade auth (session JWT | customer JWT | project key)
```

Package map (`packages/realtime/src`):

| Module        | Role                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`    | Wire envelopes, `DbChangeEvent`, channel grammar, safe filter parsing                                                                           |
| `protocol.ts` | Dependency-free RFC 6455 codec (handshake key, masked frames, fragmentation, size caps)                                                         |
| `authz.ts`    | Pure server-side policy: `canSubscribe/Broadcast/TrackPresence/Receive/WatchTable`, `matchesFilter`                                             |
| `bus.ts`      | `MemoryEventBus` (dev/test) + `RedisEventBus` (prod pub/sub, degrade-to-local, no echo)                                                         |
| `presence.ts` | `MemoryPresenceManager` + `RedisPresenceManager` (hash-per-channel, TTL, no permanent rows)                                                     |
| `gateway.ts`  | Transport-agnostic routing, fan-out, limits, metrics, heartbeat/expiry sweep                                                                    |
| `server.ts`   | Raw-socket WS server: upgrade auth, frame loop, cleanup, graceful shutdown                                                                      |
| `service.ts`  | `RealtimeService` facade (`subscribe/unsubscribe/broadcast/trackPresence/removePresence/getPresence/publishDatabaseChange/getConnectionStatus`) |
| `client.ts`   | Framework-independent SDK sketch (`channel().on/subscribe/broadcast/track/presence/unsubscribe`, auto-reconnect)                                |
| `openapi.ts`  | HTTP management path fragments merged into `openapi.json`                                                                                       |

Change capture (`packages/database/src/realtime-cdc.ts`): per-table triggers
`NOTIFY cloudnivo_changes` with row JSON; one multiplexed `LISTEN` connection
per project database with bounded reconnects. The API (`apps/api/src/realtime.ts`)
installs triggers lazily on first table subscribe and publishes notifications
into the gateway, which applies per-subscriber authorization at fan-out.

## WebSocket protocol

- Endpoint: `GET /api/v1/projects/:id/realtime/ws?token=<JWT>` or `?apikey=<key>`
  (query params — browsers cannot set WS headers). `101` on success, `401/403/404/429`
  otherwise, never upgraded on failure.
- Frames are JSON text: `{ id?, type, channel?, event?, data?, filter? }`.
  `id` correlates acks/errors; server replies carry the same `id`.
- Client types: `subscribe` / `unsubscribe` / `broadcast` / `presence.set` /
  `presence.remove` / `ping`. Server types: `subscribed` / `unsubscribed` /
  `event` / `broadcast` / `presence` / `pong` / `error`
  (`{ error: { code, message } }`, platform envelope convention).
- `ping` → `pong` (also refreshes `lastHeartbeat`). Protocol `ping` frames are
  answered with `pong` automatically. Fragmented messages reassemble up to
  `maxPayloadBytes`; oversized frames are rejected, never buffered unboundedly.
- Reconnect: the SDK client re-subscribes automatically with bounded exponential
  backoff (default 8 attempts, 30 s cap). The server sweeps stale connections
  every heartbeat interval and drops credential-expired ones.

## Channels

Grammar: `project:<project-uuid>:<topic>` — the project binding is structural,
so cross-project subscription is impossible by shape (verified again in
`canSubscribe`). App topics are free-form (`chat`, `notifications`, `orders`);
table topics are `table:<name>` and subscribe to row changes for that table.

## Database events

Subscribe to `project:<id>:table:messages` and every `INSERT`/`UPDATE`/`DELETE`
on `public.messages` in the project's own database fans out as:

```json
{
  "type": "event",
  "channel": "project:<id>:table:messages",
  "event": "INSERT",
  "data": {
    "type": "INSERT",
    "project_id": "<id>",
    "table": "messages",
    "schema": "public",
    "record": { "id": 1 },
    "old_record": null,
    "timestamp": "..."
  }
}
```

`UPDATE` carries both `record` and `old_record`; `DELETE` carries `old_record`
only. Delivery re-checks `canReceive` per subscriber (owner-scoped tables such
as `user_id` deliver only the owner's rows to `authenticated` customers;
operators/service roles see project data — same rule as the data plane).

Optional equality `filter` on subscribe, e.g.
`{ type: "subscribe", channel: "project:<id>:table:orders", filter: { "user_id": "123" } }`:
validated keys (`^[a-z_][a-z0-9_]{0,62}$`, ≤8 entries, primitive values ≤256
chars), enforced in JS at fan-out. Filters never become SQL.

## Broadcast

`{ type: "broadcast", channel, event, data }` — `event` is a ≤80-char name,
`data` is arbitrary JSON within the payload cap. Viewers/anonymous/public keys
may listen but never speak (`FORBIDDEN`). The sender gets an ack only; every
other subscriber on the channel receives `{ type: "broadcast", channel, event, data }`.

## Presence

`presence.set` tracks `{ user_id, status, metadata }` (metadata ≤4 KB) and
implies a channel join; `presence.remove` leaves; disconnect/unsubscribe removes
automatically. State is served per channel over HTTP and pushed as
`{ type: "presence", event: "join"|"leave", ... }` to subscribers. Redis stores
one hash per channel with TTL — no permanent records.

## Authentication / authorization

Upgrade credentials resolve exactly like the data plane: customer JWT
(audience-bound, live session/revocation check), platform session JWT
(membership check), or project API key (scope/expiry/revocation check).
Handshake failures return HTTP errors; per-message decisions use
`canConnect/canSubscribe/canReceive/canBroadcast/canTrackPresence` — pure
server-side functions, never frontend state. Expired credentials are rejected
at upgrade (`401`) and swept mid-connection (`expiresAt` from JWT `exp` or key
`expiresAt`); clients re-authenticate and reconnect.

## Rate limits / size limits

Upgrades share the auth flood budget (`rt-conn:<ip>`, `AUTH_RATE_MAX`/window).
Per connection: `REALTIME_MAX_MSG_PER_SECOND` (default 20/s),
`REALTIME_MAX_BROADCASTS_PER_MINUTE` (default 60/min, per sender),
`REALTIME_MAX_SUBS_PER_CONN` (default 50), `REALTIME_MAX_CONNS_PER_PROJECT`
(default 500), `REALTIME_MAX_PAYLOAD_BYTES` (default 64 KB, frames + JSON +
broadcast data + presence metadata sub-cap 4 KB). Violations return
`RATE_LIMITED` / `PAYLOAD_TOO_LARGE` / `SUBSCRIPTION_LIMIT` — the connection
stays alive except for protocol violations (malformed frames close safely).

## Scaling

One process works (memory bus/presence). For N instances set
`REALTIME_DRIVER=redis` + `REDIS_URL`: every local event publishes to Redis
pub/sub with an origin id (no echo), remote instances deliver to their local
subscribers; presence unions via Redis hashes. Redis outages degrade to
local-only delivery (counted, logged, surfaced as `degraded: true`) with bounded
reconnect — realtime never hard-depends on Redis to stay up. Connection state
stays per-instance; event distribution, change capture, authz, and presence are
separate boundaries (see `service.ts`).

## Railway deployment

Same code runs in-process on the API port (default) and standalone on
`REALTIME_PORT` (`apps/api/src/realtime-standalone.ts`, `npm run dev:realtime`,
health at `/api/v1/health`). For an independent Railway service deploy the same
image with `REALTIME_STANDALONE=true`, `REALTIME_DRIVER=redis`, `REDIS_URL`,
`DATABASE_URL`, JWT/CORS settings, and the `REALTIME_*` budgets. No
localhost/process-memory/filesystem dependence in production paths.

## Environment variables

| Var                                  | Default  | Purpose                                        |
| ------------------------------------ | -------- | ---------------------------------------------- |
| `REALTIME_DRIVER`                    | `memory` | `memory` dev/test, `redis` prod multi-instance |
| `REALTIME_PORT`                      | `3002`   | Standalone WS port                             |
| `REALTIME_STANDALONE`                | `false`  | Run the dedicated realtime service             |
| `REALTIME_HEARTBEAT_MS`              | `25000`  | Sweep interval                                 |
| `REALTIME_HEARTBEAT_TIMEOUT_MS`      | `60000`  | Stale-connection drop threshold                |
| `REALTIME_MAX_CONNS_PER_PROJECT`     | `500`    | Per-project connection cap                     |
| `REALTIME_MAX_SUBS_PER_CONN`         | `50`     | Subscriptions per socket                       |
| `REALTIME_MAX_PAYLOAD_BYTES`         | `65536`  | Frame/message/broadcast cap                    |
| `REALTIME_MAX_MSG_PER_SECOND`        | `20`     | Per-socket message budget                      |
| `REALTIME_MAX_BROADCASTS_PER_MINUTE` | `60`     | Per-sender broadcast budget                    |

## HTTP management (session members)

| Method | Path                                     | Description                                                                                                                 |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/projects/:id/realtime`          | WS URL, drivers, `degraded` flag                                                                                            |
| `GET`  | `/api/v1/projects/:id/realtime/stats`    | Metrics snapshot (connections, subscriptions, channels, published/delivered/dropped, broadcasts, presence, errors, latency) |
| `GET`  | `/api/v1/projects/:id/realtime/channels` | Active channels + subscriber counts                                                                                         |
| `GET`  | `/api/v1/projects/:id/realtime/presence` | Presence state (≤50 channels)                                                                                               |

## Client sketch

```ts
import { createRealtimeClient } from '@cloudnivo/realtime';

const rt = createRealtimeClient({
  url: 'ws://localhost:3001/api/v1/projects/<id>/realtime/ws',
  token,
});
await rt.connect();
const chat = rt.channel('project:<id>:chat');
chat.on('broadcast', msg => console.log(msg.event, msg.data));
chat.subscribe();
chat.broadcast('msg', { hi: 1 });
chat.track({ status: 'online' });

const orders = rt.channel('project:<id>:table:orders');
orders.on('database_change', msg => console.log(msg.data));
orders.subscribe({ user_id: currentUserId });
```

## Local development

```bash
cp .env.example .env
docker compose up -d        # postgres + redis (redis only needed for REALTIME_DRIVER=redis)
npm run dev:api             # API + in-process WS on :3001
npm run dev:realtime --workspace=apps/api  # optional standalone WS on :3002
```

Open the project Realtime console (`/projects/:id/realtime`) and run the
connection smoke test, or connect two raw clients and broadcast between them
(see `apps/api/src/realtime.test.ts` for a scripted example).

## Failure handling / observability

Postgres/Redis outages degrade (bounded reconnects, local-only delivery, CDC
listener states `connecting/listening/reconnecting/failed`) instead of
crashing; malformed frames/payloads are rejected with error envelopes; shutdown
drains connections with a bounded timeout. Metrics (`/stats`) and structured
`realtime.request` logs expose volume, errors, and latency. Tokens, passwords,
payloads, and secrets are never logged.

## AI-generated channels (Phase 9)

Plans declare table/broadcast/presence channel intents; table channels install the standard CDC trigger on apply. Channels remain structural (project-bound) � see docs/ai-builder.md.
