import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { klog } from '../core/logger';
import {
  eraseAnnotationAtPoint,
  type AnnotationPoint,
  type AnnotationTool
} from '../annotations/annotationTools';
import type { ScreenDimensions, UserAnnotation, VisualTarget } from '../core/types';
import { createNativeBridge } from '../native/nativeBridge';
import { useTauriListeners } from '../core/useTauriListeners';
import { createPenAnnotationFromDisplayPoints, toScreenPoint } from './annotationMode';
import { subscribeToOverlayPayload } from './overlayEvents';
import { GestureLayer } from './GestureLayer';
import { VisualOverlay } from './VisualOverlay';

// Only free-draw pen and erase are exposed.
type OverlayAnnotationTool = Extract<AnnotationTool, 'pen' | 'erase'>;

export type OverlayDisplayBounds = ScreenDimensions & {
  x: number;
  y: number;
  scaleFactor: number;
};

export type OverlayPayload = {
  mode?: 'visual' | 'annotate' | 'annotation_preview' | 'gesture';
  displayBounds: OverlayDisplayBounds;
  targets: VisualTarget[];
  annotations?: UserAnnotation[];
  initialTool?: OverlayAnnotationTool | null;
};

function displayPointFromPointerEvent(event: PointerEvent<HTMLElement>): AnnotationPoint {
  const bounds = event.currentTarget.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top
  };
}

// Every sample the OS captured between two frames. A trackpad/mouse reports far faster than the
// display refreshes, so without this the stroke is built from ~1 point per frame and corners get
// cut. Absent outside Chromium/WebKit (tests) → fall back to the single event.
function coalescedDisplayPoints(event: PointerEvent<HTMLElement>): AnnotationPoint[] {
  const bounds = event.currentTarget.getBoundingClientRect();
  const native = event.nativeEvent as globalThis.PointerEvent & {
    getCoalescedEvents?: () => globalThis.PointerEvent[];
  };
  const raw = native.getCoalescedEvents?.();
  const samples = raw && raw.length > 0 ? raw : [native];

  return samples.map((sample) => ({
    x: sample.clientX - bounds.left,
    y: sample.clientY - bounds.top
  }));
}

/**
 * The LIVE pen stroke, drawn imperatively on a canvas in one rAF loop.
 *
 * This used to be React state: `setDraftPenPoints([...draftPenPoints, point])` ran on every
 * `pointermove`, so each of up to 120 events per second copied the whole array, forced a render,
 * re-derived the bounding box across every point, rebuilt the entire `<polyline points>` string
 * and repainted an SVG carrying a `drop-shadow` filter. That is where the lag came from.
 *
 * Now a drag touches no React state at all — points accumulate in a ref, one rAF paints them, and
 * React only hears about the stroke on pointerup. Same approach GestureLayer already uses for the
 * hold-to-point comet, for the same reason.
 */
function useLivePenStroke(displayBounds: OverlayDisplayBounds) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<AnnotationPoint[]>([]);
  const rafRef = useRef(0);
  // Falls back to the brand violet only if the accent var can't be read (it is set app-wide by
  // applyAccent on <html> in every webview).
  const accentRef = useRef('102, 92, 255');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    canvas.width = Math.round(displayBounds.width * dpr);
    canvas.height = Math.round(displayBounds.height * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr); // draw in CSS px, crisp on retina
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 5;
  }, [displayBounds.width, displayBounds.height]);

  // Accent tint: read the var once, then keep it live off accent:changed (the onboarding colour
  // pick recolours mid-session). Same contract GestureLayer uses.
  useEffect(() => {
    const hexToRgb = (hex: string): string | null => {
      const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
      if (!match) return null;
      const value = parseInt(match[1], 16);
      return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
    };
    const fromVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--kairo-accent-rgb')
      .trim();
    if (fromVar) accentRef.current = fromVar.replace(/\s+/g, ', ');

    let unlisten = () => {};
    void listen<{ hex?: string }>('accent:changed', (event) => {
      const rgb = event.payload?.hex ? hexToRgb(event.payload.hex) : null;
      if (rgb) accentRef.current = rgb;
    })
      .then((next) => {
        unlisten = next;
      })
      .catch(() => {
        /* browser preview / tests have no event bus */
      });
    return () => unlisten();
  }, []);

  // How many points are already on the canvas. Ink is additive, so a frame only ever needs to draw
  // what arrived since the last one — redrawing the whole path meant the per-frame cost grew with
  // the length of the stroke (and on a Retina display that is a 3420x2224 buffer being cleared and
  // re-stroked 120 times a second). Reset to 0 whenever the layer is blanked.
  const drawnRef = useRef(0);

  const paint = useCallback(() => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const points = pointsRef.current;

    // Stroke finished / cancelled → blank the layer once and start fresh.
    if (points.length === 0) {
      if (drawnRef.current !== 0) {
        context.clearRect(0, 0, displayBounds.width, displayBounds.height);
        drawnRef.current = 0;
      }
      return;
    }

    context.strokeStyle = `rgb(${accentRef.current})`;
    context.fillStyle = `rgb(${accentRef.current})`;

    // First sample: a dot, so a tap leaves a mark.
    if (drawnRef.current === 0) {
      context.beginPath();
      context.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
      context.fill();
      drawnRef.current = 1;
    }
    if (points.length < 2 || drawnRef.current >= points.length) return;

    // Continue the path from the last point already drawn. Starting one point BEHIND keeps the
    // quadratic continuous across frames — otherwise every frame boundary shows a faint kink.
    const from = Math.max(0, drawnRef.current - 1);
    context.beginPath();
    context.moveTo(points[from].x, points[from].y);
    for (let index = from + 1; index < points.length - 1; index += 1) {
      const midX = (points[index].x + points[index + 1].x) / 2;
      const midY = (points[index].y + points[index + 1].y) / 2;
      context.quadraticCurveTo(points[index].x, points[index].y, midX, midY);
    }
    context.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    context.stroke();
    drawnRef.current = points.length;
  }, [displayBounds.width, displayBounds.height]);

  const schedule = useCallback(() => {
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(
    () => () => {
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  return {
    canvasRef,
    /** Points collected so far (live reference — never copied per move). */
    pointsRef,
    begin(point: AnnotationPoint) {
      pointsRef.current = [point];
      schedule();
    },
    extend(points: AnnotationPoint[]) {
      if (pointsRef.current.length === 0) return;
      for (const point of points) pointsRef.current.push(point);
      schedule();
    },
    /** Hand the finished stroke back and blank the live layer. */
    end(): AnnotationPoint[] {
      const points = pointsRef.current;
      pointsRef.current = [];
      schedule();
      return points;
    }
  };
}

function OverlayAnnotationShape({
  annotation,
  displayBounds
}: {
  annotation: UserAnnotation;
  displayBounds: OverlayDisplayBounds;
}) {
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;
  const left = annotation.screenRegion.x / scaleFactor - displayBounds.x;
  const top = annotation.screenRegion.y / scaleFactor - displayBounds.y;
  const style = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${annotation.screenRegion.width / scaleFactor}px`,
    height: `${annotation.screenRegion.height / scaleFactor}px`
  };

  if (annotation.type === 'pen' && annotation.points) {
    const width = Math.max(annotation.screenRegion.width / scaleFactor, 1);
    const height = Math.max(annotation.screenRegion.height / scaleFactor, 1);
    const points = annotation.points
      .map((point) => {
        const x = point.x / scaleFactor - displayBounds.x - left;
        const y = point.y / scaleFactor - displayBounds.y - top;
        return `${x},${y}`;
      })
      .join(' ');

    return (
      <svg
        aria-label="pen annotation"
        className="annotation-shape pen"
        style={style}
        viewBox={`0 0 ${width} ${height}`}
      >
        <polyline points={points} />
      </svg>
    );
  }

  return <div className={`annotation-shape ${annotation.type}`} style={style} />;
}

function AnnotationOverlay({
  displayBounds,
  initialTool = 'pen',
  onDone
}: {
  displayBounds: OverlayDisplayBounds;
  initialTool?: OverlayAnnotationTool;
  onDone: (annotations: UserAnnotation[]) => void;
}) {
  const [tool, setTool] = useState<OverlayAnnotationTool>(initialTool);
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const sequence = useRef(0);
  const annotationsRef = useRef<UserAnnotation[]>([]);
  const drawingRef = useRef(false);
  const live = useLivePenStroke(displayBounds);

  useEffect(() => {
    setTool(initialTool);
  }, [initialTool]);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useTauriListeners(
    [
      () => listen('annotation:finish', () => onDone(annotationsRef.current)),
      () =>
        listen('annotation:undo', () => {
          setAnnotations((current) => {
            const nextAnnotations = current.slice(0, -1);
            void emit('annotation:sync', nextAnnotations);
            return nextAnnotations;
          });
        }),
      () =>
        listen('annotation:clear', () => {
          setAnnotations([]);
          void emit('annotation:sync', []);
        })
    ],
    [onDone]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      onDone(annotationsRef.current);
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDone]);

  // Remove the topmost annotation under the cursor (object eraser).
  function eraseAtPoint(point: AnnotationPoint) {
    const screenPoint = toScreenPoint(point, displayBounds);
    setAnnotations((current) => {
      const next = eraseAnnotationAtPoint(current, screenPoint);
      if (next !== current) {
        void emit('annotation:sync', next);
      }
      return next;
    });
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const point = displayPointFromPointerEvent(event);
    if (tool === 'erase') {
      eraseAtPoint(point);
      return;
    }

    drawingRef.current = true;
    live.begin(point);
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (tool === 'erase') {
      // Drag the eraser to remove several marks in one stroke.
      if ((event.buttons & 1) === 1) {
        eraseAtPoint(displayPointFromPointerEvent(event));
      }
      return;
    }

    // No setState here — the whole point of the canvas rewrite.
    if (drawingRef.current) live.extend(coalescedDisplayPoints(event));
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (tool === 'erase' || !drawingRef.current) {
      return;
    }

    drawingRef.current = false;
    live.extend([displayPointFromPointerEvent(event)]);
    const points = live.end();
    const previewAnnotation = createPenAnnotationFromDisplayPoints({
      id: 'preview',
      displayBounds,
      points
    });

    if (
      points.length < 2 ||
      Math.max(previewAnnotation.screenRegion.width, previewAnnotation.screenRegion.height) < 4
    ) {
      return;
    }

    sequence.current += 1;
    const annotation = createPenAnnotationFromDisplayPoints({
      id: `screen-annotation-${sequence.current}`,
      displayBounds,
      points
    });
    klog('overlay', 'debug', 'pen stroke committed', { points: points.length });
    setAnnotations((current) => [...current, annotation]);
    void emit('annotation:add', annotation);
  }

  return (
    <div className="annotation-overlay-mode">
      <div
        className="annotation-overlay-canvas"
        data-tool={tool}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          drawingRef.current = false;
          live.end();
        }}
        role="presentation"
      >
        {annotations.map((annotation) => (
          <OverlayAnnotationShape
            annotation={annotation}
            displayBounds={displayBounds}
            key={annotation.id}
          />
        ))}
        {/* The in-progress stroke. Committed strokes stay SVG (static, so they cost nothing);
            only the live one needs a canvas. */}
        <canvas
          aria-hidden="true"
          className="annotation-live-canvas"
          ref={live.canvasRef}
          style={{ width: `${displayBounds.width}px`, height: `${displayBounds.height}px` }}
        />
      </div>
    </div>
  );
}

function AnnotationPreview({
  annotations,
  displayBounds
}: {
  annotations: UserAnnotation[];
  displayBounds: OverlayDisplayBounds;
}) {
  return (
    <div className="annotation-preview-mode" aria-label="Kairo user annotations">
      {annotations.map((annotation) => (
        <OverlayAnnotationShape
          annotation={annotation}
          displayBounds={displayBounds}
          key={annotation.id}
        />
      ))}
    </div>
  );
}

export function OverlayApp() {
  const [payload, setPayload] = useState<OverlayPayload | null>(null);
  const nativeBridge = useMemo(() => createNativeBridge(), []);

  useEffect(() => {
    document.documentElement.classList.add('overlay-document');
    document.body.classList.add('overlay-document');

    return () => {
      document.documentElement.classList.remove('overlay-document');
      document.body.classList.remove('overlay-document');
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    void subscribeToOverlayPayload({
      listen,
      readCurrentPayload: () => nativeBridge.getCurrentOverlayPayload(),
      onPayload: (nextPayload) => {
        if (isMounted) {
          setPayload(nextPayload);
        }
      }
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [nativeBridge]);

  // Pen-mark flicker fix: when the native side hides the overlay it emits `overlay:clear` FIRST (while
  // we're still visible). Blank everything now so the last painted frame is empty — a hidden webview
  // freezes its last frame and would otherwise flash the old strokes/box on the next show.
  useEffect(() => {
    let un = () => {};
    void listen('overlay:clear', () => setPayload(null))
      .then((next) => {
        un = next;
      })
      .catch(() => {
        /* browser preview / tests have no event bus */
      });
    return () => un();
  }, []);

  return (
    <main className="overlay-shell" aria-label="Kairo visual overlay">
      {payload?.mode === 'gesture' ? (
        <GestureLayer displayBounds={payload.displayBounds} />
      ) : payload?.mode === 'annotate' ? (
        <AnnotationOverlay
          displayBounds={payload.displayBounds}
          initialTool={payload.initialTool ?? 'pen'}
          onDone={(annotations) => {
            const previewPayload: OverlayPayload = {
              mode: 'annotation_preview',
              displayBounds: payload.displayBounds,
              targets: [],
              annotations
            };
            void (async () => {
              try {
                await nativeBridge.updateOverlay(previewPayload);
              } finally {
                await emit('annotation:done', {});
              }
            })();
          }}
        />
      ) : payload?.mode === 'annotation_preview' ? (
        <AnnotationPreview
          annotations={payload.annotations ?? []}
          displayBounds={payload.displayBounds}
        />
      ) : payload ? (
        <VisualOverlay
          targets={payload.targets}
          dimensions={{
            width: payload.displayBounds.width,
            height: payload.displayBounds.height
          }}
          displayBounds={payload.displayBounds}
        />
      ) : null}
    </main>
  );
}
