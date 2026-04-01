export type Point = { x: number; y: number };

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
