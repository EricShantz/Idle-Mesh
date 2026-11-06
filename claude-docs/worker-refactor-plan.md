# Plan: move the simulation to a Web Worker

Status: **done** (Phases 0–4, 2026-11-05; the gate numbers and the deviations from this plan are in
`worker-refactor-progress.md`, the architecture summary in `dev-notes.md` → "Round 4 — worker").
Written 2026-11-05 after three rounds of main-thread optimization. "Current architecture" below
describes the code as it was before the refactor; "Target architecture" is what exists now, except
where the progress file records a deviation (the bridge accumulates frame deltas instead of the
worker coalescing inputs; the stall watchdog waits for a `busy` ack plus a post-ack timeout;
`getMinFps` became the lowest sim rate).

## Why

The player wants to push past ~20k events consumed per second. At that load the per-dot
simulation (`useGameLoop.ts`) and the UI (React, sidebar, WebGL dot canvas) share one thread. The
worker split gives the simulation its own core: the UI stays at 60 fps regardless of load, and the
simulation gets roughly twice the budget before it starts to dilate (dt clamp at 100 ms/tick).

Facts that drive the design:

- Income is governed by **simulation ticks**, not render frames. A tick advances sim time by
  `min(realDt, MAX_FRAME_DT_MS=100)`. Below 10 ticks/s the sim runs slower than wall time and income
  drops. Above that, income is the same at 12 or 60 ticks/s.
- Dots are **not persisted** (`eventDots` is excluded from the save). They can live entirely in the
  worker. Everything persisted stays in the main-thread store.
- GitHub Pages cannot set COOP/COEP headers, so **no `SharedArrayBuffer`**. Use transferable
  `ArrayBuffer`s (zero-copy `postMessage` with a transfer list).
- Vite bundles `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })` as a
  static asset; nothing to host, no config change beyond what Vite does automatically.
- Harness: `scripts/perf/` (`README.md` there). `behavior.mjs` + `compare.mjs` at scales
  `S,M,L,U,W` must show consumed/dropped/earned per second within noise at every gate;
  `dragsmoke.mjs M` must show 0 off-path dots and no errors.

## Non-goals

- No gameplay or rule changes. Every rule in the loop stays byte-for-byte in behavior.
- No change to the save format.
- No `SharedArrayBuffer`, no cross-origin isolation.
- No worker for anything but the dot simulation (React, sidebar, prestige, tutorials stay).

## Current architecture (what the plan starts from)

`src/hooks/useGameLoop.ts` (~1,730 lines) runs one `requestAnimationFrame` loop on the main thread:

1. Reads `useGameStore.getState()`: `components`, `connections`, `upgrades`, `prestige` (via
   `getPermanent*` helpers that take `state`), `draggingNodeId`, `showWinScreen`, `eventDots`.
2. Runs the frame function (an IIFE over `state.eventDots`): Pass 1 moves every dot using the
   cached **route profile** (`getPathInfo` → `PathInfo`: segment scales, zones, node marks), Pass 2
   releases queued dots per queue (`shouldReleaseTo`), Pass 3 releases from the DMQ. It mutates dot
   objects in place and returns the new `updated` array plus `queueSlotSignatures`, `toConsume`,
   `droppedCount`.
3. Polls the auto-publisher on sim time (every `AUTO_PUB_POLL_MS=100` of clamped dt) and collects
   due publisher ids.
4. Commits everything with **one** store call: `state.commitFrame({ dots, consumed, droppedCount,
   publisherIds, queueSlotSignatures })` (`gameStore.ts`). `commitFrame` applies consumes
   (`applyConsumes`: balance, totals, coin pops, milestones, win screen), builds the due publishers'
   dots (`buildPublishBatch` → `buildPublishDots` → cached `getPublishPlan`), bumps `eventsDropped`,
   and sets `eventDots`.
5. Keeps the fps stat (`_smoothedDt`, `getSmoothedFps`, `getMinFps`) and the first-drop tutorial
   timer, which calls `useGameStore.getState().showTutorial('firstDrop')`.

Module-level state in `useGameLoop.ts` that the UI reads directly (these must become part of the
tick summary once the sim is in a worker):

| Export | Backing state | Read by |
|---|---|---|
| `getActiveDrops()` | `nodeDropTracker` (per node: reason, lastDropTime) | `HelpButton.tsx` |
| `getBrokerUtilization(id, cap)` | `brokerRelayTimestamps` (relays in last 1 s) | `NodeCard.tsx` |
| `getSubscriberConsume(id)` | `subscriberConsume` (start, duration of current consume) | `NodeCard.tsx` |
| `getSmoothedFps()` / `getMinFps()` | `_smoothedDt`, `_minFps` | `Sidebar.tsx`, `WinScreen.tsx`, `gameStore.ts` (coin-pop throttle in `applyConsumes`) |

Other module-level sim state in the loop (moves to the worker unchanged): `brokerRelayTimestamps`,
`queueRoundRobinIdx`, `lastDmqReleaseTime`, `queueLastReleaseTime`, `autoPubAccumulator`,
`simNow`, `autoFireLastSim`, `pathInfoCache`, `routeValidityCache`, `forkSpawnCache`,
`releasePathCache`, `subscriberConsume`, `firstDropTime`/`firstDropTutorialShown`.

UI code that reads `eventDots` directly (must stop, since dots will not be in the store):

- `EventCanvas.tsx` render loop: `useGameStore.getState().eventDots` → draws every dot each frame.
- `NodeCard.tsx` webhook card: selects `s.eventDots` and scans traveling dots to animate the
  border fill (`best` = how far the furthest dot inside the webhook box has progressed, 0..1).

Store code that touches dots (must move into the sim or become messages):

- `fireEvent` (manual publisher click) → `fireEvents` → appends to `eventDots`.
- `commitFrame`, `fireEvents`, `updateDots`, `dropEvent`, `removeDot`, `consumeEvent`,
  `isPathOccupied`: of these only `fireEvent`/`fireEvents`/`commitFrame` have callers outside the
  store (`fireEvent` from `NodeCard`, `commitFrame` from the loop). The rest are dead and can go.
- `buildPublishDots` / `computePublishPlan` depend on `state._getAllPathsWithNodes(publisherId)`
  (a store method using `get()`) and `state.getEventValue(publisherId)`. Both are pure functions
  of (`components`, `connections`, `upgrades`, `prestige`) and must be extracted so the worker can
  call them without a store.
- `getPermanentSpeedMult`, `getPermanentSubPayoutMult`, `getPermanentBrokerThroughputMult`,
  `getPermanentQueueBufferBonus`, `getPermanentPubRateMult`, `getPublisherCooldownMs`,
  `findNextInteractableId`, `firstBridgeExitNodeId`, `getQueueValueMultiplier`: pure, take
  `state`/`Pick<GameState,'prestige'>`; keep them in a store-free module (see Phase 1).

## Target architecture

```
main thread                                     worker thread
-----------                                     -------------
gameStore (persisted state, React)   --mesh-->  sim.ts (the loop, owns dots)
useSimBridge (RAF: send inputs,      --input->  ticks on its own timer
   apply tick summary, hand          <--tick--  posts: positions buffer + summary
   position buffer to EventCanvas)
EventCanvas (draws the latest buffer)
```

- `src/sim/sim.ts`: the simulation as a plain class/module with no store, no React, no DOM.
  Interface below. Runs identically on either thread.
- `src/sim/sim.worker.ts`: thin worker entry: receives messages, calls `sim`, posts results.
- `src/sim/simBridge.ts` (+ `useSimBridge` hook replacing `useGameLoop`): main-thread side.
  Subscribes to the store, sends mesh snapshots on change, sends drag positions each frame,
  applies tick summaries via `commitFrame`, exposes the latest position buffer to the canvas, and
  provides `getActiveDrops` etc. from the latest summary.
- Inline fallback: if `Worker` construction throws, the bridge runs `sim` on the main thread in
  the RAF loop with the same interface (this is also what Phase 2 ships).

### Sim interface (`src/sim/sim.ts`)

```ts
export type Mesh = {                     // everything the rules read from the store
  components: GameComponent[];
  connections: Connection[];
  upgrades: GameState['upgrades'];
  prestige: GameState['prestige'];
};
export type SimInput = {
  dtMs: number;                           // raw frame delta; sim clamps to MAX_FRAME_DT_MS
  nowMs: number;                          // Date.now() of the caller (worker clock == main clock)
  draggingNodeId: string | null;
  frozen: boolean;                        // showWinScreen: tick does nothing
  manualFires: string[];                  // publisher ids clicked since last tick (already cooldown-checked)
};
export type TickSummary = {
  consumed: { value: number; subscriberId: string }[];
  droppedCount: number;
  publisherIds: string[];                 // auto-publishers that fired this tick (for cooldown map + publish rate)
  publishes: { count: number }[];         // fireCount per fired publisher, same order
  queueSlotSignatures: Record<string, string>;
  activeDrops: { nodeId: string; nodeLabel: string; reason: DropReason; lastDropTime: number }[];
  brokerRelayCounts: Record<string, number>;   // relays in the last 1 s per broker (replaces getBrokerUtilization's scan)
  subscriberConsume: Record<string, { start: number; duration: number }>;
  webhookFill: Record<string, number>;    // per webhook id: the NodeCard border value (-1 if none)
  firstDropAt: number | null;             // Date.now() of first drop ever in this sim, for the tutorial
  simNow: number;                         // for the UI's sim-ticks/sec stat
  liveDots: number;
};
export class Sim {
  setMesh(mesh: Mesh): void;              // replaces the snapshot; invalidates caches by identity exactly as today
  moveComponent(id: string, x: number, y: number): void;  // drag frames: patches the snapshot's component (new array identity, like moveComponent in the store)
  tick(input: SimInput): TickSummary;
  fillPositions(buf: Float32Array): number;   // writes [x, y, extent, r, g, b, a, glow] per drawable dot (the EventCanvas renderGl layout); returns dot count
  getDots(): EventDot[];                  // test/debug only
}
```

Rules for the port: the body of `tick` is today's frame function + auto-publish poll + the
publish-dot building (`buildPublishBatch` minus the cooldown/recentPublishes bookkeeping, which
stays in `commitFrame`). The dot array and every cache move into the `Sim` instance or stay
module-level in `sim.ts`. Nothing in `sim.ts` may import from `gameStore.ts`, `react`, or touch
`window`/`document`/`localStorage`.

### Messages (`sim.worker.ts`)

Main → worker:

- `{ type: 'mesh', mesh }` on any store change to components/connections/upgrades/prestige
  (compare identities in a store subscription; send the whole snapshot — a few hundred objects).
- `{ type: 'move', id, x, y }` each frame while `draggingNodeId` is set (the worker applies
  `moveComponent`, which is what today's per-frame rebuild sees).
- `{ type: 'input', input: SimInput, buffer: ArrayBuffer }` once per animation frame on the main
  thread: `dtMs`, `nowMs`, flags, manual fires, and the **returned** position buffer (ping-pong).
- `{ type: 'reset' }` on prestige/wipe (dots cleared; today `eventDots` is just replaced).

Worker → main:

- `{ type: 'tick', summary: TickSummary, buffer: ArrayBuffer, count }` with the buffer in the
  transfer list. The worker ticks when it receives `input`; if a tick takes longer than a frame,
  inputs queue and the worker coalesces them (sum `dtMs`, union `manualFires`, latest flags) so sim
  time never lags wall time by more than the clamp allows.

Buffer protocol: two `Float32Array`s of capacity `8 * N` (grow when `count` would exceed
capacity: the worker allocates a bigger one and sends it; the main thread then returns the bigger
one). The main thread draws from the buffer it holds; the worker fills the one it holds. Never
read a buffer after transferring it (it is detached).

### Clocks and the two fps numbers

- The render fps (`getSmoothedFps`/`getMinFps`) stays on the main thread, computed from RAF
  deltas exactly as today — it drives the coin-pop throttle and the win-screen stat.
- Add `getSimTicksPerSec()` on the bridge from consecutive `summary.simNow` deltas vs wall time.
  Sidebar shows both: "Frame rate 60 fps · Sim 48 ticks/s". Below 10 ticks/s the sim dilates; say
  so in the tooltip the same way the frame-rate stat does today.
- The dt the sim steps by is the **main thread's** RAF delta sent in `input` (clamped in the
  sim). This keeps "one tick per frame" semantics when the worker keeps up, and coalesces when it
  does not. Do not let the worker free-run on its own timer in Phase 3; that changes publish
  cadence relative to today. (Free-running at a fixed tick is a possible later step.)

## Phases

### Phase 0 — baseline (½ h)

1. `npm run perf:build && npm run perf:serve`, then
   `for sc in S M L U W; do node scripts/perf/behavior.mjs $sc wbase; done` and
   `node scripts/perf/dragsmoke.mjs M`. Keep the `wbase` JSON files; every gate compares to them.
2. Note the pre-existing lint count (`npx eslint src | grep problems`, 24 errors at time of
   writing, all pre-existing patterns). It must not grow.

### Phase 1 — pure sim module, still on the main thread (½ day)

Goal: `src/sim/sim.ts` exists, has the interface above, and `useGameLoop` is a thin RAF driver
around it. No worker yet. Zero behavior change.

1. Create `src/sim/meshRules.ts` by **moving** (not copying) the store-free helpers out of
   `gameStore.ts`: `getPermanent*`, `getPublisherCooldownMs`, `findNextInteractableId`,
   `firstBridgeExitNodeId`, `pathCrossesBridge`, `getQueueValueMultiplier`, `BRIDGE_GOLD_COLOR`,
   `BRIDGE_VALUE_MULT`, `QUEUE_VALUE_BONUS_PER_HOP`, `getPublisherTierMultiplier`,
   `getPermanentValueBoost`, and a pure `getEventValue(mesh, publisherId)` and
   `getAllPathsWithNodes(components, connections, publisherId)` (the body of the store method, with
   `state.components`/`state.connections` as parameters). Re-export from `gameStore.ts` so
   existing imports keep working. The store's `getEventValue`/`_getAllPathsWithNodes` become
   one-line delegations.
2. Move `buildPublishDots`, `computePublishPlan`, `getPublishPlan`, `publishPlanCache` and the
   `PlannedDot`/`PublishPlan` types into `src/sim/publish.ts`, taking a `Mesh` instead of
   `GameState`. `buildPublishBatch` stays in the store but calls the moved function with
   `{ components, connections, upgrades, prestige }` from `state`.
3. Create `src/sim/sim.ts`: move the whole of `useGameLoop.ts` except `useGameLoop` itself, the
   fps stat, and the first-drop tutorial call. The frame IIFE becomes `Sim.tick`. Replace every
   `state.X` read with `this.mesh.X` / `input.X`; replace `useGameStore.getState()` with nothing
   (there are two: the state read at the top of the loop and `showTutorial('firstDrop')`).
   `tick` returns the `TickSummary` instead of calling `commitFrame`. Inside `tick`, after Pass 3,
   build the due auto-publishers' dots with `buildPublishDots(mesh, id)` and append them to the
   dot array (today `commitFrame` does the append; moving it is required because the worker owns
   the dots). `manualFires` are built the same way at the start of the tick.
4. `getActiveDrops`, `getBrokerUtilization`, `getSubscriberConsume`: keep their signatures as
   exports of a new `src/sim/simStats.ts` that reads **from the latest `TickSummary`** held by the
   bridge, so `HelpButton`, `NodeCard` keep working unchanged. `brokerRelayCounts` replaces the
   timestamp scan: `getBrokerUtilization(id, cap)` = `(counts[id] ?? 0) / cap`.
5. `commitFrame` in the store: accept a `TickSummary` (plus the dots array for now). It keeps
   doing consumes, drops, cooldown map (`publisherCooldowns[id] = now` for each `publisherIds`),
   `recentPublishes` entries from `publishes`, slot signatures, and setting `eventDots`. Delete
   `updateDots`, `dropEvent`, `removeDot`, `consumeEvent`, `isPathOccupied` (verify no callers
   first with grep; at time of writing there are none).
6. `fireEvent` (manual click): keep the wall-clock cooldown check, then instead of building dots,
   push the id onto a bridge-level `pendingManualFires` list that the next tick's `input` consumes.
   The cooldown timestamp is still written by the store immediately (so the card overlay reacts on
   the click, as today).
7. `useGameLoop` becomes: RAF → fps stat → build `SimInput` from the store → `sim.tick(input)` →
   `commitFrame(summary, sim.getDots())` → first-drop tutorial from `summary.firstDropAt`.
   `setMesh` is called from a store subscription when any of the four mesh fields changes identity
   (compare previous refs); `moveComponent` is called by the same subscription when
   `draggingNodeId` is set and `components` changed (or simply call `setMesh` — during a drag the
   store already replaces `components` every frame, and the caches key on identity either way).
8. Webhook border: `NodeCard` stops selecting `eventDots`; the sim computes `webhookFill` in Pass 1
   (the same box/`t` computation, over traveling dots, for each component of type `webhook`) and
   the card reads it through `simStats` with a ref-driven effect, like the cooldown overlays.
9. `EventCanvas` keeps reading `eventDots` from the store **in this phase** (dots are still
   committed). Do not change it yet.

Gate 1: `tsc`, lint count unchanged, `behavior.mjs` at S,M,L,U,W vs `wbase` within noise,
`dragsmoke.mjs M` clean, and a manual check in the browser: click-to-fire works, webhook border
animates (scale `W` layout or the fresh-game layout), help button shows drop reasons, broker
utilization bar moves, win screen freezes the mesh. Commit: "sim: extract pure simulation module".

### Phase 2 — canvas reads a position buffer (2 h)

Goal: `EventCanvas` no longer reads `eventDots`; dots stop being committed to the store.

1. `Sim.fillPositions(buf)` writes the exact layout `renderGl` fills today (move the inline
   interpolation + queued-snap + color parse from `EventCanvas.renderGl` into the sim; `parseColor`
   goes with it). Pausing dots are included with a `glow` value of 2 and their shrink `scale` so
   the front canvas can still draw them (or draw pausing dots in GL too with a size scale — either
   is fine as long as the look matches; the 2D front canvas exists only to draw above node cards,
   z-index 25 vs 19, so keep the two canvases and have the 2D path read pausing entries from the
   buffer).
2. The bridge owns two `Float32Array`s and exposes `getPositions(): { buf, count }`.
   `EventCanvas` draws from that; the 2D fallback path reads the same buffer.
3. Remove `eventDots` from `GameState`, `commitFrame`, the save exclusion list, and the
   `EventCanvas` `Dot` type. `queueSlotSignatures` stays (cards need it).
4. `prof.mjs`/`behavior.mjs` read `s.eventDots.length` and `byStatus` in-page: switch them to
   `window.__sim.liveDots()` / `window.__sim.byStatus()` exposed by the bridge in all builds (it
   already exposes `useGameStore` and `__eventCanvasRenderer` for the harness).

Gate 2: same as Gate 1 plus screenshots at M before/after look identical (behavior.mjs saves
`shot-<label>-<scale>.png`). Commit: "sim: canvas draws from position buffer".

### Phase 3 — the worker (½–1 day)

1. `src/sim/sim.worker.ts`: instantiate `Sim`, handle the four message types, post `tick`
   results with the buffer transferred. Coalesce queued `input` messages as described.
2. `src/sim/simBridge.ts`: `createBridge()` tries `new Worker(new URL('./sim.worker.ts',
   import.meta.url), { type: 'module' })`; on failure (or `?inlineSim` in the URL, for A/B
   testing) uses the inline driver from Phase 1. Both expose the same object: `start()`,
   `stop()`, `getPositions()`, `latestSummary()`, `queueManualFire(id)`, `getSimTicksPerSec()`.
3. Main-thread RAF (`useGameLoop` → rename `useSimBridge`): fps stat; send `input` + the free
   buffer; when a `tick` message arrives, `commitFrame(summary)` and swap buffers. If no tick has
   arrived since the last frame, send nothing new except drag moves (do not pile up inputs; let
   the worker coalesce only what the RAF actually produced).
4. Store subscription: on mesh identity change post `mesh`; on prestige/wipe post `reset`.
   During a drag post `move` per frame instead of the full snapshot (the snapshot is also fine if
   measured cheap — it is a few hundred objects, but it invalidates every cache each frame exactly
   as today's per-frame `components` identity change does).
5. Sidebar: add the sim ticks/s stat next to frame rate. `WinScreen` keeps `getMinFps`.
6. Harness: `behavior.mjs` must report both fps numbers (`window.__sim.ticksPerSec()`), and
   `prof.mjs` should profile the worker thread too (CDP `Target.attachToTarget` for the worker,
   then `Profiler.start` there) — add a `--worker` switch that prints the worker profile.

Gate 3: all of Gate 2, plus: U scale shows render fps ≈ 60 and ticks/s ≥ the pre-worker fps;
`?inlineSim` gives Phase-2 numbers; killing the worker from DevTools (or forcing the throw) falls
back inline without a reload; two scenarios in a row in one page (prestige, then play) keep
working. Commit: "sim: run the simulation in a Web Worker".

### Phase 4 — docs and cleanup (1 h)

- `CLAUDE.md`: file structure (`src/sim/*`), the performance rules ("the simulation runs in a
  worker; the store never holds dots; new rules go in `sim.ts` and read the `Mesh`; anything the
  UI needs from the sim goes in `TickSummary`"), the two fps numbers.
- `claude-docs/dev-notes.md`: append "Round 4 — worker" with the measured numbers.
- `claude-docs/event-dot-lifecycle.md`: update the "game loop passes" section for the new home.
- Remove this plan's "planned" status line.

## Risks and how each is handled

- **Stale mesh in the worker** (dots follow old cables after an upgrade or rewire): the store
  subscription compares all four mesh field identities every commit; any change posts a snapshot.
  Test: buy a queue slot and wire a new queue mid-flow; drag a node; perform prestige.
- **Tick/frame coupling** when the worker is slower than the frame: inputs coalesce (sum of dt,
  clamped by the sim), so sim time tracks wall time up to the clamp exactly as today's slow frames
  did. Test with scale `H` (oversized): consumed/sec must match the inline run.
- **Coin pops and sidebar rates** are derived in `commitFrame` from the summary, unchanged.
- **Manual fire while a tick is in flight**: `pendingManualFires` is drained into the next `input`;
  the store writes the cooldown on click so double-clicks are rejected as today.
- **Win screen**: `frozen: true` makes `tick` return an empty summary without advancing; the
  worker keeps idling on inputs so resume is instant.
- **`Date.now()` inside the worker** is the same clock as the main thread; `performance.now()` is
  per-context (different time origins) — the sim must only use the `nowMs` it receives, never
  `performance.now()` for anything that crosses threads (`brokerRelayTimestamps` and the drop
  tracker use it today; switch them to `nowMs`).
- **HMR / React StrictMode double-mount**: the bridge must be idempotent (`start()` twice creates
  one worker; `stop()` terminates it). Test `npm run dev` with StrictMode on.
- **Bundle/base path**: Vite emits the worker under `/Idle-Mesh/assets/`; verify in the preview
  build and on the deployed site, not only in dev.

## Definition of done

- All three gates pass and are committed separately.
- At scale `U` in the production preview: render fps ≈ 60, sim ticks/s ≥ 55, consumed/dropped/
  earned per second within noise of `wbase`.
- `?inlineSim` still works and matches.
- No `eventDots` in the store; no `useGameStore` import in `src/sim/`.
- Lint error count unchanged; `tsc` clean.
