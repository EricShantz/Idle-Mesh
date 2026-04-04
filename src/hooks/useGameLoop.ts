import { useEffect, useRef } from 'react';
import { useGameStore, nextDotId } from '../store/gameStore';
import { interpolatePath, normalizedSpeed } from '../utils/pathUtils';

// Node card dimensions: positioned at left: x-60, top: y-28
// Card width: 120px (half = 60), card height varies but ~56px
const NODE_HALF_W = 60;
const NODE_TOP_OFFSET = 28;   // from center to top edge
const NODE_BOTTOM_OFFSET = 28; // from center to bottom edge (generous to cover content)

const DOT_RADIUS = 6;

const BROKER_BASE_THROUGHPUT = 8; // events/sec

/** Rolling window of relay timestamps per broker for throughput cap */
const brokerRelayTimestamps = new Map<string, number[]>();

/** Round-robin index per queue for competing consumer pattern */
const queueRoundRobinIdx = new Map<string, number>();

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

/** Get broker throughput cap from upgrade level */
function getBrokerCap(brokerComp: { upgrades: Record<string, number> }): number {
  const level = brokerComp.upgrades['increaseThroughput'] ?? 0;
  const bonus = level * (level + 9) / 2;
  return BROKER_BASE_THROUGHPUT + bonus;
}

/** Get current utilization ratio (0-1+) for a broker */
export function getBrokerUtilization(brokerId: string, cap: number): number {
  const ts = brokerRelayTimestamps.get(brokerId) ?? [];
  const now = performance.now();
  const recent = ts.filter(t => now - t < 1000);
  return recent.length / cap;
}

/** Rebuild orthogonal waypoints from node IDs using current component positions */
function rebuildPathFromNodeIds(
  nodeIds: string[],
  components: { id: string; type: string; x: number; y: number }[]
): { x: number; y: number }[] {
  const nodes: { id: string; type: string; x: number; y: number }[] = [];
  for (const id of nodeIds) {
    const comp = components.find(c => c.id === id);
    if (comp) nodes.push(comp);
  }
  if (nodes.length === 0) return [];
  const path: { x: number; y: number }[] = [{ x: nodes[0].x, y: nodes[0].y }];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (Math.abs(a.y - b.y) >= 1) {
      // DMQ→broker uses vertical-first routing
      if (a.type === 'dmq' && b.type === 'broker') {
        const midY = (a.y + b.y) / 2;
        path.push({ x: a.x, y: midY });
        path.push({ x: b.x, y: midY });
      } else {
        // Match port-adjusted midX from ConnectionLine.tsx
        const aHalfW = a.type === 'queue' ? 70 : 60;
        const bHalfW = b.type === 'queue' ? 70 : 60;
        const portStartX = a.x + aHalfW + 24;
        const portEndX = b.x - bHalfW - 2;
        const midX = (portStartX + portEndX) / 2;
        path.push({ x: midX, y: a.y });
        path.push({ x: midX, y: b.y });
      }
    }
    path.push({ x: b.x, y: b.y });
  }
  return path;
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
      const dt = time - lastTimeRef.current;
      lastTimeRef.current = time;

      // Update smoothed FPS for adaptive coin pop throttling
      if (dt > 0) {
        const instantFps = 1000 / dt;
        _smoothedFps += FPS_SMOOTH * (instantFps - _smoothedFps);
      }

      const state = useGameStore.getState();
      const toConsume: { id: string; value: number; subscriberId: string }[] = [];
      const toFinish: string[] = [];
      const toRemove: string[] = [];
      let droppedCount = 0;

      state.updateDots(dots => {
        type Dot = import('../store/gameStore').EventDot;
        // Use a mutable array so each dot sees the results of earlier dots in the same frame
        const updated: Dot[] = [];

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

          // Rebuild path in real-time when a component on this dot's route is being dragged
          if (state.draggingNodeId && dot.originalNodeIds?.includes(state.draggingNodeId) &&
              (dot.status === 'traveling' || dot.status === 'queued')) {
            const currentPos = dot.status === 'traveling' ? interpolatePath(dot.path, dot.progress) : null;
            const newPath = rebuildPathFromNodeIds(dot.originalNodeIds, state.components);
            if (newPath.length >= 2) {
              const newProgress = currentPos ? projectOntoPath(newPath, currentPos.x, currentPos.y) : dot.progress;
              dot = { ...dot, path: newPath, progress: newProgress } as typeof dot;
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
              const comp = state.components.find(c => Math.abs(c.x - pt.x) < 1 && Math.abs(c.y - pt.y) < 1);
              if (comp && (pathComps.length === 0 || pathComps[pathComps.length - 1].comp.id !== comp.id)) {
                pathComps.push({ comp, idx: wp });
              }
            }
            // Check each consecutive component pair ahead of the dot has a connection
            // Skip validation while a node is being dragged — dragging moves positions
            // but doesn't disconnect cables, so the position-based matching would give false positives
            let pathInvalid = false;
            for (let pc = 0; pc < pathComps.length - 1 && !state.draggingNodeId; pc++) {
              const fromProgress = pathComps[pc].idx / (dot.path.length - 1);
              // Only validate segments the dot hasn't passed yet
              if (pathComps[pc + 1].idx / (dot.path.length - 1) < dot.progress - 0.01) continue;
              const a = pathComps[pc].comp;
              const b = pathComps[pc + 1].comp;
              const bothBrokers = a.type === 'broker' && b.type === 'broker';
              const connExists = state.connections.some(c =>
                (c.fromId === a.id && c.toId === b.id) ||
                (bothBrokers && c.fromId === b.id && c.toId === a.id)
              );
              if (!connExists) {
                pathInvalid = true;
                break;
              }
            }
            if (pathInvalid) {
              droppedCount++;
              updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
              continue;
            }

            let actualSpeed = dot.speed * state.upgrades.propagationSpeed;

            const webhookComponent = state.components.find(c => c.type === 'webhook');
            if (webhookComponent && dotTouchesNode(eventPos.x, eventPos.y, webhookComponent.x, webhookComponent.y)) {
              const fasterRoutingLevel = webhookComponent.upgrades['fasterRouting'] ?? 0;
              const slowFactor = Math.min(1.0, 0.4 + fasterRoutingLevel * 0.2);
              actualSpeed *= slowFactor;
            }
            const blockRadius = NODE_HALF_W + DOT_RADIUS + 15; // detect approaching dots before they enter the node

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
                  updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: dropColor } as Dot);
                  blocked = true;
                  break;
                }
              }
            }
            if (blocked) continue;

            const newProgress = Math.min(dot.progress + actualSpeed * dt, 1);
            const newPos = interpolatePath(dot.path, newProgress);

            // Broker throughput cap (ingestion only): only the FIRST broker on the path
            // counts against throughput. Bridged events flow freely through subsequent brokers.
            let brokerCapped = false;
            const now = performance.now();
            const firstBroker = pathComps.find(pc => pc.comp.type === 'broker');
            if (firstBroker) {
              const brokerProgress = firstBroker.idx / (dot.path.length - 1);
              if (dot.progress < brokerProgress && newProgress >= brokerProgress) {
                const cap = getBrokerCap(firstBroker.comp);
                if (!tryBrokerRelay(firstBroker.comp.id, cap, now)) {
                  droppedCount++;
                  updated.push({ ...dot, status: 'dropped', dropX: firstBroker.comp.x, dropY: firstBroker.comp.y, dropVY: 0, color: dropColor } as Dot);
                  brokerCapped = true;
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
                    const forkCap = getBrokerCap(forkComp);
                    if (!tryBrokerRelay(forkComp.id, forkCap, now)) {
                      droppedCount++;
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
                        value: dot.value,
                        originalValue: dot.originalValue,
                        originalNodeIds: forkStartNodeIds,
                      });
                    } else {
                      updated.push({
                        id: forkDotId,
                        path: forkWaypoints,
                        progress: 0,
                        speed: normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, forkWaypoints),
                        status: 'traveling' as const,
                        color: dot.color,
                        opacity: 1,
                        value: dot.value,
                        originalValue: dot.originalValue,
                        originalNodeIds: forkStartNodeIds,
                      });
                    }
                  }
                }
                // Clear fork data from this dot
                dot = { ...dot, forkPaths: undefined, forkNodeId: undefined };
              }
            }

            // Find the next component the dot should interact with (queue or subscriber)
            // This prevents dots from being captured by nodes they pass through spatially
            // but haven't reached yet along their connection path
            const nextInteractable = pathComps.find(pc => {
              const compProgress = pc.idx / (dot.path.length - 1);
              return compProgress > dot.progress - 0.01 && (pc.comp.type === 'queue' || pc.comp.type === 'subscriber');
            });

            // Check collision with queues — only the next queue on the path
            let queued = false;
            if (nextInteractable && nextInteractable.comp.type === 'queue') {
              const queue = nextInteractable.comp;
              if (dotTouchesNode(newPos.x, newPos.y, queue.x, queue.y)) {
                const bufferSize = 3 + (queue.upgrades['bufferSize'] ?? 0);
                // Count from the already-processed updated array for accurate counts
                const queuedCount = updated.filter(d =>
                  d.status === 'queued' && d.queuedAtNodeId === queue.id
                ).length;

                if (queuedCount < bufferSize) {
                  updated.push({ ...dot, status: 'queued', pauseStartTime: Date.now(), queuedAtNodeId: queue.id, progress: newProgress } as Dot);
                } else {
                  droppedCount++;
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

              if (dotTouchesNode(newPos.x, newPos.y, subscriber.x, subscriber.y)) {
                // Check updated array for accurate subscriber occupancy
                const isSubscriberOccupied = updated.some(d =>
                  d.status === 'pausing' &&
                  !d.moneyAdded &&
                  d.path.length > 0 &&
                  Math.hypot(d.path[d.path.length - 1].x - lastPathPoint.x, d.path[d.path.length - 1].y - lastPathPoint.y) < 50
                );
                if (!isSubscriberOccupied) {
                  updated.push({ ...dot, status: 'pausing', pauseStartTime: Date.now(), progress: newProgress } as Dot);
                } else {
                  droppedCount++;
                  updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: dropColor } as Dot);
                }
                continue;
              }
            }

            if (newProgress >= 1) {
              const endPos = dot.path[dot.path.length - 1];
              droppedCount++;
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
                  const dmqQueuedCount = updated.filter(d =>
                    d.status === 'queued' && d.queuedAtNodeId === dmq.id
                  ).length;

                  if (dmqQueuedCount < dmqBufferSize) {
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

        // --- Pass 2: auto-release ONE queued dot per queue if subscriber is free ---
        const releasedQueues = new Set<string>();

        for (let i = 0; i < updated.length; i++) {
          let dot = updated[i];
          if (dot.status !== 'queued' || !dot.queuedAtNodeId) continue;
          if (releasedQueues.has(dot.queuedAtNodeId)) continue;

          const queueId = dot.queuedAtNodeId;

          // Skip DMQ-queued dots — they're handled in Pass 3
          const queueComp = state.components.find(c => c.id === queueId);
          if (queueComp?.type === 'dmq') continue;


          // Only release the oldest queued dot in this queue (FIFO by pauseStartTime)
          let isOldest = true;
          for (let j = 0; j < updated.length; j++) {
            if (j === i) continue;
            const d = updated[j];
            if (d.status === 'queued' && d.queuedAtNodeId === queueId &&
                (d.pauseStartTime ?? 0) < (dot.pauseStartTime ?? 0)) {
              isOldest = false;
              break;
            }
          }
          if (!isOldest) continue;

          // Find the subscriber this queue feeds into (check current connections, not baked path)
          const queueOutConn = state.connections.find(c => c.fromId === queueId);
          const subscriberComp = queueOutConn
            ? state.components.find(c => c.id === queueOutConn.toId && c.type === 'subscriber')
            : null;
          // Also check baked path for dots that already have a valid path
          const endPoint = dot.path[dot.path.length - 1];
          const bakedSubscriber = state.components.find(c =>
            c.type === 'subscriber' && Math.hypot(c.x - endPoint.x, c.y - endPoint.y) < 50
          );
          const targetSub = subscriberComp ?? bakedSubscriber;

          // Check if subscriber is free — gated by queue's Faster Release upgrade
          const releaseSpeedLevel = queueComp?.upgrades.queueReleaseSpeed ?? 0;
          const releaseBoostPct = releaseSpeedLevel * (releaseSpeedLevel + 9) / 2;
          const releaseThreshold = 1 - (releaseBoostPct / 100); // 0→1.0, 10→0.05

          const isSubscriberBusy = !targetSub ? false : updated.some(d => {
            if (d.id === dot.id || d.path.length === 0) return false;
            const dEnd = d.path[d.path.length - 1];
            if (Math.hypot(dEnd.x - targetSub.x, dEnd.y - targetSub.y) >= 50) return false;
            if (d.status === 'pausing' && !d.moneyAdded) return true;
            if (d.status === 'traveling') {
              // Only block if this dot is past all queues in its path (on the final segment to subscriber)
              const isPastAllQueues = !d.path.some((wp, idx) => {
                if (idx >= d.path.length - 1) return false; // skip last waypoint
                const q = state.components.find(c =>
                  c.type === 'queue' && Math.abs(c.x - wp.x) < 1 && Math.abs(c.y - wp.y) < 1
                );
                if (!q) return false;
                const queueProgress = idx / (d.path.length - 1);
                return d.progress <= queueProgress + 0.01;
              });
              if (!isPastAllQueues) return false;
              // With Faster Release, allow next release once previous dot has traveled
              // far enough past the queue on the queue→subscriber segment
              // Find queue waypoint progress and subscriber (end) progress
              let queueWpProgress = 0;
              for (let pi = d.path.length - 2; pi >= 0; pi--) {
                const wp = d.path[pi];
                const q = state.components.find(c =>
                  c.type === 'queue' && Math.abs(c.x - wp.x) < 1 && Math.abs(c.y - wp.y) < 1
                );
                if (q) { queueWpProgress = pi / (d.path.length - 1); break; }
              }
              const segmentProgress = queueWpProgress < 1
                ? (d.progress - queueWpProgress) / (1 - queueWpProgress)
                : 1;
              return segmentProgress < releaseThreshold;
            }
            return false;
          });

          // Check if queue currently has a connection to a subscriber
          let hasSubscriber = false;
          let pendingExtension: { target: { x: number; y: number } } | null = null;

          // Always use current connections as source of truth
          {
            const queue = state.components.find(c => c.id === queueId);
            if (queue) {
              const outConns = state.connections.filter(c => c.fromId === queueId);
              for (const conn of outConns) {
                const target = state.components.find(c => c.id === conn.toId && c.type === 'subscriber');
                if (target) {
                  hasSubscriber = true;
                  // Only need to extend path if it doesn't already end at this subscriber
                  const alreadyHasPath = Math.abs(endPoint.x - target.x) < 1 && Math.abs(endPoint.y - target.y) < 1;
                  if (!alreadyHasPath) {
                    pendingExtension = { target: { x: target.x, y: target.y } };
                  }
                  break;
                }
              }
            }
          }

          if (hasSubscriber && !isSubscriberBusy) {
            releasedQueues.add(queueId);
            const queue = state.components.find(c => c.id === queueId);
            const hasFanOut = queueComp && (queueComp.upgrades['fanOut'] ?? 0) > 0;

            // Collect all connected subscribers
            const allSubTargets: { x: number; y: number }[] = [];
            if (queue) {
              const outConns = state.connections.filter(c => c.fromId === queueId);
              for (const conn of outConns) {
                const sub = state.components.find(c => c.id === conn.toId && c.type === 'subscriber');
                if (sub) allSubTargets.push({ x: sub.x, y: sub.y });
              }
            }
            // Fallback to baked path subscriber
            if (allSubTargets.length === 0 && targetSub) {
              allSubTargets.push({ x: targetSub.x, y: targetSub.y });
            }

            // Without fan-out, round-robin across subscribers (competing consumers)
            let targets: { x: number; y: number }[];
            if (hasFanOut) {
              targets = allSubTargets;
            } else {
              const rrIdx = (queueRoundRobinIdx.get(queueId) ?? 0) % allSubTargets.length;
              queueRoundRobinIdx.set(queueId, rrIdx + 1);
              targets = [allSubTargets[rrIdx]];
            }

            for (let ti = 0; ti < targets.length; ti++) {
              const subTarget = targets[ti];
              let releaseDot = { ...dot };
              let releaseProgress = dot.progress;

              if (queue) {
                // Find the queue's waypoint index in the baked path
                let bestIdx = 0;
                let bestDist = Infinity;
                for (let pi = 0; pi < releaseDot.path.length; pi++) {
                  const d = Math.hypot(releaseDot.path[pi].x - queue.x, releaseDot.path[pi].y - queue.y);
                  if (d < bestDist) { bestDist = d; bestIdx = pi; }
                }
                // Truncate path at the queue and rebuild queue→subscriber with current positions
                const pathBeforeQueue = releaseDot.path.slice(0, bestIdx);
                const queuePoint = { x: queue.x, y: queue.y };

                const extension: { x: number; y: number }[] = [];
                if (Math.abs(queue.y - subTarget.y) >= 1) {
                  const qHalfW = 70; // queues always 70
                  const sHalfW = 60; // subscribers always 60
                  const midX = (queue.x + qHalfW + 24 + subTarget.x - sHalfW - 2) / 2;
                  extension.push({ x: midX, y: queue.y });
                  extension.push({ x: midX, y: subTarget.y });
                }
                extension.push({ x: subTarget.x, y: subTarget.y });
                // Only use queue→subscriber as the release path (not the full path from publisher)
                const releasePath = dedupeConsecutiveWaypoints([queuePoint, ...extension]);
                releaseDot = { ...releaseDot, path: releasePath };
                const totalSegments = releasePath.length - 1;
                if (totalSegments > 0) {
                  const from = releasePath[0];
                  const to = releasePath[1];
                  const segLen = Math.hypot(to.x - from.x, to.y - from.y);
                  const clearanceFraction = segLen > 0 ? (NODE_HALF_W + DOT_RADIUS + 2) / segLen : 1;
                  releaseProgress = Math.min(clearanceFraction / totalSegments, 1);
                } else {
                  releaseProgress = 0;
                }
              }

              const releaseSpeed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, releaseDot.path);
              if (ti === 0) {
                // Update the original dot in place
                updated[i] = { ...releaseDot, status: 'traveling', progress: releaseProgress, speed: releaseSpeed, pauseStartTime: undefined, queuedAtNodeId: undefined } as Dot;
              } else {
                // Fan-out: create a copy for additional subscribers
                updated.push({
                  ...releaseDot,
                  id: nextDotId(),
                  status: 'traveling',
                  progress: releaseProgress,
                  speed: releaseSpeed,
                  pauseStartTime: undefined,
                  queuedAtNodeId: undefined,
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
            // Only release if no previously-released DMQ dot is still traveling on the DMQ→broker segment
            const releaseSpeedLevel = dmqComp.upgrades.dmqReleaseSpeed ?? 0;
            const releaseBoostPct = releaseSpeedLevel * (releaseSpeedLevel + 9) / 2;
            const releaseThreshold = 1 - (releaseBoostPct / 100);
            const dmqLineBusy = updated.some(d => {
              if (d.status !== 'traveling' || !d.isRetry) return false;
              // Check if this dot's path starts at DMQ and it hasn't reached the broker yet
              if (d.path.length < 2) return false;
              const startsAtDmq = Math.abs(d.path[0].x - dmqComp.x) < 1 && Math.abs(d.path[0].y - dmqComp.y) < 1;
              if (!startsAtDmq) return false;
              // Find broker waypoint progress — if dot is before it, the line is busy
              for (let pi = 0; pi < d.path.length; pi++) {
                if (Math.abs(d.path[pi].x - brokerTarget.x) < 1 && Math.abs(d.path[pi].y - brokerTarget.y) < 1) {
                  const brokerProgress = pi / (d.path.length - 1);
                  return d.progress < brokerProgress * releaseThreshold;
                }
              }
              return false;
            });

            if (!dmqLineBusy) {
              // Find the first queued dot in DMQ
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
                const nodeIdsFromBroker = brokerIdx >= 0 ? origNodeIds.slice(brokerIdx) : [brokerTarget.id];

                // Build fresh waypoints from current positions: broker → ... → subscriber
                const routeNodes: { x: number; y: number; type: string }[] = [];
                for (const nid of nodeIdsFromBroker) {
                  const comp = state.components.find(c => c.id === nid);
                  if (comp) routeNodes.push({ x: comp.x, y: comp.y, type: comp.type });
                }

                // Expand to orthogonal waypoints
                const pathFromBroker: { x: number; y: number }[] = routeNodes.length > 0 ? [{ x: routeNodes[0].x, y: routeNodes[0].y }] : [];
                for (let ni = 0; ni < routeNodes.length - 1; ni++) {
                  const a = routeNodes[ni];
                  const b = routeNodes[ni + 1];
                  if (Math.abs(a.y - b.y) >= 1) {
                    const aHalfW = a.type === 'queue' ? 70 : 60;
                    const bHalfW = b.type === 'queue' ? 70 : 60;
                    const midX = (a.x + aHalfW + 24 + b.x - bHalfW - 2) / 2;
                    pathFromBroker.push({ x: midX, y: a.y });
                    pathFromBroker.push({ x: midX, y: b.y });
                  }
                  pathFromBroker.push({ x: b.x, y: b.y });
                }

                // Build DMQ → broker path (vertical first)
                const dmqToBroker: { x: number; y: number }[] = [{ x: dmqComp.x, y: dmqComp.y }];
                if (Math.abs(dmqComp.x - brokerTarget.x) >= 1) {
                  const midY = (dmqComp.y + brokerTarget.y) / 2;
                  dmqToBroker.push({ x: dmqComp.x, y: midY });
                  dmqToBroker.push({ x: brokerTarget.x, y: midY });
                }
                // Combine: DMQ → broker → original route from broker
                const fullPath = [...dmqToBroker, ...pathFromBroker];

                const speed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed, fullPath);

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
                  originalValue: undefined,
                  pauseStartTime: undefined,
                  queuedAtNodeId: undefined,
                  dropX: undefined,
                  dropY: undefined,
                  dropVY: undefined,
                } as Dot;
                break; // Only release one per frame
              }
            } // end !dmqLineBusy
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
      }

      // Add money for dots that reached 50% of animation
      for (const { id, value, subscriberId } of toConsume) {
        useGameStore.getState().consumeEvent(id, value, subscriberId);
      }

      // Prune old earnings (keep last 5s)
      const now = Date.now();
      const { recentEarnings } = useGameStore.getState();
      if (recentEarnings.length > 0 && recentEarnings[0].time < now - 5000) {
        useGameStore.setState(state => ({
          ...state,
          recentEarnings: state.recentEarnings.filter(e => e.time > now - 5000),
        }));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);
}

const AUTO_PUB_INTERVALS = [5000, 3000, 1000, 750, 500, 250, 100];

export function useAutoPublisher() {
  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  useEffect(() => {
    // Poll publisher autoPub levels and manage per-publisher timers
    const check = setInterval(() => {
      const state = useGameStore.getState();
      const publishers = state.components.filter(c => c.type === 'publisher');
      const activeIds = new Set<string>();

      for (const pub of publishers) {
        const level = pub.upgrades['autoPub'] ?? 0;
        if (level === 0) continue;
        activeIds.add(pub.id);
        const interval = AUTO_PUB_INTERVALS[Math.min(level - 1, AUTO_PUB_INTERVALS.length - 1)];

        // Check if timer exists with correct interval (stored as data attribute)
        const existing = timersRef.current.get(pub.id);
        const existingInterval = (timersRef.current as any)[`${pub.id}_ms`];
        if (existing && existingInterval === interval) continue;

        // Clear old timer and set new one
        if (existing) clearInterval(existing);
        const timer = setInterval(() => {
          const s = useGameStore.getState();
          s.fireEvent(pub.id, true);
        }, interval);
        timersRef.current.set(pub.id, timer);
        (timersRef.current as any)[`${pub.id}_ms`] = interval;
      }

      // Clean up timers for removed or downgraded publishers
      for (const [id, timer] of timersRef.current.entries()) {
        if (!activeIds.has(id)) {
          clearInterval(timer);
          timersRef.current.delete(id);
          delete (timersRef.current as any)[`${id}_ms`];
        }
      }
    }, 500);

    return () => {
      clearInterval(check);
      for (const timer of timersRef.current.values()) clearInterval(timer);
      timersRef.current.clear();
    };
  }, []);
}
