import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { klog } from '../core/logger';

const BARS = 7;

// Accent-tinted mic meter — the classic dancing-bars "we can hear you" waveform (the design pattern
// Wispr/Siri/voice apps use). Fed by the EXISTING global `cursor:level` stream that native already
// emits while the mic captures (audio.rs) — it NEVER grabs its own mic (no getUserMedia / MediaRecorder
// / AudioContext), so it can't collide with native cpal or light a second mic indicator.
//
// It smooths toward the latest level and DECAYS to 0 when no level arrives (>120ms), so the bars go
// reliably flat on silence or on ⌥⌃ release — native may never emit a final zero, so we don't rely on it.
export function MicMeter() {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const target = useRef(0);
  const shown = useRef(0);
  const lastAt = useRef(0);

  useEffect(() => {
    let raf = 0;
    const un = listen<{ level: number }>('cursor:level', (e) => {
      target.current = Math.max(0, Math.min(1, e.payload.level ?? 0));
      lastAt.current = performance.now();
    });
    const tick = () => {
      // No fresh level for >120ms → treat as silence, ease the target to 0 (duck-to-flat).
      if (performance.now() - lastAt.current > 120) target.current *= 0.8;
      shown.current += (target.current - shown.current) * 0.35; // smooth
      rootRef.current?.style.setProperty('--mic-level', shown.current.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    klog('mic', 'info', 'mic meter mounted');
    return () => {
      cancelAnimationFrame(raf);
      void un.then((f) => f());
      klog('mic', 'info', 'mic meter unmounted');
    };
  }, []);

  return (
    <span ref={rootRef} className="kairo-mic-meter" aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
