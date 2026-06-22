import { describe, expect, test, vi } from 'vitest';
import { subscribeToOverlayPayload } from '../src/overlay/overlayEvents';
import type { OverlayPayload } from '../src/overlay/OverlayApp';

const payload: OverlayPayload = {
  displayBounds: {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scaleFactor: 1
  },
  targets: [
    {
      kind: 'highlight_box',
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

describe('subscribeToOverlayPayload', () => {
  test('loads the current native payload before subscribing for future overlay events', async () => {
    const onPayload = vi.fn();
    const listen = vi.fn(async () => vi.fn());
    const readCurrentPayload = vi.fn(async () => payload);

    await subscribeToOverlayPayload({
      listen,
      readCurrentPayload,
      onPayload
    });

    expect(readCurrentPayload).toHaveBeenCalledBefore(listen);
    expect(onPayload).toHaveBeenCalledWith(payload);
    expect(listen).toHaveBeenCalledWith('overlay:update', expect.any(Function));
  });
});
