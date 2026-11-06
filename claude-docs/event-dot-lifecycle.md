# Event Dot Lifecycle

The dots live in the simulation (`src/sim/sim.ts`: a `Sim` instance that runs in the Web Worker, or inline — see `dev-notes.md` → "Round 4 — worker"), never in the store. The type is in `src/sim/types.ts`:

```ts
type EventDot = {
  id: string;
  path: { x: number; y: number }[];  // waypoints from getAllPathsWithNodes() (meshRules.ts); sliced at the spawn broker for forks, queue→subscriber for releases
  progress: number;                   // 0.0 → 1.0 along the path (a staggered batch starts below 0)
  speed: number;                      // normalizedSpeed(0.0007 * propagationSpeed, path) — constant per-hop duration. Visual pixel speed is made uniform across segments by the route profile's segment scales
  progressPerMs: number;              // progress per ms the next tick will move the dot by (segment scale and zone multipliers applied) …
  speedUntilP: number;                // … and the progress at which the sim next changes or stops that motion; written per tick, read only by fillPositions (the canvas extrapolates between ticks)
  count: number;                      // events this dot stands for (a batch fire travels as one bundle dot where that is exact); every rule that counts events uses it
  status: 'traveling' | 'pausing' | 'queued' | 'dropped' | 'consumed';
  pauseStartTime?: number;            // nowMs when pausing/queuing began
  queuedAtNodeId?: string;            // queue or DMQ component ID when status is 'queued'
  dropX?: number;
  dropY?: number;
  dropVY?: number;                    // fall velocity in px per ms of sim time
  color: string;
  opacity: number;
  value: number;
  moneyAdded?: boolean;
  isRetry?: boolean;                  // true for DMQ retry dots (orange, no re-catch)
  originalNodeIds?: string[];         // node IDs of the original route, used to rebuild the path during drags and on DMQ release
  nodeWpIndices?: number[];           // waypoint index of each node in originalNodeIds on the current path (set during drag rebuild, cleared after post-drag cleanup)
  originalValue?: number;             // publisher event value at creation, used for DMQ value recovery calc
  forkStep?: ForkStep;               // head of the dot's fork-step list: { nodeId, forks[], next } — at broker nodeId spawn one copy per fork (each fork: full route waypoints/nodeIds, its own value/color, and its own `steps` for where its routes diverge further on), then continue with next; see src/sim/forkTree.ts
  nextNodeId?: string;               // ID of the next queue/subscriber this dot should interact with — gates capture to that node's profile mark, so unrelated nodes on the geometry never capture it
  bridgeGoldAfterNodeId?: string;    // broker node this dot must pass before switching to the bridge-crossing gold color; cleared once triggered
};
```

Every creation site sets every per-tick field (`progressPerMs`, `speedUntilP`, `count`, …) so all dots share one object shape; the sim advances dots **in place** and only a status change makes a new object. A dot stands for `count` events (`scale-plan.md` Phase C): `buildPublishDots` (`src/sim/publish.ts`) emits one dot per plan entry with `count = fireCount` when the fire's routes make that exact (`routesBundleExact`: no webhook on the route and 0 ms subscribers at its end), otherwise `fireCount` staggered dots of `count` 1, as before bundles.

## Event value pipeline
- Publisher sets initial value via `getEventValue(mesh, publisherId)` (`src/sim/meshRules.ts`): `(1.0 + level * 0.45 + level² * 0.05 + permanentValueBoost) * getPublisherTierMultiplier(networkTier)`, where `networkTier` is the publisher's permanent purchase-order tier (`1 + tier * 0.1` multiplier; undefined/0 for the starter publisher)
- If the dot's route crosses a broker-to-broker bridge, its value is multiplied by `BRIDGE_VALUE_MULT` (1.5) once at creation, flat regardless of hop count — computed per dot (and per fork, since a fan-out can send some paths across a bridge and others not) via `pathCrossesBridge()` / `firstBridgeExitNodeId()`
- If the dot's route passes through a queue, its value is multiplied by `getQueueValueMultiplier()` (1 + 5% per queue hop) at creation, computed per dot and per fork from that path's `nodeIds`
- Subscriber applies a consumption multiplier when the dot starts pausing (`sim.ts`): `1.0 + level * 0.08 + level² * 0.02`, multiplied directly against `dot.value` (not additive)
- When the consume completes the dot is reported in `TickSummary.consumed` as `{ id, value, subscriberId, count }`; `commitFrame` → `applyConsumes` (`gameStore.ts`) applies the global multiplier and the permanent payout multipliers and credits `value × count` in the tick's single store commit. The store never looks a dot up

## Bridge color switch
- A dot that will cross a bridge is created cyan with `bridgeGoldAfterNodeId` set to the broker node it exits through before crossing (from `firstBridgeExitNodeId()`). It stays cyan for the publisher→broker leg.
- Each tick in `Sim.tick`'s traveling branch, once the dot's progress passes that broker's waypoint (progress-based, not a pixel test: a long tick can jump clean over a box), the dot's color flips to `BRIDGE_GOLD_COLOR` (`#fde047`) and the field is cleared.
- Fork dots (see below) spawn already positioned at the fork broker, so if their path crosses a bridge they're colored gold immediately at creation instead of waiting for this check.

## Collision detection
- `dotTouchesNode(px, py, nodeX, nodeY)` is the geometric definition: a 6px-radius dot against the node's box (`getNodeHalfExtents`: 60×28 half-extents for a card, the cluster's for a DMR Cluster). The sim does not run it per dot per tick. The **route profile** (`getPathInfo` → `PathInfo`, cached per path array, rebuilt when components change) precomputes per path: one `NodeMark` per node with its waypoint progress (`centerP`) and the progress at which a dot first touches its box (`touchStart`), the webhook (×0.4) and DMR Cluster (×2.5) speed zones, the webhook approach band, and per-segment speed scales. Rules fire by comparing the dot's progress to those marks: broker crossings and the gold switch at `centerP`, fork spawn at `touchStart`, queue/subscriber capture at `touchStart` (or `centerP − 0.01` with `nextNodeId`). A tick that jumps past a mark triggers the rule late instead of never. Add new position-based rules as profile zones/marks, never as per-dot `interpolatePath` tests; pixel positions are computed only when a rule fires (drop coordinates).
- Webhook blockage: the profile's approach band before the webhook plus `isComponentOccupied()` (a traveling dot inside the webhook box). Brokers never block; they cap (the relay window below).
- **Path-ordered interaction**: dots only interact with the **next** queue or subscriber on their route. **`nextNodeId` gating**: when set, only the component with that ID can capture the dot (by its mark), so a queue/subscriber sitting on an unrelated segment of the geometry (e.g. on the DMQ→broker or publisher→broker line) cannot. Set at creation from `originalNodeIds` via `findNextInteractableId()`, updated on queue release to the target subscriber. DMQ catch is exempt — it is spatial, on falling dots.

## Broker-level forking
When multiple downstream paths exist (fan-out or bridge), the publish plan (`src/sim/publish.ts`) creates one dot per unique first-broker and gives it a **fork tree** (`src/sim/forkTree.ts`): the group's routes are partitioned by their next hop after that broker; the dot itself follows the first partition's route, every other partition contributes one fork at that broker, and a partition whose next hop is another broker (a bridge) recurses there, so the fork is spawned at the far cluster for the routes that diverge only after it. The dot carries the result as `forkStep` (a linked list of `{ nodeId, forks[], next }`; each fork has its own precomputed `value`/`color`, bridge-aware, and its own `steps`). When the dot's progress reaches the head step's broker (the route profile's `touchStart`), `Sim.tick` spawns one dot per fork from the broker position (sliced route, `forkSpawnFor`), charges each to that broker's relay cap (a copy relayed down another link, so a cluster pays once per bridge or queue it fans out on and the cluster at the far end of a bridge pays for its own fan-out, like real DMR), using `fork.value ?? dot.value` and `fork.color ?? dot.color`, and advances to the next step. Each fork takes its own relay slots with the count the dot arrived at that broker with, whatever the cap did to the dot itself; a dot refused outright loses every step past that broker (a lost link copy takes the deliveries behind it along). So each spawn charges the spawn broker and each crossing charges the broker crossed: 2 / 4 / 4 relays per event in the harness's `F` layout (ingestion cluster / each bridged cluster). Fork dot IDs come from `nextDotId()` (`publish.ts`). During node drag, the fork routes (through nested steps) are rebuilt each frame alongside the main `path` so fork dots don't spawn on stale coordinates if a broker has moved.

## Key behaviors
- `traveling` → speed from the profile at the dot's progress (segment scale × zone multiplier × propagationSpeed). Every broker whose `centerP` the dot crosses this tick is charged `count` relay slots (`tryBrokerRelay`, a rolling 1 s window per broker against its cap); a bundle that does not wholly fit is relayed in part — head passes, tail drops at that broker. Drops near an occupied webhook, and drops if the remaining route's connections no longer exist
- `traveling` → on reaching the next queue's mark, `queued` (the whole bundle) if `queuedCount < bufferSize` (the backlog as of the previous tick; same-tick arrivals do not count, so a batch larger than the buffer is admitted when the queue is not already backed up, exactly as its events were as separate dots), otherwise drops as queue-full
- `traveling` → on reaching the next subscriber's mark (only if no queue ahead), `pausing` if the subscriber is free, otherwise drops as subscriber-occupied (a 0 ms subscriber is never busy)
- `queued` → predictive auto-release (Pass 2): per queue, in arrival order, the candidate's travel time to the target subscriber (`scaledTravelTime()`, to the collision-box arrival progress `getArrivalProgress()`) is checked against everything already heading there using the per-subscriber arrival index (`src/sim/releaseIndex.ts`): it must arrive no earlier than the subscriber is free and must not make a later arrival collide. Without fan-out the round-robin target; with fan-out ALL connected subscribers must pass and one copy per subscriber is released, each carrying `count`. The release path is rebuilt as queue→subscriber (shared per (queue, subscriber) in `releasePathCache`) and same-tick releases are staggered along it. 50ms tolerance margin at subscriber arrival prevents tick-timing drops
- `pausing` → at the end of the consume duration (`consumeDurationFor`: 1 s base, 0 ms at fasterConsumption ≥ 11) the dot goes into `TickSummary.consumed` and is removed; while pausing it is drawn shrinking on the front canvas (above the cards)
- `dropped` → gravity fall (px/ms over dt) and fade over 2.5 s from where the blockage occurred; the events are added to `droppedCount` in the summary and `commitFrame` adds that to `eventsDropped`. Non-retry dots can be caught by the DMQ (`min(free slots, count)` events; the rest keeps falling). Retry dots turn dark grey and cannot be re-caught. Beyond `DROPPED_VISUAL_CAP` (300) falling dots, new drops are counted but not animated unless they fall where the DMQ could catch them

## `Sim.tick` (the game loop)
One call per input from the bridge (`src/hooks/useSimBridge.ts` sends one per animation frame when the previous tick has returned, otherwise the accumulated frame delta with the next one); dt is clamped to `MAX_FRAME_DT_MS` (100 ms), so below 10 ticks/s the sim runs slower than real time. Sections, each timed into `tickSections` (`behavior.mjs` reports them as `sectionMsPerTick`):
1. Manual fires: the publisher clicks queued since the last tick (`SimInput.manualFires`, cooldown-checked by the store's `fireEvent` and queued with `queueManualFire`) are built with `buildPublishDots` and appended before anything moves.
2. `setup`: per-tick lookups built once (component maps, the DMQ's free capacity, pausing dots bucketed per subscriber, each queue's backlog from the previous tick, the drag / post-drag path rebuilds).
3. `pass1`: the main dot loop over a mutable `updated` array (a `for` loop, not `.map()`), so each dot sees the results of earlier dots in the same tick — `traveling` (profile speed, broker crossings, fork spawn, gold switch, webhook / queue / subscriber rules), `pausing` (consume completion), `dropped` (fall, DMQ catch); `queued` dots are kept.
4. `index`: the per-subscriber arrival index for the release check (skipped for subscribers with a 0 ms consume, where the check can never reject).
5. `pass2`: queue auto-release (skips DMQ-queued dots; time-throttled per queue during a drag via `queueLastReleaseTime`).
6. `pass3`: DMQ release, one **event** every 500 ms (`lastDmqReleaseTime`; a caught bundle goes out one event at a time). If the retry route's first target is a queue it releases on the timer (drops on arrival if the queue is full); if a subscriber, the same timing check as Pass 2. The path is rebuilt from current positions; the DMQ may be wired to a different broker than the original route's, in which case a DFS through bridges finds a route to the original destination.
7. `sigs`: `queueSlotSignatures` (one char per queued event, oldest first, cut at the buffer size) and `webhookFill` for the cards.
8. `publish`: the auto-publisher poll on sim time (every `AUTO_PUB_POLL_MS` = 100 ms of clamped dt, anchored to nominal poll times): the due publishers' dots are built and appended, and their ids and fire counts go into the summary for the store's cooldown map and publish rate.

The `TickSummary` (`consumed`, `droppedCount`, `publisherIds`/`publishes`, `queueSlotSignatures`, `activeDrops`, `brokerRelayCounts`, `subscriberConsume`, `webhookFill`, `firstDropAt`, `simNow`, `liveDots`/`liveEvents`) is returned; the worker then runs `fillPositions` into the free position buffer and posts both back, and `commitFrame` applies the summary with one plain store `set`. Side-effect counters are never applied mid-loop.
- **Queue release path truncation**: when a dot is released from a queue, its path is rebuilt as queue→subscriber only (not the full publisher→…→queue→subscriber), so `normalizedSpeed` is computed on the remaining segments and dots travel at consistent visual speed regardless of how many hops preceded the queue.
