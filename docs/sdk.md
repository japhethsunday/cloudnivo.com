# CloudNivo SDK

Typed HTTP client for server-side integrations, agents, and the CLI
(`packages/sdk`, `CloudNivoClient`). Covers discovery, projects, database and
migrations, secrets, environments, auth configuration, storage, functions,
automation, logs, and the AI Builder.

Accepts a session JWT, a `cn_agent_…` agent token, or a project API key in
the same `token` option — the API decides what the credential may do.

## Discovery and connection

```ts
const manifest = await cn.discover();          // no credential needed
const bundle = await cn.connect(projectId);    // URLs, key prefixes, env template
```

## Migrations

```ts
const { migration } = await cn.createMigration(projectId, {
  name: 'add_posts',
  sql: "create table posts (id uuid primary key);",
  environment: 'development',
});
const { preview } = await cn.previewMigration(projectId, migration.id);
await cn.applyMigration(projectId, migration.id);
```

## Errors

`SdkError` carries `code`, `message`, `remediation`, `requestId`, `details`
and — on HTTP 428 — `approvalId` plus `needsApproval`:

```ts
try {
  await cn.applyMigration(projectId, migration.id);
} catch (err) {
  if (err instanceof SdkError && err.needsApproval) {
    // Hand err.approvalId to a human, then retry:
    // cn.applyMigration(projectId, migration.id, { approvalId: err.approvalId })
  }
}
```

Branch on `err.code`, never on `err.message`.

```ts
import { CloudNivoClient } from '@cloudnivo/sdk';

const cn = new CloudNivoClient({
  baseUrl: process.env.CLOUDNIVO_API_URL!,
  token: process.env.CLOUDNIVO_TOKEN!,
});
const plan = await cn.aiPlan('<project-id>', 'I need tasks with email reminders.');
await cn.aiApprove('<project-id>', plan.id);
const res = await cn.aiApply('<project-id>', plan.id);
```

WARNING: hold tokens server-side only. Never bundle session JWTs or service
keys into browser code — browsers use the dashboard backend or short-lived
customer tokens. Errors surface as `SdkError` with stable `code`/`status`.

## Automation, metrics, debugger, CSV (Phase 14)

```ts
await cn.createQueue(pid, { name: 'jobs' });
await cn.publishMessage(pid, qid, { n: 1 }, 'key-1');
await cn.createSchedule(pid, { name: 'nightly', functionSlug: 'report', cron: '0 2 * * *' });
await cn.createWebhook(pid, { name: 'ops', url, eventTypes: ['job.failed'] });
await cn.projectMetrics(orgId, pid, '24h');
await cn.aiDiagnose(pid, {});
await cn.exportTable(pid, 'users'); // CSV text
await cn.importTable(pid, 'users', csv);
```
