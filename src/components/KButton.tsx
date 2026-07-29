import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * THE button. Before this the app had five: .primary-button and .secondary-button (the permission
 * screen), .s-btn / -primary / -ghost / -mini (settings), plus the onboarding's bespoke CTAs — all
 * re-implementing the same ink fill and hard offset shadow with drifting values (5px vs 6px vs 7px
 * offsets, 640 vs 660 vs 680 weight).
 *
 * The look is unchanged — this is the same press: the button slides into its own violet shadow. What
 * is new is the three states nothing had: a visible :focus-visible ring (from styles.css), a real
 * disabled treatment, and `busy`, which keeps the label in place and adds a spinner so a slow
 * checkout or sign-out stops looking like a dead click.
 *
 * The onboarding hero CTA + colour confirm stay bespoke on purpose: they are marketing-scale
 * (bigger type, longer travel) and their choreography is welded to the FrontDoor collapse.
 */
export type KButtonVariant = 'primary' | 'ghost' | 'mini';

type KButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: KButtonVariant;
  /** Shows a spinner and blocks clicks without changing the button's width. */
  busy?: boolean;
  children: ReactNode;
};

export function KButton({
  variant = 'primary',
  busy = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: KButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={className ? `kbtn ${className}` : 'kbtn'}
      data-variant={variant}
      data-busy={busy ? 'true' : undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="kbtn-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
