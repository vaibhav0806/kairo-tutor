import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A segmented control whose indicator TRAVELS. The old one hard-swapped a background between
 * cells, which is the one thing a segmented control exists not to do — the motion is what tells
 * you the two options are the same kind of thing.
 *
 * The indicator is a single positioned element measured off the active button (no per-cell
 * backgrounds), filled with the user's accent. Arrow keys move between options, matching the
 * radiogroup semantics the markup now declares.
 */
export type SegmentedOption<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  label
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const active = track?.querySelector<HTMLButtonElement>('[data-active="true"]');
    if (!track || !active) return;
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, []);

  // Measure after layout so the first paint already has the indicator in the right place —
  // otherwise it visibly slides in from the left on mount.
  useLayoutEffect(measure, [measure, value, options.length]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure]);

  const move = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + delta + options.length) % options.length];
    if (next && next.value !== value) onChange(next.value);
  };

  return (
    <div
      className="kseg"
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {/* Hidden until measured, so it never animates in from 0. */}
      <span
        aria-hidden
        className="kseg-ind"
        style={
          indicator
            ? { transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }
            : { opacity: 0 }
        }
      />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className="kseg-opt"
            data-active={active}
            disabled={disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
