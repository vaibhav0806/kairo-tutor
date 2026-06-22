import { describe, expect, test, vi } from 'vitest';
import {
  createNativeBridge,
  type NativeInvoke,
  type NativeShortcutRegistrar,
  type NativeWindowController
} from '../src/native/nativeBridge';

describe('createNativeBridge', () => {
  test('returns browser-safe fallback values when no native invoke is available', async () => {
    const bridge = createNativeBridge();

    await expect(bridge.getActiveApp()).resolves.toMatchObject({
      activeApp: 'Browser Preview',
      source: 'web-fallback'
    });
    await expect(bridge.getPermissionStatus()).resolves.toMatchObject({
      screenRecording: 'unknown',
      accessibility: 'unknown',
      microphone: 'unknown'
    });
    await expect(bridge.requestRequiredPermissions()).resolves.toMatchObject({
      screenRecording: 'unknown',
      accessibility: 'unknown',
      microphone: 'unknown'
    });
  });

  test('calls Tauri commands when invoke is provided', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'get_active_app') {
        return {
          activeApp: 'Blender',
          bundleId: 'org.blenderfoundation.blender',
          windowTitle: 'Blender',
          source: 'native'
        };
      }

      if (command === 'capture_screen') {
        return {
          captured: true,
          imageMimeType: 'image/png',
          imageBase64: 'abc123',
          byteLength: 4
        };
      }

      if (command === 'request_required_permissions') {
        return {
          screenRecording: 'granted',
          accessibility: 'not_determined',
          microphone: 'unknown'
        };
      }

      return {
        screenRecording: 'granted',
        accessibility: 'unknown',
        microphone: 'granted'
      };
    }) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.getActiveApp()).resolves.toMatchObject({
      activeApp: 'Blender',
      bundleId: 'org.blenderfoundation.blender',
      source: 'native'
    });
    expect(invoke).toHaveBeenCalledWith('get_active_app');
    await expect(bridge.captureScreen()).resolves.toMatchObject({
      captured: true,
      imageMimeType: 'image/png',
      byteLength: 4
    });
    expect(invoke).toHaveBeenCalledWith('capture_screen');
    await expect(bridge.requestRequiredPermissions()).resolves.toMatchObject({
      screenRecording: 'granted',
      accessibility: 'not_determined',
      microphone: 'unknown'
    });
    expect(invoke).toHaveBeenCalledWith('request_required_permissions');
  });

  test('trusts native microphone status when the desktop shell reports it', async () => {
    const invoke = vi.fn(async () => ({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'granted'
    })) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.getPermissionStatus()).resolves.toMatchObject({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'granted'
    });
  });

  test('does not request browser microphone when native permission request reports mic status', async () => {
    const originalMediaDevices = globalThis.navigator.mediaDevices;
    const getUserMedia = vi.fn();
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    });
    const invoke = vi.fn(async () => ({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'granted'
    })) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.requestRequiredPermissions()).resolves.toMatchObject({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'granted'
    });
    expect(getUserMedia).not.toHaveBeenCalled();

    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices
    });
  });

  test('requests browser microphone when native microphone request remains unresolved', async () => {
    const originalMediaDevices = globalThis.navigator.mediaDevices;
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }]
    }));
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    });
    const invoke = vi.fn(async () => ({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'not_determined'
    })) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.requestRequiredPermissions()).resolves.toMatchObject({
      screenRecording: 'granted',
      accessibility: 'granted',
      microphone: 'granted'
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalled();

    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices
    });
  });

  test('opens the native permission settings pane on request', async () => {
    const invoke = vi.fn(async () => undefined) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.openPermissionSettings('microphone')).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith('open_permission_settings', {
      permission: 'microphone'
    });
  });

  test('sends tutor overlay payloads to the native overlay window commands', async () => {
    const payload = {
      displayBounds: {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scaleFactor: 2
      },
      targets: [
        {
          kind: 'highlight_box' as const,
          targetId: 'default_cube',
          label: 'Default cube',
          confidence: 0.86,
          screenRegion: {
            x: 928,
            y: 430,
            width: 160,
            height: 160
          }
        }
      ]
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'get_current_overlay_payload') {
        return payload;
      }

      return undefined;
    }) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.showOverlay(payload)).resolves.toBeUndefined();
    await expect(bridge.showAnnotationOverlay(payload.displayBounds)).resolves.toBeUndefined();
    await expect(bridge.updateOverlay(payload)).resolves.toBeUndefined();
    await expect(bridge.getCurrentOverlayPayload()).resolves.toEqual(payload);
    await expect(bridge.hideOverlay()).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith('show_overlay', { payload });
    expect(invoke).toHaveBeenCalledWith('show_overlay', {
      payload: {
        mode: 'annotate',
        displayBounds: payload.displayBounds,
        targets: []
      }
    });
    expect(invoke).toHaveBeenCalledWith('update_overlay', { payload });
    expect(invoke).toHaveBeenCalledWith('get_current_overlay_payload');
    expect(invoke).toHaveBeenCalledWith('hide_overlay');
  });

  test('shows and hides the native notch assistant window', async () => {
    const payload = {
      state: 'listening' as const,
      title: 'Kairo is listening',
      detail: 'Capturing the current screen'
    };
    const invoke = vi.fn(async () => undefined) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.showNotch(payload)).resolves.toBeUndefined();
    await expect(bridge.hideNotch()).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith('show_notch', { payload });
    expect(invoke).toHaveBeenCalledWith('hide_notch');
  });

  test('sends tutor turns to the native provider proxy', async () => {
    const input = {
      userQuery: 'What should I click?',
      activeApp: { activeApp: 'Blender' },
      annotations: [],
      screen: { captured: false, reason: 'No capture' },
      skill: {
        slug: 'blender',
        displayName: 'Blender',
        appIdentifiers: ['org.blenderfoundation.blender'],
        landmarks: {}
      },
      constraints: ['Return one short tutor step.']
    };
    const invoke = vi.fn(async () => '{"voiceText":"Click the cube."}') as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.runTutorTurn(input)).resolves.toBe('{"voiceText":"Click the cube."}');

    expect(invoke).toHaveBeenCalledWith('run_tutor_turn', { input });
  });

  test('registers activation shortcut without foregrounding the desktop debug window', async () => {
    let shortcutHandler: ((event: { state: string; shortcut: string }) => void) | undefined;
    const callOrder: string[] = [];
    const registerShortcut = vi.fn(async (_shortcut: string, handler) => {
      shortcutHandler = handler;
    }) as NativeShortcutRegistrar;
    const windowController: NativeWindowController = {
      show: vi.fn(async () => {
        callOrder.push('show');
      }),
      setFocus: vi.fn(async () => {
        callOrder.push('focus');
      })
    };
    const onActivated = vi.fn(async () => {
      callOrder.push('activate');
    });
    const bridge = createNativeBridge(undefined, {
      registerShortcut,
      windowController
    });

    const registration = await bridge.registerActivationShortcut(onActivated);
    await shortcutHandler?.({ state: 'Pressed', shortcut: 'CommandOrControl+Shift+Space' });

    expect(registration.registered).toBe(true);
    expect(registerShortcut).toHaveBeenCalledWith(
      'CommandOrControl+Shift+Space',
      expect.any(Function)
    );
    expect(windowController.show).not.toHaveBeenCalled();
    expect(windowController.setFocus).not.toHaveBeenCalled();
    expect(onActivated).toHaveBeenCalled();
    expect(callOrder).toEqual(['activate']);
  });
});
