import { describe, expect, test, vi } from 'vitest';
import {
  createAnnotationOverlayBounds,
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
    await expect(bridge.showAnnotationOverlay(payload.displayBounds, 'erase')).resolves.toBeUndefined();
    const annotationDisplayBounds = createAnnotationOverlayBounds(payload.displayBounds);
    const annotationPreviewPayload = {
      mode: 'annotation_preview' as const,
      displayBounds: payload.displayBounds,
      targets: [],
      annotations: [
        {
          id: 'screen-annotation-1',
          type: 'pen' as const,
          screenRegion: { x: 120, y: 140, width: 180, height: 90 },
          points: [
            { x: 120, y: 140 },
            { x: 160, y: 180 }
          ]
        }
      ]
    };
    await expect(bridge.updateOverlay(annotationPreviewPayload)).resolves.toBeUndefined();
    await expect(bridge.updateOverlay(payload)).resolves.toBeUndefined();
    await expect(bridge.getCurrentOverlayPayload()).resolves.toEqual(payload);
    await expect(bridge.hideOverlay()).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith('show_overlay', { payload });
    expect(invoke).toHaveBeenCalledWith('show_overlay', {
      payload: {
        mode: 'annotate',
        displayBounds: annotationDisplayBounds,
        targets: []
      }
    });
    expect(invoke).toHaveBeenCalledWith('show_overlay', {
      payload: {
        mode: 'annotate',
        displayBounds: annotationDisplayBounds,
        targets: [],
        initialTool: 'erase'
      }
    });
    expect(invoke).toHaveBeenCalledWith('update_overlay', { payload: annotationPreviewPayload });
    expect(invoke).toHaveBeenCalledWith('update_overlay', { payload });
    expect(invoke).toHaveBeenCalledWith('get_current_overlay_payload');
    expect(invoke).toHaveBeenCalledWith('hide_overlay');
  });

  test('covers the whole display so the user can draw anywhere', () => {
    const displayBounds = {
      x: 0,
      y: 0,
      width: 1800,
      height: 1169,
      scaleFactor: 1
    };

    expect(createAnnotationOverlayBounds(displayBounds)).toEqual(displayBounds);
  });

  test('shows and hides the native notch assistant window', async () => {
    const payload = {
      state: 'listening' as const,
      layout: 'compact' as const,
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
      skillSlug: 'blender',
      constraints: ['Return one short tutor step.']
    };
    const invoke = vi.fn(async () => '{"voiceText":"Click the cube."}') as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.runTutorTurn(input)).resolves.toBe('{"voiceText":"Click the cube."}');

    expect(invoke).toHaveBeenCalledWith('run_tutor_turn', { input });
  });

  test('wraps the follow-along native commands', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'capture_frame_hash') {
        return { hash: [1, 2, 3, 4, 5, 6, 7, 8] };
      }
      if (command === 'run_ack_turn') {
        return 'Nice, moving on.';
      }
      return undefined;
    }) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.captureFrameHash()).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(invoke).toHaveBeenCalledWith('capture_frame_hash');

    await expect(bridge.runAckTurn('Clicked the File menu')).resolves.toBe('Nice, moving on.');
    expect(invoke).toHaveBeenCalledWith('run_ack_turn', {
      input: { completedStep: 'Clicked the File menu' }
    });

    await expect(bridge.armFollowClick()).resolves.toBeUndefined();
    await expect(bridge.disarmFollowClick()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('arm_follow_click');
    expect(invoke).toHaveBeenCalledWith('disarm_follow_click');
  });

  test('falls back to a zero frame-hash and no-op click watch without a native runtime', async () => {
    const bridge = createNativeBridge();

    await expect(bridge.captureFrameHash()).resolves.toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(bridge.armFollowClick()).resolves.toBeUndefined();
    await expect(bridge.disarmFollowClick()).resolves.toBeUndefined();
  });

  test('sends voice recordings to the native transcription proxy', async () => {
    const input = {
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav',
      filename: 'voice.wav'
    };
    const invoke = vi.fn(async () => ({
      text: 'open the cube settings',
      provider: 'sarvam'
    })) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.transcribeAudio(input)).resolves.toEqual({
      text: 'open the cube settings',
      provider: 'sarvam'
    });

    expect(invoke).toHaveBeenCalledWith('transcribe_audio', { input });
  });

  test('sends answer text to the native speech synthesis proxy', async () => {
    const input = {
      text: 'Click the cube once.'
    };
    const invoke = vi.fn(async () => ({
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav',
      provider: 'sarvam'
    })) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.synthesizeSpeech(input)).resolves.toEqual({
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav',
      provider: 'sarvam'
    });

    expect(invoke).toHaveBeenCalledWith('synthesize_speech', { input });
  });

  test('surfaces native provider proxy failures', async () => {
    const input = {
      userQuery: 'What should I click?',
      activeApp: { activeApp: 'Blender' },
      annotations: [],
      screen: { captured: false, reason: 'No capture' },
      skillSlug: 'blender',
      constraints: ['Return one short tutor step.']
    };
    const invoke = vi.fn(async () => {
      throw new Error('OPENROUTER_API_KEY is required for native OpenRouter tutor turns.');
    }) as unknown as NativeInvoke;
    const bridge = createNativeBridge(invoke);

    await expect(bridge.runTutorTurn(input)).rejects.toThrow('OPENROUTER_API_KEY');
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
