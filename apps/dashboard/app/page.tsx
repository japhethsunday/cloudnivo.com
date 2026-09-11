'use client';

import Link from 'next/link';
import { useState } from 'react';
import { InfraVisual } from '../components/InfraVisual';
import {
  IconAIBuilder,
  IconAPI,
  IconAgents,
  IconAuth,
  IconCheck,
  IconCLI,
  IconDatabase,
  IconFunctions,
  IconMenu,
  IconRealtime,
  IconShield,
  IconStorage,
  IconUsage,
  IconX,
} from '../components/icons';
import styles from './marketing.module.css';

const CAPS = ['PostgreSQL', 'Auth', 'APIs', 'Storage', 'Realtime', 'Functions', 'AI', 'Security'];

const SHOWCASE: {
  id: string;
  label: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  code: { k?: string; s?: string; c?: string; t?: string }[][];
}[] = [
  {
    id: 'database',
    label: 'Database',
    icon: <IconDatabase size={15} />,
    title: 'PostgreSQL with guardrails',
    body: 'Isolated databases per project, live schema inspection, a guarded SQL editor, and CSV import/export against the same engine as the API.',
    code: [[{ t: '-- guarded, allow-listed identifiers' }], [{ k: 'SELECT', t: ' * ' }, { k: 'FROM', t: ' users ' }, { k: 'LIMIT', t: ' 20;' }]],
  },
  {
    id: 'api',
    label: 'API',
    icon: <IconAPI size={15} />,
    title: 'REST generated from your tables',
    body: 'Every table gets filterable, sortable, paginated endpoints with project keys and live OpenAPI — same envelope everywhere.',
    code: [[{ c: '$ ' }, { t: 'curl -H "apikey: cn_…" ' }], [{ t: '  "https://api/api/v1/projects/abc/users?limit=20"' }]],
  },
  {
    id: 'auth',
    label: 'Authentication',
    icon: <IconAuth size={15} />,
    title: 'Users, sessions, and keys',
    body: 'Per-project application users with rotating sessions, plus platform sessions and scoped project keys for servers.',
    code: [
      [
        { t: '{"data": {"user": {"id": "usr_9f2", "emailVerified": ' },
        { s: 'true' },
        { t: ' }}}' },
      ],
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: <IconStorage size={15} />,
    title: 'Buckets with real bytes',
    body: 'Private or public buckets, streaming uploads, signed URLs, move/copy, quotas, and usage that matches billing meters.',
    code: [[{ c: '$ ' }, { t: 'cloudnivo storage upload --bucket avatars ./me.png' }]],
  },
  {
    id: 'realtime',
    label: 'Realtime',
    icon: <IconRealtime size={15} />,
    title: 'Live channels and presence',
    body: 'Project-scoped WebSocket channels, Postgres change feeds, presence, and reconnecting clients with latency stats.',
    code: [[{ k: 'SUBSCRIBE', t: ' project:abc:orders ' }, { c: '# 12 ms avg' }]],
  },
  {
    id: 'functions',
    label: 'Functions',
    icon: <IconFunctions size={15} />,
    title: 'Serverless with versions',
    body: 'Deploy from source or the CLI, roll back to any version, invoke on schedules, and read per-execution logs.',
    code: [[{ c: '$ ' }, { t: 'cloudnivo agent deploy --project abc --function api --source ./h.js' }]],
  },
  {
    id: 'ai',
    label: 'AI Builder',
    icon: <IconAIBuilder size={15} />,
    title: 'Describe, review, approve',
    body: 'Plans are validated structured data with destructive confirmations — nothing executes without your approval.',
    code: [[{ c: '$ ' }, { t: 'cloudnivo ai plan --project abc --prompt "..."' }], [{ t: 'plan pl_8f2 [pending] · 14 changes' }]],
  },
];

const AI_CHECKS = [
  'Database schema',
  'Authentication',
  'API',
  'Storage',
  'Realtime',
  'Functions',
  'Security checks',
  'Approval gate',
];

const PLATFORM: { icon: React.ReactNode; title: string; body: string }[] = [
  { icon: <IconDatabase size={16} />, title: 'DATABASE', body: 'Isolated PostgreSQL per project with live status, schema inspection, guarded SQL, and CSV portability.' },
  { icon: <IconAuth size={16} />, title: 'AUTHENTICATION', body: 'Application users, rotating sessions, project keys, and scoped agent credentials.' },
  { icon: <IconAPI size={16} />, title: 'API', body: 'Auto-generated REST over your tables with filtering, pagination, keys, and live OpenAPI docs.' },
  { icon: <IconStorage size={16} />, title: 'STORAGE', body: 'Buckets and objects with visibility controls, signed URLs, quotas, and S3-compatible drivers.' },
  { icon: <IconRealtime size={16} />, title: 'REALTIME', body: 'Channels, presence, and Postgres change feeds over project-scoped WebSockets.' },
  { icon: <IconFunctions size={16} />, title: 'FUNCTIONS', body: 'Versioned serverless deploys with cron schedules, queues, logs, and rollback.' },
  { icon: <IconAIBuilder size={16} />, title: 'AI', body: 'Plan → review → approve → apply backend generation, plus a deterministic failure debugger.' },
  { icon: <IconShield size={16} />, title: 'SECURITY', body: 'Live posture scans with a score, scoped credentials, approval gates, and audit trails.' },
  { icon: <IconUsage size={16} />, title: 'OBSERVABILITY', body: 'Request metrics, job history, function logs, and metered usage in one place.' },
];

const WORKFLOW = [
  ['BUILD', 'Describe the backend; AI drafts a validated plan.'],
  ['CONNECT', 'Keys, SDK, and CLI wired to one envelope.'],
  ['TEST', 'Preview diffs and dry-run before anything executes.'],
  ['SECURE', 'Scopes, approvals, and posture scans gate risk.'],
  ['DEPLOY', 'Functions, schedules, and webhooks go live.'],
  ['MONITOR', 'Metrics, logs, and activity stay in one view.'],
  ['SCALE', 'Quotas and plans grow with real usage.'],
];

const SEC_ROWS: [string, string][] = [
  ['Authentication protected', 'Scrypt sessions with rotation and reuse detection.'],
  ['Secrets hash-protected', 'API keys and webhook secrets store hashes only.'],
  ['Agent permissions scoped', 'Allow-lists, expiries, and per-token rate limits.'],
  ['Destructive ops approval-gated', 'Deletes and deploys pause for human approval.'],
  ['Activity audited', 'Append-only org-scoped trail across every plane.'],
];

const OBS_SERVICES = ['API', 'Database', 'Auth', 'Storage', 'Realtime', 'Functions', 'AI'];
const OBS_BARS = [34, 52, 40, 64, 48, 78, 58, 88, 70, 92, 66, 80, 54, 72, 44, 60, 38, 50];

export default function HomePage(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [show, setShow] = useState(SHOWCASE[0] === undefined ? 'database' : SHOWCASE[0].id);
  const active = SHOWCASE.find(s => s.id === show) ?? SHOWCASE[0] ?? {
    id: 'database',
    label: 'Database',
    icon: null,
    title: 'Database',
    body: '',
    code: [],
  };

  return (
    <div className={`${styles.page} ${styles.mkt}`}>
      <header className={styles.nav}>
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/" aria-label="CloudNivo home">
            <span className="brand-mark">C</span>CloudNivo
          </Link>
          <nav className={styles.links} aria-label="Marketing">
            <Link href="#platform">Platform</Link>
            <Link href="#developers">Developers</Link>
            <Link href="#ai">AI</Link>
            <Link href="#security">Security</Link>
            <Link href="/developer">Docs</Link>
            <Link href="#pricing">Pricing</Link>
          </nav>
          <div className={styles.navCtas}>
            <Link className={`btn ${styles.hideMobile}`} href="/login">
              Sign in
            </Link>
            <Link className={`btn btn-primary ${styles.hideMobile}`} href="/signup">
              Start building
            </Link>
            <button
              type="button"
              className={`icon-btn ${styles.menuBtn}`}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen(o => !o)}
            >
              {menuOpen ? <IconX size={18} /> : <IconMenu size={18} />}
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav className={styles.mobileMenu} aria-label="Mobile">
            {[
              ['Platform', '#platform'],
              ['Developers', '#developers'],
              ['AI', '#ai'],
              ['Security', '#security'],
              ['Docs', '/developer'],
              ['Pricing', '#pricing'],
              ['Sign in', '/login'],
              ['Start building', '/signup'],
            ].map(([label, href]) => (
              <Link key={href + label} href={href} onClick={() => setMenuOpen(false)}>
                {label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      <main>
        <section className={styles.hero}>
          <div>
            <p className={`${styles.eyebrow} ${styles.rise}`}>The AI-native backend platform</p>
            <h1 className={styles.rise1}>Build, deploy and scale your backend with CloudNivo.</h1>
            <p className={`${styles.lede} ${styles.rise2}`}>
              One control plane for PostgreSQL, authentication, APIs, storage, realtime, and
              functions — with AI that drafts your backend and never executes without approval.
            </p>
            <div className={`${styles.ctaRow} ${styles.rise3}`}>
              <Link className="btn btn-primary" href="/signup">
                Start building
              </Link>
              <Link className="btn" href="#platform">
                Explore CloudNivo
              </Link>
            </div>
          </div>
          <div className={styles.rise2}>
            <InfraVisual />
          </div>
        </section>

        <div className={styles.strip} aria-label="Platform capabilities">
          <div className={styles.stripInner}>
            <span className={styles.stripLabel}>Includes</span>
            {CAPS.map(c => (
              <span key={c} className={styles.cap}>
                <span className={styles.capDot} aria-hidden />
                {c}
              </span>
            ))}
          </div>
        </div>

        <section className={styles.section} id="platform" aria-labelledby="showcase-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Product tour</p>
            <h2 id="showcase-h">One platform, every primitive</h2>
            <p>Each surface below mirrors a real console in the dashboard — same concepts, same envelope.</p>
          </div>
          <div className={styles.showTabs} role="tablist" aria-label="Product areas">
            {SHOWCASE.map(s => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={show === s.id}
                onClick={() => setShow(s.id)}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </div>
          <div className={styles.showBody}>
            <div className={styles.panel}>
              <h3>{active.title}</h3>
              <p>{active.body}</p>
              <Link className="btn btn-sm" href="/signup">
                Try it in the console
              </Link>
            </div>
            <div className={styles.console}>
              <div className={styles.infraBar} aria-hidden="true">
                <span className={styles.dots}>
                  <i />
                  <i />
                  <i />
                </span>
                console — {active.label.toLowerCase()}
                <span className={styles.liveDot}>
                  <i />
                  preview
                </span>
              </div>
              <pre className={styles.code} aria-label={`${active.label} example`}>
                {active.code.map((line, i) => (
                  <span key={i}>
                    {line.map((tok, j) => (
                      <span key={j} className={tok.k ? styles.k : tok.s ? styles.s : tok.c ? styles.c : undefined}>
                        {tok.t}
                      </span>
                    ))}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </div>
          </div>
        </section>

        <section className={styles.section} id="ai" aria-labelledby="ai-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>AI-native</p>
            <h2 id="ai-h">Describe it. Review it. Ship it.</h2>
            <p>CloudNivo is more than hosted tables — the AI Builder, Debugger, and Agent Access turn intent into reviewed infrastructure.</p>
          </div>
          <div className={styles.grid2}>
            <div className={styles.panel}>
              <p className={styles.prompt}>
                <cite>Developer</cite>
                “Build a marketplace backend with users, sellers, products, orders and payments.”
              </p>
              <ul className={styles.checkList}>
                {AI_CHECKS.map(c => (
                  <li key={c}>
                    <span className={styles.ok} aria-hidden>
                      <IconCheck size={15} />
                    </span>
                    {c}
                  </li>
                ))}
              </ul>
              <p className={styles.pipeline}>
                Review <span className={styles.arrow} aria-hidden>→</span> Approve{' '}
                <span className={styles.arrow} aria-hidden>→</span> Deploy
              </p>
            </div>
            <div className={styles.panel}>
              <h3>
                <span className={styles.panelIcon} aria-hidden>
                  <IconAIBuilder size={16} />
                </span>
                AI Builder, Debugger &amp; Agents
              </h3>
              <p>Plans are validated structured data with destructive confirmations. The Debugger traces real jobs and logs to probable causes. Agents get scoped, expiring tokens with approval gates — never passwords.</p>
              <pre className={styles.code}>
                <span className={styles.c}>$ </span>cloudnivo ai plan --project abc --prompt "..."{'\n'}plan pl_8f2 [pending] · 14 changes
              </pre>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="caps-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Platform</p>
            <h2 id="caps-h">Everything a backend needs</h2>
            <p>Every capability below is implemented in the product — open the console and use it.</p>
          </div>
          <div className={styles.grid3}>
            {PLATFORM.map(p => (
              <div key={p.title} className={styles.panel}>
                <h3>
                  <span className={styles.panelIcon} aria-hidden>
                    {p.icon}
                  </span>
                  {p.title}
                </h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="flow-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Lifecycle</p>
            <h2 id="flow-h">From idea to scale</h2>
            <p>CloudNivo carries the backend lifecycle so application code stays the focus.</p>
          </div>
          <div className={styles.steps}>
            {WORKFLOW.map(([t, d], i) => (
              <div key={t} className={styles.step}>
                <div className={styles.n}>0{i + 1}</div>
                <div className={styles.t}>{t}</div>
                <div className={styles.d}>{d}</div>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section} id="developers" aria-labelledby="dx-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Developers</p>
            <h2 id="dx-h">Built for how you work</h2>
            <p>CLI, SDK, raw API, dashboard, and agent tokens — one envelope, five surfaces.</p>
          </div>
          <div className={styles.grid2}>
            <div className={styles.panel}>
              <h3>
                <span className={styles.panelIcon} aria-hidden>
                  <IconCLI size={16} />
                </span>
                CLI &amp; SDK
              </h3>
              <pre className={styles.code}>
                <span className={styles.c}>$ </span>
                <span>cloudnivo queues publish --project abc --queue jobs</span>
              </pre>
            </div>
            <div className={styles.panel}>
              <h3>
                <span className={styles.panelIcon} aria-hidden>
                  <IconAgents size={16} />
                </span>
                Agent access
              </h3>
              <p>Issue <code>cn_agent_…</code> tokens with granular scopes, expiries, and approval gates for destructive work. Same header, safer agents.</p>
              <pre className={styles.code}>
                <span className={styles.c}>$ </span>export CLOUDNIVO_AGENT_TOKEN=cn_agent_…{'\n'}
                <span className={styles.c}>$ </span>cloudnivo agent whoami  <span className={styles.c}># name · scopes · expiry</span>
              </pre>
            </div>
          </div>
        </section>

        <section className={styles.section} id="security" aria-labelledby="sec-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Security</p>
            <h2 id="sec-h">Protection is a feature</h2>
            <p>How CloudNivo is engineered — the live Security Center in the console scores your workspace against these same principles.</p>
          </div>
          <div className={styles.secPanel} aria-label="CloudNivo security principles">
            {SEC_ROWS.map(([t, d]) => (
              <div key={t} className={styles.secRow}>
                <span className={styles.secCheck} aria-hidden>
                  <IconCheck size={15} />
                </span>
                <span className={styles.grow}>
                  <span className={styles.t}>{t}</span>
                  <div className={styles.d}>{d}</div>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="obs-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Observability</p>
            <h2 id="obs-h">Know what your backend is doing</h2>
            <p>Requests, latency, errors, usage, and health across API, database, auth, storage, realtime, functions, and AI — the console renders this live.</p>
          </div>
          <div className={styles.panel}>
            <h3>Representative traffic shape</h3>
            <p>
              {OBS_SERVICES.join(' · ')} — requests, latency, errors, usage, and health per service.
            </p>
            <div className={styles.miniBars} aria-hidden="true">
              {OBS_BARS.map((h, i) => (
                <i key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
            <p className={styles.figureTag}>Illustrative rendering of the Metrics console</p>
          </div>
        </section>

        <section className={styles.section} id="pricing" aria-labelledby="price-h">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Pricing</p>
            <h2 id="price-h">Start free, grow on meters</h2>
            <p>Real plans with metered quotas — exact limits and usage live in billing. No surprises.</p>
          </div>
          <div className={styles.grid4}>
            {[
              {
                name: 'Free',
                price: '$0',
                per: 'forever',
                desc: 'For prototypes and evaluation. Real limits, no payment required.',
                features: ['3 projects', '100K API requests / mo', '1 GB storage', '3 team members'],
                featured: false,
              },
              {
                name: 'Pro',
                price: '$20',
                per: '/ mo',
                desc: 'For production side projects and small teams. 14-day trial.',
                features: ['15 projects', '5M API requests / mo', '25 GB storage', '10 team members'],
                featured: true,
              },
              {
                name: 'Business',
                price: '$99',
                per: '/ mo',
                desc: 'For teams with compliance needs and higher scale. 14-day trial.',
                features: ['50 projects', '50M API requests / mo', '256 GB storage', '50 team members'],
                featured: false,
              },
              {
                name: 'Enterprise',
                price: 'Custom',
                per: '',
                desc: 'Negotiated limits and dedicated support.',
                features: ['Negotiated quotas', 'Dedicated support', 'Same envelope, same APIs'],
                featured: false,
              },
            ].map(p => (
              <div key={p.name} className={`${styles.panel} ${styles.priceCard}${p.featured ? ` ${styles.featured}` : ''}`}>
                {p.featured ? <span className={styles.priceFlag}>Most popular</span> : null}
                <h3>{p.name}</h3>
                <div className={styles.price}>
                  {p.price}
                  {p.per ? <span>{p.per}</span> : null}
                </div>
                <p>{p.desc}</p>
                <ul className={styles.priceList}>
                  {p.features.map(f => (
                    <li key={f}>
                      <span className={styles.ok} aria-hidden>
                        <IconCheck size={15} />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link className={`btn${p.featured ? ' btn-primary' : ''}`} href="/signup">
                  Start building
                </Link>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.cta} aria-labelledby="cta-h">
          <div className={styles.ctaInner}>
            <p className={styles.eyebrow}>Get started</p>
            <h2 id="cta-h">Your backend. One platform.</h2>
            <p>Build faster with infrastructure designed for modern applications and AI-powered development.</p>
            <div className={styles.ctaRow} style={{ justifyContent: 'center' }}>
              <Link className="btn btn-primary" href="/signup">
                Start building
              </Link>
              <Link className="btn" href="/developer">
                View documentation
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <Link className={styles.brand} href="/" aria-label="CloudNivo home" style={{ fontSize: 15 }}>
            <span className="brand-mark" style={{ width: 22, height: 22, fontSize: 12 }}>
              C
            </span>
            CloudNivo
          </Link>
          <span>© 2026 CloudNivo — the AI-native backend platform.</span>
          <nav aria-label="Footer">
            <Link href="/login">Sign in</Link>
            <Link href="/developer">CLI &amp; SDK</Link>
            <Link href="#security">Security</Link>
            <Link href="#pricing">Pricing</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
