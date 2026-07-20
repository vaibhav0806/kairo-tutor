import {
  createAnnotationFromPoints,
  type AnnotationPoint
} from '../annotations/annotationTools';
import type { UserAnnotation } from '../core/types';
import type { DisplayBounds } from './coordinates';

export function toScreenPoint(point: AnnotationPoint, displayBounds: DisplayBounds): AnnotationPoint {
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;

  return {
    x: (displayBounds.x + point.x) * scaleFactor,
    y: (displayBounds.y + point.y) * scaleFactor
  };
}

export function createPenAnnotationFromDisplayPoints({
  id,
  displayBounds,
  points
}: {
  id: string;
  displayBounds: DisplayBounds;
  points: AnnotationPoint[];
}): UserAnnotation {
  return createAnnotationFromPoints({
    id,
    points: points.map((point) => toScreenPoint(point, displayBounds))
  });
}
