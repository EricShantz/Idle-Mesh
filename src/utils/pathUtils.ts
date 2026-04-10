export type Point = { x: number; y: number };

/**
 * Normalize progress-per-ms speed so each path segment takes the same duration.
 * Calibrated to REFERENCE_SEGMENTS=2 (the original pub→webhook→sub path).
 */
const REFERENCE_SEGMENTS = 2;
export function normalizedSpeed(baseSpeed: number, path: Point[]): number {
  const segments = Math.max(path.length - 1, 1);
  return baseSpeed * REFERENCE_SEGMENTS / segments;
}

export function interpolatePath(path: Point[], progress: number): Point {
  if (path.length < 2) return path[0] ?? { x: 0, y: 0 };

  if (progress <= 0) return path[0];

  const totalSegments = path.length - 1;
  const segmentProgress = progress * totalSegments;
  const segmentIndex = Math.min(Math.floor(segmentProgress), totalSegments - 1);
  const t = segmentProgress - segmentIndex;

  const from = path[segmentIndex];
  const to = path[segmentIndex + 1];

  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}
