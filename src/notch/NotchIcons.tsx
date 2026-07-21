import type { ReactNode } from 'react';

// Shared stroke icon base for the notch's small SVG glyphs.
function NotchIcon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="notch-icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.9}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

export const CloseIcon = () => (
  <NotchIcon size={16}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </NotchIcon>
);
