import { useEffect, useState } from 'react';
import { klog } from '../../core/logger';
import { playSound } from '../../core/sound';
import { HERO_COPY } from '../copy';
import { heroDemoSrc } from '../heroDemo';

// Act 0 — the split "front door" (v2 spec §C.2). Static left (brand + one line + one CTA + tiny legal),
// motion right (one looping demo + a serif value line + a blurred/zoomed backdrop for depth). Lighter
// than a carousel: one demo, then we rush into the REAL practice. This is the ONLY new windowed surface
// besides the color card — Acts 2/3/4 stay windowless (thesis intact).
//
// AUDIO-UNLOCK GOTCHA: the hero is the FIRST screen, before any user gesture, so the shared AudioContext
// isn't unlocked yet. The hero is therefore SILENT on mount (no say/chime/TTS). The first cue is
// playSound('morph') on the Get-started CLICK — a real gesture that both plays the whoosh AND unlocks
// the context for every later cue/TTS.
export function Act0Hero({ onGetStarted }: { onGetStarted: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    klog('onboarding', 'info', 'hero shown');
  }, []);

  const handleStart = () => {
    if (leaving) return;
    klog('onboarding', 'info', 'hero get-started');
    playSound('morph'); // synchronous inside the gesture → unlocks the AudioContext + plays the whoosh
    setLeaving(true); // adds .ob-morph-out to the card
    window.setTimeout(onGetStarted, 200); // advance after the morph-out plays
  };

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      <div className={`ob-card ob-card--hero${leaving ? ' ob-morph-out' : ''}`}>
        <div className="ob-hero-left">
          <div className="ob-hero-mark">{HERO_COPY.wordmark}</div>
          <h1 className="ob-hero-h1">{HERO_COPY.h1}</h1>
          <p className="ob-hero-sub">{HERO_COPY.sub}</p>
          <button type="button" className="ob-hero-cta" onClick={handleStart}>
            {HERO_COPY.cta}
          </button>
          <p className="ob-hero-legal">{HERO_COPY.legal}</p>
        </div>
        <div className="ob-hero-right">
          {/* Depth layer: the same demo frame, blurred + scaled up, sitting behind the crisp one. */}
          <div className="ob-hero-backdrop" aria-hidden>
            <HeroDemoInner />
          </div>
          <div className="ob-hero-demo">
            <HeroDemoInner />
            <div className="ob-hero-value">{HERO_COPY.value}</div>
          </div>
        </div>
      </div>
    </>
  );
}

// The looping demo: the real curated GIF once it lands (heroDemoSrc), else the pure-CSS mock so the
// layout is fully testable with zero image asset. Both the crisp foreground and the blurred backdrop
// render this, so swapping in the GIF fills both.
function HeroDemoInner() {
  return heroDemoSrc ? (
    <img className="ob-hero-demo-media" src={heroDemoSrc} alt="" />
  ) : (
    <HeroDemoMock />
  );
}

// Pure-CSS stand-in for the hero demo: a faux app window with an accent "pet" glyph that drifts to a
// target on a loop. Decorative only; the real GIF replaces it via heroDemo.ts.
function HeroDemoMock() {
  return (
    <div className="ob-hero-mock" aria-hidden>
      <div className="ob-hero-mock-window">
        <div className="ob-hero-mock-bar">
          <span />
          <span />
          <span />
        </div>
        <div className="ob-hero-mock-body">
          <div className="ob-hero-mock-target" />
          <div className="ob-hero-mock-pet" />
        </div>
      </div>
    </div>
  );
}
