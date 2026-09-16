---
version: 1
slug: "apps-dashboard"
primary_target: "apps/dashboard"
related_targets: []
---

## Scope

The CloudNivo console (apps/dashboard): the app shell, the project workspace
and every resource page inside it. The marketing route inherits the world's
palette and type but keeps its own Persuade composition.

Visitor mode: Operate.

## Audience and task

Solo developers and small teams running their own backend, plus platform
engineers operating backends for others. They arrive to answer one question
first — is my infrastructure healthy, and if not, where — then to act:
provision, query, deploy, inspect, rotate, approve.

## Direction contract

THESIS: the console is a status board, not a document. State comes first at
every scale — the workspace, the panel, the row — and everything else is
subordinate to it. It refuses the arrangement this category ships by default:
rounded white cards floating on grey, each one an equal-weight island, with
status demoted to a small coloured dot.

OWN-WORLD: a dark instrument ground (near-navy, not black) with panels cut
from it by hairline rules rather than by shadow and radius. Status owns
regions: a panel whose subject is degraded carries the colour in its header
band and left edge, not in a dot. CloudNivo blue stays the action and
identity colour, never a status colour. Telemetry and identifiers set in
tabular mono; prose and labels in the incumbent sans. Dense, square-ish
geometry (4px radii), 4px spacing grid, uppercase micro-labels only inside
panel chrome where they name a channel, never above a heading.

STORY: the operator sees the whole system's state in the first viewport,
finds the one thing that needs them, and reaches its console in one move.

FIRST VIEWPORT: a fixed rail of sections on the left; a status strip across
the top carrying org, project, environment and live health; beneath it the
workspace grid — a wide system-state panel listing every primitive with its
real state as a coloured band, and a narrow activity column. The primary
action (Connect) sits in the status strip, right-aligned, always visible.

FORM: operations status board; candidate 2 of the grounded list, taken over
the roll's assignment on the user's explicit lock. Seed key 794f5b18.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.

## Constraints that bind

- The CloudNivo logo, N-mark and blue identity are fixed brand commitments.
- Real functionality and real data only; no invented state anywhere.
- Strict CSP: no inline scripts, no third-party style or script origins.
- Every existing route, flow and API call keeps working; this is a visual and
  compositional replacement, not a functional one.
