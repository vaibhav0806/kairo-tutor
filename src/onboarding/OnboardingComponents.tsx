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

export function VoiceInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  listening: boolean;
  processing?: boolean;
  onMic: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className={`ob-input${props.processing ? ' is-processing' : ''}`}>
      <input
        value={props.value}
        placeholder={props.processing ? 'thinking…' : props.listening ? 'listening…' : props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
        disabled={props.processing}
        autoFocus
        spellCheck={false}
      />
      <button type="button" className={`ob-mic${props.listening ? ' is-live' : ''}`} onClick={props.onMic} disabled={props.processing} aria-label={props.listening ? 'Stop' : 'Talk'}>
        {props.processing ? (
          <span className="ob-mic-spin" />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}
