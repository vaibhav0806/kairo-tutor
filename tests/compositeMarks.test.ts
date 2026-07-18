// tests/compositeMarks.test.ts
import { describe, it, expect } from 'vitest';
import { physicalToEncoded } from '../src/notch/compositeMarks';

const capture = {
  displayBounds: { x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 },
  imageGeometry: { rawWidth: 2880, rawHeight: 1800, encodedWidth: 1280, encodedHeight: 800 }
};

describe('physicalToEncoded', () => {
  it('maps top-left physical origin to image origin', () => {
    expect(physicalToEncoded({ x: 0, y: 0 }, capture)).toEqual({ x: 0, y: 0 });
  });

  it('scales physical px down to encoded px', () => {
    // scale = 1280/2880 = 0.4444...
    const p = physicalToEncoded({ x: 2880, y: 1800 }, capture);
    expect(p.x).toBeCloseTo(1280, 5);
    expect(p.y).toBeCloseTo(800, 5);
  });

  it('subtracts a non-zero display origin (secondary display)', () => {
    const cap = { ...capture, displayBounds: { ...capture.displayBounds, x: 1440, y: 0 } };
    // physical origin = x(1440) * scaleFactor(2) = 2880; point at physical 2880 → image 0
    expect(physicalToEncoded({ x: 2880, y: 0 }, cap).x).toBeCloseTo(0, 5);
  });
});
