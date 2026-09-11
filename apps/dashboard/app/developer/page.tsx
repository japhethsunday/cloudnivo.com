'use client';

import Link from 'next/link';
import { apiBase } from '../../lib/api';
import { RequireAuth } from '../../components/RequireAuth';
import { IconInfo } from '../../components/icons';
import { CopyButton, SectionHead } from '../../components/ui';

function Snippet({ title, code }: { title: string; code: string }): React.JSX.Element {
  return (
    <div className="card">
      <div className="section-head split">
        <div>
          <h2 style={{ fontSize: 15 }}>{title}</h2>
        </div>
        <CopyButton text={code} />
      </div>
      <pre className="codeblock">{code}</pre>
    </div>
  );
}

export default function DeveloperPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <section aria-labelledby="dev-title">
        <div className="page-head">
          <div>
            <h1 id="dev-title">CLI &amp; SDK</h1>
            <p className="sub muted">Drive CloudNivo from terminals, CI, and your own code — same API, same envelope.</p>
          </div>
          <Link className="btn btn-primary" href="/agents">
            Get an agent token
          </Link>
        </div>

        <div className="banner info" role="note">
          <span className="banner-icon" aria-hidden>
            <IconInfo size={16} />
          </span>
          <div className="grow">
            <strong>Authenticate with a scoped token, never a password.</strong>
            <p>
              Issue a <code>cn_agent_…</code> token in Agent Access, export it as{' '}
              <code>CLOUDNIVO_AGENT_TOKEN</code>, and every command below just works — locally and in CI.
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <SectionHead
              eyebrow="Command line"
              title="cloudnivo CLI"
              desc="The CLI ships in this monorepo (packages/cli). Build it once, then run it anywhere Node 20+ exists."
            />
            <div style={{ display: 'grid', gap: 12 }}>
              <Snippet
                title="Install & authenticate"
                code={`# from the cloudnivo.com repo
npm run build:packages
export CLOUDNIVO_AGENT_TOKEN=cn_agent_…

# verify who you are
node packages/cli/dist/bin.js agent whoami`}
              />
              <Snippet
                title="Work with projects & functions"
                code={`# list projects visible to the token
node packages/cli/dist/bin.js agent projects

# deploy a function
node packages/cli/dist/bin.js agent deploy \\
  --project <project-id> --function api --source ./handler.js`}
              />
              <Snippet
                title="AI builder from the terminal"
                code={`node packages/cli/dist/bin.js ai plan \\
  --project <project-id> \\
  --prompt "SaaS starter: orgs, seats, and invite emails"

node packages/cli/dist/bin.js ai approve --project <project-id> --plan <plan-id>
node packages/cli/dist/bin.js ai apply --project <project-id> --plan <plan-id>
node packages/cli/dist/bin.js ai usage --project <project-id>
node packages/cli/dist/bin.js ai diagnose --project <project-id>`}
              />
              <Snippet
                title="Queues, schedules, webhooks, metrics"
                code={`node packages/cli/dist/bin.js queues publish \\
  --project <project-id> --queue jobs --body '{"n":1}'
node packages/cli/dist/bin.js schedules create \\
  --project <project-id> --name nightly --function report --cron "0 2 * * *"
node packages/cli/dist/bin.js webhooks create \\
  --project <project-id> --name ops --url https://example.com/hook --events job.failed
node packages/cli/dist/bin.js metrics --org <org-id> --project <project-id> --window 24h`}
              />
            </div>
          </div>

          <div>
            <SectionHead
              eyebrow="TypeScript"
              title="SDK"
              desc="The typed client (packages/sdk) speaks the same versioned envelope as the dashboard."
            />
            <div style={{ display: 'grid', gap: 12 }}>
              <Snippet
                title="Query and mutate"
                code={`import { CloudNivoClient } from '@cloudnivo/sdk';

const cn = new CloudNivoClient({
  baseUrl: '${apiBase()}',
  token: process.env.CLOUDNIVO_AGENT_TOKEN,
});

const who = await cn.agentWhoami();
const { token, raw } = await cn.createAgentToken(orgId, {
  name: 'ci',
  scopes: ['projects.read'],
  expiresIn: '30d',
});`}
              />
            </div>
          </div>

          <div>
            <SectionHead
              eyebrow="Raw HTTP"
              title="Direct API access"
              desc="Every response uses the platform envelope { data, meta } on success and { error } on failure."
            />
            <div style={{ display: 'grid', gap: 12 }}>
              <Snippet
                title="curl the envelope"
                code={`curl -s ${apiBase()}/api/v1/health | head -c 300
curl -s -H "Authorization: Bearer $CLOUDNIVO_AGENT_TOKEN" \\
  ${apiBase()}/api/v1/projects | head -c 300`}
              />
            </div>
          </div>
        </div>
      </section>
    </RequireAuth>
  );
}
