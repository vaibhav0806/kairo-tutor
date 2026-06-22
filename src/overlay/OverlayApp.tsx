import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ScreenDimensions, VisualTarget } from '../core/types';
import { createNativeBridge } from '../native/nativeBridge';
import { subscribeToOverlayPayload } from './overlayEvents';
import { VisualOverlay } from './VisualOverlay';

type OverlayDisplayBounds = ScreenDimensions & {
  x: number;
  y: number;
  scaleFactor: number;
};

export type OverlayPayload = {
  displayBounds: OverlayDisplayBounds;
  targets: VisualTarget[];
};

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
      {payload ? (
        <VisualOverlay
          targets={payload.targets}
          dimensions={{
            width: payload.displayBounds.width,
            height: payload.displayBounds.height
          }}
        />
      ) : null}
    </main>
  );
}
