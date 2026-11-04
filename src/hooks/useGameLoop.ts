import { useEffect, useRef } from 'react';
import { useGameStore, nextDotId, getPermanentQueueBufferBonus, findNextInteractableId, getPermanentBrokerThroughputMult, BRIDGE_GOLD_COLOR } from '../store/gameStore';
import { interpolatePath, normalizedSpeed, getSegmentSpeedScale, scaledTravelTime } from '../utils/pathUtils';
import { computeOrthogonalWaypoints, computeVerticalFirstWaypoints } from '../utils/orthogonalPath';
import { getClusterSlotCount, getNodeHalfExtents } from '../store/upgradeConfig';

// Node card dimensions: positioned at left: x-60, top: y-28
// Card width: 120px (half = 60), card height varies but ~56px
const NODE_HALF_W = 60;
const NODE_TOP_OFFSET = 28;   // from center to top edge
const NODE_BOTTOM_OFFSET = 28; // from center to bottom edge (generous to cover content)

const DOT_RADIUS = 6;

/** Longest frame delta the simulation will step by (~10fps); larger gaps are treated as a pause. */
const MAX_FRAME_DT_MS = 100;

const BROKER_BASE_THROUGHPUT = 8; // events/sec

/** Rolling window of relay timestamps per broker for throughput cap */
const brokerRelayTimestamps = new Map<string, number[]>();

/** Round-robin index per queue for competing consumer pattern */
const queueRoundRobinIdx = new Map<string, number>();

/** Timestamp of the first event drop (for tutorial trigger) */
let firstDropTime: number | null = null;
let firstDropTutorialShown = false;

/** Throttle DMQ releases to ~1 every 500ms */
let lastDmqReleaseTime = 0;

/** Last release timestamp per queue — safety net during drag to prevent rapid draining */
const queueLastReleaseTime = new Map<string, number>();
/** Drop reason tracking for the warning "!" button */
export type DropReason = 'path-invalid' | 'webhook-occupied' | 'broker-capped' | 'queue-full' | 'subscriber-occupied' | 'path-incomplete';

const nodeDropTracker = new Map<string, { reason: DropReason; lastDropTime: number; nodeLabel: string }>();

function recordDrop(nodeId: string, reason: DropReason, nodeLabel: string) {
  nodeDropTracker.set(nodeId, { reason, lastDropTime: performance.now(), nodeLabel });
}

export function getActiveDrops(): Array<{ nodeId: string; nodeLabel: string; reason: DropReason }> {
  const now = performance.now();
  const active: Array<{ nodeId: string; nodeLabel: string; reason: DropReason }> = [];
  for (const [nodeId, entry] of nodeDropTracker) {
    if (now - entry.lastDropTime < 2000) {
      active.push({ nodeId, nodeLabel: entry.nodeLabel, reason: entry.reason });
    }
  }
  return active;
}

/** Smoothed FPS for adaptive coin pop throttling */
let _smoothedFps = 60;
const FPS_SMOOTH = 0.05; // low-pass filter weight (lower = smoother)
export function getSmoothedFps() { return _smoothedFps; }

/** Try to relay an event through a broker. Returns true if under cap, false if over. */
function tryBrokerRelay(brokerId: string, cap: number, now: number): boolean {
  let ts = brokerRelayTimestamps.get(brokerId) ?? [];
  ts = ts.filter(t => now - t < 1000);
  if (ts.length >= cap) { brokerRelayTimestamps.set(brokerId, ts); return false; }
  ts.push(now);
  brokerRelayTimestamps.set(brokerId, ts);
  return true;
}

/** Get broker throughput cap from upgrade level, plus any permanent prestige multiplier */
function getBrokerCap(brokerComp: { upgrades: Record<string, number> }, permanentMult: number): number {
  const level = brokerComp.upgrades['increaseThroughput'] ?? 0;
  const bonus = level * (level + 9) / 2;
  const slots = getClusterSlotCount(brokerComp.upgrades);
  return (BROKER_BASE_THROUGHPUT + bonus) * permanentMult * slots;
}

/** Get current utilization ratio (0-1+) for a broker */
export function getBrokerUtilization(brokerId: string, cap: number): number {
  const ts = brokerRelayTimestamps.get(brokerId) ?? [];
  const now = performance.now();
  const recent = ts.filter(t => now - t < 1000);
  return recent.length / cap;
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


export function useGameLoop() {
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    const loop = (time: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = time;
      // Clamp the frame delta. requestAnimationFrame stops while the tab is hidden but the
      // clock doesn't, so the first frame back would otherwise get a dt of the whole absence —
      // every dot slams to its destination at once and the queue releases the entire pile
      // spread across that one enormous "frame". Capping it means a return from a tab switch
      // just resumes at normal pace (and ordinary hitches can't teleport dots either).
      const dt = Math.min(time - lastTimeRef.current, MAX_FRAME_DT_MS);
      lastTimeRef.current = time;

      // Update smoothed FPS for adaptive coin pop throttling
      if (dt > 0) {
        const instantFps = 1000 / dt;
        _smoothedFps += FPS_SMOOTH * (instantFps - _smoothedFps);
      }

      const state = useGameStore.getState();
      const toConsume: { id: string; value: number; subscriberId: string }[] = [];
      let droppedCount = 0;

      state.updateDots(dots => {
        type Dot = import('../store/gameStore').EventDot;
        // Use a mutable array so each dot sees the results of earlier dots in the same frame
        const updated: Dot[] = [];
        // Track queues whose dots were rebuilt in post-drag cleanup this frame
        // (skip releases for 1 frame to let paths stabilize after Y-snap).
        const postDragCleanupQueues = new Set<string>();
        // Pre-compute DMQ queued count from source array to avoid undercounting
        // when existing queued dots appear later in iteration order
        const dmqCompForCount = state.components.find(c => c.type === 'dmq');
        let dmqQueuedCount = dmqCompForCount
          ? dots.filter(d => d.status === 'queued' && d.queuedAtNodeId === dmqCompForCount.id).length
          : 0;
        // Per-queue BACKLOG from the previous frame: dots still waiting because the subscriber
        // couldn't take them. This — not the running count including this frame's arrivals —
        // is what the buffer limit gates on. Arrivals happen (Pass 1) before releases (Pass 2)
        // within a frame, so counting same-frame arrivals meant a burst larger than the buffer
        // dropped its tail as "queue-full" even though Pass 2 drained the whole buffer a moment
        // later. A dot that arrives and leaves within one tick never really held a slot; buffer
        // depth only matters once the consumer actually falls behind.
        const queueBacklogCounts = new Map<string, number>();
        for (const d of dots) {
          if (d.status === 'queued' && d.queuedAtNodeId) {
            queueBacklogCounts.set(d.queuedAtNodeId, (queueBacklogCounts.get(d.queuedAtNodeId) ?? 0) + 1);
          }
        }
        // Per-frame component lookups. Pass 1 used to re-scan the component list for every
        // dot (webhook lookup, DMR cluster bounds, and matching each path waypoint to a node),
        // which at ~1,500 live dots was ~100k comparisons per frame.
        const webhookComponent = state.components.find(c => c.type === 'webhook');
        const clusterBounds = state.components
          .filter(c => c.type === 'broker' && getClusterSlotCount(c.upgrades) > 1)
          .map(c => ({ x: c.x, y: c.y, ...getNodeHalfExtents(c) }));
        // Node waypoints in every path builder are exact copies of a component's x/y, so an
        // exact rounded key is a faithful replacement for the old `< 1px` linear scan; the hit
        // is still verified against that tolerance below. First-wins on a key collision mirrors
        // the old `find` returning the first match.
        const posKey = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
        const componentByPos = new Map<string, typeof state.components[0]>();
        const componentById = new Map<string, typeof state.components[0]>();
        for (const c of state.components) {
          const k = posKey(c.x, c.y);
          if (!componentByPos.has(k)) componentByPos.set(k, c);
          componentById.set(c.id, c);
        }
        const connectionKeys = new Set<string>();
        for (const c of state.connections) connectionKeys.add(`${c.fromId}->${c.toId}`);

        for (let i = 0; i < dots.length; i++) {
          let dot = dots[i];

          // Helper: check if a component is occupied — sees already-processed + remaining dots
          const isComponentOccupied = (componentId: string) => {
            const comp = state.components.find(c => c.id === componentId);
            if (!comp) return false;
            const allDots = [...updated, ...dots.slice(i + 1)];
            return allDots.some(d => {
              if (d.id === dot.id) return false; // never block yourself
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
            });
          };

          // Post-drag cleanup: if dot was rebuilt during drag (has nodeWpIndices) but drag ended,
          // rebuild one final time from current positions to account for Y-snap
          if (!state.draggingNodeId && dot.nodeWpIndices && dot.originalNodeIds &&
              (dot.status === 'traveling' || dot.status === 'queued')) {
            const oldPath = dot.path;
            const oldNodeWpIndices = dot.nodeWpIndices;
            const { path: freshPath, nodeWpIndices: freshIndices } = rebuildPathFromNodeIds(dot.originalNodeIds, state.components, state.connections);
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
                const { path: newForkPath } = rebuildPathFromNodeIds(fork.nodeIds, state.components, state.connections);
                return newForkPath.length >= 2 ? { ...fork, waypoints: newForkPath } : fork;
              });
              dot = { ...dot, forkPaths: updatedForks } as typeof dot;
            }
          }

          // Rebuild path in real-time when a component on this dot's route is being dragged
          if (state.draggingNodeId && dot.originalNodeIds?.includes(state.draggingNodeId) &&
              (dot.status === 'traveling' || dot.status === 'queued')) {
            const oldPath = dot.path;
            const { path: newPath, nodeWpIndices: newNodeWpIndices } = rebuildPathFromNodeIds(dot.originalNodeIds, state.components, state.connections);
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
                  oldNodeWpIndices = computeNodeWpIndices(oldPath, dot.originalNodeIds, state.components);
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
                if (fork.nodeIds.includes(state.draggingNodeId!)) {
                  const { path: newForkPath } = rebuildPathFromNodeIds(fork.nodeIds, state.components, state.connections);
                  return { ...fork, waypoints: newForkPath };
                }
                return fork;
              });
              dot = { ...dot, forkPaths: updatedForks } as typeof dot;
            }
          }

          if (dot.status === 'traveling') {
            const dropColor = dot.isRetry ? '#4a5568' : '#ff4444';
            const eventPos = interpolatePath(dot.path, dot.progress);

            // Drop dots whose path no longer matches the connection graph (connection was removed)
            // Extract component nodes from the path (skip orthogonal midpoints)
            const pathComps: { comp: typeof state.components[0]; idx: number }[] = [];
            for (let wp = 0; wp < dot.path.length; wp++) {
              const pt = dot.path[wp];
              const hit = componentByPos.get(posKey(pt.x, pt.y));
              const comp = hit && Math.abs(hit.x - pt.x) < 1 && Math.abs(hit.y - pt.y) < 1 ? hit : undefined;
              if (comp && (pathComps.length === 0 || pathComps[pathComps.length - 1].comp.id !== comp.id)) {
                pathComps.push({ comp, idx: wp });
              }
            }
            // Check each consecutive component pair ahead of the dot has a connection
            // Skip validation while a node is being dragged — dragging moves positions
            // but doesn't disconnect cables, so the position-based matching would give false positives
            // Validate path against the connection graph.
            // When originalNodeIds is set, use it as the authoritative route instead of
            // the geometric pathComps, which can include spurious nodes that happen to
            // sit on the path geometry.
            let pathInvalid = false;
            const validationNodes = dot.originalNodeIds
              ? dot.originalNodeIds.map(id => componentById.get(id)).filter(Boolean) as typeof state.components
              : pathComps.map(pc => pc.comp);
            if (dot.originalNodeIds) {
              // Validate using authoritative node IDs — no geometric ambiguity
              for (let ni = 0; ni < validationNodes.length - 1 && !state.draggingNodeId; ni++) {
                const a = validationNodes[ni];
                const b = validationNodes[ni + 1];
                const bothBrokers = a.type === 'broker' && b.type === 'broker';
                const connExists = connectionKeys.has(`${a.id}->${b.id}`) ||
                  (bothBrokers && connectionKeys.has(`${b.id}->${a.id}`));
                if (!connExists) {
                  pathInvalid = true;
                  break;
                }
              }
            } else {
              for (let pc = 0; pc < pathComps.length - 1 && !state.draggingNodeId; pc++) {
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
              updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
              continue;
            }

            let actualSpeed = dot.speed * state.upgrades.propagationSpeed;

            // Scale speed by segment length ratio so dots move at constant pixel speed
            actualSpeed *= getSegmentSpeedScale(dot.path, dot.progress);

            if (webhookComponent && dotTouchesNode(eventPos.x, eventPos.y, webhookComponent.x, webhookComponent.y)) {
              actualSpeed *= 0.4;
            }

            // DMR Cluster nodes render much larger than a regular broker and hide dots
            // behind an opaque background — speed through so it still feels instantaneous.
            for (const cb of clusterBounds) {
              if (Math.abs(eventPos.x - cb.x) <= cb.halfW && Math.abs(eventPos.y - cb.y) <= cb.halfH) {
                actualSpeed *= 2.5;
                break;
              }
            }

            let blocked = false;
            for (const comp of state.components) {
              if (comp.type === 'publisher' || comp.type === 'broker') continue;
              if (comp.type === 'webhook') {
                // Only block dots approaching from the left, just before the node's left edge
                const leftEdge = comp.x - NODE_HALF_W - DOT_RADIUS;
                if (eventPos.x >= leftEdge) continue; // already at or past the edge
                if (eventPos.x < leftEdge - 20) continue; // too far away to block
                if (isComponentOccupied(comp.id)) {
                  droppedCount++;
                  recordDrop(comp.id, 'webhook-occupied', comp.label);
                  updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
                  blocked = true;
                  break;
                }
              }
            }
            if (blocked) continue;

            const newProgress = Math.min(dot.progress + actualSpeed * dt, 1);
            const newPos = interpolatePath(dot.path, newProgress);

            // Broker throughput cap: every broker the dot passes through gates against its OWN
            // cap (not just the first) — a bridge hop is a real relay, not a free pass, so
            // chaining brokers no longer lets a route dodge capacity limits. The DMR Cluster
            // upgrade is the intended way to raise a given broker's own ceiling instead.
            let brokerCapped = false;
            const now = performance.now();
            for (const pc of pathComps) {
              if (pc.comp.type !== 'broker') continue;
              const brokerProgress = pc.idx / (dot.path.length - 1);
              if (dot.progress < brokerProgress && newProgress >= brokerProgress) {
                const cap = getBrokerCap(pc.comp, getPermanentBrokerThroughputMult(state));
                if (!tryBrokerRelay(pc.comp.id, cap, now)) {
                  droppedCount++;
                  recordDrop(pc.comp.id, 'broker-capped', pc.comp.label);
                  updated.push({ ...dot, status: 'dropped', dropX: pc.comp.x, dropY: pc.comp.y, dropVY: 0, color: dropColor } as Dot);
                  brokerCapped = true;
                  break;
                }
              }
            }
            if (brokerCapped) continue;

            // Fork spawning: when dot with forkPaths passes its fork broker, spawn fork dots
            if (dot.forkPaths && dot.forkNodeId) {
              const forkComp = state.components.find(c => c.id === dot.forkNodeId);
              if (forkComp && dotTouchesNode(newPos.x, newPos.y, forkComp.x, forkComp.y)) {
                for (const fork of dot.forkPaths) {
                  const forkDotId = nextDotId();
                  // Build fork path starting from the broker position onward
                  const brokerIdxInFork = fork.nodeIds.indexOf(dot.forkNodeId!);
                  const forkStartNodeIds = brokerIdxInFork >= 0 ? fork.nodeIds.slice(brokerIdxInFork) : fork.nodeIds;
                  // Build waypoints from broker onward using the fork's full waypoints
                  // Find the waypoint closest to the broker
                  let brokerWpIdx = 0;
                  let bestDist = Infinity;
                  for (let wi = 0; wi < fork.waypoints.length; wi++) {
                    const d = Math.hypot(fork.waypoints[wi].x - forkComp.x, fork.waypoints[wi].y - forkComp.y);
                    if (d < bestDist) { bestDist = d; brokerWpIdx = wi; }
                  }
                  const forkWaypoints = fork.waypoints.slice(brokerWpIdx);
                  if (forkWaypoints.length >= 2) {
                    // Fork dots spawn at the publisher's first broker (ingestion point),
                    // so they count against that broker's throughput cap
                    const forkCap = getBrokerCap(forkComp, getPermanentBrokerThroughputMult(state));
                    if (!tryBrokerRelay(forkComp.id, forkCap, now)) {
                      droppedCount++;
                      recordDrop(forkComp.id, 'broker-capped', forkComp.label);
                      updated.push({
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
                        speed: normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, forkWaypoints),
                        status: 'traveling' as const,
                        color: fork.color ?? dot.color,
                        opacity: 1,
                        value: fork.value ?? dot.value,
                        originalValue: fork.value ?? dot.originalValue,
                        originalNodeIds: forkStartNodeIds,
                        nextNodeId: findNextInteractableId(forkStartNodeIds, state.components),
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
            const nextInteractable = dot.nextNodeId
              ? pathComps.findLast(pc => pc.comp.id === dot.nextNodeId)
              : pathComps.find(pc => {
                  const compProgress = pc.idx / (dot.path.length - 1);
                  return compProgress > dot.progress - 0.01 && (pc.comp.type === 'queue' || pc.comp.type === 'subscriber');
                });

            // Check collision with queues — only the next queue on the path
            let queued = false;
            if (nextInteractable && nextInteractable.comp.type === 'queue') {
              const queue = nextInteractable.comp;
              // During drag, pixel collision can fail because orthogonal paths are rebuilt
              // each frame (dot pixel position shifts while progress approaches the queue).
              // Fall back to progress-based capture when dot reaches the queue's waypoint.
              const queueProgress = nextInteractable.idx / (dot.path.length - 1);
              const reachedByProgress = state.draggingNodeId && newProgress >= queueProgress;
              // When nextNodeId is set, use only progress-based detection to avoid
              // premature capture when the queue is physically on an earlier path segment.
              const touchesQueue = dot.nextNodeId
                ? newProgress >= queueProgress - 0.01
                : dotTouchesNode(newPos.x, newPos.y, queue.x, queue.y);
              if (reachedByProgress || touchesQueue) {
                const bufferSize = 3 + (queue.upgrades['bufferSize'] ?? 0) + getPermanentQueueBufferBonus(state);
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
                  updated.push({ ...resolvedDot, status: 'queued', pauseStartTime: Date.now(), queuedAtNodeId: queue.id, progress: newProgress } as Dot);
                } else {
                  droppedCount++;
                  recordDrop(queue.id, 'queue-full', queue.label);
                  updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: dropColor } as Dot);
                }
                queued = true;
              }
            }
            if (queued) continue;

            // Check collision with subscriber — only if subscriber is the next interactable node
            if (nextInteractable && nextInteractable.comp.type === 'subscriber') {
              const subscriber = nextInteractable.comp;
              const lastPathPoint = dot.path[dot.path.length - 1];

              const subProgress = nextInteractable.idx / (dot.path.length - 1);
              const touchesSub = dot.nextNodeId
                ? newProgress >= subProgress - 0.01
                : dotTouchesNode(newPos.x, newPos.y, subscriber.x, subscriber.y);
              if (touchesSub) {
                // Check updated array for accurate subscriber occupancy
                // A subscriber is occupied only if the consuming dot still has time remaining
                const subscriberForOccupancy = state.components.find(c =>
                  c.type === 'subscriber' && Math.hypot(c.x - lastPathPoint.x, c.y - lastPathPoint.y) < 50
                );
                const occFcLevel = subscriberForOccupancy?.upgrades['fasterConsumption'] ?? 0;
                const occBoostPct = Math.min(occFcLevel * (occFcLevel + 9) / 2, 100);
                const occConsumeDuration = 1000 * (1 - occBoostPct / 100);
                const isOccupyingThisSubscriber = (d: Dot) => {
                  if (d.status !== 'pausing' || d.moneyAdded || d.path.length === 0) return false;
                  if (Math.hypot(d.path[d.path.length - 1].x - lastPathPoint.x, d.path[d.path.length - 1].y - lastPathPoint.y) >= 50) return false;
                  const elapsed = Date.now() - (d.pauseStartTime ?? Date.now());
                  // Allow arrival within 50ms of consumption finishing to account for frame timing
                  return elapsed < occConsumeDuration - 50;
                };
                // Scan already-processed dots, then the not-yet-processed remainder, without
                // allocating a concatenated copy of both per arriving dot.
                let isSubscriberOccupied = updated.some(isOccupyingThisSubscriber);
                if (!isSubscriberOccupied) {
                  for (let j = i + 1; j < dots.length; j++) {
                    if (isOccupyingThisSubscriber(dots[j])) { isSubscriberOccupied = true; break; }
                  }
                }
                if (!isSubscriberOccupied) {
                  updated.push({ ...dot, status: 'pausing', pauseStartTime: Date.now(), progress: newProgress } as Dot);
                } else {
                  droppedCount++;
                  recordDrop(subscriber.id, 'subscriber-occupied', subscriber.label);
                  updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: dropColor } as Dot);
                }
                continue;
              }
            }

            if (newProgress >= 1) {
              const endPos = dot.path[dot.path.length - 1];
              droppedCount++;
              const lastComp = pathComps[pathComps.length - 1]?.comp;
              if (lastComp) recordDrop(lastComp.id, 'path-incomplete', lastComp.label);
              updated.push({ ...dot, status: 'dropped', dropX: endPos.x, dropY: endPos.y, dropVY: 0, color: dropColor } as Dot);
              continue;
            }

            updated.push({ ...dot, progress: newProgress } as Dot);
          } else if (dot.status === 'pausing') {
            const elapsed = Date.now() - (dot.pauseStartTime ?? Date.now());
            const lastComponent = dot.path[dot.path.length - 1];
            const subscriber = state.components.find(c =>
              c.type === 'subscriber' && Math.hypot(c.x - lastComponent.x, c.y - lastComponent.y) < 50
            );
            const fasterConsumptionLevel = subscriber?.upgrades['fasterConsumption'] ?? 0;
            const boostPct = Math.min(fasterConsumptionLevel * (fasterConsumptionLevel + 9) / 2, 100);
            const consumeDuration = 1000 * (1 - boostPct / 100);
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
            const newVY = (dot.dropVY ?? 0) + 0.3 * dt / 16;
            const newDropY = (dot.dropY ?? 0) + newVY;
            const newDot = {
              ...dot,
              dropVY: newVY,
              dropY: newDropY,
              opacity: dot.opacity - dt / 2500,
            } as Dot;

            // DMQ catch: check if dropping dot lands on the DMQ
            if (!dot.isRetry) {
              const dmq = state.components.find(c => c.type === 'dmq');
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
                      pauseStartTime: Date.now(),
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

            if (newDot.opacity > 0) {
              updated.push(newDot);
            }
          } else {
            updated.push(dot);
          }
        }

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
        const subscriberIds = new Set(state.components.filter(c => c.type === 'subscriber').map(c => c.id));
        const queuePositions = state.components.filter(c => c.type === 'queue').map(c => ({ x: c.x, y: c.y }));

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
          const queueComp = state.components.find(c => c.id === queueId);
          if (queueComp?.type === 'dmq') continue;

          // Skip releases on the post-drag cleanup frame (paths just rebuilt after Y-snap)
          if (postDragCleanupQueues.has(queueId)) continue;

          const queue = state.components.find(c => c.id === queueId);
          const hasFanOut = queueComp && (queueComp.upgrades['fanOut'] ?? 0) > 0;

          // Collect all connected subscribers (needed for busy check and release) — queue-level,
          // same for every dot in this queue, so computed once per queue rather than per dot.
          const allConnectedSubs: { x: number; y: number }[] = [];
          if (queue) {
            const outConns = state.connections.filter(c => c.fromId === queueId);
            for (const conn of outConns) {
              const target = state.components.find(c => c.id === conn.toId && c.type === 'subscriber');
              if (target) allConnectedSubs.push({ x: target.x, y: target.y });
            }
          }

          // Releases made from this queue so far this frame — used to stagger their start
          // progress so same-frame releases don't render stacked on top of each other.
          let releaseSeq = 0;

          for (const i of indices) {
          const dot = updated[i];
          if (dot.status !== 'queued') continue;

          // Fallback to baked path subscriber (per-dot, only when no live connection exists)
          let subsForThisDot = allConnectedSubs;
          if (subsForThisDot.length === 0) {
            const endPoint = dot.path[dot.path.length - 1];
            const bakedSubscriber = state.components.find(c =>
              c.type === 'subscriber' && Math.hypot(c.x - endPoint.x, c.y - endPoint.y) < 50
            );
            subsForThisDot = bakedSubscriber ? [{ x: bakedSubscriber.x, y: bakedSubscriber.y }] : [];
          }

          const hasSubscriber = subsForThisDot.length > 0;
          if (!hasSubscriber) break; // FIFO — oldest remaining can't go, don't skip ahead

          // Pre-build release paths for all connected subscribers
          const buildReleasePath = (subTarget: { x: number; y: number }) => {
            if (!queue) return { path: dot.path, progress: dot.progress };
            let bestDist = Infinity;
            for (let pi = 0; pi < dot.path.length; pi++) {
              const d = Math.hypot(dot.path[pi].x - queue.x, dot.path[pi].y - queue.y);
              if (d < bestDist) { bestDist = d; }
            }
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
            return { path: releasePath, progress: releaseProgress };
          };

          // Predictive release: release when the dot would arrive as the subscriber finishes consuming
          // Calculate the progress at which a dot enters a subscriber's collision box
          // (dotTouchesNode triggers before progress 1.0 due to the node's bounding rectangle)
          const shouldReleaseTo = (sub: { x: number; y: number }, releasePath: { x: number; y: number }[], startProgress: number) => {
            const baseSpeed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, releasePath);
            // During movement, dot.speed is multiplied by propagationSpeed again
            const actualSpeed = baseSpeed * state.upgrades.propagationSpeed;
            const arrivalProg = getArrivalProgress(releasePath);
            const travelTime = scaledTravelTime(releasePath, startProgress, Math.max(arrivalProg, startProgress), actualSpeed);

            const subComp = state.components.find(c =>
              c.type === 'subscriber' && Math.hypot(c.x - sub.x, c.y - sub.y) < 50
            );
            const fcLevel = subComp?.upgrades['fasterConsumption'] ?? 0;
            const boostPct = Math.min(fcLevel * (fcLevel + 9) / 2, 100);
            const consumeDuration = 1000 * (1 - boostPct / 100);

            // Collect every other dot already pausing at or traveling toward this subscriber.
            // A pausing dot is a special case — it's already mid-consumption, so it finishes
            // at `remaining`, not at `arrival + consumeDuration` like an incoming dot would.
            let pausingRemaining: number | null = null;
            const arrivals: number[] = [];

            for (const d of updated) {
              if (d.id === dot.id || d.path.length === 0) continue;
              const dEnd = d.path[d.path.length - 1];
              if (Math.hypot(dEnd.x - sub.x, dEnd.y - sub.y) >= 50) continue;

              if (d.status === 'pausing' && !d.moneyAdded) {
                const elapsed = Date.now() - (d.pauseStartTime ?? Date.now());
                const remaining = Math.max(consumeDuration - elapsed, 0);
                pausingRemaining = Math.max(pausingRemaining ?? 0, remaining);
              }

              if (d.status === 'traveling') {
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
                const inFlightActualSpeed = d.speed * state.upgrades.propagationSpeed;
                const dArrivalProg = getArrivalProgress(d.path);
                const arrivalTime = scaledTravelTime(d.path, d.progress, Math.max(dArrivalProg, d.progress), inFlightActualSpeed);
                arrivals.push(arrivalTime);
              }
            }

            // Simulate the subscriber's consumption queue in arrival order with the candidate
            // inserted at its own predicted arrival. Each dot can only start consuming once it
            // has physically arrived AND the subscriber has finished with whoever was ahead of
            // it; a dot that arrives while the subscriber is still busy is a collision (it
            // drops on arrival). Reject if the candidate would collide, or if inserting it
            // would make any dot arriving AFTER it collide. Order-aware on purpose: staggered
            // same-frame releases mean a fresh release can legitimately arrive before dots
            // released a frame earlier that are still waiting behind the queue — those are
            // behind it, not ahead of it, and must not be read as "subscriber busy until then".
            const chain = arrivals.map(t => ({ t, candidate: false }));
            chain.push({ t: travelTime, candidate: true });
            chain.sort((a, b) => a.t - b.t);
            let busyUntil = pausingRemaining ?? 0;
            let candidateSeen = false;
            for (const { t, candidate } of chain) {
              if (candidate) {
                if (t < busyUntil) return false;
                candidateSeen = true;
              } else if (candidateSeen && t < busyUntil) {
                return false;
              }
              busyUntil = Math.max(t, busyUntil) + consumeDuration;
            }
            return true;
          };

          // Without fan-out, determine round-robin target
          let targets: { x: number; y: number }[];
          if (hasFanOut) {
            targets = subsForThisDot;
          } else {
            const rrIdx = (queueRoundRobinIdx.get(queueId) ?? 0) % subsForThisDot.length;
            queueRoundRobinIdx.set(queueId, rrIdx + 1);
            targets = [subsForThisDot[rrIdx]];
          }

          // Build release paths and check timing for each target
          const releaseData = targets.map(sub => ({
            sub,
            ...buildReleasePath(sub),
          }));

          // Same-frame releases are spread across the frame's own travel distance (the k-th of
          // N starts k/N of one frame's movement behind, as negative progress that clamps to
          // the queue's center, hidden under its card) so they emerge as a stream instead of
          // all rendering on the same pixel. The spread is deliberately bounded by ONE frame:
          // a fixed per-release offset made a dot's lifetime proportional to how many released
          // that frame — at low fps that was ~90 releases/frame, dots hidden for over a second,
          // and a feedback loop (more live dots → slower frames → more releases per frame →
          // longer lives). The timing check must evaluate the same staggered start the dot gets.
          const releaseStaggerFor = (path: { x: number; y: number }[]) => {
            const progressPerMs = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, path)
              * state.upgrades.propagationSpeed * getSegmentSpeedScale(path, 0);
            return (releaseSeq / Math.max(1, indices.length)) * dt * progressPerMs;
          };

          // With fanout: all subscribers must be ready; without: just the target
          let canRelease = releaseData.every(rd => shouldReleaseTo(rd.sub, rd.path, rd.progress - releaseStaggerFor(rd.path)));

          // During drag, shouldReleaseTo timing is unreliable (in-flight dots' paths/speeds
          // are rebuilt each frame). Enforce a minimum interval based on consume duration
          // to prevent rapid queue draining.
          if (canRelease && state.draggingNodeId) {
            const lastRelease = queueLastReleaseTime.get(queueId) ?? 0;
            const subComp = subsForThisDot.length > 0
              ? state.components.find(c => c.type === 'subscriber' && Math.hypot(c.x - subsForThisDot[0].x, c.y - subsForThisDot[0].y) < 50)
              : null;
            const fcLevel = subComp?.upgrades['fasterConsumption'] ?? 0;
            const boostPct = Math.min(fcLevel * (fcLevel + 9) / 2, 100);
            const minInterval = 1000 * (1 - boostPct / 100); // consume duration
            if (Date.now() - lastRelease < minInterval) {
              canRelease = false;
            }
          }

          if (!canRelease) break; // FIFO — oldest remaining can't go yet, don't skip ahead

          queueLastReleaseTime.set(queueId, Date.now());
          releaseSeq++;

          for (let ti = 0; ti < releaseData.length; ti++) {
            const { path: releasePath, progress: releaseProgress, sub: releaseSub } = releaseData[ti];
            const releaseDot = { ...dot, path: releasePath };
            const releaseSpeed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, releasePath);
            // Find subscriber ID for this target so originalNodeIds stays in sync with the release path
            const releaseSubComp = state.components.find(c =>
              c.type === 'subscriber' && Math.hypot(c.x - releaseSub.x, c.y - releaseSub.y) < 1
            );
            const releaseNodeIds = [queueId, ...(releaseSubComp ? [releaseSubComp.id] : [])];
            if (ti === 0) {
              updated[i] = { ...releaseDot, status: 'traveling', progress: releaseProgress - releaseStaggerFor(releasePath), speed: releaseSpeed, pauseStartTime: undefined, queuedAtNodeId: undefined, originalNodeIds: releaseNodeIds, nextNodeId: releaseSubComp?.id, nodeWpIndices: undefined } as Dot;
            } else {
              updated.push({
                ...releaseDot,
                id: nextDotId(),
                status: 'traveling',
                progress: releaseProgress - releaseStaggerFor(releasePath),
                speed: releaseSpeed,
                pauseStartTime: undefined,
                queuedAtNodeId: undefined,
                originalNodeIds: releaseNodeIds,
                nextNodeId: releaseSubComp?.id,
                nodeWpIndices: undefined,
              } as Dot);
            }
          }
          }
        }

        // --- Pass 3: auto-release ONE queued dot from DMQ if broker connection exists ---
        const dmqComp = state.components.find(c => c.type === 'dmq');
        if (dmqComp) {
          const dmqConn = state.connections.find(c => c.fromId === dmqComp.id);
          const brokerTarget = dmqConn
            ? state.components.find(c => c.id === dmqConn.toId && c.type === 'broker')
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
                    const c = state.components.find(comp => comp.id === nid);
                    return c?.type === 'queue' || c?.type === 'subscriber';
                  });
                  let foundPath: string[] | null = null;
                  if (origDest) {
                    const walkForDest = (nodeId: string, path: string[], visited: Set<string>): void => {
                      if (foundPath) return;
                      if (visited.has(nodeId)) return;
                      visited.add(nodeId);
                      const node = state.components.find(c => c.id === nodeId);
                      if (!node) return;
                      const curPath = [...path, nodeId];
                      if (nodeId === origDest) { foundPath = curPath; return; }
                      // Follow outgoing connections + reverse bridges (bidirectional)
                      const nextConns = state.connections.filter(c => c.fromId === nodeId);
                      const reverseBridgeConns = node.type === 'broker'
                        ? state.connections.filter(c => c.toId === nodeId &&
                          state.components.find(comp => comp.id === c.fromId)?.type === 'broker')
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
                  const comp = state.components.find(c => c.id === nid);
                  if (comp) routeNodes.push({ x: comp.x, y: comp.y, type: comp.type, id: comp.id, upgrades: comp.upgrades });
                }

                // Expand to orthogonal waypoints
                const pathFromBroker: { x: number; y: number }[] = routeNodes.length > 0 ? [{ x: routeNodes[0].x, y: routeNodes[0].y }] : [];
                for (let ni = 0; ni < routeNodes.length - 1; ni++) {
                  const a = routeNodes[ni];
                  const b = routeNodes[ni + 1];
                  if (Math.abs(a.y - b.y) >= 5) {
                    const isReverseBridge = a.type === 'broker' && b.type === 'broker' &&
                      !state.connections.some(c => c.fromId === a.id && c.toId === b.id) &&
                      state.connections.some(c => c.fromId === b.id && c.toId === a.id);
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

                const speed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, fullPath);

                let canRelease = false;
                if (targetComp.type === 'queue') {
                  canRelease = (Date.now() - lastDmqReleaseTime) >= 500;
                } else {
                  // Subscriber — predictive timing (same logic as queue release)
                  const actualSpeed = speed * state.upgrades.propagationSpeed;
                  const dmqArrivalProg = getArrivalProgress(fullPath);
                  const travelTime = scaledTravelTime(fullPath, 0, dmqArrivalProg, actualSpeed);

                  const subComp = state.components.find(c => c.id === targetComp!.id);
                  const fcLevel = subComp?.upgrades['fasterConsumption'] ?? 0;
                  const boostPct = Math.min(fcLevel * (fcLevel + 9) / 2, 100);
                  const consumeDuration = 1000 * (1 - boostPct / 100);

                  let latestSlotOpen = 0;
                  for (const d of updated) {
                    if (d.id === dot.id || d.path.length === 0) continue;
                    const dEnd = d.path[d.path.length - 1];
                    if (Math.hypot(dEnd.x - targetComp!.x, dEnd.y - targetComp!.y) >= 50) continue;

                    if (d.status === 'pausing' && !d.moneyAdded) {
                      const elapsed = Date.now() - (d.pauseStartTime ?? Date.now());
                      const remaining = Math.max(consumeDuration - elapsed, 0);
                      latestSlotOpen = Math.max(latestSlotOpen, remaining);
                    }

                    if (d.status === 'traveling') {
                      const dArrProg = getArrivalProgress(d.path);
                      const arrivalTime = scaledTravelTime(d.path, d.progress, Math.max(dArrProg, d.progress), d.speed * state.upgrades.propagationSpeed);
                      latestSlotOpen = Math.max(latestSlotOpen, arrivalTime + consumeDuration);
                    }
                  }

                  canRelease = latestSlotOpen <= travelTime;
                }

                if (!canRelease) break; // Only attempt the oldest queued dot — if it can't release, wait

                lastDmqReleaseTime = Date.now();
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

        return updated;
      });

      // Increment dropped counter
      if (droppedCount > 0) {
        useGameStore.setState(state => ({
          ...state,
          eventsDropped: state.eventsDropped + droppedCount,
        }));
        // Track first drop time for tutorial
        if (!firstDropTime && !firstDropTutorialShown) {
          firstDropTime = Date.now();
        }
      }

      // Show first-drop tutorial 1 second after the first drop
      if (firstDropTime && !firstDropTutorialShown && Date.now() - firstDropTime >= 1000) {
        firstDropTutorialShown = true;
        useGameStore.getState().showTutorial('firstDrop');
      }

      // Add money for dots that reached 50% of animation — one store commit for the whole
      // frame's consumes (each commit notifies every selector in the app and wakes the
      // auto-save subscriber); the 5s earnings window is pruned inside that same commit.
      if (toConsume.length > 0) {
        useGameStore.getState().consumeEvents(toConsume);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);
}

export function useAutoPublisher() {
  useEffect(() => {
    // Poll every 100ms and attempt to fire for each auto-click publisher
    // The cooldown check inside fireEvent naturally gates the rate
    const timer = setInterval(() => {
      // The frame loop is suspended while the tab is hidden, but this interval isn't (just
      // throttled) — firing would pile up dots with nothing moving them, all of which would
      // then flood the mesh the moment the tab comes back.
      if (document.hidden) return;
      const state = useGameStore.getState();
      const publishers = state.components.filter(c => c.type === 'publisher');
      for (const pub of publishers) {
        if ((pub.upgrades['autoPub'] ?? 0) >= 1) {
          state.fireEvent(pub.id);
        }
      }
    }, 100);

    return () => clearInterval(timer);
  }, []);
}
