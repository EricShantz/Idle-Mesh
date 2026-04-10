# Development Notes

## Testing & Debugging
- **Starting balance for testing**: change `balance: saved?.balance ?? 5000000` in `gameStore.ts`. Clear localStorage **then hard-refresh the page** (Ctrl+Shift+R) to reset — the auto-save subscriber will re-persist in-memory state if the tab stays open.
- **Component IDs**: initial components use fixed IDs (`pub-1`, `webhook-1`, `sub-1`, `conn-1`, `conn-2`). Dynamically added components use counter-based IDs starting at 10 (`comp-10+`, `conn-10+`). Counters are initialized from saved state on load via `initCountersFromSaved()` to prevent duplicate IDs.

## Collision & Thresholds
- `useGameLoop.ts` uses `dotTouchesNode()` bounding-box collision for all node interactions: webhook slowdown, queue capture, subscriber pause/drop. Exception: when a dot has `nextNodeId` set, queue/subscriber capture uses progress-based detection instead of hitbox collision to avoid premature capture by nodes on unrelated path segments.
- Webhook blockage uses a 20px approach zone before the node's left edge; `isComponentOccupied()` detects traveling dots inside the webhook via `dotTouchesNode()`. Brokers skip blockage entirely.

## Viewport (Pan/Zoom)
- Managed by `useViewport.ts` — a React context holding a mutable ref `{ panX, panY, zoom }` with lightweight pub/sub (not Zustand, to avoid mass re-renders).
- All component positions in the store remain "world" coordinates. Transform: `screenX = worldX * zoom + panX`.
- Each rendering layer applies this independently: SVG uses `<g transform>`, canvases use `ctx.setTransform()` (with DPR scaling), HTML nodes use `worldToScreen()` for `left`/`top` + CSS `transform: scale(zoom)`.
- All pointer events reverse-transformed via `screenToWorld()`. Node drag deltas divided by zoom.

## Drag-to-Move
- Implemented in `NodeCard.tsx` using pointer capture + ref-based drag state. RAF-throttled state updates. Final position flushed synchronously on pointer up.
- `draggingNodeId` (transient, in store) is set when drag movement begins and cleared on pointer up.
- **Y-snap on drop**: on pointer up, if the node's Y is within 10px of any connected neighbor's Y, the node snaps to that neighbor's Y. This ensures nearly-horizontal connections become perfectly straight, eliminating the small orthogonal step that would otherwise cause dots to visibly climb/descend.

## Live Path Rebuilding During Drag
- When a component is being dragged, all in-flight dots whose `originalNodeIds` include the dragged component have their paths rebuilt every frame via `rebuildPathFromNodeIds()`.
- **Reverse bridge path matching**: broker bridges are bidirectional — dots can traverse a connection in either direction. When a dot travels in the reverse direction of the stored connection (e.g., dot goes B→A but connection is A→B), waypoints are computed in the connection's actual direction (matching the SVG line) and then the intermediate points are reversed. This ensures dots always follow the visually displayed path. The same logic applies in `rebuildPathFromNodeIds()`, `getAllPathsForPublisher()`, and the DMQ retry path builder.
- `rebuildPathFromNodeIds()` accepts an optional `connections` parameter for reverse bridge detection. It returns both the path and `nodeWpIndices` (waypoint index of each node center). Progress is remapped via `remapProgressSemantic()` which identifies the dot's logical segment (e.g. broker→queue) using node waypoint indices, then projects the dot's pixel position onto only that segment of the new path. This prevents dots from jumping across segment boundaries (e.g. skipping a queue) while avoiding progress oscillation from waypoint-count changes.
- **Fork path rebuilding during drag**: dots with `forkPaths` (pre-computed alternate broker paths) also have their fork waypoints rebuilt each frame if the dragged node appears in any fork's `nodeIds`. This prevents fork dots from spawning on stale/ghost paths when a broker is moved. The same rebuild runs during post-drag cleanup.
- **Post-drag cleanup**: on the first frame after drag ends (`!draggingNodeId && dot.nodeWpIndices`), paths are rebuilt one final time from current (post-Y-snap) positions, including `forkPaths`. Queued dots are pinned to their queue's waypoint; traveling dots are semantically remapped. `nodeWpIndices` is cleared so this runs only once.
- **Progress-based queue capture during drag**: pixel-based `dotTouchesNode` collision can fail during drag because orthogonal paths are rebuilt each frame (dot pixel position shifts while progress approaches the queue). As a fallback, dots are captured when their progress reaches the queue's waypoint progress (`newProgress >= queueProgress`), gated on `draggingNodeId`.
- **Time-throttled queue releases during drag**: `shouldReleaseTo` timing is unreliable during drag because in-flight dots' paths/speeds are rebuilt each frame. A per-queue `queueLastReleaseTime` map enforces a minimum interval equal to the subscriber's consume duration between releases, preventing rapid queue draining. Only active while `draggingNodeId` is set.
- Connection validation is bypassed while `draggingNodeId` is set.

## Draggable Connections
- `draggingConnection` transient state tracks active drag (type, fromId, connectionId, mouseX, mouseY).
- `MeshCanvas.tsx` handles pointer move/up for drop detection (bounding-box: 70px × 38px).
- `ConnectionLine.tsx` hides itself during reassign drag and initiates detach on click.
- `cancelDragConnection` deletes the connection when a reassign drag is dropped on nothing. Validation via `connectionRules.ts`.

## Connection Line Geometry
- Orthogonal (Boomi-style) lines routed horizontal → vertical → horizontal with rounded 12px corners.
- Port position = `from.x + halfW + 16` where halfW is 60 (120px nodes) or 70 (140px queue nodes).
- DMQ uses top-center port (`from.x, from.y - 28 - 16`) with vertical-first routing via `computeVerticalFirstWaypoints()`, terminating at broker's bottom edge (`to.x, to.y + 30`). Node-aware: detours around node bodies when the simple path would clip, descending on the broker-facing side of the DMQ and entering the broker from below.
- All nodes use `minHeight: 56` and fixed `width` for consistent port alignment (DMQ width is dynamic: 120 + 40 * dmqWidthLevel).
- **Node-aware routing**: `computeOrthogonalWaypoints()` in `orthogonalPath.ts` is the single source of truth for routing. It accepts optional `NodeBounds` for source and target nodes. When the midpoint vertical segment would clip through either node (e.g. nodes vertically aligned or target to the left), it routes a 6-point detour: right to clear source → vertically past source → left to clear target → vertically to target Y → right into target. Lines always exit right from the source port and enter left into the target.
- `buildSvgPathFromWaypoints()` draws rounded corners for any number of waypoints (generic, not limited to 4 points).

## Dot Path Waypoint Expansion
- `_getAllPathsWithNodes()` walks node centers, then expands non-horizontal segments into orthogonal waypoints using `computeOrthogonalWaypoints()` with node bounding boxes, keeping dot paths in sync with SVG connection lines.

## Smart Routing & Fan-out
- `_getAllPathsWithNodes()` does DFS returning paths with both waypoints and node IDs. Bridge connections traversed bidirectionally.
- `fireEvent()` groups paths by broker, deduplicates by queue. Broker always fans out to ALL matching queues — one dot per unique queue per broker.
- Queue-level fan-out (Persistent Delivery) handled at release time in Pass 2. Broker never duplicates per-subscriber; only per-queue.

## Path Deduplication
- `dedupeConsecutiveWaypoints()` removes consecutive duplicate waypoints (within 1px) from rebuilt paths in Pass 2 queue release. Without this, when queue and subscriber share the same x-coordinate, `isPastAllQueues` fails and queues drain at ~60×/s.

## Connection-Aware Dot Lifecycle
- Traveling dots validate their remaining path against the current connection graph each frame — if a connection was removed, the dot drops immediately. When `originalNodeIds` is set, validation uses the authoritative node ID list instead of geometric `pathComps`, avoiding false invalidation from unrelated nodes sitting on the path geometry.
- Queued dots only release when the queue has an active connection to a subscriber (checked via `state.connections`, not baked path).
- Queue collision check skips waypoints the dot has already passed to prevent re-capture after release.

## ID Counters & Clock
- `componentIdCounter` and `connectionIdCounter` initialized from saved state on load via `initCountersFromSaved()`.
- `nextDotId()` exported from `gameStore.ts` for use in `useGameLoop.ts` when spawning fork dots.
- `pauseStartTime` uses `Date.now()` (Unix epoch). The RAF `time` argument is a different clock — don't mix them.

## Speed Double-Application
- `dot.speed` is set to `normalizedSpeed(0.0007 * propagationSpeed, path)` at creation/release. During movement, `actualSpeed = dot.speed * propagationSpeed`. This means `propagationSpeed` is applied **twice** (squared). Any code predicting travel time must account for this: `travelTime = (arrivalProgress - progress) / (dot.speed * propagationSpeed)`.

## Constant Pixel Speed (Segment Speed Scaling)
- Orthogonal paths have segments of varying pixel length, but progress is distributed equally by segment count. Without correction, dots visually speed up on long segments and slow down on short ones.
- `getSegmentSpeedScale(path, progress)` in `pathUtils.ts` returns `avgSegmentLength / currentSegmentLength` — a multiplier applied to `actualSpeed` in the game loop before the progress increment. Long segments get slowed down, short segments get sped up, resulting in constant visual pixel speed.
- All `index / (path.length - 1)` progress math for drag, queue pinning, and path validation remains unchanged.
- **Predictive timing must use `scaledTravelTime()`**: queue release and DMQ release predictions must account for segment speed scaling. The helper `scaledTravelTime(path, startProgress, endProgress, baseActualSpeed)` in `pathUtils.ts` integrates travel time across segments with their individual scale factors. Using simple `progressDelta / speed` will underestimate travel time on paths with long segments (e.g. subscriber above/below queue), causing premature releases and drops.

## Arrival Progress & Collision Box
- `dotTouchesNode` catches dots before they reach progress 1.0 — the subscriber's bounding box (NODE_HALF_W=60, NODE_TOP_OFFSET=28) extends well beyond its center point. Predictive timing uses `getArrivalProgress(path)` to compute the actual progress at which a dot enters the subscriber's collision box, based on the last segment's direction: horizontal approach catches at `NODE_HALF_W + DOT_RADIUS` (66px), vertical at `NODE_TOP_OFFSET + DOT_RADIUS` (34px). Using `1.0` instead of `arrivalProgress` overestimates travel time and causes premature queue releases at high propagation speeds.

## Upgrade Implementation
- Most per-component upgrade effects are read in `useGameLoop.ts` by looking up the component by position from the dot's path array. Global upgrade effects applied in `purchaseGlobalUpgrade` in `gameStore.ts`.
- `getUpgradesForType` is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync when adding new component types.
- `UpgradeDef` has optional `hidden?: boolean`. Used for `topicFilterBoost`. `subscriptionBroaden` is conditionally hidden when queue has no `subscriptionTopic`.

## DMQ Mechanics
- DMQ catch detection runs inside the `dropped` dot branch of Pass 1 — checks `!dot.isRetry` to prevent infinite loops.
- DMQ catch capacity is pre-computed from the source `dots` array before the main loop and incremented on each catch, preventing undercounting when existing queued dots appear later in iteration order.
- DMQ release (Pass 3) is time-throttled: releases one dot every 500ms (`lastDmqReleaseTime`). If the retry path's first target is a queue, it releases unconditionally on the timer — if the queue is full on arrival, the dot drops (and won't be re-caught since `isRetry` is true). If the target is a subscriber, uses predictive timing (same logic as queue release, including `getArrivalProgress` for collision-aware travel time). Retry paths rebuilt at release time from `dot.originalNodeIds` using current positions.
- DMQ can release to any connected broker, not just the original route's broker. When the connected broker differs from the original, a DFS walk (following connections + reverse bridges, same pattern as `_getAllPathsWithNodes`) finds a path from the connected broker to the original destination queue/subscriber.
- DMQ width for collision = `(120 + dmqWidthLevel * 40) / 2` as half-width.

## Adaptive Coin Pop Throttling
- `consumeEvent()` tracks per-subscriber pop rate via module-level `coinPopTracking`. Smoothed FPS via `getSmoothedFps()` using low-pass filter.
- Three tiers: ≥50 FPS (5 pops/sec, 12 max), 35–49 FPS (2 pops/sec, 6 max), <35 FPS (1 pop/sec, 3 max). Skipped pops aggregate amounts.

## Adding New Shop Items
- Add action logic to `gameStore.ts`, add UI to `Sidebar.tsx` shop section. New components placed unconnected; user wires via drag-to-connect.

## Connection Slot Limits
- Enforced in both `getValidTargets()` and `completeDragConnection()`. Broker→queue limited by `addQueueSlot` level, queue→subscriber by `addSubscriberSlot` level, broker→broker by `addBridgeSlot` level (both brokers must have a free slot — a single drag consumes one slot on each end), publisher limited to 1 broker.
- All slot checks exclude the connection being reassigned. Existing saves with more connections than upgrade levels are grandfathered.

## Event Batching
- `batchFire` number in `upgrades` state. `fireEvent` creates `batchFire` dots per path — each starts at `progress: batch * -0.04`.
- `interpolatePath()` clamps negative progress to path start. Old boolean saves migrated to level 1.

## Topic Subscription Picker
- `getAvailableTopics(queueId)` walks broker connections (including bridges) to find all reachable publishers. Returns ALL broadening levels (0 through queue's current `subscriptionBroaden` level) for each publisher, deduplicated by broadened topic string.
- `setQueueSubscription(queueId, topic, segments, broadenLevel)` updates atomically. UI in `NodeModal.tsx`. Picker state resets on node switch via `key={node.id}`.
- Picker groups topics by domain (segment index 1), sorted alphabetically; cross-domain topics (e.g. `acme/>`) appear last. Within each group, topics sort specific→broad (by `broadenLevel`), then by last segment with numeric-aware comparison (SKU001, SKU002, …).
- Picker uses `data-scroll-trap` attribute so wheel events scroll the list instead of zooming the viewport (MeshCanvas wheel handler checks for this).

## Tutorial System
- `tutorialsSeen: Record<string, boolean>` persists which tutorials dismissed. `activeTutorial: string | null` (transient).
- Triggers: `intro` on first mount via `App.tsx` (after intro cinematic completes), `brokerUpgrade` inside `upgradeComponent` (2 slides: broker info + new components available), `firstFanOut` inside `upgradeComponent` on first Persistent Delivery purchase, component-type tutorials inside `addComponent`, `firstDrop` from `useGameLoop.ts` 1 second after the first event drop. Publisher/subscriber tutorials trigger on 2nd instance.
- Post-broker-upgrade flow: after the `brokerUpgrade` tutorial is dismissed, `Sidebar.tsx` scrolls to the "Mesh Components" section and applies a cyan glow highlight. The glow persists until the user clicks anywhere (global click listener).
- **Dave** — pixel-art developer character (`PixelCharacter` exported from `IntroSequence.tsx`). Appears in the intro cinematic (frustrated → determined) and in all tutorial modals (bottom-right, delivering slides as speech bubbles). The tutorial card is positioned to Dave's left with a speech tail pointing at his mouth (bottom-right of card).
- **Intro cinematic** — `IntroSequence.tsx`, gated by `tutorialsSeen['introSequence']`. Shows 15-service spaghetti diagram with failing dots, red pulsing vignette, then Dave delivers 4 lines of dialogue via "Next" buttons. Skippable. Rendered in `App.tsx` before game UI; `showTutorial('intro')` fires after intro completes.
- Content in `tutorialConfig.tsx` (note: `.tsx` — file uses JSX for rich body content); UI in `TutorialModal.tsx` (z-index 60).
- `TutorialSlide.body` is typed as `ReactNode`, so slide bodies can be plain strings or JSX (e.g. `<span style={{color: ...}}>` for inline color). `TutorialModal` renders it directly inside a `<p>`.
- `TutorialSlide` has an optional `graphic?: ComponentType` field. When present, `TutorialModal` renders the graphic between the slide title and body text.
- Animated graphics live in `TutorialGraphics.tsx` — one SVG component per slide context (publisher, events flow, earn money, upgrade/expand, broker upgrade, new components, queue, DMQ, multi-publisher, multi-subscriber, multi-broker, payments publisher). Each uses Framer Motion `motion.circle`/`motion.text`/`motion.rect` for traveling dots and highlights. Color tokens match the game's `typeColors` palette. `MultiSubscriberGraphic` includes coin-pop animations (coin icon + "+$1.20" text floating up) on each subscriber, timed to appear when the traveling dot arrives.
- `PaymentsPublisherGraphic` is the same click/cooldown animation as `PublisherGraphic` but uses the payments electric-blue palette (`#00aaff` border, `#0c2233` bg). Used by the `firstPaymentsPublisher` tutorial.
- `TravelingDot` is the shared helper for animated dots. It accepts `delay`, `duration`, `repeatDelay`, `color`, and `hideOnMount`. When `hideOnMount` is true, the first `r` keyframe is `0` (invisible) so the dot doesn't appear at its start position during the initial delay — it snaps visible the instant its animation fires. This is needed for dots with large delays that would otherwise sit statically on-screen at mount.
- `QueueGraphic` uses a **5.0s shared cycle**: two broker→queue dots (0.5s apart), queue slots light up reactively (rightmost then middle), then both queue→sub dots depart sequentially with `hideOnMount`. Slot fill/drain keyframe times are derived from dot travel duration so they stay in sync with the traveling dots.
- `EventDropGraphic` uses a **3.5s shared cycle** with a single `duration` and `times` arrays (0→1) on all elements. Elements use `opacity: 0` to stay hidden during their waiting phase (Framer Motion's `delay` prop renders elements at their first keyframe during the wait, so `times`-based hiding is required). Timeline: dot 1 travels to subscriber → cooldown bar appears (CSS `clipPath: inset()` drain matching real game) → dot 2 travels at same speed → rejected, ✕ flash, turns red and falls. Module-level `firstDropTime`/`firstDropTutorialShown` vars in `useGameLoop.ts` track when to trigger.
- `DmqGraphic` uses a **5.0s shared cycle**. All animations satisfy `duration + repeatDelay = 5.0` so they stay phase-locked on every repeat (initial `delay` offsets the first fire within the cycle; subsequent repeats use `duration + repeatDelay` as the interval). Timeline: two red dots fall 0.5s apart (lands at t≈0.616s and t≈1.116s, lighting slots i=2 then i=1), then two orange retry dots depart 0.5s apart (t=2.2s and t=2.7s, darkening slots in order). The return wire goes from DMQ left edge horizontally to broker's x, then vertically up to broker bottom center (one 90° bend). The orange dots use explicit cx/cy keyframes (not `TravelingDot`) to follow the orthogonal path, with `times` weighted by segment length.

## Prestige System ("Schema Registry")
- `prestige` state holds `points`, `totalPoints`, `count`, `permanentUpgradeLevels: Record<string, number>`.
- Prestige awards points on a scaling triangular curve: Nth point costs $N million (1st=$1M, 2nd=$2M, 3rd=$3M...). Total earned for N points = N*(N+1)/2 million. Formula: `N = floor((-1 + sqrt(1 + 8 * totalEarned/1M)) / 2)`.
- `performPrestige()` resets all run state while preserving `prestige` and `tutorialsSeen`. Post-reset applies permanent node effects.
- `showPrestigeTree` (transient, excluded from save) controls full-page tree view.

## Prestige Tree
- `prestigeUpgradeConfig.ts` defines 16 `PrestigeNode` entries with `key`, `cost`, `requires`, and grid `position`.
- Radial layout: center Income Boost with 4 arms. `isNodePurchased()` and `isNodeAvailable()` helpers check `permanentUpgradeLevels`.
- `PrestigeTreePage.tsx` uses same `useViewportApi()` + `ViewportContext.Provider` pattern as `MeshCanvas`.

## Permanent Buff Integration
- Income multiplier (`income` node) applied in `consumeEvent`.
- Speed (`speed1/2/3` nodes) applied via `getPermanentSpeedMult()`.
- Cost reduction (`costRed1/2` nodes) added to selectors in NodeCard, NodeModal, Sidebar.
- Value boost (`value1/2` nodes) added to `getEventValue()` via `getPermanentValueBoost()`.
- Shop discount (`shopDiscount` node) applied via `getPermanentShopDiscount()`.

## Misc
- **Mesh error toast**: `meshError` transient state, red toast in top-left via Framer Motion. Auto-clears after 2.5s.
- **Sidebar sections**: `CollapsibleSection` wraps Schema Registry, Mesh Upgrades, and Mesh Components.
- Keep game logic (store, hooks) decoupled from rendering components.
- All upgrade costs/effects in `upgradeConfig.ts` (per-run) and `prestigeUpgradeConfig.ts` (permanent) — avoid hardcoding in components.
