import { describe, expect, test, vi } from 'vitest';
import { routeVisualTargets } from '../src/overlay/targetRouting';
import type { VisualTarget } from '../src/core/types';

const bounds = { x: 0, y: 0, width: 1000, height: 800, scaleFactor: 1 };

function box(id: string, x: number): VisualTarget {
  return {
    kind: 'highlight_box',
    targetId: id,
    label: 'target',
    confidence: 0.9,
    screenRegion: { x, y: 10, width: 40, height: 20 }
  };
}

function bridge() {
  return {
    cursorPoint: vi.fn().mockResolvedValue(undefined),
    cursorDrag: vi.fn().mockResolvedValue(undefined),
    showOverlay: vi.fn().mockResolvedValue(undefined),
    hideOverlay: vi.fn().mockResolvedValue(undefined)
  };
}

describe('routeVisualTargets multi-point', () => {
  test('draws the NAMED box, not the first, so accumulated boxes do not redraw', async () => {
    const b = bridge();
    const targets = [box('vision-box-0', 10), box('vision-box-1', 100), box('vision-box-2', 200)];
    await routeVisualTargets(b, targets, bounds, 'draw', 'vision-box-2');
    // The pet drags the newest box into existence — its region, not box-0's.
    expect(b.cursorDrag).toHaveBeenCalledTimes(1);
    const arg = b.cursorDrag.mock.calls[0][0];
    expect(arg.fromRegion.x).toBeGreaterThanOrEqual(200);
  });

  test('every accumulated box is handed to the overlay, not just one', async () => {
    const b = bridge();
    const targets = [box('vision-box-0', 10), box('vision-box-1', 100)];
    await routeVisualTargets(b, targets, bounds, 'draw', 'vision-box-1');
    const payload = b.showOverlay.mock.calls[0][0];
    expect(payload.targets).toHaveLength(2);
  });

  test('falls back to the first box when no id is named (single-box turns unchanged)', async () => {
    const b = bridge();
    await routeVisualTargets(b, [box('vision-box-0', 10)], bounds, 'draw');
    expect(b.cursorDrag).toHaveBeenCalledTimes(1);
    expect(b.showOverlay.mock.calls[0][0].targets).toHaveLength(1);
  });
});
