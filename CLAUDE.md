# Idle Mesh — Idle Clicker Game

An idle clicker game themed around **event-driven architecture (EDA)**, inspired by **Solace PubSub+**. The player builds and scales a distributed system by publishing events, routing them through brokers and queues, and consuming them with subscribers.

## Tech Stack

- **Framework**: React (Vite) + TypeScript
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Animation**: Framer Motion (component transitions) + raw Canvas API (event dot animation)
- **State Management**: Zustand with `immer` middleware
- **Simulation**: `src/sim/` — a store-free, React-free, DOM-free module (`sim.ts`) that owns the event dots and runs in a Web Worker (`sim.worker.ts`; inline on the main thread as the fallback, or with `?inlineSim` in the URL). The store never holds dots: the UI gets one `TickSummary` per tick and the canvas a position buffer (see Key Conventions)
- **Persistence**: localStorage auto-save (key: `idle-mesh-save`), 500ms debounce. Excluded from save (`buildSaveSnapshot` in `gameStore.ts`): `queueSlotSignatures`, `recentEarnings`, `recentPublishes`, `selectedNodeId`, `coinPops`, `draggingConnection`, `draggingNodeId`, `meshError`, `activeTutorial`, `showPrestigeTree`, `showWinScreen`. Dots are not store state at all (they live in the sim)

## File Structure

```
src/
  components/
    MeshCanvas.tsx      # SVG connections + EventCanvas + NodeCards + NodeModal + drag handling
    ConnectionLine.tsx  # Individual connection: SVG line + arrowhead + click-to-detach drag
    EventCanvas.tsx     # RAF loop: WebGL point sprites drawn from the sim's position buffer (simBridge getPositions/getTickTiming; 2D sprite fallback); back canvas for traveling/queued/dropped dots, front canvas (above the cards) for pausing dots; extrapolates each entry by its velocity floats for the time since the tick landed (capped per entry at its next corner/zone edge)
    HelpButton.tsx      # Guide + warning "!" button (drop reasons from simStats.getActiveDrops)
    NodeCard.tsx        # Individual node: color, ↑ upgrade icon, upgrade badge, output port, click handlers; broker bar / subscriber cooldown / webhook border driven through refs from simStats
    NodeModal.tsx       # Floating upgrade modal anchored to selected node
    Sidebar.tsx         # Balance, stats, collapsible sections (Schema Registry, Mesh Upgrades, Mesh Components)
    PrestigePanel.tsx   # Prestige stats, "Register Schema" button, confirmation dialog
    PrestigeTreePage.tsx # Full-page prestige skill tree with pan/zoom
    IntroSequence.tsx   # First-load cinematic: spaghetti diagram + Dave character intro; exports PixelCharacter (hoodie/tux outfits)
    WinScreen.tsx       # End-game overlay at $1T/run: confetti canvas, banner, stats, tux Dave, Keep Playing / Start Over
    TutorialModal.tsx   # Tutorial overlay with Dave (pixel-art character) delivering slides as speech bubbles
    TutorialGraphics.tsx # Animated SVG graphics for each tutorial slide (Framer Motion)
  sim/                  # The simulation. Nothing here may import the store, React, or touch window/document/localStorage
    types.ts            # GameComponent, Connection, EventDot (progress, count, progressPerMs/speedUntilP, forkStep…), ForkPath/ForkStep, Mesh, GlobalUpgrades, PrestigeState (gameStore re-exports them)
    sim.ts              # `Sim`: setMesh / moveComponent / reset / tick(SimInput) → TickSummary / fillPositions; the three passes, the route profile (getPathInfo → PathInfo), every cache, relay caps, the auto-publisher poll on sim time; per-section tick timers (tickSections)
    publish.ts          # What a publisher emits per fire: computePublishPlan/getPublishPlan (cached on mesh identity), buildPublishDots, the bundle gate (routesBundleExact), nextDotId/resetDotIds
    forkTree.ts         # planForkTree: where a fire's routes diverge → the ForkStep list a dot carries (one copy per link at each broker)
    releaseIndex.ts     # Per-subscriber sorted arrival index: the Pass 2 release check in O(log n) per candidate
    meshRules.ts        # Store-free rules: getEventValue, getAllPathsWithNodes, prestige multipliers, bridge/queue value helpers, consumeDurationFor
    positions.ts        # The position buffer the canvas draws: FLOATS_PER_DOT (11) floats per dot [x, y, extent, r, g, b, a, glow, vx, vy, tmax]
    protocol.ts         # Main ↔ worker message types (mesh / move / input / reset / debug; busy / tick / debug)
    sim.worker.ts       # Worker entry: one Sim, ticks each input as it arrives, fills the position buffer and transfers it back
    simBridge.ts        # Main-thread side: worker or inline driver behind one API, flow control (one input in flight), stall watchdog + inline fallback, the two position buffers, queueManualFire, getSimTicksPerSec/getMinSimTicksPerSec, window.__sim harness hooks
    simStats.ts         # What the UI reads from the latest TickSummary: getActiveDrops, getBrokerUtilization, getSubscriberConsume, getWebhookFill
    __tests__/          # `npx tsc -b && node --test src/sim/__tests__/*.test.ts`: release.test.ts (index vs the reference chain walk), forkTree.test.ts
  store/
    gameStore.ts        # All Zustand state + actions (commitFrame applies a TickSummary), auto-save subscription
    upgradeConfig.ts    # All upgrade defs (cost, multiplier, maxLevel, label, description)
    prestigeUpgradeConfig.ts # Prestige tree node definitions (23 nodes)
    topicPool.ts        # Predefined topic pool for publisher/queue assignment
    tutorialConfig.tsx  # Tutorial slide definitions (title: string, body: ReactNode, optional graphic component)
  hooks/
    useSimBridge.ts     # RAF driver around simBridge: render fps stat (coin-pop throttle only), one SimInput per frame (dt, Date.now(), dragging id, the publisher clicks queued since the last tick), applies each TickSummary with ONE store commit (commitFrame), keeps the sim's mesh snapshot current from a store subscription, first-drop tutorial
    useViewport.ts      # Pan/zoom viewport: context, ref-based state, screenToWorld/worldToScreen helpers
    useThrottledStore.ts # useThrottledGameStore(selector, ms): timer-sampled store selector for display-only values that change every frame
    useTypewriter.ts    # Character-by-character text reveal for Dave's speech bubbles (intro + win screen)
  utils/
    connectionRules.ts  # canConnect(fromType, toType), getValidTargets() — connection validation
    topicMatching.ts    # Solace-style topic matching: wildcards (*, >) and subscription broadening
    orthogonalPath.ts   # Orthogonal line routing (horizontal → vertical → horizontal)
    pathUtils.ts        # interpolatePath(path, progress) → {x, y}
    formatMoney.ts      # $1,234.56 formatter
  App.tsx               # Root: MeshCanvas + Sidebar, runs useSimBridge
  main.tsx
scripts/perf/           # Headless perf harness: behavior.mjs/compare.mjs (gameplay-equivalence diff per scale, per sim second, per-section tick ms), prof.mjs (CPU profile, --worker for the sim thread), renders.mjs, trace.mjs, dragsmoke.mjs — see its README
```

## Core Game Loop

1. Click publisher → spawns event dot (respects cooldown)
2. Event slows through webhook, continues to subscriber
3. Subscriber consumes over ~1s → money increments when consume completes
4. Blockage: if webhook occupied or subscriber busy, event drops
5. Upgrade webhook → broker ($75) to unlock queues
6. Buy queues, wire connections via drag-to-connect
7. Automation via per-publisher auto-fire upgrades. The auto-publisher is polled every 100 ms of *simulation* time inside `Sim.tick` (not a wall-clock interval), so when ticks run long publishing slows with everything else instead of flooding the mesh; the due publishers' dots are built inside the tick and their cooldowns/publish rate land in the tick's single `commitFrame` commit. A manual click is cooldown-checked by the store's `fireEvent`, then queued on the bridge (`queueManualFire`) for the start of the next tick
8. Broker fan-out: broker sends events to ALL connected queues with matching topics
9. Prestige ("Schema Registry") for permanent upgrades — points = floor(1.5 × cbrt(millions earned)), first point at $1M, Nth point costs ~N³ million (`getPrestigePointsFor` in `prestigeUpgradeConfig.ts`)
10. Publisher network tier: each publisher purchased (beyond the starter) permanently raises its own base event value by another 10% over the previous one, assigned by purchase order. Publisher purchases are capped at 24 (one per unique topic in the pool)
11. Broker bridge bonus: events whose route crosses a broker-to-broker bridge connection earn +50% value and render as gold dots once they exit the broker they bridge from
12. Queue value bonus: any event that passes through a queue on its way to a subscriber earns +5% value
13. End game: earning `WIN_THRESHOLD` ($1T, `upgradeConfig.ts`) in a single run (`totalEarned`, which prestige resets) shows the `WinScreen` once per save (`winSeen` persists; only a full wipe clears it). The sidebar's "Road to $1 Trillion" bar tracks per-run progress. `useSimBridge` sends the sim no input while it's open, so dots and the auto-publisher freeze; player picks Keep Playing or Start Over (full wipe, intro replays)

## Key Conventions

- Keep game logic (store, `src/sim/`) decoupled from rendering components
- All upgrade costs/effects in `upgradeConfig.ts` / `prestigeUpgradeConfig.ts` — avoid hardcoding
- `getUpgradesForType` is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync
- Adding new shop items: add action logic to `gameStore.ts`, add UI to `Sidebar.tsx`
- Simulation architecture (see `claude-docs/dev-notes.md` → "Round 4 — worker"): the sim (`src/sim/sim.ts`) runs in a Web Worker, owns the dots, and the store never sees them. New rules go in `sim.ts` and read the `Mesh` snapshot (`components`/`connections`/`upgrades`/`prestige`, kept current by the store subscription in `useSimBridge.ts`, which re-sends the snapshot when any of the four changes identity — never mutate them in place; every cache, including `getPublishPlan`, keys on identity). Anything the UI needs from the sim goes into `TickSummary` (read through `simStats.ts`: drop reasons, broker relay counts, subscriber consume, webhook fill), never into the store. The sim's only clock is `input.nowMs` (the main thread's `Date.now()`); never `performance.now()` for anything that crosses threads. Two rate stats: the sidebar's "Sim rate" is `getSimTicksPerSec()` (`simBridge.ts`, ticks landing per second; a tick steps at most `MAX_FRAME_DT_MS` = 100 ms, so below 10 ticks/s the sim runs slower than real time and income drops) and the win screen's "Lowest sim rate" is `getMinSimTicksPerSec()`; the render fps (`getSmoothedFps` in `useSimBridge.ts`) only throttles coin pops.
- Performance rules (measured, see `scripts/perf/README.md`): the hot path is ONE store commit per tick — `commitFrame` in `gameStore.ts` takes the `TickSummary` (consumes, drop count, due auto-publishers, queue slot signatures) and applies it with a plain `set({...})` (no immer; `applyConsumes` is the pure consume bookkeeping); immer auto-freeze is off. React components never see dots — queue/DMQ cards read `queueSlotSignatures[id]` (a string the sim writes each tick); use `useThrottledGameStore` for sidebar-style numbers; drive per-frame visuals (cooldown overlays, webhook border, broker bar) imperatively through refs from `simStats`. The canvas draws the sim's position buffer (`positions.ts`: 11 floats per dot, including a velocity and a lead cap so it can extrapolate between ticks). A dot carries `count`: a batch fire travels as one bundle dot where that is exact (`routesBundleExact` in `publish.ts`), and every rule that counts events (relay slots, buffers, consumes, drops, slot signatures) uses it. Every per-tick rule in the traveling branch reads the cached **route profile** (`getPathInfo` → `PathInfo`: segment speed scales, webhook/cluster zones, node marks with `centerP`/`touchStart`) instead of testing pixel positions — add new position-based rules as profile zones/marks, never as per-dot `interpolatePath` tests. Dot objects are advanced **in place** (`dot.progress = …`) and keep one object shape (every creation site sets every per-tick field: `progressPerMs`, `speedUntilP`, `count`); only status changes create new objects. Paths and `originalNodeIds` arrays are immutable WeakMap cache keys; fork slices (`forkSpawnFor`) and queue→subscriber release paths (`releasePathCache`) are shared arrays so dots share profiles; a fire's fork tree (`forkTree.ts`, a `ForkStep` linked list) is shared plan data and never mutated. Dropped dots beyond `DROPPED_VISUAL_CAP` (300 falling at once) are counted but not animated unless the DMQ could catch them.
- Before/after any sim or perf change: `npm run perf:build`, `npm run perf:serve`, then `node scripts/perf/behavior.mjs <S|M|L|U|W> <label>` and `node scripts/perf/compare.mjs <labelA> <labelB> S,M,L,U,W` — consumed/dropped/earned per (sim) second must stay within noise (`U` is the player-like heavy mesh, `W` the early-game webhook; `F` is the late-game TIE fighter: `FTHROUGHPUT=300 node scripts/perf/behavior.mjs F <label>`, also with `FPUBS=2`/`FPUBS=10`). For sim changes also run `node scripts/perf/dragsmoke.mjs M` in both modes (worker, and `http://localhost:5198/Idle-Mesh/?inlineSim`; every dot must stay on its cable, no errors) and the unit tests. Diagnose before fixing: the per-section tick timers (`sectionMsPerTick` in `behavior.mjs`) and `node scripts/perf/prof.mjs <scale> --worker` (the sim thread; without `--worker` the main thread)

## Detailed Documentation

See `claude-docs/` for in-depth reference (read as needed, not loaded by default):
- `visual-design.md` — colors, z-index layering, connection lines, event dot visuals
- `component-types.md` — full specs for Publisher, Webhook, Broker, Queue, DMQ, Subscriber
- `event-dot-lifecycle.md` — EventDot type, collision detection, game loop passes, forking
- `upgrades.md` — all upgrade tables (per-component, global, shop), cost formulas
- `dev-notes.md` — viewport, drag mechanics, path geometry, DMQ internals, prestige, tutorials, debugging tips
- `roadmap.md` — feature roadmap, known bugs, nice-to-have polish items
- `topic-routing-design.md` — topic system design decisions, matching rules, broadening, multi-broker bridging
- `worker-refactor-plan.md` — the design of the sim/worker split (done): target architecture, the `Sim` interface, the messages, flow control; read before touching `sim.ts`/`simBridge.ts` structure
- `worker-refactor-progress.md` — findings from that refactor (done): the deviations from the plan, the gate numbers
- `scale-plan.md` — the late-game scaling plan (release index, pausing dots in WebGL, tick-rate independence, bundles, extrapolation, the fork tree; done except the optional flow mode)
- `scale-progress.md` — session handoff for the sim: measured tables per scale, findings, the open balance decisions that need the user
