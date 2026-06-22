import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { register as registerGlobalShortcut } from '@tauri-apps/plugin-global-shortcut';
import type { VisualTarget } from '../core/types';
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

export type NativeOverlayPayload = {
  mode?: 'visual' | 'annotate';
  displayBounds: NativeOverlayDisplayBounds;
  targets: VisualTarget[];
};

export type NativeBridge = {
  getActiveApp(): Promise<NativeActiveApp>;
  getPermissionStatus(): Promise<NativePermissionStatus>;
  requestRequiredPermissions(): Promise<NativePermissionStatus>;
  openPermissionSettings(permission: NativePermissionKey): Promise<void>;
  captureScreen(): Promise<NativeScreenCapture>;
  showOverlay(payload: NativeOverlayPayload): Promise<void>;
  showAnnotationOverlay(displayBounds: NativeOverlayDisplayBounds): Promise<void>;
  updateOverlay(payload: NativeOverlayPayload): Promise<void>;
  getCurrentOverlayPayload(): Promise<NativeOverlayPayload | null>;
  hideOverlay(): Promise<void>;
  showNotch(payload?: NotchPayload): Promise<void>;
  getCurrentNotchPayload(): Promise<NotchPayload | null>;
  hideNotch(): Promise<void>;
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

    async showOverlay(payload) {
      try {
        await invoke<void>('show_overlay', { payload });
      } catch {
        // Browser previews do not have a native overlay window.
      }
    },

    async showAnnotationOverlay(displayBounds) {
      try {
        await invoke<void>('show_overlay', {
          payload: {
            mode: 'annotate',
            displayBounds,
            targets: []
          }
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
