// Guided bridge: the Screen-Recording guide + the Accessibility vision-miss fallback.
//
// NOTE (reconciliation): the onboarding orchestrator only has a WHOLE-WINDOW click-through toggle
// (Phase 0), not the notch's per-region hit-rect. During Act 3 the window MUST be click-through so
// the user can flip the real System Settings toggle underneath — so this is a NON-interactive visual
// guide (no buttons; the pane is already deep-linked on entry). It sits at the TOP (below the notch)
// so it never covers the Settings toggle, and it has no directional arrow (there's nothing on-screen
// at a fixed offset to point at) and no bob animation.

type Props = {
  permission: 'screen' | 'accessibility';
  accent: string; // hex from getAccent()
};

const COPY: Record<Props['permission'], { badge: string; title: string; hint: string }> = {
  screen: {
    badge: 'Screen Recording',
    title: 'Find Kairo in the list',
    hint: "Flip my switch on — macOS will pop up to reopen me, that's normal."
  },
  accessibility: {
    badge: 'Accessibility',
    title: 'Flip the switch next to me',
    hint: 'Turn on Accessibility for Kairo Tutor so I can steer the pointer.'
  }
};

export function PermissionBridge({ permission, accent }: Props) {
  const c = COPY[permission];
  return (
    <div className="ob-bridge" style={{ ['--ob-accent' as string]: accent }} aria-hidden>
      <span className="ob-bridge-badge">{c.badge}</span>
      <div className="ob-bridge-text">
        <h2 className="ob-bridge-title">{c.title}</h2>
        <p className="ob-bridge-hint">{c.hint}</p>
      </div>
    </div>
  );
}
