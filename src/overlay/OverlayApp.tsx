import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import {
  eraseAnnotationAtPoint,
  type AnnotationPoint,
  type AnnotationTool
} from '../annotations/annotationTools';
import type { ScreenDimensions, UserAnnotation, VisualTarget } from '../core/types';
import { createNativeBridge } from '../native/nativeBridge';
import { createPenAnnotationFromDisplayPoints, toScreenPoint } from './annotationMode';
import { subscribeToOverlayPayload } from './overlayEvents';
import { VisualOverlay } from './VisualOverlay';

// Only free-draw pen and erase are exposed.
type OverlayAnnotationTool = Extract<AnnotationTool, 'pen' | 'erase'>;

type OverlayDisplayBounds = ScreenDimensions & {
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
    x: ((event.clientX - bounds.left) / bounds.width) * bounds.width,
    y: ((event.clientY - bounds.top) / bounds.height) * bounds.height
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
  const [draftPenPoints, setDraftPenPoints] = useState<AnnotationPoint[] | null>(null);
  const sequence = useRef(0);
  const annotationsRef = useRef<UserAnnotation[]>([]);

  useEffect(() => {
    setTool(initialTool);
  }, [initialTool]);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen('annotation:finish', () => {
        if (!isMounted) {
          return;
        }

        onDone(annotationsRef.current);
      }),
      listen('annotation:undo', () => {
        if (!isMounted) {
          return;
        }

        setAnnotations((current) => {
          const nextAnnotations = current.slice(0, -1);
          void emit('annotation:sync', nextAnnotations);
          return nextAnnotations;
        });
      }),
      listen('annotation:clear', () => {
        if (!isMounted) {
          return;
        }

        setAnnotations([]);
        void emit('annotation:sync', []);
      })
    ])
      .then((nextUnlisteners) => {
        unlisteners.push(...nextUnlisteners);
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [onDone]);

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

  const draftAnnotation = draftPenPoints
    ? createPenAnnotationFromDisplayPoints({
        id: 'draft-annotation',
        displayBounds,
        points: draftPenPoints
      })
    : null;

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

    setDraftPenPoints([point]);
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (tool === 'erase') {
      // Drag the eraser to remove several marks in one stroke.
      if ((event.buttons & 1) === 1) {
        eraseAtPoint(displayPointFromPointerEvent(event));
      }
      return;
    }

    if (draftPenPoints) {
      setDraftPenPoints([...draftPenPoints, displayPointFromPointerEvent(event)]);
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (tool === 'erase' || !draftPenPoints) {
      return;
    }

    const points = [...draftPenPoints, displayPointFromPointerEvent(event)];
    const previewAnnotation = createPenAnnotationFromDisplayPoints({
      id: 'preview',
      displayBounds,
      points
    });
    setDraftPenPoints(null);

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
          setDraftPenPoints(null);
        }}
        role="presentation"
      >
        {[...annotations, ...(draftAnnotation ? [draftAnnotation] : [])].map((annotation) => (
          <OverlayAnnotationShape
            annotation={annotation}
            displayBounds={displayBounds}
            key={annotation.id}
          />
        ))}
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

  return (
    <main className="overlay-shell" aria-label="Kairo visual overlay">
      {payload?.mode === 'annotate' ? (
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
