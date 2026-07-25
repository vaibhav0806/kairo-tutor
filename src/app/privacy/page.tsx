import type { Metadata } from 'next';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Privacy notice | Kairo',
  description: 'How Kairo handles information submitted through the alpha waitlist.'
};

export default function PrivacyPage() {
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
        <p className={styles.eyebrow}>Privacy notice</p>
        <h1>Your email, explained plainly.</h1>
        <p className={styles.updated}>Effective July 22, 2026</p>

        <div className={styles.body}>
          <section>
            <h2>What we collect</h2>
            <p>
              If you join the Kairo alpha waitlist, we collect the email address you submit.
              Our hosting providers may also process standard request information needed to
              deliver and protect the website.
            </p>
          </section>

          <section>
            <h2>How we use it</h2>
            <p>
              We use your email to manage early access, contact you about the Kairo alpha, and
              understand who is interested in trying the product. Joining the waitlist is optional.
            </p>
          </section>

          <section>
            <h2>Who processes it</h2>
            <p>
              Kairo uses service providers to host the website and store waitlist records. They
              process this information only to provide those services to us. We do not rent or
              sell waitlist email addresses.
            </p>
          </section>

          <section>
            <h2>How long we keep it</h2>
            <p>
              We keep waitlist records while Kairo is in early access, until the waitlist is no
              longer active, or until you ask us to remove your address.
            </p>
          </section>

          <section>
            <h2>Your choices</h2>
            <p>
              You can ask to access, correct, or delete your waitlist information. Reply to any
              Kairo email you receive, or contact the maintainers through the{' '}
              <a href="https://github.com/vaibhav0806/kairo-tutor">Kairo repository</a>. Do not
              include personal information in a public GitHub issue.
            </p>
          </section>

          <section>
            <h2>Changes to this notice</h2>
            <p>
              We may update this notice as Kairo develops. The effective date above will change
              when we make a material update.
            </p>
          </section>
        </div>

        <nav className={styles.related} aria-label="Related legal pages">
          <a href="/license">License status</a>
        </nav>
      </article>
    </main>
  );
}
