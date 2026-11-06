// The position buffer: what the canvas draws, written once per tick by the sim. Every drawable
// dot is FLOATS_PER_DOT floats, [x, y, extent, r, g, b, a, glow], the vertex layout EventCanvas's
// WebGL path uploads as-is. The interpolation, the queued-dot snap to its queue's center, the
// pausing-dot shrink and the color parsing were moved here verbatim from EventCanvas.renderGl /
// drawDot so the canvas no longer needs the dot objects (the worker phase keeps them off the
// main thread; the buffer crosses as a transferable ArrayBuffer). No store, no React, no DOM.
import type { EventDot, GameComponent } from './types';

export const FLOATS_PER_DOT = 8; // x, y, extent, r, g, b, a, glow

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

// interpolatePath inlined: no {x, y} allocation per dot per frame. Result in posX/posY.
let posX = 0;
let posY = 0;
function pathPos(path: { x: number; y: number }[], progress: number): void {
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
    posX = a.x + (b.x - a.x) * t; posY = a.y + (b.y - a.y) * t;
  }
}

/** Writes every drawable dot into `data` (which must hold dots.length * FLOATS_PER_DOT floats)
 *  and returns the number of entries written. `nowMs` is the sim clock of the tick that moved
 *  the dots (the pausing shrink is time-based). */
export function fillPositions(dots: EventDot[], components: GameComponent[], nowMs: number, data: Float32Array): number {
  refreshLookups(components);
  let n = 0;
  for (const dot of dots) {
    let extent: number, glow: number, a: number;
    // A bundle (count > 1, see EventDot.count) draws as one slightly fuller dot: the sprite
    // scales with its extent, by 1 + 0.15·log2(count) (x1.15 for 2 events, x1.39 for 6).
    const size = dot.count === 1 ? 1 : 1 + 0.15 * Math.log2(dot.count);
    if (dot.status === 'traveling' || dot.status === 'queued') {
      const queue = dot.status === 'queued' && dot.queuedAtNodeId ? componentById.get(dot.queuedAtNodeId) : undefined;
      if (queue) {
        posX = queue.x; posY = queue.y;
      } else {
        pathPos(dot.path, dot.progress);
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
    n++;
  }
  return n;
}
