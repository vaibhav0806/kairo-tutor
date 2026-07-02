import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { register as registerGlobalShortcut } from '@tauri-apps/plugin-global-shortcut';
import type { ScreenRegion, UserAnnotation, VisualTarget } from '../core/types';
import type { TutorTurnInput } from '../core/orchestrator';
import type { NotchAnnotationTool } from '../notch/annotationActions';
import type { NotchPayload } from '../notch/types';

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type NativeShortcutEvent = {
  state: string;
  shortcut: string;
};
export type NativeShortcutRegistrar = (
  shortcut: string,
  handler: (event: NativeShortcutEvent) => void | Promise<void>
) => Promise<void>;
export type NativeWindowController = {
  show(): Promise<void>;
  setFocus(): Promise<void>;
};

export type NativeSource = 'native' | 'web-fallback';

export type NativeActiveApp = {
  activeApp: string;
  bundleId?: string;
  windowTitle?: string;
  // Active-tab URL when the frontmost app is a supported browser (native only).
  url?: string;
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
};

export type NativeSpeechSynthesisResult = {
  audioBase64: string;
  mimeType: string;
  provider: string;
};

export type NativeOverlayPayload = {
  mode?: 'visual' | 'annotate' | 'annotation_preview';
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

// The app a teaching target points at, captured when the box is revealed. A later
// frontmost/scroll/click change relative to this clears the stale guidance.
export type NativeContextBaseline = {
  bundleId?: string;
  windowTitle?: string;
};

export type NativeGateInput = {
  userQuery: string;
  activeApp?: string;
  windowTitle?: string;
  url?: string;
};

export type NativeBridge = {
  getActiveApp(): Promise<NativeActiveApp>;
  getPermissionStatus(): Promise<NativePermissionStatus>;
  requestRequiredPermissions(): Promise<NativePermissionStatus>;
  openPermissionSettings(permission: NativePermissionKey): Promise<void>;
  restartApp(): Promise<void>;
  debugLog(message: string): Promise<void>;
  captureScreen(): Promise<NativeScreenCapture>;
  getDisplayBounds(): Promise<NativeOverlayDisplayBounds>;
  showOverlay(payload: NativeOverlayPayload): Promise<void>;
  showAnnotationOverlay(
    displayBounds: NativeOverlayDisplayBounds,
    initialTool?: NotchAnnotationTool
  ): Promise<void>;
  updateOverlay(payload: NativeOverlayPayload): Promise<void>;
  getCurrentOverlayPayload(): Promise<NativeOverlayPayload | null>;
  hideOverlay(): Promise<void>;
  cursorPoint(input: NativeCursorPointInput): Promise<void>;
  cursorRelease(): Promise<void>;
  armContextWatch(baseline: NativeContextBaseline): Promise<void>;
  disarmContextWatch(): Promise<void>;
  showNotch(payload?: NotchPayload): Promise<void>;
  getCurrentNotchPayload(): Promise<NotchPayload | null>;
  hideNotch(): Promise<void>;
  runTutorTurn(input: TutorTurnInput): Promise<string>;
  // Text-only "do I need to look at the screen?" gate. Returns raw JSON
  // { needsScreen: boolean, voiceText: string }.
  runGateTurn(input: NativeGateInput): Promise<string>;
  transcribeAudio(input: NativeTranscribeAudioInput): Promise<NativeTranscriptionResult>;
  synthesizeSpeech(input: NativeSynthesizeSpeechInput): Promise<NativeSpeechSynthesisResult>;
  registerActivationShortcut(onActivated: () => void | Promise<void>): Promise<NativeShortcutRegistration>;
};

export type NativeShortcutRegistration = {
  registered: boolean;
  shortcut: string;
  reason?: string;
};

export type NativeBridgeDependencies = {
  registerShortcut?: NativeShortcutRegistrar;
  windowController?: NativeWindowController;
};

export const KAIRO_DEFAULT_ACTIVATION_SHORTCUT = 'CommandOrControl+Shift+Space';

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

function fallbackShortcutRegistration(reason: string): NativeShortcutRegistration {
  return {
    registered: false,
    shortcut: KAIRO_DEFAULT_ACTIVATION_SHORTCUT,
    reason
  };
}

export function createNativeBridge(
  invokeCommand?: NativeInvoke,
  dependencies: NativeBridgeDependencies = {}
): NativeBridge {
  const invoke = invokeCommand ?? tauriInvoke;
  const registerShortcut = dependencies.registerShortcut ?? registerGlobalShortcut;

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

    async restartApp() {
      try {
        await invoke<void>('restart_app');
      } catch {
        // Browser previews cannot restart the native app.
      }
    },

    async debugLog(message) {
      try {
        await invoke<void>('debug_log', { message });
      } catch {
        // No-op outside the native runtime.
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

    async cursorRelease() {
      try {
        await invoke<void>('cursor_release');
      } catch {
        // Browser previews do not have a native cursor window.
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

    async transcribeAudio(input) {
      return invoke<NativeTranscriptionResult>('transcribe_audio', { input });
    },

    async synthesizeSpeech(input) {
      return invoke<NativeSpeechSynthesisResult>('synthesize_speech', { input });
    },

    async registerActivationShortcut(onActivated) {
      try {
        await registerShortcut(KAIRO_DEFAULT_ACTIVATION_SHORTCUT, async (event) => {
          if (event.state !== 'Pressed') {
            return;
          }

          await onActivated();
        });

        return {
          registered: true,
          shortcut: KAIRO_DEFAULT_ACTIVATION_SHORTCUT
        };
      } catch (error) {
        return fallbackShortcutRegistration(
          error instanceof Error ? error.message : 'Global shortcut registration failed.'
        );
      }
    }
  };
}
