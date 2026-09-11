'use client';

import styles from '../app/marketing.module.css';

const SERVICES = [
  { name: 'Database', sub: 'PostgreSQL 16' },
  { name: 'Auth', sub: 'sessions · keys' },
  { name: 'API', sub: 'REST · OpenAPI' },
  { name: 'Storage', sub: 'buckets · URLs' },
  { name: 'Realtime', sub: 'WS · presence' },
  { name: 'Functions', sub: 'cron · versions' },
  { name: 'AI', sub: 'builder · agents' },
];

/**
 * Original CloudNivo infrastructure illustration (SVG + CSS motion, no
 * images, no libraries). Representative product visualization — it shows
 * architecture, not live system data.
 */
export function InfraVisual({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const W = 460;
  const topY = 34;
  const coreY = 118;
  const rowY = 232;
  const cx = W / 2;
  const gap = (W - 40) / (SERVICES.length - 1);
  return (
    <figure className={styles.infra} style={{ margin: 0 }} aria-label="CloudNivo infrastructure illustration">
      <div className={styles.infraBar} aria-hidden="true">
        <span className={styles.dots}>
          <i />
          <i />
          <i />
        </span>
        cloudnivo — infrastructure
      </div>
      <div className={styles.infraBody}>
      <svg viewBox={`0 0 ${W} ${compact ? 300 : 300}`} role="img" aria-hidden="true">
        {/* App node */}
        <rect className={styles.node} x={cx - 90} y={topY - 20} width={180} height={40} rx={8} />
        <text className={styles.label} x={cx} y={topY - 2} textAnchor="middle">
          Your application
        </text>
        <text className={styles.sub} x={cx} y={topY + 12} textAnchor="middle">
          web · mobile · agents
        </text>
        {/* Trunk */}
        <line className={styles.wire} x1={cx} y1={topY + 20} x2={cx} y2={coreY - 22} />
        <line className={styles.flow} x1={cx} y1={topY + 20} x2={cx} y2={coreY - 22} />
        {/* Core */}
        <rect className={styles.core} x={cx - 110} y={coreY - 22} width={220} height={44} rx={8} />
        <text className={styles.label} x={cx} y={coreY - 3} textAnchor="middle">
          CloudNivo
        </text>
        <text className={styles.sub} x={cx} y={coreY + 12} textAnchor="middle">
          control plane · policy · audit
        </text>
        <circle className={styles.pulse} cx={cx + 96} cy={coreY - 12} r={4} />
        {/* Branches */}
        {SERVICES.map((s, i) => {
          const x = 20 + i * gap;
          return (
            <g key={s.name}>
              <line className={styles.wire} x1={cx} y1={coreY + 22} x2={x} y2={rowY - 24} />
              <line
                className={styles.flow}
                x1={cx}
                y1={coreY + 22}
                x2={x}
                y2={rowY - 24}
                style={{ animationDelay: `${i * 0.22}s` }}
              />
              <rect className={styles.node} x={x - 30} y={rowY - 24} width={60} height={52} rx={8} />
              <circle className={styles.pulse} cx={x + 22} cy={rowY - 16} r={3} style={{ animationDelay: `${i * 0.3}s` }} />
              <text className={styles.label} x={x} y={rowY + 2} textAnchor="middle" style={{ fontSize: 10 }}>
                {s.name}
              </text>
              <text className={styles.sub} x={x} y={rowY + 15} textAnchor="middle" style={{ fontSize: 8 }}>
                {s.sub}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.figureTag}>Product illustration — your stack on CloudNivo primitives</figcaption>
      </div>
    </figure>
  );
}
