export type Point = { x: number; y: number };

function segmentLength(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Normalize progress-per-ms speed so each path segment takes the same duration.
 * Calibrated to REFERENCE_SEGMENTS=2 (the original pub→webhook→sub path).
 */
const REFERENCE_SEGMENTS = 2;
export function normalizedSpeed(baseSpeed: number, path: Point[]): number {
  const segments = Math.max(path.length - 1, 1);
  return baseSpeed * REFERENCE_SEGMENTS / segments;
}

/**
 * Returns a speed multiplier for the current segment so the dot moves at
 * constant pixel speed regardless of segment length.
 *
 * Without this, progress increments uniformly across segments but segments
 * have different pixel lengths, causing visible speed variation.
 *
 * The multiplier is: averageSegmentLength / currentSegmentLength
 * - Long segments get slowed down (multiplier < 1)
 * - Short segments get sped up (multiplier > 1)
 */
export function getSegmentSpeedScale(path: Point[], progress: number): number {
  if (path.length < 2) return 1;
  const numSegments = path.length - 1;
  const segmentProgress = Math.max(0, Math.min(1, progress)) * numSegments;
  const segmentIndex = Math.min(Math.floor(segmentProgress), numSegments - 1);

  const { lengths, avgLen } = getPathMetrics(path);
  const currentLen = lengths[segmentIndex];
  if (currentLen === 0) return 1;

  return avgLen / currentLen;
}

type PathMetrics = { lengths: number[]; totalLen: number; avgLen: number };

// Segment lengths are summed for every live dot every frame (speed scaling, arrival
// prediction). Paths are immutable — every builder creates a new array and nothing appends to
// one — so the metrics are cached on the array itself; entries die with their dot.
const pathMetricsCache = new WeakMap<Point[], PathMetrics>();

export function getPathMetrics(path: Point[]): PathMetrics {
  let m = pathMetricsCache.get(path);
  if (m) return m;
  const n = Math.max(path.length - 1, 0);
  const lengths: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < n; i++) {
    const len = segmentLength(path[i], path[i + 1]);
    lengths.push(len);
    totalLen += len;
  }
  m = { lengths, totalLen, avgLen: n > 0 ? totalLen / n : 0 };
  pathMetricsCache.set(path, m);
  return m;
}

/**
 * Compute the actual travel time (in ms) from `startProgress` to `endProgress`
 * accounting for per-segment speed scaling. `baseActualSpeed` is the unscaled
 * progress-per-ms (i.e. dot.speed * propagationSpeed).
 */
export function scaledTravelTime(
  path: Point[],
  startProgress: number,
  endProgress: number,
  baseActualSpeed: number,
): number {
  if (baseActualSpeed <= 0 || path.length < 2) return Infinity;
  const n = path.length - 1;

  const { lengths, avgLen } = getPathMetrics(path);
  if (avgLen === 0) return Infinity;

  // Integrate time across each segment the dot will traverse
  let time = 0;

  // A dot can start at negative progress (staggered queue release, batch fire). Movement
  // advances it at segment 0's speed scale until it reaches the path start, so count that
  // hidden stretch too — otherwise its predicted arrival comes out too early.
  if (startProgress < 0) {
    const scale0 = lengths[0] === 0 ? 1 : avgLen / lengths[0];
    time += (Math.min(0, endProgress) - startProgress) / (baseActualSpeed * scale0);
  }

  for (let i = 0; i < n; i++) {
    const segStart = i / n;
    const segEnd = (i + 1) / n;

    // Clip to [startProgress, endProgress]
    const lo = Math.max(segStart, startProgress);
    const hi = Math.min(segEnd, endProgress);
    if (lo >= hi) continue;

    const progressSpan = hi - lo;
    const scale = lengths[i] === 0 ? 1 : avgLen / lengths[i];
    // time = progressSpan / (baseActualSpeed * scale)
    time += progressSpan / (baseActualSpeed * scale);
  }
  return time;
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
