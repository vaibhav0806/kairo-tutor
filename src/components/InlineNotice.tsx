import type { ReactNode } from 'react';

/**
 * THE inline message. Before this, an inline error was whatever the nearest screen invented —
 * onboarding's sign-in error and Settings' sign-in error were two different sizes, two different
 * reds, and two different spacings, both of them bare unstyled paragraphs jammed against the
 * control below.
 *
 * This is not the toaster (`KairoToaster`): that is for something that just happened somewhere
 * else and floats away. This is for a message bound to the control it sits above — it stays until
 * the thing it describes is resolved, so it reads as part of the form, not as an alert.
 */
export type InlineNoticeTone = 'error' | 'info';

export function InlineNotice({
  tone = 'error',
  children,
}: {
  tone?: InlineNoticeTone;
  children: ReactNode;
}) {
  return (
    <p className={`inline-notice inline-notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
