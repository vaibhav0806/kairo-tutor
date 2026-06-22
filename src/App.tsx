import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  type AnnotationPoint,
  type AnnotationTool,
  createAnnotationFromDrag,
  eraseAnnotationAtPoint,
  normalizeDragToRegion
} from './annotations/annotationTools';
import {
  type ActivationState,
  activationStateToNotchPayload,
  reduceActivationState
} from './activation/activationState';
import { loadBrowserEnv } from './config/env';
import { createMockTutorPlanner } from './core/mockTutor';
import { createTutorOrchestrator } from './core/orchestrator';
import type { ScreenDimensions, TutorResponse, UserAnnotation } from './core/types';
import {
  createNativeBridge,
  type NativeActiveApp,
  type NativePermissionState,
  type NativePermissionStatus,
  type NativeScreenCapture,
  type NativeShortcutRegistration
} from './native/nativeBridge';
import { normalizeRegionToPercent } from './overlay/coordinates';
import { VisualOverlay } from './overlay/VisualOverlay';
import type { NotchAskPayload } from './notch/prompt';
import { resolveScreenPreview } from './screenPreview';

const demoContext = {
  activeApp: 'Blender',
  bundleId: 'org.blenderfoundation.blender',
  windowTitle: 'Blender',
  source: 'web-fallback' as const
};

const mockPreviewDimensions: ScreenDimensions = {
  width: 1920,
  height: 1080
};

const annotationTools: AnnotationTool[] = ['rectangle', 'circle', 'highlight', 'underline', 'erase'];

function isPermissionGranted(status: NativePermissionStatus, permission: keyof NativePermissionStatus) {
  return status[permission] === 'granted';
}

function permissionStateLabel(state: NativePermissionState) {
  if (state === 'granted') {
    return 'Granted';
  }

  if (state === 'denied') {
    return 'Needs access';
  }

  if (state === 'not_determined') {
    return 'Needs setup';
  }

  return 'Checking';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function AnnotationShape({
  annotation,
  dimensions
}: {
  annotation: UserAnnotation;
  dimensions: ScreenDimensions;
}) {
  const region = normalizeRegionToPercent(annotation.screenRegion, dimensions);
  const style = {
    left: `${region.left}%`,
    top: `${region.top}%`,
    width: `${region.width}%`,
    height: `${region.height}%`
  };

  return (
    <div
      aria-label={`${annotation.type} annotation`}
      className={`annotation-shape ${annotation.type}`}
      style={style}
    />
  );
}

function AnnotationLayer({
  annotations,
  draftAnnotation,
  dimensions
}: {
  annotations: UserAnnotation[];
  draftAnnotation: UserAnnotation | null;
  dimensions: ScreenDimensions;
}) {
  return (
    <div className="annotation-layer" aria-label="User annotations">
      {[...annotations, ...(draftAnnotation ? [draftAnnotation] : [])].map((annotation) => (
        <AnnotationShape key={annotation.id} annotation={annotation} dimensions={dimensions} />
      ))}
    </div>
  );
}

export function App() {
  const env = loadBrowserEnv();
  const planner = useMemo(() => createMockTutorPlanner(), []);
  const orchestrator = useMemo(
    () =>
      createTutorOrchestrator({
        planner: async (input) =>
          planner.planNextStep({
            ...input.activeApp,
            userQuery: input.userQuery,
            annotations: input.annotations
          })
      }),
    [planner]
  );
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const requiredPermissions = useMemo(
    () =>
      [
        {
          key: 'screenRecording' as const,
          label: 'Screen Recording',
          detail: 'Lets Kairo inspect the active screen before giving visual guidance.'
        },
        {
          key: 'accessibility' as const,
          label: 'Accessibility',
          detail: 'Lets Kairo identify the active app and focused window.'
        },
        ...(env.sttProvider === 'sarvam'
          ? [
              {
                key: 'microphone' as const,
                label: 'Microphone',
                detail: 'Lets Kairo listen when voice input is enabled.'
              }
            ]
          : [])
      ],
    [env.sttProvider]
  );
  const [query, setQuery] = useState('Help me make my first animation');
  const [activeApp, setActiveApp] = useState<NativeActiveApp>(demoContext);
  const [permissions, setPermissions] = useState<NativePermissionStatus>({
    screenRecording: 'unknown',
    accessibility: 'unknown',
    microphone: 'unknown'
  });
  const [screenCapture, setScreenCapture] = useState<NativeScreenCapture | null>(null);
  const [isOverlayActive, setIsOverlayActive] = useState(false);
  const [activationState, setActivationState] = useState<ActivationState>('idle');
  const [overlayActivationCount, setOverlayActivationCount] = useState(0);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('rectangle');
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const [draftDrag, setDraftDrag] = useState<{
    type: Exclude<AnnotationTool, 'erase'>;
    start: AnnotationPoint;
    end: AnnotationPoint;
  } | null>(null);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const annotationSequence = useRef(0);
  const [activationShortcut, setActivationShortcut] = useState<NativeShortcutRegistration>({
    registered: true,
    shortcut: 'CommandOrControl+Shift+Space',
    reason: 'Registered by native app shell.'
  });
  const [response, setResponse] = useState<TutorResponse>(() =>
    planner.createIdleResponse(env.defaultSkill)
  );
  const previewSource = resolveScreenPreview(screenCapture, mockPreviewDimensions);

  const showActivationState = useCallback(
    async (nextState: ActivationState) => {
      setActivationState(nextState);
      await nativeBridge.showNotch(activationStateToNotchPayload(nextState));
    },
    [nativeBridge]
  );

  const askTutor = useCallback(async (nextQuery = query) => {
    const nextThinkingState = reduceActivationState(activationState, { type: 'thinking_started' });
    await showActivationState(nextThinkingState);
    const nextResponse = await orchestrator.runTextTurn({
      request: {
        ...activeApp,
        userQuery: nextQuery,
        annotations
      },
      screenCapture,
      skillSlug: env.defaultSkill
    });
    setResponse(nextResponse);

    const hasVisualTargets = nextResponse.visualTargets.length > 0;
    setIsOverlayActive(hasVisualTargets);
    if (hasVisualTargets) {
      setOverlayActivationCount((count) => count + 1);
    } else {
      void nativeBridge.hideOverlay();
    }
    await showActivationState(reduceActivationState(nextThinkingState, { type: 'response_ready' }));
  }, [
    activationState,
    activeApp,
    annotations,
    env.defaultSkill,
    nativeBridge,
    orchestrator,
    query,
    screenCapture,
    showActivationState
  ]);

  function pointFromPointerEvent(event: PointerEvent<HTMLElement>): AnnotationPoint {
    const bounds = event.currentTarget.getBoundingClientRect();

    return {
      x: clamp(
        ((event.clientX - bounds.left) / bounds.width) * previewSource.dimensions.width,
        0,
        previewSource.dimensions.width
      ),
      y: clamp(
        ((event.clientY - bounds.top) / bounds.height) * previewSource.dimensions.height,
        0,
        previewSource.dimensions.height
      )
    };
  }

  function handleAnnotationPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }

    const point = pointFromPointerEvent(event);
    if (annotationTool === 'erase') {
      setAnnotations((currentAnnotations) => eraseAnnotationAtPoint(currentAnnotations, point));
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftDrag({
      type: annotationTool,
      start: point,
      end: point
    });
  }

  function handleAnnotationPointerMove(event: PointerEvent<HTMLElement>) {
    if (!draftDrag) {
      return;
    }

    setDraftDrag({
      ...draftDrag,
      end: pointFromPointerEvent(event)
    });
  }

  function handleAnnotationPointerUp(event: PointerEvent<HTMLElement>) {
    if (!draftDrag) {
      return;
    }

    const end = pointFromPointerEvent(event);
    const screenRegion = normalizeDragToRegion(draftDrag.start, end);
    setDraftDrag(null);

    if (screenRegion.width < 4 || screenRegion.height < 4) {
      return;
    }

    annotationSequence.current += 1;
    setAnnotations((currentAnnotations) => [
      ...currentAnnotations,
      createAnnotationFromDrag({
        id: `annotation-${annotationSequence.current}`,
        type: draftDrag.type,
        start: draftDrag.start,
        end
      })
    ]);
  }

  const refreshNativeContext = useCallback(async () => {
    const [nextActiveApp, nextPermissions] = await Promise.all([
      nativeBridge.getActiveApp(),
      nativeBridge.getPermissionStatus()
    ]);
    setActiveApp(nextActiveApp);
    setPermissions(nextPermissions);
  }, [nativeBridge]);

  const refreshPermissionStatus = useCallback(async () => {
    setPermissions(await nativeBridge.getPermissionStatus());
  }, [nativeBridge]);

  const handleActivationShortcut = useCallback(async () => {
    const listeningState = reduceActivationState('idle', { type: 'shortcut_pressed' });
    await showActivationState(listeningState);
    setIsOverlayActive(false);
    void nativeBridge.hideOverlay();
    const [nextActiveApp, nextPermissions, nextScreenCapture] = await Promise.all([
      nativeBridge.getActiveApp(),
      nativeBridge.getPermissionStatus(),
      nativeBridge.captureScreen()
    ]);
    setActiveApp(nextActiveApp);
    setPermissions(nextPermissions);
    setScreenCapture(nextScreenCapture);
    await showActivationState(
      reduceActivationState(listeningState, {
        type: nextScreenCapture.captured ? 'capture_complete' : 'capture_failed'
      })
    );
  }, [nativeBridge, showActivationState]);

  async function captureNativeScreen() {
    setScreenCapture(await nativeBridge.captureScreen());
  }

  async function requestRequiredPermissions() {
    setIsRequestingPermissions(true);
    try {
      const nextPermissions = await nativeBridge.requestRequiredPermissions();
      setPermissions(nextPermissions);

      if (env.sttProvider === 'sarvam' && nextPermissions.microphone !== 'granted') {
        await nativeBridge.openPermissionSettings('microphone');
      }

      await refreshNativeContext();
    } finally {
      setIsRequestingPermissions(false);
    }
  }

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    void refreshNativeContext();

    void listen('activation:shortcut', () => {
      void handleActivationShortcut();
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
        if (isMounted) {
          setActivationShortcut({
            registered: true,
            shortcut: 'CommandOrControl+Shift+Space',
            reason: 'Registered by native app shell.'
          });
        }
      })
      .catch((error) => {
        if (isMounted) {
          setActivationShortcut({
            registered: false,
            shortcut: 'CommandOrControl+Shift+Space',
            reason:
              error instanceof Error
                ? error.message
                : 'Native activation listener is unavailable in this environment.'
          });
        }
      });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [handleActivationShortcut, refreshNativeContext]);

  useEffect(() => {
    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen<NotchAskPayload>('notch:ask', (event) => {
        if (!isMounted) {
          return;
        }

        setQuery(event.payload.query);
        void askTutor(event.payload.query);
      }),
      listen('annotation:start', () => {
        if (!isMounted || !screenCapture?.displayBounds) {
          return;
        }

        void nativeBridge.hideNotch();
        void nativeBridge.showAnnotationOverlay(screenCapture.displayBounds);
      }),
      listen<UserAnnotation>('annotation:add', (event) => {
        if (!isMounted) {
          return;
        }

        setAnnotations((currentAnnotations) => [...currentAnnotations, event.payload]);
      }),
      listen('annotation:done', () => {
        if (!isMounted) {
          return;
        }

        void showActivationState('captured');
      })
    ])
      .then((nextUnlisteners) => {
        unlisteners.push(...nextUnlisteners);
      })
      .catch(() => {
        // Browser preview runs without the native event bus.
      });

    return () => {
      isMounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [askTutor, nativeBridge, screenCapture?.displayBounds, showActivationState]);

  const missingPermissions = requiredPermissions.filter(
    (permission) => !isPermissionGranted(permissions, permission.key)
  );

  useEffect(() => {
    if (missingPermissions.length === 0) {
      return undefined;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshPermissionStatus();
      }
    };

    const interval = window.setInterval(() => {
      void refreshPermissionStatus();
    }, 3000);

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [missingPermissions.length, refreshPermissionStatus]);

  useEffect(() => {
    if (!isOverlayActive || response.visualTargets.length === 0) {
      void nativeBridge.hideOverlay();
      return undefined;
    }

    void nativeBridge.showOverlay({
      displayBounds: screenCapture?.displayBounds ?? {
        x: 0,
        y: 0,
        width: mockPreviewDimensions.width,
        height: mockPreviewDimensions.height,
        scaleFactor: 1
      },
      targets: response.visualTargets
    });

    return () => {
      void nativeBridge.hideOverlay();
    };
  }, [
    isOverlayActive,
    nativeBridge,
    overlayActivationCount,
    response.visualTargets,
    screenCapture?.displayBounds
  ]);

  const draftAnnotation = draftDrag
    ? createAnnotationFromDrag({
        id: 'draft-annotation',
        type: draftDrag.type,
        start: draftDrag.start,
        end: draftDrag.end
      })
    : null;

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Tutor status">
        <div>
          <p className="eyebrow">Kairo Tutor</p>
          <h1>Screen-native AI tutor shell</h1>
        </div>
        <div className="status-pill">Provider: {env.aiProvider}</div>
      </section>

      {missingPermissions.length > 0 ? (
        <section className="permission-onboarding" aria-label="Required permissions">
          <div>
            <p className="eyebrow">Setup</p>
            <h2>Enable Kairo permissions</h2>
          </div>
          <div className="permission-list">
            {requiredPermissions.map((permission) => (
              <div className="permission-item" key={permission.key}>
                <div>
                  <strong>{permission.label}</strong>
                  <span>{permission.detail}</span>
                </div>
                <span
                  className={
                    isPermissionGranted(permissions, permission.key)
                      ? 'permission-state granted'
                      : 'permission-state'
                  }
                >
                  {permissionStateLabel(permissions[permission.key])}
                </span>
              </div>
            ))}
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={requestRequiredPermissions}
            disabled={isRequestingPermissions}
          >
            {isRequestingPermissions ? 'Checking...' : 'Enable permissions'}
          </button>
        </section>
      ) : null}

      <section className="workspace">
        <aside className="panel">
          <h2>Activation</h2>
          <p>State: {activationState}</p>
          <p>Shortcut target: {activationShortcut.shortcut}</p>
          <p>Status: {activationShortcut.registered ? 'registered' : activationShortcut.reason}</p>
          <p>Default skill: {env.defaultSkill}</p>
          <p>Voice: {env.sttProvider === 'sarvam' || env.ttsProvider === 'sarvam' ? 'Sarvam' : 'Mock'}</p>
          <p>Active app: {activeApp.activeApp}</p>
          <p>Window: {activeApp.windowTitle ?? 'unknown'}</p>
          <p>Source: {activeApp.source}</p>
          <button className="secondary-button" type="button" onClick={refreshNativeContext}>
            Refresh Native Context
          </button>
          <button className="secondary-button" type="button" onClick={captureNativeScreen}>
            Capture Screen
          </button>
          <div className="permission-grid">
            <span>Screen</span>
            <strong>{permissionStateLabel(permissions.screenRecording)}</strong>
            <span>Accessibility</span>
            <strong>{permissionStateLabel(permissions.accessibility)}</strong>
            <span>Mic</span>
            <strong>{permissionStateLabel(permissions.microphone)}</strong>
          </div>
          {screenCapture ? (
            <div className="capture-status">
              <strong>{screenCapture.captured ? 'Capture ready' : 'Capture unavailable'}</strong>
              <span>
                {screenCapture.captured
                  ? `${screenCapture.imageMimeType ?? 'image'} · ${screenCapture.byteLength ?? 0} bytes`
                  : screenCapture.reason}
              </span>
              {screenCapture.blockedSensitiveApp ? <span>Sensitive app block is active.</span> : null}
              {screenCapture.displayBounds ? (
                <span>
                  Display: {Math.round(screenCapture.displayBounds.width)}x
                  {Math.round(screenCapture.displayBounds.height)} @ {screenCapture.displayBounds.scaleFactor.toFixed(2)}x
                </span>
              ) : null}
            </div>
          ) : null}
        </aside>

        <section className="tutor-surface">
          <div className="screen-preview" aria-label="Screen preview">
            <div className="toolbar">{previewSource.title}</div>
            <div
              className="screen-preview-stage"
              style={{
                aspectRatio: `${previewSource.dimensions.width} / ${previewSource.dimensions.height}`
              }}
            >
              <div
                className={`annotation-canvas ${annotationTool === 'erase' ? 'erasing' : 'drawing'}`}
                onPointerDown={handleAnnotationPointerDown}
                onPointerMove={handleAnnotationPointerMove}
                onPointerUp={handleAnnotationPointerUp}
                onPointerCancel={() => setDraftDrag(null)}
                role="presentation"
              >
                {previewSource.imageSrc ? (
                  <img
                    alt=""
                    className="screen-capture-image"
                    draggable={false}
                    src={previewSource.imageSrc}
                  />
                ) : previewSource.mode === 'mock' ? (
                  <div className="screen-empty">
                    <strong>Waiting for screen capture</strong>
                    <span>Press the shortcut to capture the current app.</span>
                  </div>
                ) : null}
                <AnnotationLayer
                  annotations={annotations}
                  draftAnnotation={draftAnnotation}
                  dimensions={previewSource.dimensions}
                />
              </div>
              <VisualOverlay targets={response.visualTargets} dimensions={previewSource.dimensions} />
            </div>
            <div className="timeline">Timeline: frame 1 - 250</div>
          </div>

          <div className="annotation-toolbar" aria-label="Annotation tools">
            {annotationTools.map((tool) => (
              <button
                aria-pressed={annotationTool === tool}
                className={annotationTool === tool ? 'selected' : undefined}
                key={tool}
                type="button"
                onClick={() => setAnnotationTool(tool)}
              >
                {tool}
              </button>
            ))}
            <button type="button" onClick={() => setAnnotations([])}>
              clear
            </button>
            <span>{annotations.length} annotation{annotations.length === 1 ? '' : 's'}</span>
          </div>

          <div className="ask-row">
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="button" onClick={() => void askTutor()}>
              Ask
            </button>
          </div>

          <article className="response">
            <p className="eyebrow">{response.mode}</p>
            <h2>{response.screenText}</h2>
            <p>{response.voiceText}</p>
            <ul>
              {response.visualTargets.map((target) => (
                <li key={`${target.kind}-${target.targetId}`}>
                  {target.kind}: {target.label} ({Math.round(target.confidence * 100)}%)
                </li>
              ))}
            </ul>
          </article>
        </section>
      </section>
    </main>
  );
}
