# Event Dot Lifecycle

```ts
type EventDot = {
  id: string;
  path: { x: number; y: number }[];  // waypoints from getAllPathsForPublisher()
  progress: number;                   // 0.0 → 1.0 along full path
  speed: number;                      // normalizedSpeed(0.0007 * propagationSpeed, path) — constant per-hop duration
  status: 'traveling' | 'pausing' | 'queued' | 'dropped' | 'consumed';
  pauseStartTime?: number;            // Date.now() when pausing began
  queuedAtNodeId?: string;            // queue component ID when status is 'queued'
  dropX?: number;
  dropY?: number;
  dropVY?: number;
  color: string;
  opacity: number;
  value: number;
  moneyAdded?: boolean;               // true once consumeEvent() has credited earnings
  isRetry?: boolean;                  // true for DMQ retry dots (orange, no re-catch)
  originalNodeIds?: string[];         // node IDs of the original path, used to rebuild fresh path on DMQ release
  nodeWpIndices?: number[];           // waypoint index of each node in originalNodeIds on the current path (set during drag rebuild, cleared after post-drag cleanup)
  originalValue?: number;             // publisher event value at creation, used for DMQ value recovery calc
  forkPaths?: { waypoints: { x: number; y: number }[]; nodeIds: string[] }[];  // additional paths to spawn when dot reaches fork broker
  forkNodeId?: string;               // broker ID where fork dots should spawn
};
```

## Event value pipeline
- Publisher sets initial value: `$0.50 + level * 0.45 + level² * 0.05` (accelerating increments)
- Subscriber adds consumption value: `$0.50 + level * 0.45 + level² * 0.05` (same formula)
- Global multiplier applied in `consumeEvent()`: `finalValue * globalValueMultiplier`
- Value is passed directly to `consumeEvent(id, value)` — no dot lookup needed

## Collision detection
- `dotTouchesNode(px, py, nodeX, nodeY)` tests a 6px-radius dot against node bounding boxes (NODE_HALF_W=60, NODE_TOP_OFFSET=28, NODE_BOTTOM_OFFSET=28)
- Webhook/broker blockage uses proximity check (30px radius) + `isComponentOccupied()` (checks for pausing/queued dots)
- **Path-ordered interaction**: dots only collide with the **next** queue or subscriber on their path (determined from `pathComps` by progress). This prevents dots from being captured by nodes they physically overlap but haven't reached yet along their connection route. DMQ catch is exempt — it uses spatial-only collision on falling dots.

## Broker-level forking
When multiple downstream paths exist (fan-out or bridge), `fireEvent` creates one dot per unique first-broker. Extra paths are stored as `forkPaths` on the dot. When the dot reaches the fork broker (detected via `dotTouchesNode` in `useGameLoop`), fork dots are spawned from the broker position for each additional path. Fork dot IDs are generated via `nextDotId()` exported from `gameStore.ts`.

## Key behaviors
- `traveling` → slows through webhook when dot visually overlaps the webhook node, drops near webhook/broker if component is occupied
- `traveling` → on collision with next queue on path, always transitions to `queued` if buffer has space, otherwise drops
- `traveling` → on collision with next subscriber on path (only if no queue ahead), transitions to `pausing` if subscriber is free, otherwise drops
- `queued` → predictive auto-release: one per queue per frame. Queue computes travel time to the target subscriber and when the subscriber will be free (`latestSlotOpen`). Travel time accounts for the subscriber's collision box via `getArrivalProgress()` — dots are caught by `dotTouchesNode` before reaching progress 1.0, so the prediction uses the actual arrival progress (based on approach direction and node dimensions) rather than the path endpoint. Releases when `latestSlotOpen <= travelTime` so the dot arrives exactly as the subscriber finishes consuming. Without fan-out, checks the round-robin target; with fan-out, waits until ALL connected subscribers satisfy the timing condition. Path dynamically rebuilt as queue→subscriber at release time. 50ms tolerance margin at subscriber arrival prevents frame-timing drops.
- `pausing` → at end of consume duration (1s base), value is passed directly to `consumeEvent(id, value)` and dot is removed from array
- `dropped` → gravity fall + fade over 1.2s; position is where the blockage occurred. Non-retry dots can be caught by the DMQ. Retry dots turn dark grey and cannot be re-caught. `eventsDropped` counter incremented via batch `setState` after the dot loop.

## Game loop pattern
- Dots are processed sequentially in a `for` loop (not `.map()`) building a mutable `updated` array, so each dot sees the results of earlier dots in the same frame.
- Side-effect counters (`droppedCount`) are accumulated during the dot loop and applied to the store in a single `setState` call after `updateDots` completes.
- Three passes per frame: Pass 1 (main dot loop: travel, collide, drop, DMQ catch, live path rebuild during drag, post-drag cleanup on first frame after drag ends), Pass 2 (queue auto-release, skips DMQ-queued dots; time-throttled during drag via `queueLastReleaseTime`), Pass 3 (DMQ time-throttled auto-release: one dot every 500ms. If first target on retry path is a queue, releases unconditionally on the timer (drops on arrival if queue full). If subscriber, uses same timing prediction as Pass 2. Rebuilds path from current positions).
- **Queue release path truncation**: when a dot is released from a queue (Pass 2), its path is rebuilt as queue→subscriber only (not the full publisher→...→queue→subscriber). This ensures `normalizedSpeed` is calculated on the remaining segments, so dots travel at consistent visual speed regardless of how many hops preceded the queue. With fan-out, the queue creates additional dot copies for each extra connected subscriber.
