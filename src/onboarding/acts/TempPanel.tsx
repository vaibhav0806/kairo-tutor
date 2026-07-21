import type { ReactNode } from 'react';

// The small centered surface that hosts the color wheel (master spec §3: only color + sign-in get a
// temp panel). Own classes (ob-color-*) so it never collides with the legacy card box (.ob-temp-panel).
export function TempPanel({ children }: { children: ReactNode }) {
  return (
    <div className="ob-color-scrim" aria-hidden={false}>
      <div className="ob-color-panel" role="dialog">
        {children}
      </div>
    </div>
  );
}
