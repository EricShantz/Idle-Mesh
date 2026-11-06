// The dot simulation as a plain module: no store, no React, no DOM. Everything here was moved
// out of the old src/hooks/useGameLoop.ts (now src/hooks/useSimBridge.ts, a thin requestAnimationFrame driver around
// `Sim`) so it can run on either thread. `tick` is the loop's old frame function plus the
// auto-publisher poll and the publish-dot building; the dot array and every cache live here.
// Nothing in this file may import from gameStore.ts, react, or touch window/document/localStorage.
import { nextDotId, resetDotIds, buildPublishDots } from './publish';
import { fillPositions } from './positions';
import { getPermanentQueueBufferBonus, findNextInteractableId, getPermanentBrokerThroughputMult, getPublisherCooldownMs, BRIDGE_GOLD_COLOR } from './meshRules';
import type { EventDot, GameComponent, Connection, Mesh } from './types';
import { interpolatePath, normalizedSpeed, getSegmentSpeedScale, scaledTravelTime, getPathMetrics } from '../utils/pathUtils';
import { computeOrthogonalWaypoints, computeVerticalFirstWaypoints } from '../utils/orthogonalPath';
import { createArrivalIndex, finalizeArrivalIndex, insertArrival, canAcceptArrival } from './releaseIndex';
import type { ArrivalIndex } from './releaseIndex';
import { getClusterSlotCount, getNodeHalfExtents } from '../store/upgradeConfig';

// Node card dimensions: positioned at left: x-60, top: y-28
// Card width: 120px (half = 60), card height varies but ~56px
const NODE_HALF_W = 60;
const NODE_TOP_OFFSET = 28;   // from center to top edge
const NODE_BOTTOM_OFFSET = 28; // from center to bottom edge (generous to cover content)

const DOT_RADIUS = 6;

/** Longest frame delta the simulation will step by (~10fps); larger gaps are treated as a pause. */
export const MAX_FRAME_DT_MS = 100;

const BROKER_BASE_THROUGHPUT = 8; // events/sec

/** Drop reason tracking for the warning "!" button */
export type DropReason = 'path-invalid' | 'webhook-occupied' | 'broker-capped' | 'queue-full' | 'subscriber-occupied' | 'path-incomplete';

/** The auto-publisher polls every AUTO_PUB_POLL_MS of *simulation* time (the same clamped dt
 *  that moves the dots), not wall-clock time. When frames run long the sim advances less than
 *  real time, so publishing slows down with consumption instead of outrunning it — the old
 *  setInterval kept firing at full speed into a mesh that was moving in slow motion, and the
 *  pile-up made every following frame slower still. */
const AUTO_PUB_POLL_MS = 100;
// Max falling (dropped) dots animated at once; drops beyond this are counted but not drawn.
export const DROPPED_VISUAL_CAP = 300;

/** Try to relay an event through a broker. Returns true if under cap, false if over. */
function tryBrokerRelay(brokerRelayTimestamps: Map<string, number[]>, brokerId: string, cap: number, now: number): boolean {
  let ts = brokerRelayTimestamps.get(brokerId);
  if (!ts) { ts = []; brokerRelayTimestamps.set(brokerId, ts); }
  // Timestamps are appended in order, so expired ones are a prefix: trim it in place instead of
  // filtering into a fresh array per relay (this runs once per broker crossing, thousands of
  // times a second at full throughput).
  let expired = 0;
  while (expired < ts.length && now - ts[expired] >= 1000) expired++;
  if (expired > 0) ts.splice(0, expired);
  if (ts.length >= cap) return false;
  ts.push(now);
  return true;
}

/** Get broker throughput cap from upgrade level, plus any permanent prestige multiplier */
function getBrokerCap(brokerComp: { upgrades: Record<string, number> }, permanentMult: number): number {
  const level = brokerComp.upgrades['increaseThroughput'] ?? 0;
  const bonus = level * (level + 9) / 2;
  const slots = getClusterSlotCount(brokerComp.upgrades);
  return (BROKER_BASE_THROUGHPUT + bonus) * permanentMult * slots;
}

/** Rebuild orthogonal waypoints from node IDs using current component positions.
 *  Returns the path AND the waypoint index of each node center in the path. */
function rebuildPathFromNodeIds(
  nodeIds: string[],
  components: { id: string; type: string; x: number; y: number; upgrades: Record<string, number> }[],
  connections?: { fromId: string; toId: string }[]
): { path: { x: number; y: number }[]; nodeWpIndices: number[] } {
  const nodes: { id: string; type: string; x: number; y: number; upgrades: Record<string, number> }[] = [];
  for (const id of nodeIds) {
    const comp = components.find(c => c.id === id);
    if (comp) nodes.push(comp);
  }
  if (nodes.length === 0) return { path: [], nodeWpIndices: [] };
  const path: { x: number; y: number }[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const nodeWpIndices: number[] = [0]; // first node is always at index 0
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (Math.abs(a.y - b.y) >= 5) {
      // DMQ→broker uses vertical-first routing
      if (a.type === 'dmq' && b.type === 'broker') {
        const aExtents = getNodeHalfExtents(a);
        const bExtents = getNodeHalfExtents(b);
        const fromBounds = { left: a.x - aExtents.halfW, right: a.x + aExtents.halfW, top: a.y - aExtents.halfH, bottom: a.y + aExtents.halfH };
        const toBounds = { left: b.x - bExtents.halfW, right: b.x + bExtents.halfW, top: b.y - bExtents.halfH, bottom: b.y + bExtents.halfH };
        const startX = a.x;
        const startY = a.y - aExtents.halfH - 16; // top-center port
        const endX = b.x;
        const endY = b.y + bExtents.halfH + 2; // bottom edge of broker
        const segWaypoints = computeVerticalFirstWaypoints(startX, startY, endX, endY, fromBounds, toBounds);
        for (let w = 1; w < segWaypoints.length - 1; w++) {
          path.push(segWaypoints[w]);
        }
      } else {
        // Check if this is a reverse bridge traversal (dot goes a→b but connection is b→a)
        const isReverseBridge = a.type === 'broker' && b.type === 'broker' && connections &&
          !connections.some(c => c.fromId === a.id && c.toId === b.id) &&
          connections.some(c => c.fromId === b.id && c.toId === a.id);

        // Use connection direction for waypoint computation so dots follow the displayed SVG path
        const src = isReverseBridge ? b : a;
        const dst = isReverseBridge ? a : b;
        const { halfW: srcHalfW, halfH: srcHalfH } = getNodeHalfExtents(src);
        const { halfW: dstHalfW, halfH: dstHalfH } = getNodeHalfExtents(dst);
        const portStartX = src.x + srcHalfW + 24;
        const portEndX = dst.x - dstHalfW - 2;
        const fromBounds = {
          left: src.x - srcHalfW,
          right: src.x + srcHalfW + 24,
          top: src.y - srcHalfH,
          bottom: src.y + srcHalfH,
        };
        const toBounds = {
          left: dst.x - dstHalfW,
          right: dst.x + dstHalfW,
          top: dst.y - dstHalfH,
          bottom: dst.y + dstHalfH,
        };
        const segWaypoints = computeOrthogonalWaypoints(portStartX, src.y, portEndX, dst.y, fromBounds, toBounds);
        // For reverse bridges, reverse the intermediate waypoints so dot travels the displayed path backward
        const intermediates = segWaypoints.slice(1, -1);
        if (isReverseBridge) intermediates.reverse();
        for (const wp of intermediates) {
          path.push(wp);
        }
      }
    }
    path.push({ x: b.x, y: b.y });
    nodeWpIndices.push(path.length - 1); // record where this node landed
  }
  return { path, nodeWpIndices };
}

/** Project a point onto a polyline path, returning the progress (0-1) of the closest point */
function projectOntoPath(path: { x: number; y: number }[], px: number, py: number): number {
  let bestProgress = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].x, ay = path[i].y;
    const bx = path[i + 1].x, by = path[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestProgress = (i + t) / (path.length - 1);
    }
  }
  return bestProgress;
}

/** Compute nodeWpIndices for an existing path by matching waypoints to component positions.
 *  Uses a generous tolerance to handle cases where a node has moved slightly since the path was built. */
function computeNodeWpIndices(
  path: { x: number; y: number }[],
  originalNodeIds: string[],
  components: { id: string; type: string; x: number; y: number }[]
): number[] | undefined {
  const indices: number[] = [];
  for (const nodeId of originalNodeIds) {
    const comp = components.find(c => c.id === nodeId);
    if (!comp) return undefined;
    // Find the closest waypoint to this component's current position
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let wp = 0; wp < path.length; wp++) {
      const d = Math.hypot(path[wp].x - comp.x, path[wp].y - comp.y);
      if (d < bestDist) { bestDist = d; bestIdx = wp; }
    }
    if (bestIdx < 0 || bestDist > 100) return undefined; // too far, bail out
    indices.push(bestIdx);
  }
  // Indices must be monotonically increasing
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) return undefined;
  }
  return indices;
}

/** Remap dot progress from old path to new path.
 *  Uses node waypoint indices to identify which logical segment the dot is in
 *  (preventing dots from jumping past queues), then projects the dot's pixel
 *  position onto that segment of the new path (preventing progress oscillation
 *  when waypoint counts change between frames). */
function remapProgressSemantic(
  oldNodeWpIndices: number[],
  newNodeWpIndices: number[],
  oldPath: { x: number; y: number }[],
  newPath: { x: number; y: number }[],
  oldProgress: number
): number | null {
  if (oldNodeWpIndices.length < 2 || newNodeWpIndices.length < 2) return null;
  if (oldNodeWpIndices.length !== newNodeWpIndices.length) return null;

  // Convert progress to waypoint-space position on old path
  const oldWpPos = oldProgress * (oldPath.length - 1);

  // Step 1: Determine which logical segment the dot is in
  let segIdx = oldNodeWpIndices.length - 2; // default to last segment
  for (let k = 0; k < oldNodeWpIndices.length - 1; k++) {
    if (oldWpPos <= oldNodeWpIndices[k + 1] + 0.001) {
      segIdx = k;
      break;
    }
  }

  // Step 2: Get the dot's current pixel position from the old path
  const px = interpolatePath(oldPath, oldProgress);

  // Step 3: Project that pixel position onto ONLY the matching segment of the new path
  // This prevents cross-segment jumping while avoiding progress oscillation
  const newSegStart = newNodeWpIndices[segIdx];
  const newSegEnd = newNodeWpIndices[segIdx + 1];

  let bestProgress = newSegStart / (newPath.length - 1);
  let bestDist = Infinity;
  for (let i = newSegStart; i < newSegEnd; i++) {
    const ax = newPath[i].x, ay = newPath[i].y;
    const bx = newPath[i + 1].x, by = newPath[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px.x - ax) * dx + (px.y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(px.x - cx, px.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestProgress = (i + t) / (newPath.length - 1);
    }
  }

  // Clamp to segment boundaries
  const segStartProgress = newSegStart / (newPath.length - 1);
  const segEndProgress = newSegEnd / (newPath.length - 1);
  return Math.max(segStartProgress, Math.min(segEndProgress, bestProgress));
}

/** Remove consecutive duplicate waypoints (within 1px) that break isPastAllQueues checks */
function dedupeConsecutiveWaypoints(path: { x: number; y: number }[]): { x: number; y: number }[] {
  return path.filter((p, i) => i === 0 || Math.abs(p.x - path[i - 1].x) >= 1 || Math.abs(p.y - path[i - 1].y) >= 1);
}

type Dot = EventDot;
type PathComps = { comp: GameComponent; idx: number }[];
/** A progress interval along a path (endpoints inclusive, in clamped [0, 1] progress). */
type Zone = { start: number; end: number };
/** A node on the path: its waypoint's progress and the progress at which a dot first touches it. */
type NodeMark = { comp: GameComponent; idx: number; centerP: number; touchStart: number };
/**
 * The route profile: everything the per-frame rules need to know about a path, precomputed as
 * progress fractions so a dot's frame is an add and a few compares instead of a dozen pixel
 * tests. Cached per path (below) and rebuilt when the component layout changes, exactly like the
 * node list and end subscriber it grew out of. Fractions, not pixels, so it survives a cable
 * getting longer or shorter while a node is dragged (progress is remapped the same way).
 */
type PathInfo = {
  componentsRef: GameComponent[];
  comps: PathComps;
  endSubscriber: GameComponent | undefined;
  /** Per segment: average segment length / this segment's (what getSegmentSpeedScale returns). */
  segScale: number[];
  /** Inside the webhook's touch box: speed x0.4. */
  slowZones: Zone[];
  /** Inside a DMR Cluster's bounds: speed x2.5. */
  fastZones: Zone[];
  /** The 20px band left of the webhook where an occupied webhook drops arrivals. */
  approachZones: Zone[];
  /** One per entry of `comps`, in path order. */
  marks: NodeMark[];
  /** Last mark per component id (what `findLast` over comps used to return). */
  markById: Map<string, NodeMark>;
  /** Single-entry memos for the per-dot lookups: dots on one path share a route and a target,
   *  so a property compare replaces a WeakMap/Map lookup per dot per frame. */
  rvIds?: string[];
  rvConnections?: Connection[];
  rvInvalid?: boolean;
  nextId?: string;
  nextMark?: NodeMark;
};

function inZones(zones: Zone[], p: number): boolean {
  for (const z of zones) if (p >= z.start && p <= z.end) return true;
  return false;
}

function addZone(zones: Zone[], start: number, end: number) {
  const last = zones[zones.length - 1];
  if (last && start <= last.end + 1e-9) { if (end > last.end) last.end = end; return; }
  zones.push({ start, end });
}

/** Progress intervals where the path lies inside an axis-aligned rect (edges inclusive). */
function rectZones(path: { x: number; y: number }[], left: number, right: number, top: number, bottom: number): Zone[] {
  const n = path.length - 1;
  const zones: Zone[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[i + 1];
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-9) {
      if (a.x < left || a.x > right) continue;
    } else {
      let ta = (left - a.x) / dx;
      let tb = (right - a.x) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-9) {
      if (a.y < top || a.y > bottom) continue;
    } else {
      let ta = (top - a.y) / dy;
      let tb = (bottom - a.y) / dy;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1) continue;
    addZone(zones, (i + t0) / n, (i + t1) / n);
  }
  return zones;
}

/**
 * Progress intervals where dotTouchesNode(pos, node) holds. The touch shape is the node box grown
 * by DOT_RADIUS with rounded corners; a cable entering through a face (every real route does) is
 * exact from the grown box alone, and the ends are refined against the exact test in case a
 * segment only clips a corner.
 */
function touchZones(path: { x: number; y: number }[], nodeX: number, nodeY: number): Zone[] {
  const coarse = rectZones(path,
    nodeX - NODE_HALF_W - DOT_RADIUS, nodeX + NODE_HALF_W + DOT_RADIUS,
    nodeY - NODE_TOP_OFFSET - DOT_RADIUS, nodeY + NODE_BOTTOM_OFFSET + DOT_RADIUS);
  const touches = (prog: number) => { const q = interpolatePath(path, prog); return dotTouchesNode(q.x, q.y, nodeX, nodeY); };
  const zones: Zone[] = [];
  for (const z of coarse) {
    let { start, end } = z;
    const startOk = touches(start);
    const endOk = touches(end);
    if (!startOk || !endOk) {
      let probe = -1;
      for (let k = 0; k <= 32; k++) { const q = start + (end - start) * k / 32; if (touches(q)) { probe = q; break; } }
      if (probe < 0) continue; // only grazes a rounded corner: never actually touches
      if (!startOk) { let lo = start; let hi = probe; for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (touches(mid)) hi = mid; else lo = mid; } start = hi; }
      if (!endOk) { let lo = probe; let hi = end; for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (touches(mid)) lo = mid; else hi = mid; } end = lo; }
    }
    zones.push({ start, end });
  }
  return zones;
}
/** Layout-derived data per path array (see getPathInfo in the loop). Paths are never mutated
 *  in place, so keying on the array is exact; entries are collected with their dot. */
const pathInfoCache = new WeakMap<{ x: number; y: number }[], PathInfo>();

/** Fork spawn geometry per (fork waypoint array, broker): the slice from the broker onward and
 *  its route, computed once and shared by every dot the fork spawns. Each spawn used to slice
 *  fresh arrays, so thousands of fork dots per second each carried a unique path — and a unique
 *  route profile and validity entry to build and garbage-collect. */
type ForkSpawn = {
  componentsRef: GameComponent[];
  nodeIdsRef: string[];
  waypoints: { x: number; y: number }[];
  nodeIds: string[];
  nextNodeId: string | undefined;
};
const forkSpawnCache = new WeakMap<{ x: number; y: number }[], Map<string, ForkSpawn>>();

/** Queue→subscriber release path per (queue, subscriber position), rebuilt when components move. */
type ReleasePath = { componentsRef: GameComponent[]; path: { x: number; y: number }[]; progress: number; nodeIds: string[] };
const releasePathCache = new Map<string, ReleasePath>();
type RouteValidity = { componentsRef: GameComponent[]; connectionsRef: Connection[]; invalid: boolean };
/** Whether a route (a dot's originalNodeIds, shared by every dot of one fire) still has a
 *  connection for each hop, cached until the component or connection list changes. */
const routeValidityCache = new WeakMap<string[], RouteValidity>();


/** Consume duration (ms) for a subscriber at its fasterConsumption level; 1s when unknown. */
function consumeDurationFor(sub: { upgrades: Record<string, number> } | undefined): number {
  const level = sub?.upgrades['fasterConsumption'] ?? 0;
  const boostPct = Math.min(level * (level + 9) / 2, 100);
  return 1000 * (1 - boostPct / 100);
}

/** Check if a point (dot) touches the rectangular bounding box of a node */
function dotTouchesNode(px: number, py: number, nodeX: number, nodeY: number): boolean {
  const left = nodeX - NODE_HALF_W;
  const right = nodeX + NODE_HALF_W;
  const top = nodeY - NODE_TOP_OFFSET;
  const bottom = nodeY + NODE_BOTTOM_OFFSET;

  // Closest point on the rect to the dot center
  const cx = Math.max(left, Math.min(px, right));
  const cy = Math.max(top, Math.min(py, bottom));

  const dist = Math.hypot(px - cx, py - cy);
  return dist <= DOT_RADIUS;
}

export type SimInput = {
  /** Raw frame delta; the sim clamps it to MAX_FRAME_DT_MS. */
  dtMs: number;
  /** Date.now() of the caller. The only clock the sim uses (the worker shares it with the main thread). */
  nowMs: number;
  draggingNodeId: string | null;
  /** showWinScreen: the tick does nothing. */
  frozen: boolean;
  /** Publisher ids clicked since the last tick (already cooldown-checked by the store). */
  manualFires: string[];
};

export type TickSummary = {
  consumed: { id: string; value: number; subscriberId: string }[];
  droppedCount: number;
  /** Auto-publishers that fired this tick (for the cooldown map + publish rate). */
  publisherIds: string[];
  /** fireCount per fired publisher, same order as publisherIds. */
  publishes: { count: number }[];
  queueSlotSignatures: Record<string, string>;
  activeDrops: { nodeId: string; nodeLabel: string; reason: DropReason; lastDropTime: number }[];
  /** Relays in the last 1 s per broker (what getBrokerUtilization used to scan for). */
  brokerRelayCounts: Record<string, number>;
  subscriberConsume: Record<string, { start: number; duration: number }>;
  /** Per webhook id: the NodeCard border fill value (-1 if no dot is inside the box). */
  webhookFill: Record<string, number>;
  /** nowMs of the first drop ever in this sim, for the first-drop tutorial. */
  firstDropAt: number | null;
  /** For the UI's sim-ticks/sec stat. */
  simNow: number;
  liveDots: number;
};

const EMPTY_MESH: Mesh = {
  components: [],
  connections: [],
  upgrades: { propagationSpeed: 1.0, costReduction: 0, batchFire: 0, globalValueMultiplier: 1.0 },
  prestige: { points: 0, totalPoints: 0, count: 0, permanentUpgradeLevels: {} },
};

/** Cumulative ms spent in each section of `tick` (diagnostics: window.__sim.stats().sections in
 *  the bridge, per-tick averages in behavior.mjs). A handful of performance.now() calls per tick. */
export type TickSections = { setup: number; pass1: number; index: number; pass2: number; pass3: number; sigs: number; publish: number };
export const tickSections: TickSections = { setup: 0, pass1: 0, index: 0, pass2: 0, pass3: 0, sigs: 0, publish: 0 };
let sectionMark = 0;
function sectionStart(): void { sectionMark = performance.now(); }
function sectionEnd(key: keyof TickSections): void { const n = performance.now(); tickSections[key] += n - sectionMark; sectionMark = n; }

export class Sim {
  private mesh: Mesh = EMPTY_MESH;
  private dots: Dot[] = [];
  /** Rolling window of relay timestamps per broker for throughput cap */
  private readonly brokerRelayTimestamps = new Map<string, number[]>();
  /** Round-robin index per queue for competing consumer pattern */
  private readonly queueRoundRobinIdx = new Map<string, number>();
  /** Throttle DMQ releases to ~1 every 500ms */
  private lastDmqReleaseTime = 0;
  /** Last release timestamp per queue — safety net during drag to prevent rapid draining */
  private readonly queueLastReleaseTime = new Map<string, number>();
  /** Drop reason tracking for the warning "!" button */
  private readonly nodeDropTracker = new Map<string, { reason: DropReason; lastDropTime: number; nodeLabel: string }>();
  private autoPubAccumulator = 0;
  /** Nominal sim time of the latest auto-publisher poll: simNow − autoPubAccumulator, kept as an
   *  exact multiple of AUTO_PUB_POLL_MS so consecutive polls are exactly one interval apart
   *  whatever the tick pattern (the cooldown compare must not fail on floating point). */
  private autoPubPollSimTime = 0;
  private simNow = 0;
  /** Sim-time timestamp of each publisher's last auto fire (wall-clock cooldowns live in the store). */
  private readonly autoFireLastSim = new Map<string, number>();
  /** Start time and duration of the most recent consume at each subscriber, recorded when a dot
   *  starts pausing there. The subscriber card's cooldown overlay reads this (via the summary)
   *  instead of scanning every live dot for one pausing near it. */
  private readonly subscriberConsume = new Map<string, { start: number; duration: number }>();
  /** Timestamp of the first event drop (for tutorial trigger) */
  private firstDropAt: number | null = null;
  private lastSlotSignatures: Record<string, string> = {};
  private lastWebhookFill: Record<string, number> = {};
  /** Clock of the last tick; the pausing-dot shrink in fillPositions is time-based. */
  private lastNowMs = 0;

  /** Replaces the snapshot. Caches key on the identity of its four fields exactly as the loop's
   *  did on the store's, so a new `components` array (any move/add/remove) rebuilds them. */
  setMesh(mesh: Mesh): void {
    const prev = this.mesh;
    this.mesh = mesh;
    // removeComponent used to filter the dots queued at the removed node out of the store's
    // array; the sim owns the dots now, so the same pruning happens here. Only a removal
    // shrinks the component list (moves and upgrades keep its length, purchases grow it).
    if (mesh.components !== prev.components && mesh.components.length < prev.components.length && this.dots.length > 0) {
      const ids = new Set<string>();
      for (const c of mesh.components) ids.add(c.id);
      this.dots = this.dots.filter(d => d.queuedAtNodeId === undefined || ids.has(d.queuedAtNodeId));
    }
  }

  /** Drag frames: patches one component's position (new array identity, like moveComponent in
   *  the store, so the layout caches rebuild). */
  moveComponent(id: string, x: number, y: number): void {
    const components = this.mesh.components.map(c => (c.id === id ? { ...c, x, y } : c));
    this.mesh = { ...this.mesh, components };
  }

  /** Prestige / wipe: the dots are cleared and dot ids restart (what performPrestige did). */
  reset(): void {
    this.dots = [];
    resetDotIds();
  }

  getDots(): EventDot[] {
    return this.dots;
  }

  /** Writes [x, y, extent, r, g, b, a, glow] per drawable dot into `buf` (the EventCanvas vertex
   *  layout, see positions.ts) and returns the entry count. `buf` must hold at least
   *  getDots().length * FLOATS_PER_DOT floats. */
  fillPositions(buf: Float32Array): number {
    return fillPositions(this.dots, this.mesh.components, this.lastNowMs, buf);
  }

  private brokerRelayCounts(now: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [brokerId, ts] of this.brokerRelayTimestamps) {
      // Same trim tryBrokerRelay does, so the count is the relays still inside the 1 s window.
      let expired = 0;
      while (expired < ts.length && now - ts[expired] >= 1000) expired++;
      if (expired > 0) ts.splice(0, expired);
      if (ts.length > 0) counts[brokerId] = ts.length;
    }
    return counts;
  }

  private activeDrops(now: number): TickSummary['activeDrops'] {
    const active: TickSummary['activeDrops'] = [];
    for (const [nodeId, entry] of this.nodeDropTracker) {
      if (now - entry.lastDropTime < 2000) {
        active.push({ nodeId, nodeLabel: entry.nodeLabel, reason: entry.reason, lastDropTime: entry.lastDropTime });
      }
    }
    return active;
  }

  private buildSummary(
    consumed: TickSummary['consumed'], droppedCount: number, publisherIds: string[], publishes: { count: number }[],
    queueSlotSignatures: Record<string, string>, webhookFill: Record<string, number>, nowMs: number,
  ): TickSummary {
    this.lastSlotSignatures = queueSlotSignatures;
    this.lastWebhookFill = webhookFill;
    return {
      consumed,
      droppedCount,
      publisherIds,
      publishes,
      queueSlotSignatures,
      activeDrops: this.activeDrops(nowMs),
      brokerRelayCounts: this.brokerRelayCounts(nowMs),
      subscriberConsume: Object.fromEntries(this.subscriberConsume),
      webhookFill,
      firstDropAt: this.firstDropAt,
      simNow: this.simNow,
      liveDots: this.dots.length,
    };
  }

  tick(input: SimInput): TickSummary {
    const mesh = this.mesh;
    // Clamp the frame delta. requestAnimationFrame stops while the tab is hidden but the
    // clock doesn't, so the first frame back would otherwise get a dt of the whole absence —
    // every dot slams to its destination at once and the queue releases the entire pile
    // spread across that one enormous "frame". Capping it means a return from a tab switch
    // just resumes at normal pace (and ordinary hitches can't teleport dots either).
    const dt = Math.min(input.dtMs, MAX_FRAME_DT_MS);
    this.lastNowMs = input.nowMs;

    // End-game win screen: freeze the simulation in place behind the overlay. dt is already
    // clamped, so resuming after dismissal just picks up at normal pace.
    if (input.frozen) {
      return this.buildSummary([], 0, [], [], this.lastSlotSignatures, this.lastWebhookFill, input.nowMs);
    }

    // Manual publisher clicks since the last tick: appended before this tick's movement, as
    // they were when the store appended them between frames.
    if (input.manualFires.length > 0) {
      let dots = this.dots;
      for (const id of input.manualFires) {
        const built = buildPublishDots(mesh, id);
        if (built) dots = dots.concat(built.dots);
      }
      this.dots = dots;
    }

    const brokerRelayTimestamps = this.brokerRelayTimestamps;
    const queueRoundRobinIdx = this.queueRoundRobinIdx;
    const queueLastReleaseTime = this.queueLastReleaseTime;
    const subscriberConsume = this.subscriberConsume;
    const nodeDropTracker = this.nodeDropTracker;

    const toConsume: { id: string; value: number; subscriberId: string }[] = [];
    let droppedCount = 0;

    // Queue/DMQ slot display for this frame, filled in below and returned with the summary.
    let queueSlotSignatures: Record<string, string> = {};
    // Webhook card border fill (see the traveling branch), per webhook id.
    let webhookFill: Record<string, number> = {};
    let webhookBest = -1;

    sectionStart();
    const frameDots = ((dots: Dot[]): Dot[] => {
      // One clock read per frame: the rules only ever compare times within a frame or against
      // windows of hundreds of ms, and the calls were being made once per dot.
      const nowMs = input.nowMs;
      const frameNow = nowMs;
      const recordDrop = (nodeId: string, reason: DropReason, nodeLabel: string) => {
        nodeDropTracker.set(nodeId, { reason, lastDropTime: nowMs, nodeLabel });
      };
      // Use a mutable array so each dot sees the results of earlier dots in the same frame
      const updated: Dot[] = [];
      // Track queues whose dots were rebuilt in post-drag cleanup this frame
      // (skip releases for 1 frame to let paths stabilize after Y-snap).
      const postDragCleanupQueues = new Set<string>();
      // Pre-compute DMQ queued count from source array to avoid undercounting
      // when existing queued dots appear later in iteration order
      const dmqCompForCount = mesh.components.find(c => c.type === 'dmq');
      let dmqQueuedCount = 0;
      // Per-queue BACKLOG from the previous frame: dots still waiting because the subscriber
      // couldn't take them. This — not the running count including this frame's arrivals —
      // is what the buffer limit gates on. Arrivals happen (Pass 1) before releases (Pass 2)
      // within a frame, so counting same-frame arrivals meant a burst larger than the buffer
      // dropped its tail as "queue-full" even though Pass 2 drained the whole buffer a moment
      // later. A dot that arrives and leaves within one tick never really held a slot; buffer
      // depth only matters once the consumer actually falls behind.
      // One pass over the dots for both counts (two passes over 100k+ dots were 5 ms a tick).
      const queueBacklogCounts = new Map<string, number>();
      for (const d of dots) {
        if (d.status !== 'queued' || !d.queuedAtNodeId) continue;
        queueBacklogCounts.set(d.queuedAtNodeId, (queueBacklogCounts.get(d.queuedAtNodeId) ?? 0) + 1);
        if (dmqCompForCount && d.queuedAtNodeId === dmqCompForCount.id) dmqQueuedCount++;
      }
      // Per-frame component lookups. Pass 1 used to re-scan the component list for every
      // dot (webhook lookup, DMR cluster bounds, and matching each path waypoint to a node),
      // which at ~1,500 live dots was ~100k comparisons per frame.
      const webhookComponent = mesh.components.find(c => c.type === 'webhook');
      const clusterBounds = mesh.components
        .filter(c => c.type === 'broker' && getClusterSlotCount(c.upgrades) > 1)
        .map(c => ({ x: c.x, y: c.y, ...getNodeHalfExtents(c) }));
      // Node waypoints in every path builder are exact copies of a component's x/y, so an
      // exact rounded key is a faithful replacement for the old `< 1px` linear scan; the hit
      // is still verified against that tolerance below. First-wins on a key collision mirrors
      // the old `find` returning the first match.
      const posKey = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
      const componentByPos = new Map<string, GameComponent>();
      const componentById = new Map<string, GameComponent>();
      for (const c of mesh.components) {
        const k = posKey(c.x, c.y);
        if (!componentByPos.has(k)) componentByPos.set(k, c);
        componentById.set(c.id, c);
      }
      const connectionKeys = new Set<string>();
      for (const c of mesh.connections) connectionKeys.add(`${c.fromId}->${c.toId}`);

      // Subscriber lookup by position. Every path that ends at a subscriber ends exactly on
      // its center (all builders use node x/y), so an exact key resolves it; the linear
      // `< 50px` scan is kept only as the fallback for an end point that isn't a center.
      const subscribers = mesh.components.filter(c => c.type === 'subscriber');
      // Consume duration per subscriber for this tick, and whether any subscriber takes time at
      // all. A 0 ms subscriber (fasterConsumption maxed) is never occupied and never rejects a
      // release, so the occupancy buckets and the arrival index are not built for it.
      const consumeDurationBySub = new Map<string, number>();
      let anyTimedSubscriber = false;
      for (const s of subscribers) {
        const cd = consumeDurationFor(s);
        consumeDurationBySub.set(s.id, cd);
        if (cd > 0) anyTimedSubscriber = true;
      }
      const subscriberByPos = new Map<string, GameComponent>();
      for (const s of subscribers) {
        const k = posKey(s.x, s.y);
        if (!subscriberByPos.has(k)) subscriberByPos.set(k, s);
      }
      const subscriberNear = (x: number, y: number): GameComponent | undefined =>
        subscriberByPos.get(posKey(x, y)) ?? subscribers.find(s => Math.hypot(s.x - x, s.y - y) < 50);

      // Per-path data derived from the component layout (the nodes sitting on the path, and
      // the subscriber it ends at). Cached on the path array; rebuilt when the components
      // array identity changes (any move/add/remove), which during a drag is every frame —
      // exactly the old per-frame cost, but only then.
      const getPathInfo = (path: { x: number; y: number }[]): PathInfo => {
        let info = pathInfoCache.get(path);
        if (info && info.componentsRef === mesh.components) return info;
        const comps: PathComps = [];
        for (let wp = 0; wp < path.length; wp++) {
          const pt = path[wp];
          const hit = componentByPos.get(posKey(pt.x, pt.y));
          const comp = hit && Math.abs(hit.x - pt.x) < 1 && Math.abs(hit.y - pt.y) < 1 ? hit : undefined;
          if (comp && (comps.length === 0 || comps[comps.length - 1].comp.id !== comp.id)) {
            comps.push({ comp, idx: wp });
          }
        }
        const end = path[path.length - 1];
        const n = path.length - 1;
        const metrics = getPathMetrics(path);
        const segScale = metrics.lengths.map(len => (len === 0 ? 1 : metrics.avgLen / len));
        const marks: NodeMark[] = comps.map(({ comp, idx }) => {
          const centerP = n > 0 ? idx / n : 0;
          // The touch interval around the node's own waypoint (a cable can't reach the center
          // without entering the box, so it always exists; the fallback is just for safety).
          const own = touchZones(path, comp.x, comp.y).find(z => z.start <= centerP && centerP <= z.end);
          return { comp, idx, centerP, touchStart: own ? own.start : centerP };
        });
        const markById = new Map<string, NodeMark>();
        for (const mk of marks) markById.set(mk.comp.id, mk);
        let approachZones: Zone[] = [];
        if (webhookComponent) {
          const leftEdge = webhookComponent.x - NODE_HALF_W - DOT_RADIUS;
          approachZones = rectZones(path, leftEdge - 20, leftEdge, -Infinity, Infinity);
        }
        const fastZones: Zone[] = [];
        for (const cb of clusterBounds) {
          for (const z of rectZones(path, cb.x - cb.halfW, cb.x + cb.halfW, cb.y - cb.halfH, cb.y + cb.halfH)) fastZones.push(z);
        }
        info = {
          componentsRef: mesh.components,
          comps,
          endSubscriber: end ? subscriberNear(end.x, end.y) : undefined,
          segScale,
          slowZones: webhookComponent ? touchZones(path, webhookComponent.x, webhookComponent.y) : [],
          fastZones,
          approachZones,
          marks,
          markById,
        };
        pathInfoCache.set(path, info);
        return info;
      };

      // Pausing dots grouped by the subscriber they sit at. Seeded from the pre-frame state
      // and extended as dots pause during Pass 1, so an arriving dot sees the same set the
      // old full scan of `updated` + the unprocessed remainder saw: earlier dots in their
      // updated form, later ones as they were. (A dot consumed this frame has
      // elapsed ≥ its consume duration and so never passes the occupancy test anyway.)
      const pausingFallbackKey = (d: Dot) => {
        const end = d.path[d.path.length - 1];
        return end ? `@${posKey(end.x, end.y)}` : '@';
      };
      const pausingBucketKey = (d: Dot) => {
        const sub = getPathInfo(d.path).endSubscriber;
        return sub ? sub.id : pausingFallbackKey(d);
      };
      const pausingBySub = new Map<string, Dot[]>();
      const addPausing = (d: Dot) => {
        const sub = getPathInfo(d.path).endSubscriber;
        // Only the occupancy check reads the buckets, and it skips them for a 0 ms subscriber
        // (see the subscriber capture in Pass 1), so those dots are not filed. On a maxed
        // fan-out mesh they are nearly all of the pausing dots.
        if (sub && consumeDurationBySub.get(sub.id) === 0) return;
        const k = sub ? sub.id : pausingFallbackKey(d);
        const bucket = pausingBySub.get(k);
        if (bucket) bucket.push(d); else pausingBySub.set(k, [d]);
      };
      for (const d of dots) if (d.status === 'pausing' && d.path.length > 0) addPausing(d);

      const forkSpawnFor = (fork: { waypoints: { x: number; y: number }[]; nodeIds: string[] }, forkComp: GameComponent): ForkSpawn => {
        let byBroker = forkSpawnCache.get(fork.waypoints);
        if (!byBroker) { byBroker = new Map(); forkSpawnCache.set(fork.waypoints, byBroker); }
        const hit = byBroker.get(forkComp.id);
        if (hit && hit.componentsRef === mesh.components && hit.nodeIdsRef === fork.nodeIds) return hit;
        // Build fork path starting from the broker position onward: route from the broker, and
        // waypoints from the one closest to the broker
        const brokerIdxInFork = fork.nodeIds.indexOf(forkComp.id);
        const nodeIds = brokerIdxInFork >= 0 ? fork.nodeIds.slice(brokerIdxInFork) : fork.nodeIds;
        let brokerWpIdx = 0;
        let bestDist = Infinity;
        for (let wi = 0; wi < fork.waypoints.length; wi++) {
          const d = Math.hypot(fork.waypoints[wi].x - forkComp.x, fork.waypoints[wi].y - forkComp.y);
          if (d < bestDist) { bestDist = d; brokerWpIdx = wi; }
        }
        const entry: ForkSpawn = {
          componentsRef: mesh.components,
          nodeIdsRef: fork.nodeIds,
          waypoints: fork.waypoints.slice(brokerWpIdx),
          nodeIds,
          nextNodeId: findNextInteractableId(nodeIds, mesh.components),
        };
        byBroker.set(forkComp.id, entry);
        return entry;
      };

      // Dropped dots are pure visuals once the drop is counted — the one exception being a dot
      // that falls onto the DMQ and gets re-queued. In a flood (brokers over cap) they were
      // three quarters of all live dots, each still allocated, moved and drawn every frame for
      // 2.5 s. Beyond DROPPED_VISUAL_CAP falling dots, new drops are counted but not animated,
      // unless they fall where the DMQ could catch them.
      let droppedVisuals = 0;
      for (const d of dots) if (d.status === 'dropped') droppedVisuals++;
      const dmqHalfWForCatch = dmqCompForCount ? (120 + (dmqCompForCount.upgrades['dmqWidth'] ?? 0) * 40) / 2 : 0;
      const pushDropped = (d: Dot) => {
        const x = d.dropX ?? 0;
        const catchable = dmqCompForCount !== undefined && !d.isRetry &&
          x >= dmqCompForCount.x - dmqHalfWForCatch && x <= dmqCompForCount.x + dmqHalfWForCatch;
        if (droppedVisuals < DROPPED_VISUAL_CAP || catchable) {
          droppedVisuals++;
          updated.push(d);
        }
      };

      // Helper: check if a component is occupied — sees already-processed + remaining dots.
      // Defined once per frame: as a per-dot closure it allocated two functions per dot per frame.
      const isComponentOccupied = (componentId: string, self: Dot, i: number) => {
          const comp = componentById.get(componentId);
          if (!comp) return false;
          const occupiedBy = (d: Dot) => {
            if (d.id === self.id) return false; // never block yourself
            if (d.status === 'pausing' || d.status === 'queued') {
              const lastPos = d.path[d.path.length - 1];
              return Math.hypot(comp.x - lastPos.x, comp.y - lastPos.y) < 50;
            }
            // A traveling dot inside a webhook/broker counts as occupying it
            if (d.status === 'traveling' && (comp.type === 'webhook' || comp.type === 'broker')) {
              const pos = interpolatePath(d.path, d.progress);
              return dotTouchesNode(pos.x, pos.y, comp.x, comp.y);
            }
            return false;
          };
          for (const d of updated) if (occupiedBy(d)) return true;
          for (let j = i + 1; j < dots.length; j++) if (occupiedBy(dots[j])) return true;
          return false;
      };

      sectionEnd('setup');
      for (let i = 0; i < dots.length; i++) {
        let dot = dots[i];

        // Post-drag cleanup: if dot was rebuilt during drag (has nodeWpIndices) but drag ended,
        // rebuild one final time from current positions to account for Y-snap
        if (!input.draggingNodeId && dot.nodeWpIndices && dot.originalNodeIds &&
            (dot.status === 'traveling' || dot.status === 'queued')) {
          const oldPath = dot.path;
          const oldNodeWpIndices = dot.nodeWpIndices;
          const { path: freshPath, nodeWpIndices: freshIndices } = rebuildPathFromNodeIds(dot.originalNodeIds, mesh.components, mesh.connections);
          if (freshPath.length >= 2) {
            if (dot.status === 'queued' && dot.queuedAtNodeId) {
              postDragCleanupQueues.add(dot.queuedAtNodeId);
              const queueNodeIdx = dot.originalNodeIds.indexOf(dot.queuedAtNodeId);
              if (queueNodeIdx >= 0 && queueNodeIdx < freshIndices.length) {
                const queueWpIdx = freshIndices[queueNodeIdx];
                dot = { ...dot, path: freshPath, progress: queueWpIdx / (freshPath.length - 1), nodeWpIndices: undefined } as typeof dot;
              } else {
                dot = { ...dot, path: freshPath, nodeWpIndices: undefined } as typeof dot;
              }
            } else {
              let newProgress: number | null = remapProgressSemantic(oldNodeWpIndices, freshIndices, oldPath, freshPath, dot.progress);
              if (newProgress === null) {
                const currentPos = interpolatePath(oldPath, dot.progress);
                newProgress = projectOntoPath(freshPath, currentPos.x, currentPos.y);
              }
              const newSpeed = dot.speed * Math.max(oldPath.length - 1, 1) / Math.max(freshPath.length - 1, 1);
              dot = { ...dot, path: freshPath, progress: newProgress, speed: newSpeed, nodeWpIndices: undefined } as typeof dot;
            }
          } else {
            dot = { ...dot, nodeWpIndices: undefined } as typeof dot;
          }
          // Also rebuild forkPaths one final time for Y-snap
          if (dot.forkPaths) {
            const updatedForks = dot.forkPaths.map(fork => {
              const { path: newForkPath } = rebuildPathFromNodeIds(fork.nodeIds, mesh.components, mesh.connections);
              return newForkPath.length >= 2 ? { ...fork, waypoints: newForkPath } : fork;
            });
            dot = { ...dot, forkPaths: updatedForks } as typeof dot;
          }
        }

        // Rebuild path in real-time when a component on this dot's route is being dragged
        if (input.draggingNodeId && dot.originalNodeIds?.includes(input.draggingNodeId) &&
            (dot.status === 'traveling' || dot.status === 'queued')) {
          const oldPath = dot.path;
          const { path: newPath, nodeWpIndices: newNodeWpIndices } = rebuildPathFromNodeIds(dot.originalNodeIds, mesh.components, mesh.connections);
          if (newPath.length >= 2) {
            // For queued dots: pin progress to the queue's waypoint on the new path
            if (dot.status === 'queued' && dot.queuedAtNodeId) {
              const queueNodeIdx = dot.originalNodeIds.indexOf(dot.queuedAtNodeId);
              if (queueNodeIdx >= 0 && queueNodeIdx < newNodeWpIndices.length) {
                const queueWpIdx = newNodeWpIndices[queueNodeIdx];
                dot = { ...dot, path: newPath, progress: queueWpIdx / (newPath.length - 1), nodeWpIndices: newNodeWpIndices } as typeof dot;
              } else {
                dot = { ...dot, path: newPath, nodeWpIndices: newNodeWpIndices } as typeof dot;
              }
            } else {
              // Traveling dots: semantic remap preserves logical segment position
              let oldNodeWpIndices = dot.nodeWpIndices;
              // First drag frame: compute old indices by matching waypoints to components
              if (!oldNodeWpIndices && dot.originalNodeIds) {
                oldNodeWpIndices = computeNodeWpIndices(oldPath, dot.originalNodeIds, mesh.components);
              }
              let newProgress: number | null = null;
              if (oldNodeWpIndices && oldNodeWpIndices.length >= 2) {
                newProgress = remapProgressSemantic(oldNodeWpIndices, newNodeWpIndices, oldPath, newPath, dot.progress);
              }
              // Fall back to spatial projection if semantic remap fails
              if (newProgress === null) {
                const currentPos = interpolatePath(oldPath, dot.progress);
                newProgress = projectOntoPath(newPath, currentPos.x, currentPos.y);
              }
              // Recalculate speed for new waypoint count
              const newSpeed = dot.speed * Math.max(oldPath.length - 1, 1) / Math.max(newPath.length - 1, 1);
              dot = { ...dot, path: newPath, progress: newProgress, speed: newSpeed, nodeWpIndices: newNodeWpIndices } as typeof dot;
            }
          }
          // Also rebuild forkPaths so fork dots don't follow stale waypoints
          if (dot.forkPaths) {
            const updatedForks = dot.forkPaths.map(fork => {
              if (fork.nodeIds.includes(input.draggingNodeId!)) {
                const { path: newForkPath } = rebuildPathFromNodeIds(fork.nodeIds, mesh.components, mesh.connections);
                return { ...fork, waypoints: newForkPath };
              }
              return fork;
            });
            dot = { ...dot, forkPaths: updatedForks } as typeof dot;
          }
        }

        if (dot.status === 'traveling') {
          const dropColor = dot.isRetry ? '#4a5568' : '#ff4444';
          // Everything a frame needs to know about the route — where nodes, slow/fast zones and
          // touch boxes sit as progress fractions — comes from the cached route profile. A dot's
          // frame is then an add and a few compares; pixel positions are only computed when a
          // rule actually fires (drop positions), not for every dot every frame.
          const pathInfo = getPathInfo(dot.path);
          const pathComps = pathInfo.comps;
          const p = dot.progress;
          const pClamped = p < 0 ? 0 : p; // interpolatePath holds negative progress at the path start

          // Drop dots whose path no longer matches the connection graph (connection was removed)
          // Check each consecutive component pair ahead of the dot has a connection
          // Skip validation while a node is being dragged — dragging moves positions
          // but doesn't disconnect cables, so the position-based matching would give false positives
          // Validate path against the connection graph.
          // When originalNodeIds is set, use it as the authoritative route instead of
          // the geometric pathComps, which can include spurious nodes that happen to
          // sit on the path geometry.
          let pathInvalid = false;
          if (dot.originalNodeIds) {
            // Validate using authoritative node IDs — no geometric ambiguity. The verdict only
            // depends on the route and the current graph, so it is cached on the node-id array
            // (shared by every dot of a fire) until components or connections change.
            if (!input.draggingNodeId) {
              if (pathInfo.rvIds === dot.originalNodeIds && pathInfo.rvConnections === mesh.connections) {
                pathInvalid = pathInfo.rvInvalid === true;
              } else {
              let rv = routeValidityCache.get(dot.originalNodeIds);
              if (!rv || rv.componentsRef !== mesh.components || rv.connectionsRef !== mesh.connections) {
                const validationNodes = dot.originalNodeIds.map(id => componentById.get(id)).filter(Boolean) as GameComponent[];
                let invalid = false;
                for (let ni = 0; ni < validationNodes.length - 1; ni++) {
                  const a = validationNodes[ni];
                  const b = validationNodes[ni + 1];
                  const bothBrokers = a.type === 'broker' && b.type === 'broker';
                  const connExists = connectionKeys.has(`${a.id}->${b.id}`) ||
                    (bothBrokers && connectionKeys.has(`${b.id}->${a.id}`));
                  if (!connExists) {
                    invalid = true;
                    break;
                  }
                }
                rv = { componentsRef: mesh.components, connectionsRef: mesh.connections, invalid };
                routeValidityCache.set(dot.originalNodeIds, rv);
              }
              pathInfo.rvIds = dot.originalNodeIds;
              pathInfo.rvConnections = mesh.connections;
              pathInfo.rvInvalid = rv.invalid;
              pathInvalid = rv.invalid;
              }
            }
          } else {
            for (let pc = 0; pc < pathComps.length - 1 && !input.draggingNodeId; pc++) {
              // Only validate segments the dot hasn't passed yet
              if (pathComps[pc + 1].idx / (dot.path.length - 1) < dot.progress - 0.01) continue;
              const a = pathComps[pc].comp;
              const b = pathComps[pc + 1].comp;
              const bothBrokers = a.type === 'broker' && b.type === 'broker';
              const connExists = connectionKeys.has(`${a.id}->${b.id}`) ||
                (bothBrokers && connectionKeys.has(`${b.id}->${a.id}`));
              if (!connExists) {
                pathInvalid = true;
                break;
              }
            }
          }
          if (pathInvalid) {
            droppedCount++;
            const failComp = pathComps[0]?.comp;
            if (failComp) recordDrop(failComp.id, 'path-invalid', failComp.label);
            const eventPos = interpolatePath(dot.path, p);
            pushDropped({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
            continue;
          }

          // Speed: segment scale (constant pixel speed), x0.4 inside the webhook's touch box, x2.5
          // inside a DMR Cluster (it renders much larger and hides dots behind an opaque
          // background — speed through so it still feels instantaneous). All read off the route
          // profile at the dot's current progress, as the pixel tests did at its current position.
          const segScale = pathInfo.segScale;
          const segCount = segScale.length;
          let actualSpeed = dot.speed * mesh.upgrades.propagationSpeed;
          if (segCount > 0) actualSpeed *= segScale[Math.min(Math.floor(pClamped * segCount), segCount - 1)];
          if (pathInfo.slowZones.length > 0 && inZones(pathInfo.slowZones, pClamped)) actualSpeed *= 0.4;
          if (pathInfo.fastZones.length > 0 && inZones(pathInfo.fastZones, pClamped)) actualSpeed *= 2.5;

          // Only block dots approaching from the left, just before the webhook's left edge
          if (webhookComponent && pathInfo.approachZones.length > 0 && inZones(pathInfo.approachZones, pClamped) &&
              isComponentOccupied(webhookComponent.id, dot, i)) {
            const eventPos = interpolatePath(dot.path, p);
            droppedCount++;
            recordDrop(webhookComponent.id, 'webhook-occupied', webhookComponent.label);
            pushDropped({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
            continue;
          }

          const newProgress = Math.min(p + actualSpeed * dt, 1);

          // Broker throughput cap: every broker the dot passes through gates against its OWN
          // cap (not just the first) — a bridge hop is a real relay, not a free pass, so
          // chaining brokers no longer lets a route dodge capacity limits. The DMR Cluster
          // upgrade is the intended way to raise a given broker's own ceiling instead.
          let brokerCapped = false;
          const now = frameNow;
          for (const mk of pathInfo.marks) {
            if (mk.comp.type !== 'broker') continue;
            if (p < mk.centerP && newProgress >= mk.centerP) {
              const cap = getBrokerCap(mk.comp, getPermanentBrokerThroughputMult(mesh));
              if (!tryBrokerRelay(brokerRelayTimestamps, mk.comp.id, cap, now)) {
                droppedCount++;
                recordDrop(mk.comp.id, 'broker-capped', mk.comp.label);
                pushDropped({ ...dot, status: 'dropped', dropX: mk.comp.x, dropY: mk.comp.y, dropVY: 0, color: dropColor } as Dot);
                brokerCapped = true;
                break;
              }
            }
          }
          if (brokerCapped) continue;

          // Fork spawning: when dot with forkPaths passes its fork broker, spawn fork dots
          if (dot.forkPaths && dot.forkNodeId) {
            const forkComp = componentById.get(dot.forkNodeId);
            // Fires once the dot's progress reaches the point where it enters the broker's touch
            // box (the profile's touchStart): the same frame the old per-frame pixel test fired,
            // but a long frame can't skip it — inside a DMR Cluster the dot moves at 2.5x and
            // used to jump clean over the box, so the forks never spawned and all but one of the
            // fan-out events silently vanished (~30% of throughput at ~20 fps).
            const forkMark = pathInfo.markById.get(dot.forkNodeId);
            if (forkComp && forkMark && newProgress >= forkMark.touchStart) {
              for (const fork of dot.forkPaths) {
                const forkDotId = nextDotId();
                // Path and route from the broker onward, shared by every dot spawned from this
                // fork (see forkSpawnFor) so they also share one cached route profile.
                const { waypoints: forkWaypoints, nodeIds: forkStartNodeIds, nextNodeId: forkNextNodeId } = forkSpawnFor(fork, forkComp);
                if (forkWaypoints.length >= 2) {
                  // Fork dots spawn at the publisher's first broker (ingestion point),
                  // so they count against that broker's throughput cap
                  const forkCap = getBrokerCap(forkComp, getPermanentBrokerThroughputMult(mesh));
                  if (!tryBrokerRelay(brokerRelayTimestamps, forkComp.id, forkCap, now)) {
                    droppedCount++;
                    recordDrop(forkComp.id, 'broker-capped', forkComp.label);
                    pushDropped({
                      id: forkDotId,
                      path: forkWaypoints,
                      progress: 0,
                      speed: 0,
                      status: 'dropped' as const,
                      dropX: forkComp.x,
                      dropY: forkComp.y,
                      dropVY: 0,
                      color: dropColor,
                      opacity: 1,
                      value: fork.value ?? dot.value,
                      originalValue: fork.value ?? dot.originalValue,
                      originalNodeIds: forkStartNodeIds,
                    });
                  } else {
                    updated.push({
                      id: forkDotId,
                      path: forkWaypoints,
                      progress: 0,
                      speed: normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed, forkWaypoints),
                      status: 'traveling' as const,
                      color: fork.color ?? dot.color,
                      opacity: 1,
                      value: fork.value ?? dot.value,
                      originalValue: fork.value ?? dot.originalValue,
                      originalNodeIds: forkStartNodeIds,
                      nextNodeId: forkNextNodeId,
                    });
                  }
                }
              }
              // Clear fork data from this dot
              dot = { ...dot, forkPaths: undefined, forkNodeId: undefined };
            }
          }

          // Bridge color switch: once the dot's progress passes the broker it exits before
          // crossing a bridge, flip it gold in place (it stays cyan for the publisher→broker
          // leg). Progress-based, not pixel-touch — normalizedSpeed scales per-frame pixel
          // displacement up for longer paths (so total travel time stays consistent), and a
          // long path between far-apart DMR clusters can jump clean over a pixel-proximity
          // check in a single frame. A progress-fraction crossing can't be skipped that way.
          if (dot.bridgeGoldAfterNodeId) {
            const exitPc = pathComps.find(pc => pc.comp.id === dot.bridgeGoldAfterNodeId);
            const exitProgress = exitPc ? exitPc.idx / (dot.path.length - 1) : null;
            if (exitProgress === null || newProgress >= exitProgress) {
              dot = { ...dot, color: BRIDGE_GOLD_COLOR, bridgeGoldAfterNodeId: undefined };
            }
          }

          // Find the next component the dot should interact with (queue or subscriber).
          // If the dot has a nextNodeId tag, only that specific component can capture it.
          // This prevents dots from being intercepted by unrelated nodes that happen to
          // sit on the geometric path (e.g. a queue placed on top of a DMQ→broker line).
          let nextInteractable: NodeMark | undefined;
          if (dot.nextNodeId) {
            if (pathInfo.nextId !== dot.nextNodeId) {
              pathInfo.nextId = dot.nextNodeId;
              pathInfo.nextMark = pathInfo.markById.get(dot.nextNodeId);
            }
            nextInteractable = pathInfo.nextMark;
          } else {
            nextInteractable = pathInfo.marks.find(mk => mk.centerP > p - 0.01 && (mk.comp.type === 'queue' || mk.comp.type === 'subscriber'));
          }

          // Check collision with queues — only the next queue on the path
          let queued = false;
          if (nextInteractable && nextInteractable.comp.type === 'queue') {
            const queue = nextInteractable.comp;
            // With nextNodeId: progress-based, just before the queue's waypoint (avoids premature
            // capture when the queue is physically on an earlier path segment). Without: the
            // progress at which the dot enters the queue's touch box — a late frame now captures
            // instead of skipping the box. Both sit at or before the waypoint, which is what the
            // old drag-time "reached by progress" fallback checked for.
            const touchesQueue = dot.nextNodeId
              ? newProgress >= nextInteractable.centerP - 0.01
              : newProgress >= nextInteractable.touchStart;
            if (touchesQueue) {
              const bufferSize = 3 + (queue.upgrades['bufferSize'] ?? 0) + getPermanentQueueBufferBonus(mesh);
              // Gate on last frame's backlog, not on dots that arrived earlier this same frame
              // (see queueBacklogCounts above for why).
              const queuedCount = queueBacklogCounts.get(queue.id) ?? 0;

              if (queuedCount < bufferSize) {
                // A queue always sits downstream of any bridge hop (bridges are broker-to-
                // broker only), so reaching one means the bridge-exit broker was already
                // passed. If bridgeGoldAfterNodeId is still set, the per-frame touch-box
                // check for that broker was skipped — at high speed a dot's progress can
                // jump past a narrow touch window in a single frame. Resolve it here instead
                // of carrying it forward: the dot's eventual release path is a short direct
                // queue→subscriber hop that never revisits the bridge-exit broker's position,
                // so a missed trigger could otherwise never fire and the dot stays cyan forever.
                const resolvedDot = dot.bridgeGoldAfterNodeId
                  ? { ...dot, color: BRIDGE_GOLD_COLOR, bridgeGoldAfterNodeId: undefined }
                  : dot;
                updated.push({ ...resolvedDot, status: 'queued', pauseStartTime: nowMs, queuedAtNodeId: queue.id, progress: newProgress } as Dot);
              } else {
                droppedCount++;
                recordDrop(queue.id, 'queue-full', queue.label);
                const newPos = interpolatePath(dot.path, newProgress);
                pushDropped({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: dropColor } as Dot);
              }
              queued = true;
            }
          }
          if (queued) continue;

          // Check collision with subscriber — only if subscriber is the next interactable node
          if (nextInteractable && nextInteractable.comp.type === 'subscriber') {
            const subscriber = nextInteractable.comp;

            const touchesSub = dot.nextNodeId
              ? newProgress >= nextInteractable.centerP - 0.01
              : newProgress >= nextInteractable.touchStart;
            if (touchesSub) {
              // A subscriber is occupied only if a dot consuming there still has time remaining.
              // Only the dots pausing at this same subscriber can matter, so check that bucket
              // instead of scanning every live dot per arrival.
              const occConsumeDuration = consumeDurationFor(pathInfo.endSubscriber);
              let isSubscriberOccupied = false;
              // A 0 ms consume (fasterConsumption maxed) never occupies: `elapsed < 0 - 50` is false for
              // every dot in the bucket, and that bucket is the only place thousands of pausing dots
              // can pile up (at any longer duration the occupancy rule itself keeps it to a few), so
              // scanning it per arrival was the dominant cost of a saturated fan-out mesh.
              const bucket = occConsumeDuration > 0 ? pausingBySub.get(pausingBucketKey(dot)) : undefined;
              if (bucket) {
                for (const d of bucket) {
                  if (d.id === dot.id || d.status !== 'pausing' || d.moneyAdded || d.path.length === 0) continue;
                  const elapsed = nowMs - (d.pauseStartTime ?? nowMs);
                  // Allow arrival within 50ms of consumption finishing to account for frame timing
                  if (elapsed < occConsumeDuration - 50) { isSubscriberOccupied = true; break; }
                }
              }
              if (!isSubscriberOccupied) {
                const pausingDot = { ...dot, status: 'pausing', pauseStartTime: nowMs, progress: newProgress } as Dot;
                updated.push(pausingDot);
                addPausing(pausingDot);
                if (pathInfo.endSubscriber) {
                  subscriberConsume.set(pathInfo.endSubscriber.id, { start: pausingDot.pauseStartTime!, duration: occConsumeDuration });
                }
              } else {
                droppedCount++;
                recordDrop(subscriber.id, 'subscriber-occupied', subscriber.label);
                const newPos = interpolatePath(dot.path, newProgress);
                pushDropped({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: dropColor } as Dot);
              }
              continue;
            }
          }

          if (newProgress >= 1) {
            const endPos = dot.path[dot.path.length - 1];
            droppedCount++;
            const lastComp = pathComps[pathComps.length - 1]?.comp;
            if (lastComp) recordDrop(lastComp.id, 'path-incomplete', lastComp.label);
            pushDropped({ ...dot, status: 'dropped', dropX: endPos.x, dropY: endPos.y, dropVY: 0, color: dropColor } as Dot);
            continue;
          }

          // Nothing happened this frame: advance in place. Dot objects are owned by the loop
          // (the array is committed without immer and nothing else keeps references across
          // frames), so there is no reason to allocate a copy per dot per frame.
          dot.progress = newProgress;
          updated.push(dot);
          // Webhook card border fill: how far across the card (0..1) the furthest dot inside
          // its box is. The webhook card used to scan every committed dot for this; the slow
          // zone is exactly the touch box it tested, so only dots inside it pay for a pixel
          // position.
          if (webhookComponent && pathInfo.slowZones.length > 0 && inZones(pathInfo.slowZones, newProgress < 0 ? 0 : newProgress)) {
            const pos = interpolatePath(dot.path, newProgress);
            const left = webhookComponent.x - NODE_HALF_W;
            const t = Math.max(0, Math.min(1, (pos.x - left) / (2 * NODE_HALF_W)));
            if (t > webhookBest) webhookBest = t;
          }
        } else if (dot.status === 'pausing') {
          const elapsed = nowMs - (dot.pauseStartTime ?? nowMs);
          const subscriber = getPathInfo(dot.path).endSubscriber;
          const consumeDuration = consumeDurationFor(subscriber);
          if (elapsed >= consumeDuration && !dot.moneyAdded) {
            const consumptionValueLevel = subscriber?.upgrades['consumptionValue'] ?? 0;
            const subscriberMult = 1.0 + consumptionValueLevel * 0.08 + consumptionValueLevel * consumptionValueLevel * 0.02;

            const finalValue = dot.value * subscriberMult;
            toConsume.push({ id: dot.id, value: finalValue, subscriberId: subscriber?.id ?? '' });
            // Don't add to updated — dot is finished
          } else {
            updated.push(dot);
          }
        } else if (dot.status === 'dropped') {
          // Fall in px/ms units, integrated over dt, so the distance fallen during the fade is the
          // same at any tick rate (the old per-tick form, vy += 0.3·dt/16; y += vy, fell ∝ 1/dt).
          // Identical to it at 60 Hz: 0.001125·16.67 = 0.01875 px/ms per tick = 0.3125 px/tick.
          const newVY = (dot.dropVY ?? 0) + 0.001125 * dt;
          const newDropY = (dot.dropY ?? 0) + newVY * dt;
          const newOpacity = dot.opacity - dt / 2500;

          // DMQ catch: check if dropping dot lands on the DMQ
          if (!dot.isRetry) {
            const dmq = dmqCompForCount;
            if (dmq) {
              const dmqWidthLevel = dmq.upgrades['dmqWidth'] ?? 0;
              const dmqHalfW = (120 + dmqWidthLevel * 40) / 2;
              const dmqTop = dmq.y - NODE_TOP_OFFSET;
              const dropX = dot.dropX ?? 0;

              if (dropX >= dmq.x - dmqHalfW && dropX <= dmq.x + dmqHalfW && newDropY >= dmqTop) {
                // Check DMQ buffer capacity
                const dmqBufferSize = 3 + (dmq.upgrades['dmqBufferSize'] ?? 0);

                if (dmqQueuedCount < dmqBufferSize) {
                  dmqQueuedCount++;
                  updated.push({
                    ...dot,
                    status: 'queued',
                    pauseStartTime: nowMs,
                    queuedAtNodeId: dmq.id,
                    dropX: undefined,
                    dropY: undefined,
                    dropVY: undefined,
                    opacity: 1,
                    originalValue: dot.originalValue ?? dot.value,
                  } as Dot);
                  continue;
                }
              }
            }
          }

          if (newOpacity > 0) {
            dot.dropVY = newVY;
            dot.dropY = newDropY;
            dot.opacity = newOpacity;
            updated.push(dot);
          }
        } else {
          updated.push(dot);
        }
      }

      sectionEnd('pass1');
      // Helper: calculate the progress at which a dot enters a subscriber's collision box
      const getArrivalProgress = (path: { x: number; y: number }[]) => {
        if (path.length < 2) return 1;
        const last = path[path.length - 1];
        const prev = path[path.length - 2];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        const lastSegLen = Math.hypot(dx, dy);
        if (lastSegLen === 0) return 1;
        const catchDist = Math.abs(dx) >= Math.abs(dy)
          ? NODE_HALF_W + DOT_RADIUS
          : NODE_TOP_OFFSET + DOT_RADIUS;
        const totalSegments = path.length - 1;
        return Math.max(0, 1 - catchDist / (lastSegLen * totalSegments));
      };

      // --- Pass 2: auto-release queued dots. Each queue is processed as its own strict
      // FIFO chain, sorted oldest-first, releasing down the list until the chained timing
      // in shouldReleaseTo says the subscriber can't take another (or the queue is empty).
      // There is deliberately no fixed per-frame release count: a maxed pipeline delivers
      // several hundred events/sec, so any constant cap (even 8/frame) falls below the
      // arrival rate at sub-60fps and the buffer overflows. The loop is already bounded by
      // the buffer size, and the FIFO `break` on the first non-releasable dot is the real
      // throttle — one that scales with the subscriber's actual consumption speed.
      // Precomputed once per frame for the in-flight check inside shouldReleaseTo, which
      // otherwise rescanned every component per path waypoint per live dot per candidate.
      const subscriberIds = new Set(subscribers.map(c => c.id));
      const queuePositions = mesh.components.filter(c => c.type === 'queue').map(c => ({ x: c.x, y: c.y }));

      // What every subscriber has coming, built once from the post-Pass-1 dots: the longest
      // remaining consume among dots pausing there, and the predicted arrival time of every
      // traveling dot heading there next. shouldReleaseTo used to rescan all live dots per
      // candidate per queue to derive exactly this. Releases made below add their own dot's
      // arrival to the index, which is what the old rescan would have picked up.
      // Subscribers with a 0 ms consume (fasterConsumption maxed) are left out entirely:
      // shouldReleaseTo answers for them before it reads the index, so building their entries
      // (tens of thousands of predicted arrivals per tick on a saturated fan-out mesh) bought
      // nothing. When no subscriber takes time, the whole loop is skipped.
      const subTiming = new Map<string, ArrivalIndex>();
      const timingFor = (subId: string): ArrivalIndex => {
        let t = subTiming.get(subId);
        if (!t) { t = createArrivalIndex(); subTiming.set(subId, t); }
        return t;
      };
      const predictedArrival = (d: Dot) => {
        const actual = d.speed * mesh.upgrades.propagationSpeed;
        const arrivalProg = getArrivalProgress(d.path);
        return scaledTravelTime(d.path, d.progress, Math.max(arrivalProg, d.progress), actual);
      };
      if (anyTimedSubscriber) for (const d of updated) {
        if (d.path.length === 0) continue;
        if (d.status !== 'pausing' && d.status !== 'traveling') continue;
        // Most traveling dots are still bound for a queue; settle that from nextNodeId before
        // paying for the profile lookup.
        if (d.status === 'traveling' && d.nextNodeId !== undefined && !subscriberIds.has(d.nextNodeId)) continue;
        const sub = getPathInfo(d.path).endSubscriber;
        if (!sub) continue;
        if ((consumeDurationBySub.get(sub.id) ?? consumeDurationFor(sub)) === 0) continue;
        if (d.status === 'pausing') {
          if (d.moneyAdded) continue;
          // A pausing dot is already mid-consumption, so it finishes at `remaining`, not at
          // `arrival + consumeDuration` like an incoming dot would.
          const elapsed = nowMs - (d.pauseStartTime ?? nowMs);
          const remaining = Math.max(consumeDurationFor(sub) - elapsed, 0);
          const t = timingFor(sub.id);
          t.pausingRemaining = Math.max(t.pausingRemaining ?? 0, remaining);
        } else {
          // Only count dots actually heading to the subscriber next (past every queue).
          // nextNodeId is authoritative when set — and unlike the progress-based scan it
          // is unaffected by the negative start progress of a staggered release — with
          // the path scan kept only as a fallback for dots that carry no nextNodeId.
          const isPastAllQueues = d.nextNodeId
            ? subscriberIds.has(d.nextNodeId)
            : !d.path.some((wp, idx) => {
                if (idx >= d.path.length - 1) return false;
                if (!queuePositions.some(q => Math.abs(q.x - wp.x) < 1 && Math.abs(q.y - wp.y) < 1)) return false;
                return d.progress <= idx / (d.path.length - 1) + 0.01;
              });
          if (!isPastAllQueues) continue;
          timingFor(sub.id).arrivals.push(predictedArrival(d));
        }
      }
      // Sort each subscriber's arrivals once and precompute the busy prefix the release check
      // reads (the old check re-sorted the list per candidate per fan-out target).
      for (const [subId, idx] of subTiming) finalizeArrivalIndex(idx, consumeDurationBySub.get(subId) ?? 0);

      sectionEnd('index');
      const queuedIndicesByQueue = new Map<string, number[]>();
      for (let qi = 0; qi < updated.length; qi++) {
        const d = updated[qi];
        if (d.status === 'queued' && d.queuedAtNodeId) {
          if (!queuedIndicesByQueue.has(d.queuedAtNodeId)) queuedIndicesByQueue.set(d.queuedAtNodeId, []);
          queuedIndicesByQueue.get(d.queuedAtNodeId)!.push(qi);
        }
      }
      for (const indices of queuedIndicesByQueue.values()) {
        indices.sort((a, b) => (updated[a].pauseStartTime ?? 0) - (updated[b].pauseStartTime ?? 0));
      }

      for (const [queueId, indices] of queuedIndicesByQueue) {
        // Skip DMQ-queued dots — they're handled in Pass 3
        const queueComp = mesh.components.find(c => c.id === queueId);
        if (queueComp?.type === 'dmq') continue;

        // Skip releases on the post-drag cleanup frame (paths just rebuilt after Y-snap)
        if (postDragCleanupQueues.has(queueId)) continue;

        const queue = mesh.components.find(c => c.id === queueId);
        const hasFanOut = queueComp && (queueComp.upgrades['fanOut'] ?? 0) > 0;

        // Collect all connected subscribers (needed for busy check and release) — queue-level,
        // same for every dot in this queue, so computed once per queue rather than per dot.
        const allConnectedSubs: { x: number; y: number; comp: GameComponent }[] = [];
        if (queue) {
          const outConns = mesh.connections.filter(c => c.fromId === queueId);
          for (const conn of outConns) {
            const target = mesh.components.find(c => c.id === conn.toId && c.type === 'subscriber');
            if (target) allConnectedSubs.push({ x: target.x, y: target.y, comp: target });
          }
        }

        // Releases made from this queue so far this frame — used to stagger their start
        // progress so same-frame releases don't render stacked on top of each other.
        let releaseSeq = 0;

        // Release path to a subscriber. Depends on the candidate only when the queue component is
        // gone (then the dot keeps its own path).
        const buildReleasePath = (subTarget: { x: number; y: number; comp: GameComponent }, dot: Dot): ReleasePath => {
          if (!queue) return { componentsRef: mesh.components, path: dot.path, progress: dot.progress, nodeIds: [queueId, subTarget.comp.id] };
          // Pure function of the queue's and subscriber's positions: build once per pair and
          // let every released dot share the array (and therefore one cached route profile).
          const cacheKey = queue.id + '->' + subTarget.comp.id;
          const cached = releasePathCache.get(cacheKey);
          if (cached && cached.componentsRef === mesh.components) return cached;
          const queuePoint = { x: queue.x, y: queue.y };
          const extension: { x: number; y: number }[] = [];
          if (Math.abs(queue.y - subTarget.y) >= 5) {
            const qHalfW = 70;
            const sHalfW = 60;
            const portStartX = queue.x + qHalfW + 24;
            const portEndX = subTarget.x - sHalfW - 2;
            const halfH = 28;
            const fromBounds = {
              left: queue.x - qHalfW,
              right: queue.x + qHalfW + 24,
              top: queue.y - halfH,
              bottom: queue.y + halfH,
            };
            const toBounds = {
              left: subTarget.x - sHalfW,
              right: subTarget.x + sHalfW,
              top: subTarget.y - halfH,
              bottom: subTarget.y + halfH,
            };
            const segWaypoints = computeOrthogonalWaypoints(portStartX, queue.y, portEndX, subTarget.y, fromBounds, toBounds);
            for (let w = 1; w < segWaypoints.length - 1; w++) {
              extension.push(segWaypoints[w]);
            }
          }
          extension.push({ x: subTarget.x, y: subTarget.y });
          const releasePath = dedupeConsecutiveWaypoints([queuePoint, ...extension]);
          const totalSegments = releasePath.length - 1;
          let releaseProgress = 0;
          if (totalSegments > 0) {
            const from = releasePath[0];
            const to = releasePath[1];
            const segLen = Math.hypot(to.x - from.x, to.y - from.y);
            const clearanceFraction = segLen > 0 ? (NODE_HALF_W + DOT_RADIUS + 2) / segLen : 1;
            releaseProgress = Math.min(clearanceFraction / totalSegments, 1);
          }
          const built: ReleasePath = { componentsRef: mesh.components, path: releasePath, progress: releaseProgress, nodeIds: [queue.id, subTarget.comp.id] };
          releasePathCache.set(cacheKey, built);
          return built;
        };

        // Predictive release: release when the dot would arrive as the subscriber finishes consuming
        // Calculate the progress at which a dot enters a subscriber's collision box
        // (dotTouchesNode triggers before progress 1.0 due to the node's bounding rectangle)
        const shouldReleaseTo = (sub: { x: number; y: number; comp: GameComponent }, releasePath: { x: number; y: number }[], startProgress: number) => {
          const baseSpeed = normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed, releasePath);
          // During movement, dot.speed is multiplied by propagationSpeed again
          const actualSpeed = baseSpeed * mesh.upgrades.propagationSpeed;
          const arrivalProg = getArrivalProgress(releasePath);
          const travelTime = scaledTravelTime(releasePath, startProgress, Math.max(arrivalProg, startProgress), actualSpeed);

          const consumeDuration = consumeDurationFor(sub.comp);
          // A subscriber with a 0 ms consume (fasterConsumption maxed) can never reject: with the
          // chain below, busyUntil after each arrival is just that arrival's time, the entries are
          // ascending, so neither the candidate nor anything after it ever lands before busyUntil.
          // Skipping the chain matters: it was rebuilt and re-sorted per candidate per fan-out target
          // over every dot bound for the subscriber, which at 20-way fan-out made ticks take seconds.
          if (consumeDuration === 0) return true;

          // Every other dot already pausing at or traveling toward this subscriber, from the
          // per-frame index (the candidate itself is queued, so it is never in there).
          // The rule: simulate the subscriber's consumption queue in arrival order with the
          // candidate inserted at its own predicted arrival. Each dot can only start consuming
          // once it has physically arrived AND the subscriber has finished with whoever was
          // ahead of it; a dot that arrives while the subscriber is still busy is a collision
          // (it drops on arrival). Reject if the candidate would collide, or if inserting it
          // would make any dot arriving AFTER it collide. Order-aware on purpose: staggered
          // same-frame releases mean a fresh release can legitimately arrive before dots
          // released a frame earlier that are still waiting behind the queue — those are
          // behind it, not ahead of it, and must not be read as "subscriber busy until then".
          // `canAcceptArrival` answers that from the sorted index in O(log n); the chain walk
          // it replaces is the reference in src/sim/__tests__/release.test.ts.
          return canAcceptArrival(timingFor(sub.comp.id), travelTime, consumeDuration);
        };

        // Everything the check and the release need per target, built once per queue per tick
        // instead of per candidate: the release path, its speed, and the progress one ms of
        // movement covers at its start (the stagger below scales that by the release number).
        // Pure in the queue and subscriber positions, like the release path cache it reads.
        type ReleaseEntry = { sub: { x: number; y: number; comp: GameComponent }; release: ReleasePath; speed: number; progressPerMs: number };
        const entryBySub = new Map<string, ReleaseEntry>();
        const entryFor = (sub: { x: number; y: number; comp: GameComponent }, dot: Dot): ReleaseEntry => {
          const hit = queue ? entryBySub.get(sub.comp.id) : undefined;
          if (hit) return hit;
          const release = buildReleasePath(sub, dot);
          const entry: ReleaseEntry = {
            sub,
            release,
            speed: normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed, release.path),
            progressPerMs: normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed, release.path)
              * mesh.upgrades.propagationSpeed * getSegmentSpeedScale(release.path, 0),
          };
          if (queue) entryBySub.set(sub.comp.id, entry);
          return entry;
        };
        // With fan-out every candidate of the queue targets the same connected subscribers.
        let fanOutData: ReleaseEntry[] | undefined;

        for (const i of indices) {
        const dot = updated[i];
        if (dot.status !== 'queued') continue;

        // Fallback to baked path subscriber (per-dot, only when no live connection exists)
        let subsForThisDot = allConnectedSubs;
        if (subsForThisDot.length === 0) {
          const endPoint = dot.path[dot.path.length - 1];
          const bakedSubscriber = mesh.components.find(c =>
            c.type === 'subscriber' && Math.hypot(c.x - endPoint.x, c.y - endPoint.y) < 50
          );
          subsForThisDot = bakedSubscriber ? [{ x: bakedSubscriber.x, y: bakedSubscriber.y, comp: bakedSubscriber }] : [];
        }

        const hasSubscriber = subsForThisDot.length > 0;
        if (!hasSubscriber) break; // FIFO — oldest remaining can't go, don't skip ahead

        // Without fan-out, determine round-robin target
        let targets: { x: number; y: number; comp: GameComponent }[];
        if (hasFanOut) {
          targets = subsForThisDot;
        } else {
          const rrIdx = (queueRoundRobinIdx.get(queueId) ?? 0) % subsForThisDot.length;
          queueRoundRobinIdx.set(queueId, rrIdx + 1);
          targets = [subsForThisDot[rrIdx]];
        }

        // Release paths and timing constants for each target
        const releaseData = hasFanOut && queue && targets === allConnectedSubs
          ? (fanOutData ??= targets.map(sub => entryFor(sub, dot)))
          : targets.map(sub => entryFor(sub, dot));

        // Same-frame releases are spread across the frame's own travel distance (the k-th of
        // N starts k/N of one frame's movement behind, as negative progress that clamps to
        // the queue's center, hidden under its card) so they emerge as a stream instead of
        // all rendering on the same pixel. The spread is deliberately bounded by ONE frame:
        // a fixed per-release offset made a dot's lifetime proportional to how many released
        // that frame — at low fps that was ~90 releases/frame, dots hidden for over a second,
        // and a feedback loop (more live dots → slower frames → more releases per frame →
        // longer lives). The timing check must evaluate the same staggered start the dot gets.
        const releaseStaggerFor = (entry: ReleaseEntry) => (releaseSeq / Math.max(1, indices.length)) * dt * entry.progressPerMs;

        // With fanout: all subscribers must be ready; without: just the target
        let canRelease = releaseData.every(rd => shouldReleaseTo(rd.sub, rd.release.path, rd.release.progress - releaseStaggerFor(rd)));

        // During drag, shouldReleaseTo timing is unreliable (in-flight dots' paths/speeds
        // are rebuilt each frame). Enforce a minimum interval based on consume duration
        // to prevent rapid queue draining.
        if (canRelease && input.draggingNodeId) {
          const lastRelease = queueLastReleaseTime.get(queueId) ?? 0;
          const subComp = subsForThisDot.length > 0
            ? mesh.components.find(c => c.type === 'subscriber' && Math.hypot(c.x - subsForThisDot[0].x, c.y - subsForThisDot[0].y) < 50)
            : null;
          const fcLevel = subComp?.upgrades['fasterConsumption'] ?? 0;
          const boostPct = Math.min(fcLevel * (fcLevel + 9) / 2, 100);
          const minInterval = 1000 * (1 - boostPct / 100); // consume duration
          if (nowMs - lastRelease < minInterval) {
            canRelease = false;
          }
        }

        if (!canRelease) break; // FIFO — oldest remaining can't go yet, don't skip ahead

        queueLastReleaseTime.set(queueId, nowMs);
        releaseSeq++;

        for (let ti = 0; ti < releaseData.length; ti++) {
          const entry = releaseData[ti];
          const { release: { path: releasePath, progress: releaseProgress, nodeIds: releaseNodeIds }, sub: releaseSub, speed: releaseSpeed } = entry;
          // The target carries its subscriber component, so originalNodeIds stays in sync with the release path
          const releaseSubComp: GameComponent | undefined = releaseSub.comp;
          // One object per released dot (the path is overridden in the same spread; a separate
          // intermediate copy per target was a second allocation of every field).
          let released: Dot;
          if (ti === 0) {
            released = { ...dot, path: releasePath, status: 'traveling', progress: releaseProgress - releaseStaggerFor(entry), speed: releaseSpeed, pauseStartTime: undefined, queuedAtNodeId: undefined, originalNodeIds: releaseNodeIds, nextNodeId: releaseSubComp?.id, nodeWpIndices: undefined } as Dot;
            updated[i] = released;
          } else {
            released = {
              ...dot,
              path: releasePath,
              id: nextDotId(),
              status: 'traveling',
              progress: releaseProgress - releaseStaggerFor(entry),
              speed: releaseSpeed,
              pauseStartTime: undefined,
              queuedAtNodeId: undefined,
              originalNodeIds: releaseNodeIds,
              nextNodeId: releaseSubComp?.id,
              nodeWpIndices: undefined,
            } as Dot;
            updated.push(released);
          }
          // Later candidates (this queue or another) must see this dot on its way, exactly as
          // the old rescan of `updated` did. It carries nextNodeId, so it is "past all queues".
          // Not for a 0 ms subscriber: its check never reads the index (see the index build).
          if (releaseSubComp) {
            const releaseConsume = consumeDurationBySub.get(releaseSubComp.id) ?? consumeDurationFor(releaseSubComp);
            if (releaseConsume > 0) insertArrival(timingFor(releaseSubComp.id), predictedArrival(released), releaseConsume);
          }
        }
        }
      }

      sectionEnd('pass2');
      // --- Pass 3: auto-release ONE queued dot from DMQ if broker connection exists ---
      const dmqComp = mesh.components.find(c => c.type === 'dmq');
      if (dmqComp) {
        const dmqConn = mesh.connections.find(c => c.fromId === dmqComp.id);
        const brokerTarget = dmqConn
          ? mesh.components.find(c => c.id === dmqConn.toId && c.type === 'broker')
          : null;

        if (brokerTarget) {
            // Find the first queued dot in DMQ and use predictive timing to decide release
            for (let i = 0; i < updated.length; i++) {
              const dot = updated[i];
              if (dot.status !== 'queued' || dot.queuedAtNodeId !== dmqComp.id) continue;

              // Rebuild path using current component positions from originalNodeIds
              const origValue = dot.originalValue ?? dot.value;
              const dmqValueRecoveryLevel = dmqComp.upgrades['dmqValueRecovery'] ?? 0;
              const recoveryPct = Math.min(1.0, 0.1 + dmqValueRecoveryLevel * 0.1);
              const retryValue = origValue * recoveryPct;

              // Get node IDs from broker onward using the original route
              const origNodeIds = dot.originalNodeIds ?? [];
              const brokerIdx = origNodeIds.indexOf(brokerTarget.id);
              let nodeIdsFromBroker: string[];
              if (brokerIdx >= 0) {
                // DMQ is connected to the same broker as the original route
                nodeIdsFromBroker = origNodeIds.slice(brokerIdx);
              } else {
                // DMQ is connected to a different broker — find a path through bridges
                // to the original destination (last queue/subscriber in the original route)
                const origDest = [...origNodeIds].reverse().find(nid => {
                  const c = mesh.components.find(comp => comp.id === nid);
                  return c?.type === 'queue' || c?.type === 'subscriber';
                });
                let foundPath: string[] | null = null;
                if (origDest) {
                  const walkForDest = (nodeId: string, path: string[], visited: Set<string>): void => {
                    if (foundPath) return;
                    if (visited.has(nodeId)) return;
                    visited.add(nodeId);
                    const node = mesh.components.find(c => c.id === nodeId);
                    if (!node) return;
                    const curPath = [...path, nodeId];
                    if (nodeId === origDest) { foundPath = curPath; return; }
                    // Follow outgoing connections + reverse bridges (bidirectional)
                    const nextConns = mesh.connections.filter(c => c.fromId === nodeId);
                    const reverseBridgeConns = node.type === 'broker'
                      ? mesh.connections.filter(c => c.toId === nodeId &&
                        mesh.components.find(comp => comp.id === c.fromId)?.type === 'broker')
                      : [];
                    const allNext = [
                      ...nextConns.map(c => c.toId),
                      ...reverseBridgeConns.map(c => c.fromId),
                    ];
                    for (const nextId of allNext) {
                      walkForDest(nextId, curPath, new Set(visited));
                    }
                  };
                  walkForDest(brokerTarget.id, [], new Set());
                }
                nodeIdsFromBroker = foundPath ?? [brokerTarget.id];
              }

              // Build fresh waypoints from current positions: broker → ... → subscriber
              const routeNodes: { x: number; y: number; type: string; id: string; upgrades: Record<string, number> }[] = [];
              for (const nid of nodeIdsFromBroker) {
                const comp = mesh.components.find(c => c.id === nid);
                if (comp) routeNodes.push({ x: comp.x, y: comp.y, type: comp.type, id: comp.id, upgrades: comp.upgrades });
              }

              // Expand to orthogonal waypoints
              const pathFromBroker: { x: number; y: number }[] = routeNodes.length > 0 ? [{ x: routeNodes[0].x, y: routeNodes[0].y }] : [];
              for (let ni = 0; ni < routeNodes.length - 1; ni++) {
                const a = routeNodes[ni];
                const b = routeNodes[ni + 1];
                if (Math.abs(a.y - b.y) >= 5) {
                  const isReverseBridge = a.type === 'broker' && b.type === 'broker' &&
                    !mesh.connections.some(c => c.fromId === a.id && c.toId === b.id) &&
                    mesh.connections.some(c => c.fromId === b.id && c.toId === a.id);
                  const src = isReverseBridge ? b : a;
                  const dst = isReverseBridge ? a : b;
                  const { halfW: srcHalfW, halfH: srcHalfH } = getNodeHalfExtents(src);
                  const { halfW: dstHalfW, halfH: dstHalfH } = getNodeHalfExtents(dst);
                  const portStartX = src.x + srcHalfW + 24;
                  const portEndX = dst.x - dstHalfW - 2;
                  const fromBounds = {
                    left: src.x - srcHalfW,
                    right: src.x + srcHalfW + 24,
                    top: src.y - srcHalfH,
                    bottom: src.y + srcHalfH,
                  };
                  const toBounds = {
                    left: dst.x - dstHalfW,
                    right: dst.x + dstHalfW,
                    top: dst.y - dstHalfH,
                    bottom: dst.y + dstHalfH,
                  };
                  const segWaypoints = computeOrthogonalWaypoints(portStartX, src.y, portEndX, dst.y, fromBounds, toBounds);
                  const intermediates = segWaypoints.slice(1, -1);
                  if (isReverseBridge) intermediates.reverse();
                  for (const wp of intermediates) {
                    pathFromBroker.push(wp);
                  }
                }
                pathFromBroker.push({ x: b.x, y: b.y });
              }

              // Build DMQ → broker path (vertical first, node-aware)
              const dmqExtents = getNodeHalfExtents(dmqComp);
              const brokerExtents = getNodeHalfExtents(brokerTarget);
              const dmqStartX = dmqComp.x;
              const dmqStartY = dmqComp.y - dmqExtents.halfH - 16; // top-center port
              const brokerEndX = brokerTarget.x;
              const brokerEndY = brokerTarget.y + brokerExtents.halfH + 2; // bottom edge
              const dmqFromBounds = { left: dmqComp.x - dmqExtents.halfW, right: dmqComp.x + dmqExtents.halfW, top: dmqComp.y - dmqExtents.halfH, bottom: dmqComp.y + dmqExtents.halfH };
              const dmqToBounds = { left: brokerTarget.x - brokerExtents.halfW, right: brokerTarget.x + brokerExtents.halfW, top: brokerTarget.y - brokerExtents.halfH, bottom: brokerTarget.y + brokerExtents.halfH };
              const dmqToBroker = computeVerticalFirstWaypoints(dmqStartX, dmqStartY, brokerEndX, brokerEndY, dmqFromBounds, dmqToBounds);
              // Combine: DMQ → broker → original route from broker
              const fullPath = [...dmqToBroker, ...pathFromBroker];

              // --- Predictive timing: find the first queue or subscriber on the retry path ---
              let targetComp: { x: number; y: number; type: string; id: string } | null = null;
              for (let ni = 1; ni < routeNodes.length; ni++) {
                if (routeNodes[ni].type === 'queue' || routeNodes[ni].type === 'subscriber') {
                  targetComp = routeNodes[ni];
                  break;
                }
              }

              if (!targetComp) continue;

              const speed = normalizedSpeed(0.0007 * mesh.upgrades.propagationSpeed, fullPath);

              let canRelease = false;
              if (targetComp.type === 'queue') {
                canRelease = (nowMs - this.lastDmqReleaseTime) >= 500;
              } else {
                // Subscriber — predictive timing (same logic as queue release)
                const actualSpeed = speed * mesh.upgrades.propagationSpeed;
                const dmqArrivalProg = getArrivalProgress(fullPath);
                const travelTime = scaledTravelTime(fullPath, 0, dmqArrivalProg, actualSpeed);

                const subComp = mesh.components.find(c => c.id === targetComp!.id);
                const fcLevel = subComp?.upgrades['fasterConsumption'] ?? 0;
                const boostPct = Math.min(fcLevel * (fcLevel + 9) / 2, 100);
                const consumeDuration = 1000 * (1 - boostPct / 100);

                let latestSlotOpen = 0;
                for (const d of updated) {
                  if (d.id === dot.id || d.path.length === 0) continue;
                  const dEnd = d.path[d.path.length - 1];
                  if (Math.hypot(dEnd.x - targetComp!.x, dEnd.y - targetComp!.y) >= 50) continue;

                  if (d.status === 'pausing' && !d.moneyAdded) {
                    const elapsed = nowMs - (d.pauseStartTime ?? nowMs);
                    const remaining = Math.max(consumeDuration - elapsed, 0);
                    latestSlotOpen = Math.max(latestSlotOpen, remaining);
                  }

                  if (d.status === 'traveling') {
                    const dArrProg = getArrivalProgress(d.path);
                    const arrivalTime = scaledTravelTime(d.path, d.progress, Math.max(dArrProg, d.progress), d.speed * mesh.upgrades.propagationSpeed);
                    latestSlotOpen = Math.max(latestSlotOpen, arrivalTime + consumeDuration);
                  }
                }

                canRelease = latestSlotOpen <= travelTime;
              }

              if (!canRelease) break; // Only attempt the oldest queued dot — if it can't release, wait

              this.lastDmqReleaseTime = nowMs;
              updated[i] = {
                ...dot,
                status: 'traveling',
                path: fullPath,
                progress: 0,
                speed,
                color: '#fb923c',
                opacity: 1,
                value: retryValue,
                isRetry: true,
                originalNodeIds: [dmqComp.id, ...nodeIdsFromBroker],
                nextNodeId: targetComp.id,
                originalValue: undefined,
                pauseStartTime: undefined,
                queuedAtNodeId: undefined,
                dropX: undefined,
                dropY: undefined,
                dropVY: undefined,
              } as Dot;
              break; // Only release one per interval
            }
        }
      }

      sectionEnd('pass3');
      // Queue/DMQ slot display: one char per queued dot, oldest first. Computed once here
      // for every node instead of by each card re-scanning every live dot on every commit.
      const queuedByNode = new Map<string, Dot[]>();
      for (const d of updated) {
        if (d.status === 'queued' && d.queuedAtNodeId) {
          const b = queuedByNode.get(d.queuedAtNodeId);
          if (b) b.push(d); else queuedByNode.set(d.queuedAtNodeId, [d]);
        }
      }
      const sigs: Record<string, string> = {};
      for (const [nodeId, list] of queuedByNode) {
        list.sort((a, b) => (a.pauseStartTime ?? 0) - (b.pauseStartTime ?? 0));
        let sig = '';
        for (const d of list) sig += d.isRetry ? 'r' : 'n';
        sigs[nodeId] = sig;
      }
      queueSlotSignatures = sigs;
      webhookFill = webhookComponent ? { [webhookComponent.id]: webhookBest } : {};
      sectionEnd('sigs');

      return updated;
    })(this.dots);

    // Track first drop time for tutorial (the driver shows it 1 s later)
    if (droppedCount > 0 && this.firstDropAt === null) {
      this.firstDropAt = input.nowMs;
    }

    // Auto-publisher: one poll per AUTO_PUB_POLL_MS of sim time. Runs after this frame's
    // movement so a new dot is first moved on the next frame, like it was when the setInterval
    // pushed it between frames. (dt is clamped to MAX_FRAME_DT_MS, so at most one poll is ever
    // due per frame.) The due publishers' dots are appended here (commitFrame used to append
    // them) because the sim owns the dot array.
    this.simNow += dt;
    this.autoPubAccumulator += dt;
    const due: string[] = [];
    const publishes: { count: number }[] = [];
    if (this.autoPubAccumulator >= AUTO_PUB_POLL_MS) {
      this.autoPubAccumulator -= AUTO_PUB_POLL_MS;
      // The cooldown is checked and stamped at the poll's nominal sim time, not at simNow: polls
      // are then exactly AUTO_PUB_POLL_MS apart, so a poll that lands one short tick after the
      // previous one (a merged input followed by a short frame) no longer rejects every publisher
      // whose cooldown is longer than that tick. Cooldowns over the poll interval still fire
      // every ceil(cooldown / AUTO_PUB_POLL_MS) polls.
      this.autoPubPollSimTime += AUTO_PUB_POLL_MS;
      const pollTime = this.autoPubPollSimTime;
      for (const pub of mesh.components) {
        if (pub.type !== 'publisher' || (pub.upgrades['autoPub'] ?? 0) < 1) continue;
        const last = this.autoFireLastSim.get(pub.id);
        if (last === undefined || pollTime - last >= getPublisherCooldownMs(pub, mesh)) {
          this.autoFireLastSim.set(pub.id, pollTime);
          // Publishers that can't fire (no outgoing connection, no broker on any path) are
          // skipped and keep their old cooldown, exactly as buildPublishBatch skipped them.
          const built = buildPublishDots(mesh, pub.id);
          if (!built) continue;
          due.push(pub.id);
          publishes.push({ count: built.fireCount });
          for (const d of built.dots) frameDots.push(d);
        }
      }
    }
    this.dots = frameDots;
    sectionEnd('publish');

    return this.buildSummary(toConsume, droppedCount, due, publishes, queueSlotSignatures, webhookFill, input.nowMs);
  }
}
