// Guided-arrow bridge: the Screen-Recording guide + the Accessibility vision-miss fallback.
//
// NOTE (Phase 4 reconciliation): the onboarding orchestrator only has a WHOLE-WINDOW click-through
// toggle (Phase 0), not the per-region hit-rect the notch uses. During Act 3 the window MUST be
// click-through so the user can flip the real System Settings toggle underneath — so this bridge
// can't host working buttons (they'd never receive clicks). It is therefore a NON-interactive
// visual guide: the Settings pane is already deep-linked on sub-step entry, and macOS shows its own
// "Quit & Reopen" for Screen Recording. A per-region hit-rect could restore buttons later.

type Props = {
  permission: 'screen' | 'accessibility';
  accent: string; // hex from getAccent()
};

const COPY: Record<Props['permission'], { title: string; hint: string }> = {
  screen: {
    title: 'Turn on Screen Recording',
    hint: 'Find Kairo Tutor in the list and flip its switch on — macOS will offer to reopen me.'
  },
  accessibility: {
    title: 'Turn on Accessibility',
    hint: 'Flip the switch next to Kairo Tutor.'
  }
};

export function PermissionBridge({ permission, accent }: Props) {
  const c = COPY[permission];
  return (
    <div className="ob-bridge" style={{ ['--ob-accent' as string]: accent }} aria-hidden>
      <div className="ob-bridge-arrow">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 4v14M12 18l-5-5M12 18l5-5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="ob-bridge-title">{c.title}</h2>
      <p className="ob-bridge-hint">{c.hint}</p>
    </div>
  );
}
