import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { motion, useDragControls, useReducedMotion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../../core/logger';

const INTERACTIVE_SELECTOR =
  'button, input, select, textarea, a, label, [role="button"], [role="radio"], [role="switch"]';

/**
 * Makes a floating onboarding card feel like a small application window without moving the
 * full-screen native onboarding panel itself. The native panel must continue covering the display
 * so the later permission and real-screen acts work; only this visible surface moves.
 */
export function DraggableSurface({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef<HTMLDivElement | null>(null);
  const reportFrameRef = useRef<number | null>(null);
  const controls = useDragControls();
  const reduce = useReducedMotion();

  const reportHitRect = useCallback(() => {
    if (reportFrameRef.current !== null) return;
    reportFrameRef.current = window.requestAnimationFrame(() => {
      reportFrameRef.current = null;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      void invoke('set_onboarding_hit_rect', {
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      }).catch((error) => {
        klog('onboarding', 'warn', 'drag surface hit rect failed', {
          surface: label,
          error: String(error)
        });
      });
    });
  }, [label]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    reportHitRect();
    const settle = window.setTimeout(reportHitRect, 440);
    const observer = new ResizeObserver(reportHitRect);
    observer.observe(surface);
    window.addEventListener('resize', reportHitRect);
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener('resize', reportHitRect);
      if (reportFrameRef.current !== null) window.cancelAnimationFrame(reportFrameRef.current);
      void invoke('set_onboarding_hit_rect', { rect: null }).catch(() => {});
    };
  }, [reportHitRect]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    controls.start(event);
  };

  return (
    <>
      <div ref={boundsRef} className="ob-drag-bounds" aria-hidden />
      <motion.div
        ref={surfaceRef}
        className="ob-drag-surface"
        drag
        dragControls={controls}
        dragListener={false}
        dragConstraints={boundsRef}
        dragElastic={0.06}
        dragMomentum={false}
        whileDrag={reduce ? undefined : { scale: 1.008 }}
        transition={{ type: 'spring', stiffness: 520, damping: 42 }}
        onPointerDown={beginDrag}
        onDragStart={() => klog('onboarding', 'info', 'card drag started', { surface: label })}
        onDrag={reportHitRect}
        onDragEnd={() => {
          reportHitRect();
          klog('onboarding', 'info', 'card drag ended', { surface: label });
        }}
      >
        {children}
      </motion.div>
    </>
  );
}
