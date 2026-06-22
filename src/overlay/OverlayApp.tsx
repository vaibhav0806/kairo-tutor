import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import {
  type AnnotationPoint,
  type AnnotationTool,
  createAnnotationFromDrag
} from '../annotations/annotationTools';
import type { ScreenDimensions, UserAnnotation, VisualTarget } from '../core/types';
import { createNativeBridge } from '../native/nativeBridge';
import { createAnnotationFromDisplayDrag } from './annotationMode';
import { subscribeToOverlayPayload } from './overlayEvents';
import { VisualOverlay } from './VisualOverlay';

type OverlayDisplayBounds = ScreenDimensions & {
  x: number;
  y: number;
  scaleFactor: number;
};

export type OverlayPayload = {
  mode?: 'visual' | 'annotate';
  displayBounds: OverlayDisplayBounds;
  targets: VisualTarget[];
};

const annotationTools: Exclude<AnnotationTool, 'erase'>[] = [
  'rectangle',
  'circle',
  'highlight',
  'underline'
];

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
  const style = {
    left: `${annotation.screenRegion.x / scaleFactor - displayBounds.x}px`,
    top: `${annotation.screenRegion.y / scaleFactor - displayBounds.y}px`,
    width: `${annotation.screenRegion.width / scaleFactor}px`,
    height: `${annotation.screenRegion.height / scaleFactor}px`
  };

  return <div className={`annotation-shape ${annotation.type}`} style={style} />;
}

function AnnotationOverlay({
  displayBounds,
  onDone
}: {
  displayBounds: OverlayDisplayBounds;
  onDone: () => void;
}) {
  const [tool, setTool] = useState<Exclude<AnnotationTool, 'erase'>>('rectangle');
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const [draftDrag, setDraftDrag] = useState<{
    type: Exclude<AnnotationTool, 'erase'>;
    start: AnnotationPoint;
    end: AnnotationPoint;
  } | null>(null);
  const sequence = useRef(0);

  const draftAnnotation = draftDrag
    ? createAnnotationFromDisplayDrag({
        id: 'draft-annotation',
        type: draftDrag.type,
        displayBounds,
        start: draftDrag.start,
        end: draftDrag.end
      })
    : null;

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const point = displayPointFromPointerEvent(event);
    setDraftDrag({
      type: tool,
      start: point,
      end: point
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (!draftDrag) {
      return;
    }

    setDraftDrag({
      ...draftDrag,
      end: displayPointFromPointerEvent(event)
    });
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    if (!draftDrag) {
      return;
    }

    const end = displayPointFromPointerEvent(event);
    const previewAnnotation = createAnnotationFromDrag({
      id: 'preview',
      type: draftDrag.type,
      start: draftDrag.start,
      end
    });
    setDraftDrag(null);

    if (previewAnnotation.screenRegion.width < 4 || previewAnnotation.screenRegion.height < 4) {
      return;
    }

    sequence.current += 1;
    const annotation = createAnnotationFromDisplayDrag({
      id: `screen-annotation-${sequence.current}`,
      type: draftDrag.type,
      displayBounds,
      start: draftDrag.start,
      end
    });
    setAnnotations((current) => [...current, annotation]);
    void emit('annotation:add', annotation);
  }

  return (
    <div className="annotation-overlay-mode">
      <div className="annotation-overlay-toolbar">
        {annotationTools.map((nextTool) => (
          <button
            aria-pressed={tool === nextTool}
            className={tool === nextTool ? 'selected' : undefined}
            key={nextTool}
            type="button"
            onClick={() => setTool(nextTool)}
          >
            {nextTool}
          </button>
        ))}
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
      <div
        className="annotation-overlay-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDraftDrag(null)}
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
          onDone={() => {
            void emit('annotation:done', {});
            void nativeBridge.hideOverlay();
          }}
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
