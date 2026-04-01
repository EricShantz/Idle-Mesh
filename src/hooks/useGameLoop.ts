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

      // Helper: check if a component is occupied (has a pausing/queued dot)
      const isComponentOccupied = (componentId: string) => {
        const comp = state.components.find(c => c.id === componentId);
        if (!comp) return false;
        return state.eventDots.some(d => {
          if (d.status !== 'pausing' && d.status !== 'queued') return false;
          const lastPos = d.path[d.path.length - 1];
          return Math.hypot(comp.x - lastPos.x, comp.y - lastPos.y) < 50;
        });
      };

      state.updateDots(dots => {
        type Dot = import('../store/gameStore').EventDot;
        // Use a mutable array so each dot sees the results of earlier dots in the same frame
        const updated: Dot[] = [];

        for (let i = 0; i < dots.length; i++) {
          let dot = dots[i];

          if (dot.status === 'traveling') {
            let actualSpeed = dot.speed * state.upgrades.propagationSpeed;

            const eventPos = interpolatePath(dot.path, dot.progress);

            const webhookComponent = state.components.find(c => c.type === 'webhook');
            if (webhookComponent && dotTouchesNode(eventPos.x, eventPos.y, webhookComponent.x, webhookComponent.y)) {
              const fasterRoutingLevel = webhookComponent.upgrades['fasterRouting'] ?? 0;
              const slowFactor = Math.min(1.0, 0.4 + fasterRoutingLevel * 0.2);
              actualSpeed *= slowFactor;
            }
            const blockRadius = 30;

            let blocked = false;
            for (const comp of state.components) {
              if (comp.type === 'publisher') continue;
              const distToComp = Math.hypot(eventPos.x - comp.x, eventPos.y - comp.y);
              if (distToComp < blockRadius && isComponentOccupied(comp.id)) {
                if (comp.type === 'webhook' || comp.type === 'broker') {
                  updated.push({ ...dot, status: 'dropped', dropX: eventPos.x, dropY: eventPos.y, dropVY: 0, color: '#ff4444' } as Dot);
                  blocked = true;
                  break;
                }
              }
            }
            if (blocked) continue;

            const newProgress = Math.min(dot.progress + actualSpeed * dt, 1);
            const newPos = interpolatePath(dot.path, newProgress);

            // Check collision with queues along the path
            let queued = false;
            for (let j = 0; j < dot.path.length - 1; j++) {
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
                updated.push({ ...dot, status: 'dropped', dropX: newPos.x, dropY: newPos.y, dropVY: 0, color: '#ff4444' } as Dot);
              }
              continue;
            }

            if (newProgress >= 1) {
              const endPos = dot.path[dot.path.length - 1];
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
          const dot = updated[i];
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

          // Check if subscriber is free — check against the updated array
          const subscriberPos = dot.path[dot.path.length - 1];
          const isSubscriberBusy = updated.some(d =>
            d.id !== dot.id &&
            d.path.length > 0 &&
            Math.hypot(d.path[d.path.length - 1].x - subscriberPos.x, d.path[d.path.length - 1].y - subscriberPos.y) < 50 &&
            (
              (d.status === 'pausing' && !d.moneyAdded) ||
              // Only count traveling dots that are past the queue (between queue and subscriber)
              (d.status === 'traveling' && d.progress > dot.progress)
            )
          );

          if (!isSubscriberBusy) {
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
