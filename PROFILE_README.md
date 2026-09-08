<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f172a,50:2563eb,100:5b8cff&height=220&section=header&text=Japheth%20Sunday&fontSize=58&fontColor=ffffff&animation=fadeIn&fontAlignY=36&desc=Full-Stack%20Engineer%20%E2%80%94%20Backend-as-a-Service%20Architect&descAlignY=60&descSize=17" alt="Japheth Sunday header" width="100%" />

<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=21&duration=2600&pause=900&color=5B8CFF&center=true&vCenter=true&width=780&lines=I+build+multi-tenant+platforms%2C+not+just+apps;Next.js+%2B+TypeScript+%2B+Postgres+%2B+Redis+%2B+Docker;Currently+architecting+CloudNivo%2C+a+Supabase-class+BaaS;Security-first%3A+tenant+isolation%2C+RBAC%2C+audit+trails" alt="typing intro" />

<p>
  <a href="https://github.com/japhethsunday"><img src="https://img.shields.io/badge/GitHub-japhethsunday-0f172a?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://github.com/japhethsunday/cloudnivo.com"><img src="https://img.shields.io/badge/Flagship-CloudNivo-2563eb?style=for-the-badge&logo=rocket&logoColor=white" alt="CloudNivo" /></a>
  <img src="https://img.shields.io/badge/Focus-Platform%20Engineering-059669?style=for-the-badge" alt="focus" />
  <img src="https://img.shields.io/badge/Open%20To-Collaboration-orange?style=for-the-badge" alt="collaboration" />
</p>

<p>
  <img src="https://img.shields.io/github/followers/japhethsunday?style=flat-square&logo=github&label=followers" alt="followers" />
  <img src="https://img.shields.io/github/stars/japhethsunday?style=flat-square&logo=github&label=stars" alt="stars" />
  <img src="https://komarev.com/ghpvc/?username=japhethsunday&label=Profile%20views&color=2563eb&style=flat" alt="profile views" />
</p>

</div>

---

## About

I am a full-stack engineer operating as designer, architect, and shipper. My current mission is **CloudNivo** — a developer-focused Backend-as-a-Service platform (Supabase-class) with a production-grade control plane: organizations, projects, environments, API keys, RBAC, audit logging, and a versioned API envelope shared across runtimes.

```ts
const currently = {
  building: 'CloudNivo — multi-tenant BaaS control plane (Phase 1 shipped)',
  mastering: ['Drizzle ORM', 'Postgres tenancy patterns', 'Next.js App Router'],
  askMeAbout: ['Platform architecture', 'Auth + RBAC', 'API envelopes', 'Monorepos'],
  discipline: 'lint + typecheck + tests + build, green before done',
} as const;
```

What defines my work:

- **Architecture before features** — monorepos, service abstractions, and contracts that survive cloud migration.
- **Multi-tenancy as a first principle** — `User → Organization → Project → Infrastructure`, enforced server-side on every request.
- **Zero-to-production discipline** — lint, typecheck, tests, and build green before anything is called done.
- **Local-first, $0 start** — Docker-local Postgres/Redis today, managed cloud tomorrow, no rewrites.

## What I do

| Architect                     | Build                          | Secure                         |
| ----------------------------- | ------------------------------ | ------------------------------ |
| Monorepo + service boundaries | Next.js dashboards + Node APIs | Tenant isolation + RBAC        |
| Versioned API contracts       | Drizzle schemas + migrations   | Hash-only keys, redacted logs  |
| Local-to-cloud portability    | Docker Compose environments    | Audit trails, fail-closed CORS |

## Stack

<p align="center">
  <img src="https://skillicons.dev/icons?i=ts,js,nodejs,nextjs,react,postgres,redis,docker,vercel,git,githubactions,vscode,postman&theme=light" alt="tech stack" />
</p>

| Layer    | Core                                   | Also                                        |
| -------- | -------------------------------------- | ------------------------------------------- |
| Frontend | TypeScript, Next.js 15, React 19       | Responsive + dark/light theming, a11y       |
| Backend  | Node.js, Drizzle ORM, Zod, JWT         | Rate limits, envelopes, `requestId` tracing |
| Data/Ops | PostgreSQL 16, Redis 7, Docker Compose | Vercel control plane, Vitest + ESLint gates |

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TS" />
  <img src="https://img.shields.io/badge/Next.js-15_App_Router-black?style=flat-square&logo=next.js&logoColor=white" alt="Next" />
  <img src="https://img.shields.io/badge/Drizzle-ORM-C5F74F?style=flat-square&logo=drizzle&logoColor=black" alt="Drizzle" />
  <img src="https://img.shields.io/badge/Zod-Validation-3E67B1?style=flat-square&logo=zod&logoColor=white" alt="Zod" />
  <img src="https://img.shields.io/badge/Vitest-Tested-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
</p>

## Featured build — CloudNivo

> Supabase-like BaaS control plane. Phase 1 foundation is live: 12-workspace monorepo, 41 green tests, production build passing.

- **Control plane:** Next.js dashboard + framework-free Node API sharing one `/api/v1` envelope.
- **Packages:** `config · logging · validation · database · auth · storage · realtime · cache · provisioning · api-core`.
- **Security:** JWT sessions, hash-only API keys, Zod boundaries, fail-closed CORS, rate limits, redacting logger, audit-log architecture.
- **Explore:** [japhethsunday/cloudnivo.com](https://github.com/japhethsunday/cloudnivo.com) — start with `docs/architecture.md`.

<p>
  <a href="https://github.com/japhethsunday/cloudnivo.com"><img src="https://github-readme-stats.vercel.app/api/pin/?username=japhethsunday&repo=cloudnivo.com&theme=transparent&title_color=2563eb&icon_color=2563eb&hide_border=true" alt="cloudnivo repo card" /></a>
</p>

## GitHub analytics

<div align="center">

<img src="https://github-readme-stats.vercel.app/api?username=japhethsunday&show_icons=true&theme=transparent&title_color=2563eb&icon_color=2563eb&text_color=0f172a&hide_border=true&count_private=true" alt="stats" width="49%" />
<img src="https://streak-stats.demolab.com?user=japhethsunday&theme=transparent&ring=2563eb&fire=2563eb&currStreakLabel=2563eb&hide_border=true" alt="streak" width="49%" />

<img src="https://github-readme-stats.vercel.app/api/top-langs/?username=japhethsunday&layout=compact&theme=transparent&title_color=2563eb&hide_border=true&langs_count=8" alt="top languages" width="49%" />
<img src="https://github-profile-trophy.vercel.app/?username=japhethsunday&theme=flat&no-frame=true&no-bg=true&column=4&margin-w=8&title=Stars,Followers,Commits,Repositories" alt="trophies" width="49%" />

<img src="https://github-readme-activity-graph.vercel.app/graph?username=japhethsunday&theme=github-compact&color=2563eb&line=2563eb&point=0f172a&hide_border=true&area=true" alt="activity graph" width="100%" />

<img src="https://github-readme-quotes.vercel.app/quote?theme=transparent&animation=grow_out_in&layout=default" alt="dev quote" width="100%" />

</div>

## Engineering principles

```ts
const howIWork = {
  tenancy: 'never trust client-supplied org / project / role — verify server-side',
  secrets: 'hash-only keys · scrypt passwords · redacted logs · fail-fast config',
  api: 'one versioned envelope · Zod in · requestId everywhere · safe 5xx',
  quality: 'lint + typecheck + 41 tests + production build, every phase',
} as const;
```

## Connect

- **GitHub:** [github.com/japhethsunday](https://github.com/japhethsunday)
- **Flagship:** [github.com/japhethsunday/cloudnivo.com](https://github.com/japhethsunday/cloudnivo.com)
- <!-- Add your LinkedIn / X / portfolio URLs here once ready. -->

---

<div align="center">
  <sub>Profile README draft — copy this file to <code>github.com/japhethsunday/japhethsunday/README.md</code> to activate it on your GitHub profile. Project README in this repo remains the source of truth for CloudNivo.</sub>
  <br />
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:2563eb,100:0f172a&height=120&section=footer" alt="footer" width="100%" />
</div>
