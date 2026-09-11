# CloudNivo SDK (Phase 9)

Typed HTTP client for server-side integrations and the CLI
(`packages/sdk`, `CloudNivoClient`). Covers projects, functions, storage,
and the AI Builder (plan/approve/apply/status/usage).

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
