import type { CSSProperties } from 'react';
import type { ScreenDimensions, VisualTarget } from '../core/types';
import {
  type DisplayBounds,
  normalizeRegionToDisplayPercent,
  normalizeRegionToPercent
} from './coordinates';

// Kairo guidance renders exactly two things: a companion-cursor pointer at the
// click point, and a highlight_box rectangle around the target. No on-screen
// labels — the spoken answer carries the meaning.
export function OverlayTarget({
  target,
  dimensions,
  displayBounds,
  renderPointTarget = true
}: {
  target: VisualTarget;
  dimensions: ScreenDimensions;
  displayBounds?: DisplayBounds;
  renderPointTarget?: boolean;
}) {
  const region = displayBounds
    ? normalizeRegionToDisplayPercent(target.screenRegion, displayBounds)
    : normalizeRegionToPercent(target.screenRegion, dimensions);

  const style: CSSProperties = {
    left: `${region.left}%`,
    top: `${region.top}%`,
    width: `${region.width}%`,
    height: `${region.height}%`
  };

  if (target.kind === 'pointer') {
    if (!renderPointTarget) {
      return null;
    }
    return (
      <div aria-label={target.label} className="overlay-target pointer" style={style}>
        <span className="overlay-pointer-ping" aria-hidden="true" />
        <span className="overlay-pointer-ring" aria-hidden="true" />
        <svg className="overlay-pointer-cursor" viewBox="0 0 24 32" aria-hidden="true">
          <defs>
            <linearGradient id="kairo-pointer-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c79bff" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
          </defs>
          <path
            d="M23 1 L23 27 L15.5 20.5 L11 31 L6 29 L10.5 18.5 L1 18.5 Z"
            fill="url(#kairo-pointer-grad)"
            stroke="#ffffff"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }

  // highlight_box: a stable purple rectangle around the target.
  return <div aria-label={target.label} className="overlay-target highlight_box" style={style} />;
}

export function VisualOverlay({
  targets,
  dimensions,
  displayBounds
}: {
  targets: VisualTarget[];
  dimensions: ScreenDimensions;
  displayBounds?: DisplayBounds;
}) {
  // When a persistent highlight is present, the companion cursor is the only
  // pointer — suppress the overlay's own duplicate point marker.
  const hasPersistentTarget = targets.some((target) => target.kind !== 'pointer');

  return (
    <div className="visual-overlay" aria-label="Tutor visual targets">
      {targets.map((target) => (
        <OverlayTarget
          key={`${target.kind}-${target.targetId}`}
          target={target}
          dimensions={dimensions}
          displayBounds={displayBounds}
          renderPointTarget={!hasPersistentTarget}
        />
      ))}
    </div>
  );
}
