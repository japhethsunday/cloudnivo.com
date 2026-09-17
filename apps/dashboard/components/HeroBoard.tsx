'use client';

import styles from '../app/marketing.module.css';

/**
 * The console's project board, rebuilt as markup for the marketing hero.
 *
 * This is the product's signature idea made visible: state owns the region.
 * Every primitive row carries a 3px edge in its state's hue, a ground tint
 * when it is not healthy, and the state spelled out in a mono word at a fixed
 * column — colour never carries the meaning alone.
 *
 * It deliberately shows NO telemetry figures. A number in a hero is a claim,
 * and CloudNivo has no benchmarks, customers or measured results to stand
 * behind (PRODUCT.md, Evidence on Hand). What it shows instead is real
 * product vocabulary: the seven primitives, the real state words the control
 * plane reports, and the real meter keys the billing API records. Nothing
 * here is invented, so nothing here has to be walked back.
 */

type State = 'running' | 'provisioning';

const ROWS: { name: string; detail: string; state: State }[] = [
  { name: 'Database', detail: 'postgres · isolated per project', state: 'running' },
  { name: 'Authentication', detail: 'sessions · rotation · keys', state: 'running' },
  { name: 'API', detail: 'rest · openapi · scoped keys', state: 'running' },
  { name: 'Storage', detail: 'buckets · signed urls', state: 'running' },
  { name: 'Realtime', detail: 'channels · presence · cdc', state: 'running' },
  { name: 'Functions', detail: 'versioned · scheduled', state: 'provisioning' },
  { name: 'AI', detail: 'plan · review · approve', state: 'running' },
];

/** Real counter names from the billing package's usage map. */
const METERS = ['api_requests', 'db_storage_bytes', 'storage_bytes', 'function_invocations'];

export function HeroBoard({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const rows = compact ? ROWS.slice(0, 4) : ROWS;

  return (
    <figure className={`${styles.board}${compact ? ` ${styles.boardCompact}` : ''}`}>
      <div className={styles.boardStrip}>
        <span className={styles.boardTitle}>your-project</span>
        <span className={styles.boardMeta}>control plane · policy · audit</span>
        <span className={styles.boardEnv}>PRODUCTION</span>
      </div>

      <div className={styles.boardHead}>System state</div>

      <ul className={styles.boardRows}>
        {rows.map(r => (
          <li key={r.name} className={styles.boardRow} data-state={r.state}>
            <span className={styles.boardName}>{r.name}</span>
            <span className={styles.boardDetail}>{r.detail}</span>
            <span className={styles.boardState}>{r.state}</span>
          </li>
        ))}
      </ul>

      {compact ? null : (
        <>
          <div className={styles.boardHead}>Metered</div>
          <div className={styles.boardMeters}>
            {METERS.map(m => (
              <span key={m} className={styles.boardMeter}>
                {m}
              </span>
            ))}
          </div>
        </>
      )}

      <figcaption className={styles.boardCap}>
        Interface preview — the project board as the console composes it.
      </figcaption>
    </figure>
  );
}
