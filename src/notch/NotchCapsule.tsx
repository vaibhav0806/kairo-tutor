//! The notch status capsule — the ONLY markup the notch WebView renders. A single
//! top-center pill that shows a listening waveform, a thinking pulse, or expands into
//! the typing input / an error line. Purely presentational: every behavior (submit
//! guard, hide, activity tracking) is a prop the NotchApp orchestrator supplies.

import { CloseIcon } from './NotchIcons';

export type NotchCapsuleMode = 'listening' | 'thinking' | 'typing' | 'error' | 'idle';

type NotchCapsuleProps = {
  mode: NotchCapsuleMode;
  statusLabel: string;
  // payload.detail — the error-capsule copy (falls back to a default prompt).
  detail: string;
  query: string;
  capsuleRef: React.RefObject<HTMLDivElement | null>;
  onQueryChange: (value: string) => void;
  // Guarded typed-submit (parent owns the isSubmitting / empty-query checks).
  onSubmit: () => void;
  onHide: () => void;
  // Pointer over the capsule (enter/move) — keeps the notch open + notes activity.
  onCapsulePointer: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
};

export function NotchCapsule({
  mode,
  statusLabel,
  detail,
  query,
  capsuleRef,
  onQueryChange,
  onSubmit,
  onHide,
  onCapsulePointer,
  onPointerLeave,
  onPointerDown
}: NotchCapsuleProps) {
  return (
    <main className="kairo-capsule-shell" aria-label="Kairo status">
      {mode === 'idle' ? null : (
        <div
          ref={capsuleRef}
          className="kairo-capsule"
          data-mode={mode}
          onPointerEnter={onCapsulePointer}
          onPointerMove={onCapsulePointer}
          onPointerLeave={onPointerLeave}
          onPointerDown={onPointerDown}
        >
          {mode === 'typing' ? (
            <form
              className="kairo-capsule-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <input
                aria-label="Ask Kairo"
                autoFocus
                data-notch-input
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Ask about this screen — or hold ⌥⌃ to talk"
                value={query}
              />
              <button
                className="kairo-capsule-ask"
                disabled={query.trim().length === 0}
                type="submit"
              >
                Ask
              </button>
              <button
                aria-label="Hide Kairo"
                className="kairo-capsule-icon"
                title="Close"
                type="button"
                onClick={onHide}
              >
                <CloseIcon />
              </button>
            </form>
          ) : mode === 'error' ? (
            <div className="kairo-capsule-status kairo-capsule-status-error" role="status">
              <span className="kairo-capsule-label">
                {detail || "Didn't catch that — hold ⌥⌃ and speak"}
              </span>
            </div>
          ) : (
            <div className="kairo-capsule-status">
              <span className="kairo-capsule-viz" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="kairo-capsule-label">{statusLabel}</span>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
