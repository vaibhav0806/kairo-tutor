import { AlphaInvitation } from './AlphaInvitation';
import { HeaderAction } from './HeaderAction';
import { HeaderNavigation } from './HeaderNavigation';
import { Hero } from './Hero';
import { GuidedLesson } from './violet-thread/GuidedLesson';
import { ToolTravel } from './violet-thread/ToolTravel';
import styles from './LandingPage.module.css';

export function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brandLockup}>
          <a className={styles.wordmark} href="#top" aria-label="Kairo home">
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
        </div>
        <HeaderNavigation />
        <HeaderAction />
      </header>
      <main>
        <Hero />
        <GuidedLesson />
        <ToolTravel />
        <AlphaInvitation />
      </main>
      <footer className={styles.colophon}>
        <p>end of screen.</p>
        <nav aria-label="Legal">
          <span>© 2026 Kairo</span>
          <span className={styles.colophonLinks}>
            <a href="/privacy">Privacy</a>
            <a href="/license">License</a>
          </span>
        </nav>
      </footer>
    </div>
  );
}
