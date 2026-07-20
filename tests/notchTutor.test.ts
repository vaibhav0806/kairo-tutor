import { describe, expect, test, vi } from 'vitest';
import { askTutorFromNotch } from '../src/notch/notchTutor';
import type { NativeBridge } from '../src/native/nativeBridge';

function createBridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    getActiveApp: vi.fn(async () => ({
      activeApp: 'Chrome',
      bundleId: 'com.google.Chrome',
      windowTitle: 'OpenRouter',
      source: 'native'
    })),
    getPermissionStatus: vi.fn(),
    requestRequiredPermissions: vi.fn(),
    openPermissionSettings: vi.fn(),
    captureScreen: vi.fn(async () => ({
      captured: true,
      activeApp: {
        activeApp: 'Chrome',
        bundleId: 'com.google.Chrome',
        windowTitle: 'OpenRouter',
        source: 'native'
      },
      imageMimeType: 'image/png',
      imageBase64: 'abc123',
      byteLength: 6,
      displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 }
    })),
    showOverlay: vi.fn(),
    showAnnotationOverlay: vi.fn(),
    updateOverlay: vi.fn(),
    getCurrentOverlayPayload: vi.fn(),
    hideOverlay: vi.fn(),
    cursorPoint: vi.fn(),
    cursorDrag: vi.fn(),
    cursorRelease: vi.fn(),
    armContextWatch: vi.fn(),
    disarmContextWatch: vi.fn(),
    showNotch: vi.fn(),
    getCurrentNotchPayload: vi.fn(),
    hideNotch: vi.fn(),
    runTutorTurn: vi.fn(async () =>
      JSON.stringify({
        mode: 'stuck_help',
        skillSlug: 'blender',
        voiceText: 'This page shows OpenRouter logs.',
        screenText: 'This page shows OpenRouter logs.',
        visualTargets: [],
        expectedNextState: 'user_asks_next'
      })
    ),
    transcribeAudio: vi.fn(async () => ({ text: 'hello', provider: 'sarvam' })),
    runGateTurn: vi.fn(async () => JSON.stringify({ needsScreen: true, voiceText: '' })),
    ...overrides
  } as NativeBridge;
}

describe('askTutorFromNotch', () => {
  test('runs a tutor turn directly from the visible notch window', async () => {
    const bridge = createBridge();

    const result = await askTutorFromNotch({
      query: 'What is on this screen?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender'
    });

    expect(result.payload).toEqual({
      state: 'showing_step',
      layout: 'answer',
      title: 'Kairo answered',
      detail: 'This page shows OpenRouter logs.'
    });

    expect(bridge.captureScreen).toHaveBeenCalled();
    expect(bridge.runTutorTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userQuery: 'What is on this screen?',
        screen: expect.objectContaining({ captured: true })
      })
    );
  });

  test('passes screen annotations from the notch into the tutor turn', async () => {
    const bridge = createBridge();
    const annotation = {
      id: 'screen-annotation-1',
      type: 'rectangle' as const,
      screenRegion: { x: 100, y: 120, width: 220, height: 90 }
    };

    await askTutorFromNotch({
      query: 'What is this marked area?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender',
      annotations: [annotation]
    });

    expect(bridge.runTutorTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        annotations: [annotation]
      })
    );
  });

  test('routes provider targets after annotated asks so the companion cursor still points', async () => {
    const bridge = createBridge({
      runTutorTurn: vi.fn(async () =>
        JSON.stringify({
          mode: 'stuck_help',
          skillSlug: 'blender',
          voiceText: 'I see the marked area.',
          screenText: 'I see the marked area.',
          visualTargets: [
            {
              kind: 'highlight_box',
              targetId: 'provider-box',
              label: 'Provider box',
              confidence: 0.8,
              screenRegion: { x: 100, y: 120, width: 220, height: 90 }
            }
          ],
          expectedNextState: 'user_asks_next'
        })
      )
    });
    const annotation = {
      id: 'screen-annotation-1',
      type: 'pen' as const,
      screenRegion: { x: 100, y: 120, width: 220, height: 90 },
      points: [
        { x: 100, y: 120 },
        { x: 140, y: 160 }
      ]
    };

    const result = await askTutorFromNotch({
      query: 'Do you see my annotation?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender',
      annotations: [annotation]
    });
    // Visuals are deferred until TTS start; reveal them, then assert routing.
    await result.revealVisuals();

    // A box's first reveal is a pen-drag from its top-left to bottom-right corner.
    expect(bridge.cursorDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        fromRegion: { x: 100, y: 120, width: 0, height: 0 },
        toRegion: { x: 320, y: 210, width: 0, height: 0 },
        displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 }
      })
    );
    expect(bridge.showOverlay).toHaveBeenCalledWith({
      displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 },
      targets: [expect.objectContaining({ targetId: 'provider-box' })]
    });
  });

  test('flies the companion cursor to a pointer target and keeps it visible in the overlay', async () => {
    const bridge = createBridge({
      runTutorTurn: vi.fn(async () =>
        JSON.stringify({
          mode: 'stuck_help',
          skillSlug: 'blender',
          voiceText: 'The GitHub tab is up here.',
          screenText: 'The GitHub tab is up here.',
          visualTargets: [
            {
              kind: 'pointer',
              targetId: 'gh-tab',
              label: 'GitHub tab',
              confidence: 0.9,
              screenRegion: { x: 240, y: 80, width: 120, height: 48 }
            }
          ],
          expectedNextState: 'user_asks_next'
        })
      )
    });

    const result = await askTutorFromNotch({
      query: 'Where is the GitHub homepage?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender'
    });
    await result.revealVisuals();

    expect(bridge.cursorPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        screenRegion: { x: 240, y: 80, width: 120, height: 48 },
        displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 }
      })
    );
    expect(bridge.showOverlay).toHaveBeenCalledWith({
      displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 },
      targets: [expect.objectContaining({ targetId: 'gh-tab', kind: 'pointer' })]
    });
  });

  test('keeps area targets in the overlay and points the companion cursor at them', async () => {
    const bridge = createBridge({
      runTutorTurn: vi.fn(async () =>
        JSON.stringify({
          mode: 'stuck_help',
          skillSlug: 'blender',
          voiceText: 'This whole panel is the inspector.',
          screenText: 'This whole panel is the inspector.',
          visualTargets: [
            {
              kind: 'highlight_box',
              targetId: 'inspector',
              label: 'Inspector',
              confidence: 0.8,
              screenRegion: { x: 100, y: 120, width: 220, height: 90 }
            }
          ],
          expectedNextState: 'user_asks_next'
        })
      )
    });

    const result = await askTutorFromNotch({
      query: 'What is this panel?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender'
    });
    await result.revealVisuals();

    // Area (highlight_box) targets are drawn by dragging corner-to-corner.
    expect(bridge.cursorDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        fromRegion: { x: 100, y: 120, width: 0, height: 0 },
        toRegion: { x: 320, y: 210, width: 0, height: 0 },
        displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 }
      })
    );
    expect(bridge.showOverlay).toHaveBeenCalledWith({
      displayBounds: { x: 0, y: 0, width: 1000, height: 700, scaleFactor: 2 },
      targets: [
        expect.objectContaining({ targetId: 'inspector', kind: 'highlight_box' })
      ]
    });
  });

  test('returns a visible provider error instead of staying in thinking', async () => {
    const bridge = createBridge({
      runTutorTurn: vi.fn(async () => {
        throw new Error('Provider failed');
      })
    });

    const result = await askTutorFromNotch({
      query: 'What is on this screen?',
      nativeBridge: bridge,
      aiProvider: 'openrouter',
      skillSlug: 'blender'
    });

    expect(result.payload).toMatchObject({
      state: 'showing_step',
      layout: 'answer',
      title: 'Kairo answered',
      detail: expect.stringContaining('Kairo could not complete the request')
    });
  });
});
