import type { CSSProperties } from 'react';
import type { ScreenDimensions, VisualTarget } from '../core/types';
import {
  type DisplayBounds,
  normalizeRegionToDisplayPercent,
  normalizeRegionToPercent
} from './coordinates';

// Relative luminance (0..1) of a #rrggbb hex — used to pick readable caption text.
function hexLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return 0.5;
  }
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function OverlayTarget({
  target,
  dimensions,
  displayBounds
}: {
  target: VisualTarget;
  dimensions: ScreenDimensions;
  displayBounds?: DisplayBounds;
}) {
  const region = displayBounds
    ? normalizeRegionToDisplayPercent(target.screenRegion, displayBounds)
    : normalizeRegionToPercent(target.screenRegion, dimensions);

  // A pointer marks a single spot: a small main circle on the point, a pulsating
  // ring around it for attention, and a compact purple-gradient arrow whose tip
  // rests on the point. All fixed-size + centered on the point.
  if (target.kind === 'pointer') {
    return (
      <div
        aria-label={target.label}
        className="overlay-target pointer"
        style={{
          left: `${region.left}%`,
          top: `${region.top}%`,
          width: `${region.width}%`,
          height: `${region.height}%`
        }}
      >
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
        {target.label ? <span className="overlay-pointer-label">{target.label}</span> : null}
      </div>
    );
  }

  const color = target.color;
  const style: CSSProperties = {
    left: `${region.left}%`,
    top: `${region.top}%`,
    width: `${region.width}%`,
    height: `${region.height}%`
  };
  // Dynamic accent: tint border + glow to the colour sampled behind the box.
  if (color && target.kind === 'highlight_box') {
    style.borderColor = color;
    style.boxShadow = `0 0 0 9999px rgb(10 14 18 / 0.08), 0 0 24px ${color}59`;
  }

  const labelStyle: CSSProperties | undefined = color
    ? {
        background: color,
        borderColor: 'rgb(255 255 255 / 0.4)',
        boxShadow: `0 2px 10px ${color}73`,
        color: hexLuminance(color) > 0.6 ? '#0a0e12' : '#ffffff'
      }
    : undefined;

  return (
    <div
      aria-label={target.label}
      className={`overlay-target ${target.kind}`}
      style={style}
      title={`${target.label} (${Math.round(target.confidence * 100)}%)`}
    >
      {target.kind === 'highlight_box' && target.label ? (
        <span className="overlay-box-label" style={labelStyle}>
          {target.label}
        </span>
      ) : null}
    </div>
  );
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
  return (
    <div className="visual-overlay" aria-label="Tutor visual targets">
      {targets.map((target) => (
        <OverlayTarget
          key={`${target.kind}-${target.targetId}`}
          target={target}
          dimensions={dimensions}
          displayBounds={displayBounds}
        />
      ))}
    </div>
  );
}
