// The position buffer: what the canvas draws, written once per tick by the sim. Every drawable
// dot is FLOATS_PER_DOT floats, [x, y, extent, r, g, b, a, glow, vx, vy, tmax], the vertex layout
// EventCanvas's WebGL path uploads as-is. The interpolation, the queued-dot snap to its queue's
// center, the pausing-dot shrink and the color parsing were moved here verbatim from
// EventCanvas.renderGl / drawDot so the canvas no longer needs the dot objects (the worker phase
// keeps them off the main thread; the buffer crosses as a transferable ArrayBuffer). No store, no
// React, no DOM.
//
// vx, vy: the dot's velocity in world units per ms along its current path segment (the sim's
// progress per ms for this dot, EventDot.progressPerMs, times the segment's direction), so the
// canvas can draw it at x + vx * (ms since the tick landed) and motion stays smooth at frame rate
// when the sim ticks slower than that. tmax: for how many ms that velocity holds, until the next
// turn in the path (the segment scale keeps the pixel speed constant through collinear waypoints,
// so only a real corner ends the run) or until the sim would change or stop the motion
// (EventDot.speedUntilP: a webhook/cluster zone edge, or the point where the next queue or
// subscriber captures the dot); the canvas caps the extrapolation there, so a dot never cuts a
// corner, overshoots the card that takes it or crosses a zone edge at the wrong speed and then
// snaps back when the next tick lands. All three are zero for queued, pausing and dropped entries
// and for a dot still before its path start (a staggered batch); they stay where the tick put them.
import type { EventDot, GameComponent } from './types';

export const FLOATS_PER_DOT = 11; // x, y, extent, r, g, b, a, glow, vx, vy, tmax

export const DOT_RADIUS = 2.5;
export const GLOW_RADIUS = 4.5;
export const GLOW_EXTENT = GLOW_RADIUS + 2; // world units from dot center to the glow's outer edge

/** The `glow` field: how an entry is drawn and on which canvas. */
export const GLOW_DROPPED = 0; // plain disc of radius `extent` (= DOT_RADIUS), back canvas
export const GLOW_LIVE = 1;    // core + glow sprite, back canvas (traveling and queued dots)
export const GLOW_PAUSING = 2; // core + glow sprite shrunk to `extent`, front canvas (above the node cards)

const CONSUME_DURATION = 2500; // ms — how long the dot pauses at subscriber (drives the shrink)

// Per-frame lookups so filling doesn't linearly search components per dot. Rebuilt only when
// the component array changes identity (the canvas rebuilt both maps every frame).
let lookupComponents: GameComponent[] | null = null;
let componentById = new Map<string, GameComponent>();
let subscriberByPos = new Map<string, GameComponent>();
function refreshLookups(components: GameComponent[]): void {
  if (components === lookupComponents) return;
  lookupComponents = components;
  componentById = new Map<string, GameComponent>();
  subscriberByPos = new Map<string, GameComponent>();
  for (const c of components) {
    componentById.set(c.id, c);
    if (c.type === 'subscriber') {
      const k = `${Math.round(c.x)},${Math.round(c.y)}`;
      if (!subscriberByPos.has(k)) subscriberByPos.set(k, c);
    }
  }
}

// '#rrggbb' / '#rgb' → [r, g, b] in 0..1 (the only color formats dots use)
const rgbCache = new Map<string, [number, number, number]>();
function parseColor(color: string): [number, number, number] {
  let rgb = rgbCache.get(color);
  if (rgb) return rgb;
  let hex = color.startsWith('#') ? color.slice(1) : '';
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const n = hex.length >= 6 ? parseInt(hex.slice(0, 6), 16) : 0xffffff;
  rgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  rgbCache.set(color, rgb);
  return rgb;
}

// interpolatePath inlined: no {x, y} allocation per dot per frame. Result in posX/posY. For a dot
// on a segment, dirX/dirY is that segment's world displacement per unit of progress (so velocity
// = dir * progressPerMs), runEndP the progress at the next corner (the end of the straight run of
// collinear segments the dot is on) and runPx the distance in world units from the dot to it.
let posX = 0;
let posY = 0;
let dirX = 0;
let dirY = 0;
let runEndP = 1;
let runPx = 0;
function pathPos(path: { x: number; y: number }[], progress: number): void {
  dirX = 0; dirY = 0; runEndP = 1; runPx = 0;
  if (path.length < 2) {
    posX = path[0]?.x ?? 0; posY = path[0]?.y ?? 0;
  } else if (progress <= 0) {
    posX = path[0].x; posY = path[0].y;
  } else {
    const segs = path.length - 1;
    const sp = Math.min(progress, 1) * segs;
    const si = Math.min(Math.floor(sp), segs - 1);
    const t = sp - si;
    const a = path[si];
    const b = path[si + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    posX = a.x + dx * t; posY = a.y + dy * t;
    if (progress < 1) {
      dirX = dx * segs; dirY = dy * segs;
      runPx = Math.sqrt(dx * dx + dy * dy) * (1 - t);
      // Walk on while the following segments point the same way (orthogonal routes have collinear
      // port stubs): the pixel speed does not change there, only at a turn or a zero-length segment.
      let e = si + 1;
      while (e < segs) {
        const q = path[e];
        const c = path[e + 1];
        const ex = c.x - q.x;
        const ey = c.y - q.y;
        const along = dx * ex + dy * ey;
        if (along <= 0 || Math.abs(dx * ey - dy * ex) > 1e-6 * along) break;
        runPx += Math.sqrt(ex * ex + ey * ey);
        e++;
      }
      runEndP = e / segs;
    }
  }
}

// The point at `progress` on `path` (same interpolation), in ptX/ptY; pathPos's outputs are untouched.
let ptX = 0;
let ptY = 0;
function pointAt(path: { x: number; y: number }[], progress: number): void {
  const segs = path.length - 1;
  const sp = Math.max(0, Math.min(progress, 1)) * segs;
  const si = Math.min(Math.floor(sp), segs - 1);
  const t = sp - si;
  const a = path[si];
  const b = path[si + 1];
  ptX = a.x + (b.x - a.x) * t; ptY = a.y + (b.y - a.y) * t;
}

/** Writes every drawable dot into `data` (which must hold dots.length * FLOATS_PER_DOT floats)
 *  and returns the number of entries written. `nowMs` is the sim clock of the tick that moved
 *  the dots (the pausing shrink is time-based). */
export function fillPositions(dots: EventDot[], components: GameComponent[], nowMs: number, data: Float32Array): number {
  refreshLookups(components);
  let n = 0;
  for (const dot of dots) {
    let extent: number, glow: number, a: number;
    let vx = 0, vy = 0, tmax = 0;
    // A bundle (count > 1, see EventDot.count) draws as one slightly fuller dot: the sprite
    // scales with its extent, by 1 + 0.15·log2(count) (x1.15 for 2 events, x1.39 for 6).
    const size = dot.count === 1 ? 1 : 1 + 0.15 * Math.log2(dot.count);
    if (dot.status === 'traveling' || dot.status === 'queued') {
      const queue = dot.status === 'queued' && dot.queuedAtNodeId ? componentById.get(dot.queuedAtNodeId) : undefined;
      if (queue) {
        posX = queue.x; posY = queue.y;
      } else {
        pathPos(dot.path, dot.progress);
        const k = dot.progressPerMs;
        if (k > 0 && (dirX !== 0 || dirY !== 0)) {
          vx = dirX * k; vy = dirY * k;
          // How long the velocity holds: to the next corner, or sooner to where the sim changes or
          // stops the motion (a straight-line distance: that point is on the same collinear run).
          const untilP = dot.speedUntilP;
          let px = runPx;
          if (untilP <= dot.progress) px = 0;
          else if (untilP < runEndP) { pointAt(dot.path, untilP); px = Math.sqrt((ptX - posX) * (ptX - posX) + (ptY - posY) * (ptY - posY)); }
          tmax = px / Math.sqrt(vx * vx + vy * vy);
        }
      }
      extent = GLOW_EXTENT * size; glow = GLOW_LIVE;
      a = Math.max(0, dot.opacity);
      if (a <= 0) continue;
    } else if (dot.status === 'dropped') {
      posX = dot.dropX ?? dot.path[0].x; posY = dot.dropY ?? dot.path[0].y; extent = DOT_RADIUS * size; glow = GLOW_DROPPED;
      a = Math.max(0, dot.opacity);
      if (a <= 0) continue;
    } else if (dot.status === 'pausing') {
      pathPos(dot.path, Math.min(dot.progress, 1));
      // Shrink scale for pausing dots: find the subscriber this dot is at and check fasterConsumption
      const subscriberPos = dot.path[dot.path.length - 1];
      const sub = subscriberByPos.get(`${Math.round(subscriberPos.x)},${Math.round(subscriberPos.y)}`);
      const fasterConsumptionLevel = sub && Math.hypot(sub.x - subscriberPos.x, sub.y - subscriberPos.y) < 1
        ? (sub.upgrades['fasterConsumption'] ?? 0)
        : 0;
      const effectiveConsumeDuration = CONSUME_DURATION * Math.pow(0.95, fasterConsumptionLevel);
      const elapsed = nowMs - (dot.pauseStartTime ?? 0);
      const shrinkProgress = Math.max(0, 1 - elapsed / effectiveConsumeDuration);
      extent = GLOW_EXTENT * size * shrinkProgress; glow = GLOW_PAUSING;
      a = Math.max(0, dot.opacity * shrinkProgress);
    } else {
      continue;
    }
    const rgb = parseColor(dot.color);
    const o = n * FLOATS_PER_DOT;
    data[o] = posX; data[o + 1] = posY; data[o + 2] = extent;
    data[o + 3] = rgb[0]; data[o + 4] = rgb[1]; data[o + 5] = rgb[2]; data[o + 6] = a;
    data[o + 7] = glow;
    data[o + 8] = vx; data[o + 9] = vy; data[o + 10] = tmax;
    n++;
  }
  return n;
}
