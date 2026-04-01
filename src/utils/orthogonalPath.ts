export type Point = { x: number; y: number };

/**
 * Generates orthogonal waypoints between two points.
 * Route: horizontal to midX, vertical to endY, horizontal to endX.
 * Returns 4 points (or 2 if same Y — just a straight horizontal line).
 */
export function getOrthogonalWaypoints(
  startX: number, startY: number,
  endX: number, endY: number,
): Point[] {
  const midX = (startX + endX) / 2;

  if (Math.abs(startY - endY) < 1) {
    // Straight horizontal
    return [
      { x: startX, y: startY },
      { x: endX, y: endY },
    ];
  }

  return [
    { x: startX, y: startY },
    { x: midX, y: startY },
    { x: midX, y: endY },
    { x: endX, y: endY },
  ];
}

/**
 * Builds an SVG path string for orthogonal waypoints with rounded corners.
 */
export function buildOrthogonalSvgPath(
  startX: number, startY: number,
  endX: number, endY: number,
  radius = 12,
): string {
  if (Math.abs(startY - endY) < 1) {
    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  const midX = (startX + endX) / 2;
  const dy = endY - startY;
  const r = Math.min(radius, Math.abs(dy) / 2, Math.abs(midX - startX), Math.abs(endX - midX));

  const dirY = dy > 0 ? 1 : -1;

  // M start → horizontal to first corner → rounded corner down → vertical → rounded corner right → horizontal to end
  return [
    `M ${startX} ${startY}`,
    `L ${midX - r} ${startY}`,
    `Q ${midX} ${startY} ${midX} ${startY + r * dirY}`,
    `L ${midX} ${endY - r * dirY}`,
    `Q ${midX} ${endY} ${midX + r} ${endY}`,
    `L ${endX} ${endY}`,
  ].join(' ');
}
