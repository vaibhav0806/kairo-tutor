import { describe, expect, test } from 'vitest';
import { createAnnotationFromDisplayDrag } from '../src/overlay/annotationMode';

describe('overlay annotation mode', () => {
  test('converts display-space drags into screenshot-space annotation regions', () => {
    expect(
      createAnnotationFromDisplayDrag({
        id: 'annotation-1',
        type: 'rectangle',
        displayBounds: {
          x: 0,
          y: 0,
          width: 900,
          height: 600,
          scaleFactor: 2
        },
        start: { x: 100, y: 50 },
        end: { x: 220, y: 160 }
      })
    ).toEqual({
      id: 'annotation-1',
      type: 'rectangle',
      screenRegion: {
        x: 200,
        y: 100,
        width: 240,
        height: 220
      }
    });
  });

  test('accounts for display offsets on secondary screens', () => {
    expect(
      createAnnotationFromDisplayDrag({
        id: 'annotation-2',
        type: 'highlight',
        displayBounds: {
          x: 1800,
          y: 0,
          width: 1000,
          height: 800,
          scaleFactor: 1
        },
        start: { x: 40, y: 60 },
        end: { x: 90, y: 100 }
      }).screenRegion
    ).toEqual({
      x: 1840,
      y: 60,
      width: 50,
      height: 40
    });
  });
});
