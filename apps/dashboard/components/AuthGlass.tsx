'use client';

import Link from 'next/link';
import { LogoMark } from './LogoMark';
import styles from '../app/auth-glass.module.css';

/**
 * The signed-out shell: one glass card on a blue-lit dark field.
 *
 * Shared by sign-in, sign-up, the MFA challenge, and password recovery, so
 * the four pages of the front door are one surface rather than four.
 *
 * `data-testid="auth-card"` is load-bearing: the e2e suite asserts the card
 * renders on every signed-out route and compares two rendered cards byte for
 * byte to prove password recovery cannot be used to enumerate accounts.
 */
export function AuthGlass({
  title,
  sub,
  children,
  foot,
  points,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
  /** A quiet line under the card. Context, never the task. */
  foot?: string;
  /** Shown under the card on first-run surfaces only. */
  points?: readonly string[];
}): React.JSX.Element {
  return (
    <div className={styles.scene}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.shell}>
        <main className={styles.card} data-testid="auth-card">
          <Link className={styles.mark} href="/" aria-label="CloudNivo home">
            <span className={styles.markBadge} aria-hidden>
              <LogoMark size={15} />
            </span>
            CloudNivo
          </Link>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.sub}>{sub}</p>
          {children}
        </main>

        {points && points.length > 0 ? (
          <ul className={styles.footPoints}>
            {points.map(p => (
              <li key={p}>
                <span className={styles.footDot} aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        {foot ? <p className={styles.foot}>{foot}</p> : null}
      </div>
    </div>
  );
}
