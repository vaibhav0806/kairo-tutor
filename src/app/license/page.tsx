import type { Metadata } from 'next';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'License status | Kairo',
  description: 'The current software license status for Kairo.'
};

export default function LicensePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.wordmark} href="/" aria-label="Kairo home">
          <img
            className={styles.brandMark}
            src="/brand/kairo-mark-transparent-64.png"
            alt=""
            width="32"
            height="32"
            aria-hidden="true"
          />
          <span>kairo</span>
        </a>
        <a className={styles.back} href="/">Back home</a>
      </header>

      <article className={styles.article}>
        <p className={styles.eyebrow}>License status</p>
        <h1>Open code. License coming.</h1>
        <p className={styles.updated}>Last checked July 22, 2026</p>

        <div className={styles.body}>
          <section>
            <h2>Current status</h2>
            <p>
              Kairo has not selected a software license yet. The source repository is public, but
              default copyright applies until an explicit license is added.
            </p>
          </section>

          <section>
            <h2>Follow the decision</h2>
            <p>
              The final license will be published in the{' '}
              <a href="https://github.com/vaibhav0806/kairo-tutor">Kairo repository</a>. Until then,
              the public code should not be treated as licensed for reuse or redistribution.
            </p>
          </section>
        </div>

        <nav className={styles.related} aria-label="Related legal pages">
          <a href="/privacy">Privacy notice</a>
        </nav>
      </article>
    </main>
  );
}
