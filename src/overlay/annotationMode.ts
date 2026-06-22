import { createAnnotationFromDrag, type AnnotationPoint } from '../annotations/annotationTools';
import type { UserAnnotation } from '../core/types';
import type { DisplayBounds } from './coordinates';

function toScreenPoint(point: AnnotationPoint, displayBounds: DisplayBounds): AnnotationPoint {
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;

  return {
    x: (displayBounds.x + point.x) * scaleFactor,
    y: (displayBounds.y + point.y) * scaleFactor
  };
}

export function createAnnotationFromDisplayDrag({
  id,
  type,
  displayBounds,
  start,
  end
}: {
  id: string;
  type: UserAnnotation['type'];
  displayBounds: DisplayBounds;
  start: AnnotationPoint;
  end: AnnotationPoint;
}): UserAnnotation {
  return createAnnotationFromDrag({
    id,
    type,
    start: toScreenPoint(start, displayBounds),
    end: toScreenPoint(end, displayBounds)
  });
}
