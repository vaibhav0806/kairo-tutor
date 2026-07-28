import { describe, expect, it } from 'vitest';
import { callbackPage } from '../src/auth/routes';
import { normalizeEmail } from '../src/access/service';

describe('closed-alpha access', () => {
  it('matches invites case-insensitively and ignores stray whitespace', () => {
    // Google returns whatever casing the user typed at signup; an invite must not miss on it.
    expect(normalizeEmail('  Prasad@Example.COM ')).toBe('prasad@example.com');
    expect(normalizeEmail('')).toBe('');
  });

  it('tells an uninvited person why the app never opened, without blaming them', () => {
    const page = callbackPage(null, 'waitlist');
    expect(page).toContain('You’re on the list.');
    expect(page).toContain('closed alpha');
    // Must NOT look like a failed sign-in — their credentials were fine.
    expect(page).not.toContain('That sign-in didn’t finish.');
    expect(page).not.toContain('href="/auth/start"');
    // No deep link: an uninvited browser must never hand the app a code.
    expect(page).not.toContain('kairo://');
    expect(page).not.toContain('<script>');
  });

  it('still renders the plain failure page when the session is missing', () => {
    const page = callbackPage(null);
    expect(page).toContain('That sign-in didn’t finish.');
    expect(page).not.toContain('You’re on the list.');
  });
});
