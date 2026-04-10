export type Point = { x: number; y: number };

export type NodeBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const CLEARANCE = 30;

/**
 * Compute orthogonal waypoints that avoid clipping through node bodies.
 * Returns Point[] — the single source of truth for routing.
 */
export function computeOrthogonalWaypoints(
  startX: number, startY: number,
  endX: number, endY: number,
  fromBounds?: NodeBounds,
  toBounds?: NodeBounds,
): Point[] {
  // Straight horizontal — no routing needed
  if (Math.abs(startY - endY) < 1) {
    return [
      { x: startX, y: startY },
      { x: endX, y: endY },
    ];
  }

  const midX = (startX + endX) / 2;

  // Check if midX would clip through either node
  const clipsFrom = fromBounds && midX > fromBounds.left && midX < fromBounds.right;
  const clipsTo = toBounds && midX > toBounds.left && midX < toBounds.right;
  const isBackward = endX <= startX;
  const needsDetour = clipsFrom || clipsTo || isBackward;

  if (!needsDetour) {
    // Normal 4-point path: H → V → H
    return [
      { x: startX, y: startY },
      { x: midX, y: startY },
      { x: midX, y: endY },
      { x: endX, y: endY },
    ];
  }

  // Determine which side to route the vertical segment on.
  // Pick the side that requires the least horizontal extension.
  const fromRight = fromBounds ? fromBounds.right : startX;
  const fromLeft = fromBounds ? fromBounds.left : startX;
  const toRight = toBounds ? toBounds.right : endX;
  const toLeft = toBounds ? toBounds.left : endX;

  // Option A: route right — vertical segment just past both right edges
  const routeRight = Math.max(fromRight, toRight) + CLEARANCE;
  const costRight = Math.abs(routeRight - startX) + Math.abs(routeRight - endX);

  // Option B: route left — vertical segment just past both left edges
  const routeLeft = Math.min(fromLeft, toLeft) - CLEARANCE;
  const costLeft = Math.abs(startX - routeLeft) + Math.abs(endX - routeLeft);

  const dy = endY - startY;

  // startX is always the right port of the source, so the line must initially go right.
  // exitRight: the minimum x the line must reach before turning vertically (clear of source).
  const exitRight = Math.max(startX, fromRight) + CLEARANCE;
  // entryLeft: the x the line must reach before the final horizontal into the target (left of target).
  const entryLeft = Math.min(endX, toLeft) - CLEARANCE;

  // midY: a Y coordinate between the two nodes to route the horizontal bridge
  const midY = dy > 0
    ? Math.max(fromBounds ? fromBounds.bottom : startY, startY) + CLEARANCE
    : Math.min(fromBounds ? fromBounds.top : startY, startY) - CLEARANCE;

  // Route: right to clear source → down to midY → left to clear target → down to endY → right to endX
  return [
    { x: startX, y: startY },
    { x: exitRight, y: startY },
    { x: exitRight, y: midY },
    { x: entryLeft, y: midY },
    { x: entryLeft, y: endY },
    { x: endX, y: endY },
  ];
}

/**
 * Generates orthogonal waypoints between two points.
 * Route: horizontal to midX, vertical to endY, horizontal to endX.
 * Returns 4 points (or 2 if same Y — just a straight horizontal line).
 */
export function getOrthogonalWaypoints(
  startX: number, startY: number,
  endX: number, endY: number,
  fromBounds?: NodeBounds,
  toBounds?: NodeBounds,
): Point[] {
  return computeOrthogonalWaypoints(startX, startY, endX, endY, fromBounds, toBounds);
}

/**
 * Builds an SVG path string for vertical-first orthogonal routing (up → horizontal → vertical).
 * Used for DMQ top-center port connecting upward to broker.
 */
export function buildVerticalFirstSvgPath(
  startX: number, startY: number,
  endX: number, endY: number,
  radius = 12,
): string {
  if (Math.abs(startX - endX) < 1) {
    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  const midY = (startY + endY) / 2;
  const dx = endX - startX;
  const r = Math.min(radius, Math.abs(dx) / 2, Math.abs(midY - startY), Math.abs(endY - midY));

  const dirX = dx > 0 ? 1 : -1;

  return [
    `M ${startX} ${startY}`,
    `L ${startX} ${midY + r}`,
    `Q ${startX} ${midY} ${startX + r * dirX} ${midY}`,
    `L ${endX - r * dirX} ${midY}`,
    `Q ${endX} ${midY} ${endX} ${midY - r}`,
    `L ${endX} ${endY}`,
  ].join(' ');
}

/**
 * Builds an SVG path string from arbitrary orthogonal waypoints with rounded corners.
 */
function buildSvgPathFromWaypoints(waypoints: Point[], radius = 12): string {
  if (waypoints.length < 2) return '';
  if (waypoints.length === 2) {
    return `M ${waypoints[0].x} ${waypoints[0].y} L ${waypoints[1].x} ${waypoints[1].y}`;
  }

  const parts: string[] = [`M ${waypoints[0].x} ${waypoints[0].y}`];

  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const next = waypoints[i + 1];

    // Compute the max radius we can use at this corner
    const lenIn = Math.max(Math.abs(curr.x - prev.x), Math.abs(curr.y - prev.y));
    const lenOut = Math.max(Math.abs(next.x - curr.x), Math.abs(next.y - curr.y));
    const r = Math.min(radius, lenIn / 2, lenOut / 2);

    if (r < 0.5) {
      // Too tight, just go straight
      parts.push(`L ${curr.x} ${curr.y}`);
      continue;
    }

    // Direction vectors (unit-ish, axis-aligned)
    const dxIn = Math.sign(curr.x - prev.x);
    const dyIn = Math.sign(curr.y - prev.y);
    const dxOut = Math.sign(next.x - curr.x);
    const dyOut = Math.sign(next.y - curr.y);

    // Line to the point where the curve starts
    const cornerStartX = curr.x - dxIn * r;
    const cornerStartY = curr.y - dyIn * r;
    parts.push(`L ${cornerStartX} ${cornerStartY}`);

    // Curve to the point where the curve ends
    const cornerEndX = curr.x + dxOut * r;
    const cornerEndY = curr.y + dyOut * r;
    parts.push(`Q ${curr.x} ${curr.y} ${cornerEndX} ${cornerEndY}`);
  }

  const last = waypoints[waypoints.length - 1];
  parts.push(`L ${last.x} ${last.y}`);

  return parts.join(' ');
}

/**
 * Builds an SVG path string for orthogonal waypoints with rounded corners.
 */
export function buildOrthogonalSvgPath(
  startX: number, startY: number,
  endX: number, endY: number,
  radius = 12,
  fromBounds?: NodeBounds,
  toBounds?: NodeBounds,
): string {
  const waypoints = computeOrthogonalWaypoints(startX, startY, endX, endY, fromBounds, toBounds);
  return buildSvgPathFromWaypoints(waypoints, radius);
}
