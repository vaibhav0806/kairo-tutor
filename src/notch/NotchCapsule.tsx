//! The notch status capsule — the ONLY markup the notch WebView renders. ONE persistent,
//! state-morphing pill (Raycast tightness + Arc fluidity, no liquid glass): its box springs
//! between sizes/radii while content cross-fades between modes. Purely presentational — every
//! behavior (submit guard, hide, activity tracking, mic level, hit-rect) is a prop the NotchApp
//! orchestrator supplies. `capsuleRef` stays on the OUTER element so --mic-level + the click-through
//! hit-rect contract are preserved.

import { useRef } from 'react';
import { CloseIcon } from './NotchIcons';
import type { NotchCapsuleMode } from './capsuleMode';
import { useCapsuleMorph } from './useCapsuleMorph';
import { useModePresence } from './useModePresence';

const MORPH_MS = 420; // keep in sync with --spring-morph

type NotchCapsuleProps = {
  mode: NotchCapsuleMode;
  statusLabel: string;
  // payload.detail — the error-capsule copy / coach caption (falls back to a default prompt).
  detail: string;
  // Coach-caption copy (payload.title) shown when detail is empty.
  title?: string;
  // Coach seeded-prompt chip (Phase 0 payload.chip), e.g. "try: 'hey Kairo, what's up?'".
  chip?: string;
  query: string;
  capsuleRef: React.RefObject<HTMLDivElement | null>;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onHide: () => void;
  onCapsulePointer: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  // Onboarding chapter progress (Phase D). null outside onboarding → no dots rendered.
  progress?: { chapter: number; total: number } | null;
};

// Notch progress dots (Phase D). Pure + decorative — a text-free row, one dot per onboarding chapter.
// Filled = current chapter (live accent); past = accent low-opacity; future = faint neutral (CSS).
function renderProgressDots(progress: { chapter: number; total: number }) {
  const { chapter, total } = progress;
  return (
    <div
      className="kairo-notch-progress"
      role="progressbar"
      aria-label="Onboarding progress"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={Math.min(chapter + 1, total)}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="kairo-progress-dot"
          data-state={i < chapter ? 'past' : i === chapter ? 'current' : 'future'}
          aria-hidden
        />
      ))}
    </div>
  );
}

// Per-mode content. The box morphs around whatever this returns; content swaps instantly
// inside while the layers cross-fade.
function renderModeContent(mode: NotchCapsuleMode, props: NotchCapsuleProps) {
  if (mode === 'coach') {
    // Empty detail = the "preparing" state: an accent loading pulse holds the moment while the
    // voice synthesizes, so the words never appear before the audio.
    return (
      <div className="kairo-capsule-coach" role="status">
        {props.detail ? (
          <>
            <span className="kairo-capsule-caption-row">
              <span className="kairo-capsule-dot" aria-hidden />
              <span className="kairo-capsule-caption">{props.detail}</span>
            </span>
            {props.chip ? <span className="kairo-capsule-chip">{props.chip}</span> : null}
          </>
        ) : (
          <span className="kairo-capsule-loading" aria-label="Kairo is preparing" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    );
  }
  if (mode === 'typing') {
    return (
      <form
        className="kairo-capsule-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <input
          aria-label="Ask Kairo"
          autoFocus
          data-notch-input
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder="Ask about this screen — or hold ⌥⌃ to talk"
          value={props.query}
        />
        <button
          className="kairo-capsule-ask"
          disabled={props.query.trim().length === 0}
          type="submit"
        >
          Ask
        </button>
        <button
          aria-label="Hide Kairo"
          className="kairo-capsule-icon"
          title="Close"
          type="button"
          onClick={props.onHide}
        >
          <CloseIcon />
        </button>
      </form>
    );
  }
  if (mode === 'error') {
    return (
      <div className="kairo-capsule-status kairo-capsule-status-error" role="status">
        <span className="kairo-capsule-label">
          {props.detail || "Didn't catch that — hold ⌥⌃ and speak"}
        </span>
      </div>
    );
  }
  // listening / thinking (idle never reaches here — the capsule unmounts).
  return (
    <div className="kairo-capsule-status">
      <span className="kairo-capsule-viz" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="kairo-capsule-label">{props.statusLabel}</span>
    </div>
  );
}

export function NotchCapsule(props: NotchCapsuleProps) {
  const { mode, capsuleRef } = props;
  const innerRef = useRef<HTMLDivElement | null>(null);
  useCapsuleMorph(capsuleRef, innerRef);
  const layers = useModePresence(mode, MORPH_MS);

  return (
    <main className="kairo-capsule-shell" aria-label="Kairo status">
      {mode === 'idle' ? null : (
        <div className="kairo-capsule-stack">
          {/* Onboarding progress dots sit ABOVE the pill (sibling, not inside) so the pill's morph
              sizing + hit-rect stay untouched. Only during onboarding (progress != null). */}
          {props.progress ? renderProgressDots(props.progress) : null}
          <div
            ref={capsuleRef}
            className="kairo-capsule"
            data-mode={mode}
            onPointerEnter={props.onCapsulePointer}
            onPointerMove={props.onCapsulePointer}
            onPointerLeave={props.onPointerLeave}
            onPointerDown={props.onPointerDown}
          >
            <div className="kairo-capsule-inner" ref={innerRef}>
              {layers.map((layer) => (
                <div
                  key={String(layer.key)}
                  className="kairo-capsule-layer"
                  data-phase={layer.phase}
                >
                  {renderModeContent(layer.key, props)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
