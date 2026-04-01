import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';

// Node card dimensions: positioned at left: x-60, top: y-28
// Card width: 120px (half = 60), card height varies but ~56px
const NODE_HALF_W = 60;
const NODE_TOP_OFFSET = 28;   // from center to top edge
const NODE_BOTTOM_OFFSET = 28; // from center to bottom edge (generous to cover content)

const DOT_RADIUS = 6;

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

          if (dot.status === 'traveling') {
            // Drop dots whose path no longer matches the connection graph (connection was removed)
            const eventPos = interpolatePath(dot.path, dot.progress);
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
            let pathInvalid = false;
            for (let pc = 0; pc < pathComps.length - 1; pc++) {
              const fromProgress = pathComps[pc].idx / (dot.path.length - 1);
              // Only validate segments the dot hasn't passed yet
              if (pathComps[pc + 1].idx / (dot.path.length - 1) < dot.progress - 0.01) continue;
              const connExists = state.connections.some(c =>
                c.fromId === pathComps[pc].comp.id && c.toId === pathComps[pc + 1].comp.id
              );
              if (!connExists) {
                pathInvalid = true;
                break;
              }
            }
            if (pathInvalid) {
              droppedCount++;
              updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: '#ff4444' } as Dot);
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
                  updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: '#ff4444' } as Dot);
                  blocked = true;
                  break;
                }
              }
            }
            if (blocked) continue;

            const newProgress = Math.min(dot.progress + actualSpeed * dt, 1);
            const newPos = interpolatePath(dot.path, newProgress);

            // Check collision with queues along the path (include last waypoint for disconnected queues)
            // Only check queues that are AHEAD of the dot's current progress to avoid re-capturing after release
            let queued = false;
            for (let j = 0; j < dot.path.length; j++) {
              // Skip waypoints the dot has already passed
              const waypointProgress = j / (dot.path.length - 1);
              if (waypointProgress < dot.progress - 0.01) continue;

              const pathPoint = dot.path[j];
              const queue = state.components.find(c =>
                c.type === 'queue' && Math.hypot(c.x - pathPoint.x, c.y - pathPoint.y) < 50
              );

              if (queue && dotTouchesNode(newPos.x, newPos.y, queue.x, queue.y)) {
                const bufferSize = 1 + (queue.upgrades['bufferSize'] ?? 0);
                // Count from the already-processed updated array for accurate counts
                const queuedCount = updated.filter(d =>
                  d.status === 'queued' && d.queuedAtNodeId === queue.id
                ).length;

                if (queuedCount < bufferSize) {
                  updated.push({ ...dot, status: 'queued', pauseStartTime: Date.now(), queuedAtNodeId: queue.id, progress: newProgress } as Dot);
                } else {
                  droppedCount++;
                  updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: '#ff4444' } as Dot);
                }
                queued = true;
                break;
              }
            }
            if (queued) continue;

            // Check collision with subscriber
            const lastPathPoint = dot.path[dot.path.length - 1];
            const subscriber = state.components.find(c =>
              c.type === 'subscriber' && Math.hypot(c.x - lastPathPoint.x, c.y - lastPathPoint.y) < 50
            );

            if (subscriber && dotTouchesNode(newPos.x, newPos.y, subscriber.x, subscriber.y)) {
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
                updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: '#ff4444' } as Dot);
              }
              continue;
            }

            if (newProgress >= 1) {
              const endPos = dot.path[dot.path.length - 1];
              droppedCount++;
              updated.push({ ...dot, status: 'dropped', dropX: endPos.x, dropY: endPos.y, dropVY: 0, color: '#ff4444' } as Dot);
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
            const consumeDuration = 2500 * Math.pow(0.95, fasterConsumptionLevel);
            const moneyAddTime = consumeDuration * 0.5;

            if (elapsed >= moneyAddTime && !dot.moneyAdded) {
              const consumptionValueLevel = subscriber?.upgrades['consumptionValue'] ?? 0;
              const subscriberValue = 0.5 + consumptionValueLevel * 0.5;
              const finalValue = dot.value + subscriberValue;
              toConsume.push({ id: dot.id, value: finalValue, subscriberId: subscriber?.id ?? '' });
              // Don't add to updated — dot is finished
            } else {
              updated.push(dot);
            }
          } else if (dot.status === 'dropped') {
            const newVY = (dot.dropVY ?? 0) + 0.3 * dt / 16;
            const newDot = {
              ...dot,
              dropVY: newVY,
              dropY: (dot.dropY ?? 0) + newVY,
              opacity: dot.opacity - dt / 600,
            } as Dot;
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

          // Only release the first queued dot in this queue
          const isFirst = !updated.some((d, di) =>
            di < i &&
            d.status === 'queued' &&
            d.queuedAtNodeId === queueId
          );
          if (!isFirst) continue;

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

          // Check if subscriber is free — only block on dots that are past all queues (on queue→subscriber segment)
          const isSubscriberBusy = !targetSub ? false : updated.some(d => {
            if (d.id === dot.id || d.path.length === 0) return false;
            const dEnd = d.path[d.path.length - 1];
            if (Math.hypot(dEnd.x - targetSub.x, dEnd.y - targetSub.y) >= 50) return false;
            if (d.status === 'pausing' && !d.moneyAdded) return true;
            if (d.status === 'traveling') {
              // Only block if this dot is past all queues in its path (on the final segment to subscriber)
              const dPos = interpolatePath(d.path, d.progress);
              const isPastAllQueues = !d.path.some((wp, idx) => {
                if (idx >= d.path.length - 1) return false; // skip last waypoint
                const q = state.components.find(c =>
                  c.type === 'queue' && Math.abs(c.x - wp.x) < 1 && Math.abs(c.y - wp.y) < 1
                );
                if (!q) return false;
                // Is the dot still at or before this queue?
                const queueProgress = idx / (d.path.length - 1);
                return d.progress <= queueProgress + 0.01;
              });
              return isPastAllQueues;
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
            // Apply path extension only at release time so queued dots aren't mutated every frame
            if (pendingExtension) {
              const queueComp2 = state.components.find(c => c.id === queueId)!;
              const extension: { x: number; y: number }[] = [];
              if (Math.abs(queueComp2.y - pendingExtension.target.y) >= 1) {
                const midX = (queueComp2.x + pendingExtension.target.x) / 2;
                extension.push({ x: midX, y: queueComp2.y });
                extension.push({ x: midX, y: pendingExtension.target.y });
              }
              extension.push(pendingExtension.target);
              const newPath = [...dot.path, ...extension];
              const oldLen = dot.path.length - 1;
              const newLen = newPath.length - 1;
              dot = { ...dot, path: newPath, progress: oldLen > 0 ? (dot.progress * oldLen) / newLen : 0 } as typeof dot;
            }
            releasedQueues.add(queueId);
            // Set progress past the queue's far edge so the dot won't re-collide.
            // Since queued dots render at queue center (EventCanvas snaps them),
            // and queue nodes render above the event canvas (z-26 vs z-25),
            // the dot will appear to emerge from behind the queue.
            const queue = state.components.find(c => c.id === queueId);
            let releaseProgress = dot.progress;
            if (queue) {
              const totalSegments = dot.path.length - 1;
              // Find the queue's waypoint index in the path
              let bestIdx = 0;
              let bestDist = Infinity;
              for (let pi = 0; pi < dot.path.length; pi++) {
                const d = Math.hypot(dot.path[pi].x - queue.x, dot.path[pi].y - queue.y);
                if (d < bestDist) { bestDist = d; bestIdx = pi; }
              }
              // Calculate how far past the queue waypoint we need to go to clear dotTouchesNode
              if (bestIdx < totalSegments) {
                const from = dot.path[bestIdx];
                const to = dot.path[bestIdx + 1];
                const segLen = Math.hypot(to.x - from.x, to.y - from.y);
                // Need to clear NODE_HALF_W + DOT_RADIUS to exit the bounding box
                const clearanceFraction = segLen > 0 ? (NODE_HALF_W + DOT_RADIUS + 2) / segLen : 1;
                releaseProgress = Math.min((bestIdx + clearanceFraction) / totalSegments, 1);
              }
            }
            updated[i] = { ...dot, status: 'traveling', progress: releaseProgress, pauseStartTime: undefined, queuedAtNodeId: undefined } as Dot;
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

export function useAutoPublisher() {
  const autoPubLevel = useGameStore(s => s.upgrades.autoPubLevel);
  const fireEvent = useGameStore(s => s.fireEvent);
  const components = useGameStore(s => s.components);

  useEffect(() => {
    if (autoPubLevel === 0) return;

    const intervals = [5000, 3000, 1000, 750, 500, 250, 100];
    const interval = intervals[Math.min(autoPubLevel - 1, intervals.length - 1)];
    const timer = setInterval(() => {
      const firstPub = components.find(c => c.type === 'publisher');
      if (firstPub) {
        fireEvent(firstPub.id, true);
      }
    }, interval);

    return () => clearInterval(timer);
  }, [autoPubLevel, fireEvent, components]);
}
