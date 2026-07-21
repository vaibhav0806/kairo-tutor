import { invoke as tauriInvoke, Channel } from '@tauri-apps/api/core';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import type { ScreenRegion, UserAnnotation, VisualTarget } from '../core/types';
import type { TutorTurnInput } from '../core/orchestrator';
import type { NotchAnnotationTool } from '../notch/annotationActions';
import type { NotchPayload } from '../notch/types';

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type NativeSource = 'native' | 'web-fallback';

export type NativeActiveApp = {
  activeApp: string;
  bundleId?: string;
  windowTitle?: string;
  source: NativeSource;
};

export type NativePermissionState = 'granted' | 'denied' | 'not_determined' | 'unknown';

export type NativePermissionStatus = {
  screenRecording: NativePermissionState;
  accessibility: NativePermissionState;
  microphone: NativePermissionState;
};
export type NativePermissionKey = keyof NativePermissionStatus;

export type NativeScreenCapture = {
  captured: boolean;
  reason?: string;
  blockedSensitiveApp?: boolean;
  activeApp?: NativeActiveApp;
  imageMimeType?: string;
  imageBase64?: string;
  byteLength?: number;
  displayBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  };
  imageGeometry?: {
    rawWidth: number;
    rawHeight: number;
    encodedWidth: number;
    encodedHeight: number;
  };
};

export type NativeOverlayDisplayBounds = NonNullable<NativeScreenCapture['displayBounds']>;

export type NativeTranscribeAudioInput = {
  audioBase64: string;
  mimeType: string;
  filename?: string;
};

export type NativeTranscriptionResult = {
  text: string;
  provider: string;
};

export type NativeSynthesizeSpeechInput = {
  text: string;
  // Per-request timeout override (ms). Omit for the generous default (long answers);
  // walkthrough steps pass a tight value so a stalled synth fails fast and retries.
  timeoutMs?: number;
};

export type NativeSpeechSynthesisResult = {
  audioBase64: string;
  mimeType: string;
  provider: string;
};

// A message on the streaming-TTS channel (mirrors the Rust `TtsStreamMsg` enum).
// `chunk.data` is base64 raw PCM (linear16, s16le, mono) at `start.sampleRate`.
export type NativeTtsStreamMsg =
  | { type: 'start'; sampleRate: number; channels: number }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

export type NativeOverlayPayload = {
  mode?: 'visual' | 'annotate' | 'annotation_preview' | 'gesture';
  displayBounds: NativeOverlayDisplayBounds;
  targets: VisualTarget[];
  annotations?: UserAnnotation[];
  initialTool?: NotchAnnotationTool | null;
};

export type NativeCursorPointInput = {
  screenRegion: ScreenRegion;
  displayBounds: NativeOverlayDisplayBounds;
  color?: string;
};

// Pen-drag reveal: the pet flies to `fromRegion` (the box's top-left corner) over
// `approachMs`, then drags to `toRegion` (bottom-right) over `durationMs`, welded
// to the box "inking" itself along the same diagonal. Corner regions are zero-size
// so the cursor's pointingTip lands its tip on each corner.
export type NativeCursorDragInput = {
  fromRegion: ScreenRegion;
  toRegion: ScreenRegion;
  displayBounds: NativeOverlayDisplayBounds;
  durationMs: number;
  approachMs: number;
  color?: string;
};

// The app a teaching target points at, captured when the box is revealed. A later
// frontmost/scroll/click change relative to this clears the stale guidance.
export type NativeContextBaseline = {
  bundleId?: string;
  windowTitle?: string;
};

export type NativeGateInput = {
  userQuery: string;
  activeApp?: string;
  bundleId?: string;
  windowTitle?: string;
  // Unified turn (RU5): the last ~6 rolling turn-triples as text, for continuity.
  history?: string;
  // True when a guide pointer is on screen waiting for a click (biases needsScreen).
  pointerPending?: boolean;
  // The signed-in user's display name — appended to the NON-cached gate prompt (spec §12).
  userName?: string;
};

export type NativeBridge = {
  getActiveApp(): Promise<NativeActiveApp>;
  getPermissionStatus(): Promise<NativePermissionStatus>;
  requestRequiredPermissions(): Promise<NativePermissionStatus>;
  openPermissionSettings(permission: NativePermissionKey): Promise<void>;
  // Act 2 primers — Mic ONLY (never Screen Recording) + Input Monitoring (separate grant).
  requestMicrophone(): Promise<NativePermissionStatus>;
  requestInputMonitoring(): Promise<void>;
  getInputMonitoringStatus(): Promise<NativePermissionState>;
  // Act 3 — fire ONE OS prompt at a time (Screen Recording, then Accessibility; never batched).
  requestScreenRecording(): Promise<NativePermissionState>;
  requestAccessibility(): Promise<NativePermissionState>;
  restartApp(): Promise<void>;
  // True when the signed-in user is out of free requests (proxy mode). The notch calls this
  // on push-to-talk release BEFORE transcribing, to skip STT/gate/vision + play the cached
  // upgrade line instead of spending on a paywalled user. false when unknown / proxy off.
  checkPaywalled(): Promise<boolean>;
  captureScreen(): Promise<NativeScreenCapture>;
  getDisplayBounds(): Promise<NativeOverlayDisplayBounds>;
  showOverlay(payload: NativeOverlayPayload): Promise<void>;
  showAnnotationOverlay(
    displayBounds: NativeOverlayDisplayBounds,
    initialTool?: NotchAnnotationTool
  ): Promise<void>;
  // Show the cosmetic hold-to-point gesture overlay (click-through, excluded from
  // capture). The notch owns the truth marks; this layer only renders fading strokes.
  showGestureOverlay(displayBounds: NativeOverlayDisplayBounds): Promise<void>;
  updateOverlay(payload: NativeOverlayPayload): Promise<void>;
  getCurrentOverlayPayload(): Promise<NativeOverlayPayload | null>;
  hideOverlay(): Promise<void>;
  cursorPoint(input: NativeCursorPointInput): Promise<void>;
  cursorDrag(input: NativeCursorDragInput): Promise<void>;
  cursorRelease(): Promise<void>;
  cursorArrived(): Promise<void>;
  cursorActive(active: boolean): Promise<void>;
  cursorEntrance(): Promise<void>;
  cursorCelebrate(): Promise<void>;
  armContextWatch(baseline: NativeContextBaseline): Promise<void>;
  disarmContextWatch(): Promise<void>;
  showNotch(payload?: NotchPayload): Promise<void>;
  getCurrentNotchPayload(): Promise<NotchPayload | null>;
  // Report the capsule's rect (CSS px, viewport-relative) so the notch is
  // click-through everywhere except the capsule. null → whole notch clickable.
  setNotchHitRect(rect: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  hideNotch(): Promise<void>;
  runTutorTurn(input: TutorTurnInput): Promise<string>;
  // Text-only "do I need to look at the screen?" gate. Returns raw JSON
  // { needsScreen: boolean, voiceText: string }.
  runGateTurn(input: NativeGateInput): Promise<string>;
  // --- Follow-along guide mode ---
  // Perceptual dHash of the current screen (8×u32) for cheap, model-free "did the
  // screen change?" checks. Returns a zero hash if no native runtime is available.
  captureFrameHash(): Promise<number[]>;
  // Cheap text-only ack after a completed step. Returns the ack sentence (may be
  // empty); mirrors runTutorTurn (errors propagate — the caller's ack is best-effort).
  runAckTurn(completedStep: string): Promise<string>;
  // Arm/disarm the native mouse-up watch that emits `input:click { x, y }`
  // (display points) while a follow-along click step is showing.
  armFollowClick(): Promise<void>;
  disarmFollowClick(): Promise<void>;
  transcribeAudio(input: NativeTranscribeAudioInput): Promise<NativeTranscriptionResult>;
  synthesizeSpeech(input: NativeSynthesizeSpeechInput): Promise<NativeSpeechSynthesisResult>;
  // Streaming TTS: PCM chunks arrive on `onChunk` as they're synthesized; resolves
  // when the stream completes. Sarvam only — other providers reject (caller falls
  // back to the buffered synthesizeSpeech).
  synthesizeSpeechStream(
    input: NativeSynthesizeSpeechInput,
    onChunk: Channel<NativeTtsStreamMsg>
  ): Promise<void>;
  // Debug-only: persist the exact composited JPEG (base64, no data: prefix) sent to
  // fable and return its path. Gated by gestureConfig.debugImages; null on failure.
  saveGestureDebugImage(base64: string): Promise<string | null>;
};

function fallbackActiveApp(): NativeActiveApp {
  return {
    activeApp: 'Browser Preview',
    windowTitle: globalThis.document?.title ?? 'Kairo Tutor',
    source: 'web-fallback'
  };
}

function fallbackPermissionStatus(): NativePermissionStatus {
  return {
    screenRecording: 'unknown',
    accessibility: 'unknown',
    microphone: 'unknown'
  };
}

function fallbackScreenCapture(): NativeScreenCapture {
  return {
    captured: false,
    reason: 'Native screen capture is only available inside the Tauri desktop shell.'
  };
}

export function createAnnotationOverlayBounds(
  displayBounds: NativeOverlayDisplayBounds
): NativeOverlayDisplayBounds {
  // Cover the entire display so the user can draw anywhere — including beside the
  // notch. The notch panel sits above the overlay (level 1001), so it stays
  // clickable even though the overlay now spans the full screen underneath it.
  return { ...displayBounds };
}

async function readBrowserMicrophonePermission(): Promise<NativePermissionState> {
  if (!globalThis.navigator?.permissions?.query) {
    return 'unknown';
  }

  try {
    const permissionStatus = await globalThis.navigator.permissions.query({
      name: 'microphone' as PermissionName
    });

    if (permissionStatus.state === 'granted') {
      return 'granted';
    }

    if (permissionStatus.state === 'denied') {
      return 'denied';
    }

    return 'not_determined';
  } catch {
    return 'unknown';
  }
}

async function requestBrowserMicrophonePermission(): Promise<NativePermissionState> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    return readBrowserMicrophonePermission();
  }

  try {
    const stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch {
    return readBrowserMicrophonePermission();
  }
}

export function createNativeBridge(invokeCommand?: NativeInvoke): NativeBridge {
  const invoke = invokeCommand ?? tauriInvoke;

  return {
    async getActiveApp() {
      try {
        return await invoke<NativeActiveApp>('get_active_app');
      } catch {
        return fallbackActiveApp();
      }
    },

    async getPermissionStatus() {
      try {
        const nativeStatus = await invoke<NativePermissionStatus>('get_permission_status');
        return {
          ...nativeStatus,
          microphone:
            nativeStatus.microphone === 'unknown'
              ? await readBrowserMicrophonePermission()
              : nativeStatus.microphone
        };
      } catch {
        return {
          ...fallbackPermissionStatus(),
          microphone: await readBrowserMicrophonePermission()
        };
      }
    },

    async captureScreen() {
      try {
        return await invoke<NativeScreenCapture>('capture_screen');
      } catch {
        return fallbackScreenCapture();
      }
    },

    async getDisplayBounds() {
      try {
        return await invoke<NativeOverlayDisplayBounds>('get_display_bounds');
      } catch {
        return { x: 0, y: 0, width: 0, height: 0, scaleFactor: 1 };
      }
    },

    async requestRequiredPermissions() {
      try {
        const nativeStatus = await invoke<NativePermissionStatus>('request_required_permissions');
        const microphone =
          nativeStatus.microphone === 'granted'
            ? nativeStatus.microphone
            : await requestBrowserMicrophonePermission();

        return {
          ...nativeStatus,
          microphone: microphone === 'unknown' ? nativeStatus.microphone : microphone
        };
      } catch {
        const microphone = await requestBrowserMicrophonePermission();

        return {
          ...fallbackPermissionStatus(),
          microphone
        };
      }
    },

    async openPermissionSettings(permission) {
      try {
        await invoke<void>('open_permission_settings', { permission });
      } catch {
        // Browser previews cannot open macOS System Settings.
      }
    },

    async requestMicrophone() {
      try {
        return await invoke<NativePermissionStatus>('request_microphone');
      } catch {
        return { ...fallbackPermissionStatus(), microphone: await requestBrowserMicrophonePermission() };
      }
    },

    async requestInputMonitoring() {
      try {
        await invoke<void>('request_input_monitoring');
      } catch {
        // Browser previews have no input-monitoring grant.
      }
    },

    async requestScreenRecording() {
      try {
        return await invoke<NativePermissionState>('request_screen_recording');
      } catch {
        return 'unknown';
      }
    },

    async requestAccessibility() {
      try {
        return await invoke<NativePermissionState>('request_accessibility');
      } catch {
        return 'unknown';
      }
    },

    async getInputMonitoringStatus() {
      try {
        const s = await invoke<string>('get_input_monitoring_status');
        return s === 'granted' ? 'granted' : s === 'unknown' ? 'unknown' : 'not_determined';
      } catch {
        return 'unknown';
      }
    },

    async restartApp() {
      try {
        await invoke<void>('restart_app');
      } catch {
        // Browser previews cannot restart the native app.
      }
    },

    async checkPaywalled() {
      try {
        return await invoke<boolean>('check_paywalled');
      } catch {
        return false;
      }
    },

    async showOverlay(payload) {
      try {
        await invoke<void>('show_overlay', { payload });
      } catch {
        // Browser previews do not have a native overlay window.
      }
    },

    async showAnnotationOverlay(displayBounds, initialTool) {
      try {
        const overlayDisplayBounds = createAnnotationOverlayBounds(displayBounds);
        const payload: NativeOverlayPayload = {
          mode: 'annotate',
          displayBounds: overlayDisplayBounds,
          targets: []
        };
        if (initialTool) {
          payload.initialTool = initialTool;
        }

        await invoke<void>('show_overlay', {
          payload
        });
      } catch {
        // Browser previews do not have a native overlay window.
      }
    },

    async showGestureOverlay(displayBounds) {
      try {
        const overlayDisplayBounds = createAnnotationOverlayBounds(displayBounds);
        await invoke<void>('show_overlay', {
          payload: { mode: 'gesture', displayBounds: overlayDisplayBounds, targets: [] }
        });
      } catch {
        // Browser previews have no native overlay window.
      }
    },

    async updateOverlay(payload) {
      try {
        await invoke<void>('update_overlay', { payload });
      } catch {
        // Browser previews do not have a native overlay window.
      }
    },

    async getCurrentOverlayPayload() {
      try {
        return await invoke<NativeOverlayPayload | null>('get_current_overlay_payload');
      } catch {
        return null;
      }
    },

    async hideOverlay() {
      try {
        await invoke<void>('hide_overlay');
      } catch {
        // Browser previews do not have a native overlay window.
      }
    },

    async cursorPoint(input) {
      try {
        await invoke<void>('cursor_point', { payload: input });
      } catch {
        // Browser previews do not have a native cursor window.
      }
    },

    async cursorDrag(input) {
      try {
        // Broadcast like the notch's cursor FX events (cursor:speaking, etc.) — the
        // cursor window is already up (it shadows the mouse), so a Rust round-trip
        // isn't needed just to reach its listener.
        await tauriEmit('cursor:drag', input);
      } catch {
        // Browser previews do not have a native cursor window / event bus.
      }
    },

    async cursorRelease() {
      try {
        await invoke<void>('cursor_release');
      } catch {
        // Browser previews do not have a native cursor window.
      }
    },

    async cursorArrived() {
      try {
        await invoke<void>('cursor_arrived');
      } catch {
        // Browser previews have no native event bus.
      }
    },

    async cursorActive(active) {
      try {
        await invoke<void>('cursor_active', { active });
      } catch {
        // Browser previews have no native event bus.
      }
    },

    async cursorEntrance() {
      try {
        await invoke<void>('cursor_entrance');
      } catch {
        // Browser previews have no native cursor window.
      }
    },

    async cursorCelebrate() {
      try {
        await invoke<void>('cursor_celebrate');
      } catch {
        // Browser previews have no native cursor window.
      }
    },

    async armContextWatch(baseline) {
      try {
        await invoke<void>('arm_context_watch', { baseline });
      } catch {
        // Browser previews have no native context watcher.
      }
    },

    async disarmContextWatch() {
      try {
        await invoke<void>('disarm_context_watch');
      } catch {
        // Browser previews have no native context watcher.
      }
    },

    async showNotch(payload) {
      try {
        await invoke<void>('show_notch', { payload: payload ?? null });
      } catch {
        // Browser previews do not have a native notch window.
      }
    },

    async getCurrentNotchPayload() {
      try {
        return await invoke<NotchPayload | null>('get_current_notch_payload');
      } catch {
        return null;
      }
    },

    async setNotchHitRect(rect) {
      try {
        await invoke<void>('set_notch_hit_rect', { rect });
      } catch {
        // Browser previews do not have a native notch window.
      }
    },

    async hideNotch() {
      try {
        await invoke<void>('hide_notch');
      } catch {
        // Browser previews do not have a native notch window.
      }
    },

    async runTutorTurn(input) {
      return invoke<string>('run_tutor_turn', { input });
    },

    async runGateTurn(input) {
      try {
        return await invoke<string>('run_gate_turn', { input });
      } catch {
        // No native runtime / failure → default to looking at the screen.
        return JSON.stringify({ needsScreen: true, voiceText: '' });
      }
    },

    async captureFrameHash() {
      try {
        const result = await invoke<{ hash: number[] }>('capture_frame_hash');
        return result.hash;
      } catch {
        // No native runtime → a zero hash (every comparison reads as "unchanged").
        return [0, 0, 0, 0, 0, 0, 0, 0];
      }
    },

    async runAckTurn(completedStep) {
      // Mirrors runTutorTurn: raw string; errors propagate (caller's ack is best-effort).
      return invoke<string>('run_ack_turn', { input: { completedStep } });
    },

    async armFollowClick() {
      try {
        await invoke<void>('arm_follow_click');
      } catch {
        // Browser previews have no native click watcher.
      }
    },

    async disarmFollowClick() {
      try {
        await invoke<void>('disarm_follow_click');
      } catch {
        // Browser previews have no native click watcher.
      }
    },

    async transcribeAudio(input) {
      return invoke<NativeTranscriptionResult>('transcribe_audio', { input });
    },

    async synthesizeSpeech(input) {
      return invoke<NativeSpeechSynthesisResult>('synthesize_speech', { input });
    },

    async synthesizeSpeechStream(input, onChunk) {
      await invoke<void>('synthesize_speech_stream', { input, onChunk });
    },

    async saveGestureDebugImage(base64) {
      try {
        return await invoke<string>('save_gesture_debug_image', { base64 });
      } catch {
        return null;
      }
    }
  };
}
