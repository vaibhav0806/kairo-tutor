import type { CSSProperties } from 'react';

export type OrbMode = 'idle' | 'speaking' | 'listening' | 'thinking';

// Progress-ring geometry, hoisted so it isn't recomputed on every render.
const ORB_R = 63;
const ORB_C = 2 * Math.PI * ORB_R;

export function KairoOrb({ mode, level, progress }: { mode: OrbMode; level: number; progress: number }) {
  return (
    <div className="ob-orb" data-mode={mode} style={{ '--level': level } as CSSProperties}>
      <svg className="ob-orb-progress" viewBox="0 0 144 144" width="144" height="144" aria-hidden>
        <circle cx="72" cy="72" r={ORB_R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="2.5" />
        <circle cx="72" cy="72" r={ORB_R} fill="none" stroke="url(#ob-arc)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={ORB_C} strokeDashoffset={ORB_C * (1 - progress)} transform="rotate(-90 72 72)" />
        <defs>
          <linearGradient id="ob-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c4a1ff" />
            <stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
      </svg>
      <span className="ob-orb-field" />
      <span className="ob-orb-sheen" />
      <span className="ob-orb-ring" />
      <span className="ob-orb-core" />
    </div>
  );
}
