import { describe, expect, test } from 'vitest';
import { createPenAnnotationFromDisplayPoints } from '../src/overlay/annotationMode';

describe('overlay annotation mode', () => {
  test('converts display-space pen points into screenshot-space annotation points', () => {
    expect(
      createPenAnnotationFromDisplayPoints({
        id: 'annotation-pen-1',
        displayBounds: {
          x: 1800,
          y: 0,
          width: 1000,
          height: 800,
          scaleFactor: 2
        },
        points: [
          { x: 20, y: 30 },
          { x: 40, y: 45 },
          { x: 55, y: 60 }
        ]
      })
    ).toEqual({
      id: 'annotation-pen-1',
      type: 'pen',
      screenRegion: {
        x: 3640,
        y: 60,
        width: 70,
        height: 60
      },
      points: [
        { x: 3640, y: 60 },
        { x: 3680, y: 90 },
        { x: 3710, y: 120 }
      ]
    });
  });
});
