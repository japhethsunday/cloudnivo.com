'use client';

import Link from 'next/link';
import { HeroBoard } from './HeroBoard';
import { LogoMark } from './LogoMark';
import styles from '../app/auth-glass.module.css';

/**
 * The signed-out shell: a glass card on a blue-lit dark field.
 *
 * Shared by sign-in, sign-up, the MFA challenge, and password recovery, so
 * the four pages of the front door are one surface rather than four.
 *
 * When `aside` is set the shell becomes two columns: the product on the
 * left, the form on the right. That is for first-run surfaces — someone
 * creating an account has not seen the product yet, so the page should show
 * it. Signing in does not: a returning user wants the form, centred, with
 * nothing to read first.
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
  aside,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
  /** A quiet line under the card. Context, never the task. */
  foot?: string;
  /** Proof points. Rendered in the aside when there is one, else under the card. */
  points?: readonly string[];
  /** Headline shown beside the form. Presence of this turns on the split. */
  aside?: { heading: string; lede: string };
}): React.JSX.Element {
  const split = Boolean(aside);
  return (
    <div className={`${styles.scene}${split ? ` ${styles.sceneSplit}` : ''}`}>
      <div className={styles.grid} aria-hidden />

      {split && aside ? (
        <section className={styles.aside} aria-label="About CloudNivo">
          <Link className={styles.asideMark} href="/" aria-label="CloudNivo home">
            <span className={styles.markBadge} aria-hidden>
              <LogoMark size={16} />
            </span>
            CloudNivo
          </Link>
          <h2 className={styles.asideHeading}>{aside.heading}</h2>
          <p className={styles.asideLede}>{aside.lede}</p>
          {points && points.length > 0 ? (
            <ul className={styles.asidePoints}>
              {points.map(p => (
                <li key={p}>
                  <span className={styles.footDot} aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          ) : null}
          {/*
            The product itself, not an illustration of it: the same project
            board component the marketing hero uses, showing real primitive
            names and real state words. Hidden on short and narrow viewports,
            where the form has to own the screen.
          */}
          <div className={styles.asideBoard}>
            <HeroBoard compact />
          </div>
        </section>
      ) : null}

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

        {points && points.length > 0 && !split ? (
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
