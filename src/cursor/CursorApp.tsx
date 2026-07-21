//! The companion "pet cursor": a filled navigation arrow that shadows the real
//! mouse, flies to on-screen targets, draws pen boxes, and surfaces turn status
//! (listening halo / thinking swirl / speaking pulse). All the imperative work —
//! the rAF spring loop, pen-drag timeline, auto-hide, and `cursor:*` listeners —
//! lives in `useCursorEngine`; this component is just the markup it binds to.

import { GLYPH_SIZE, TIP_AX, TIP_AY, VIEWBOX } from './cursorConstants';
import { useCursorEngine } from './useCursorEngine';

export function CursorApp() {
  const { shellRef, fxRef, trailRef, elementRef, arrowPathRef } = useCursorEngine();

  return (
    <div className="kairo-cursor-shell" ref={shellRef} data-fx="none" aria-hidden="true">
      <div className="kairo-cursor-fx" ref={fxRef} aria-hidden="true">
        <span className="kairo-cursor-halo" />
        <span className="kairo-cursor-think">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="kairo-cursor-trail" ref={trailRef} aria-hidden="true" />
      <div
        className="kairo-cursor"
        ref={elementRef}
        style={{ width: GLYPH_SIZE, height: GLYPH_SIZE, transformOrigin: `${TIP_AX}px ${TIP_AY}px` }}
      >
        <svg className="kairo-cursor-arrow" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
          <defs>
            <linearGradient id="kairo-cursor-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c79bff" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
          </defs>
          <path
            ref={arrowPathRef}
            d="M28 4 L6 14 L15 17 L18 26 Z"
            fill="url(#kairo-cursor-grad)"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
