'use client';

import Link from 'next/link';
import { InfraVisual } from './InfraVisual';
import { IconCheck } from './icons';
import styles from '../app/marketing.module.css';

const POINTS = [
  'Isolated PostgreSQL per project',
  'Scoped API keys and agent tokens',
  'Approval gates on destructive work',
];

/**
 * Split-screen authentication shell: brand + product visual left, form
 * right. The visual is illustrative; the form drives the real backend.
 */
export function AuthLayout({
  title,
  sub,
  asideNote,
  children,
}: {
  title: string;
  sub: string;
  asideNote?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.authPage}>
      <div className={styles.authAside}>
        <Link className="brand" href="/" aria-label="CloudNivo home" style={{ fontSize: 17 }}>
          <span className="brand-mark">C</span>CloudNivo
        </Link>
        <h2>Build your backend without building everything from scratch.</h2>
        <p className={`${styles.lede} muted`} style={{ fontSize: 14 }}>
          {asideNote ?? 'Projects, databases, APIs, auth, storage, realtime, functions, and AI — one control plane.'}
        </p>
        <ul className={styles.authPoints}>
          {POINTS.map(p => (
            <li key={p}>
              <span className={styles.ok} aria-hidden>
                <IconCheck size={15} />
              </span>
              {p}
            </li>
          ))}
        </ul>
        <div className={styles.hideSmall}>
          <InfraVisual compact />
        </div>
      </div>
      <main className={styles.authMain}>
        <div className={styles.authCard}>
          <Link className="brand brand-sm" href="/" aria-label="CloudNivo home">
            <span className="brand-mark">C</span>CloudNivo
          </Link>
          <h1>{title}</h1>
          <p className={`sub muted ${styles.sub}`}>{sub}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
