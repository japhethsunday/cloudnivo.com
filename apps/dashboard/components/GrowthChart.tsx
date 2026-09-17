'use client';

import { useEffect, useId, useMemo, useState } from 'react';

/**
 * Platform growth: signups and projects per month, one shared count axis.
 *
 * Two series of the same unit (things created in a month), so they share one
 * y-scale — never two. The palette is the app accent plus one aqua, both
 * validated against this app's chart surface in each scene; the aqua sits
 * below 3:1 on the light surface, which obliges the direct end-labels and the
 * table view below rather than leaving identity to colour alone.
 */

export interface GrowthPoint {
  /** `YYYY-MM`. */
  month: string;
  users: number;
  projects: number;
}

const SERIES = [
  { key: 'users' as const, label: 'Signups', varName: '--viz-users' },
  { key: 'projects' as const, label: 'Projects', varName: '--viz-projects' },
];

/**
 * Two geometries, not one scaled down. A 1200-wide viewBox squeezed into a
 * 350px phone renders its 11px ticks at about 3px — present, unreadable. The
 * narrow geometry is squarer, so the same type survives the scale.
 */
const WIDE = { w: 1200, h: 260, pad: { top: 18, right: 108, bottom: 30, left: 44 }, xLabels: 6 };
const NARROW = { w: 620, h: 360, pad: { top: 16, right: 20, bottom: 34, left: 40 }, xLabels: 3 };

function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return date.toLocaleDateString(undefined, { month: 'short' });
}

function monthFull(month: string): string {
  const [y, m] = month.split('-');
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Nice-ish ceiling so the top gridline is a round number, never a stray max. */
function axisMax(values: number[]): number {
  const peak = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const step = peak / magnitude <= 2 ? magnitude / 2 : magnitude;
  return Math.max(step, Math.ceil(peak / step) * step);
}

export function GrowthChart({ data }: { data: GrowthPoint[] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const titleId = useId();

  // Server-rendered markup is the wide geometry; the phone switches after
  // hydration, so the first paint is never a broken in-between.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const apply = (): void => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const box = narrow ? NARROW : WIDE;

  const geometry = useMemo(() => {
    const max = axisMax(data.flatMap(d => [d.users, d.projects]));
    const innerW = box.w - box.pad.left - box.pad.right;
    const innerH = box.h - box.pad.top - box.pad.bottom;
    const x = (i: number): number =>
      box.pad.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const y = (v: number): number => box.pad.top + innerH - (v / max) * innerH;
    const line = (key: 'users' | 'projects'): string =>
      data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
    return { max, x, y, line, innerW, innerH };
  }, [data, box]);

  if (data.length === 0) {
    return <p className="muted">No growth data yet.</p>;
  }

  const ticks = [0, 0.5, 1].map(f => Math.round(geometry.max * f));
  const last = data[data.length - 1];
  const active = hover === null ? null : data[hover];

  return (
    <div className="viz">
      <div className="viz-head">
        <ul className="viz-legend" aria-label="Series">
          {SERIES.map(s => (
            <li key={s.key}>
              <span className="viz-swatch" style={{ background: `var(${s.varName})` }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsTable(v => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Signups and projects per month</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Signups</th>
                <th scope="col">Projects</th>
              </tr>
            </thead>
            <tbody>
              {data.map(d => (
                <tr key={d.month}>
                  <th scope="row">{monthFull(d.month)}</th>
                  <td>{d.users}</td>
                  <td>{d.projects}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <figure className="viz-figure">
          <svg
            viewBox={`0 0 ${box.w} ${box.h}`}
            role="img"
            aria-labelledby={titleId}
            preserveAspectRatio="xMidYMid meet"
            onMouseLeave={() => setHover(null)}
          >
            <title id={titleId}>
              Signups and projects per month for the last {data.length} months
            </title>

            {ticks.map(t => (
              <g key={t}>
                <line
                  className="viz-grid"
                  x1={box.pad.left}
                  x2={box.w - box.pad.right}
                  y1={geometry.y(t)}
                  y2={geometry.y(t)}
                />
                <text className="viz-tick" x={box.pad.left - 8} y={geometry.y(t) + 4} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}

            {data.map((d, i) =>
              i % Math.ceil(data.length / box.xLabels) === 0 || i === data.length - 1 ? (
                <text
                  key={d.month}
                  className="viz-tick"
                  x={geometry.x(i)}
                  y={box.h - 8}
                  textAnchor="middle"
                >
                  {monthLabel(d.month)}
                </text>
              ) : null,
            )}

            {SERIES.map(s => (
              <path
                key={s.key}
                d={geometry.line(s.key)}
                fill="none"
                stroke={`var(${s.varName})`}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* Direct labels at the series end: identity without relying on
                hue. The narrow geometry has no right margin to hold them, so
                there the legend carries identity on its own. */}
            {narrow
              ? null
              : SERIES.map(s => (
                  <text
                    key={s.key}
                    className="viz-endlabel"
                    x={box.w - box.pad.right + 8}
                    y={geometry.y(last?.[s.key] ?? 0) + 4}
                  >
                    {s.label} {last?.[s.key] ?? 0}
                  </text>
                ))}

            {hover !== null ? (
              <line
                className="viz-crosshair"
                x1={geometry.x(hover)}
                x2={geometry.x(hover)}
                y1={box.pad.top}
                y2={box.pad.top + geometry.innerH}
              />
            ) : null}

            {hover !== null
              ? SERIES.map(s => (
                  <circle
                    key={s.key}
                    cx={geometry.x(hover)}
                    cy={geometry.y(data[hover]?.[s.key] ?? 0)}
                    r={5}
                    fill={`var(${s.varName})`}
                    stroke="var(--bg-elevated)"
                    strokeWidth={2}
                  />
                ))
              : null}

            {/* Hit targets are a full column wide, so the pointer never has to
                find a 2px line. */}
            {data.map((d, i) => (
              <rect
                key={d.month}
                x={geometry.x(i) - geometry.innerW / (2 * Math.max(1, data.length - 1))}
                y={box.pad.top}
                width={geometry.innerW / Math.max(1, data.length - 1)}
                height={geometry.innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
          <figcaption className="viz-caption" aria-live="polite">
            {active
              ? `${monthFull(active.month)} — ${active.users} signups, ${active.projects} projects`
              : `Last ${data.length} months, ending ${last ? monthFull(last.month) : ''}`}
          </figcaption>
        </figure>
      )}
    </div>
  );
}
