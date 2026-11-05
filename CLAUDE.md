# Idle Mesh — Idle Clicker Game

An idle clicker game themed around **event-driven architecture (EDA)**, inspired by **Solace PubSub+**. The player builds and scales a distributed system by publishing events, routing them through brokers and queues, and consuming them with subscribers.

## Tech Stack

- **Framework**: React (Vite) + TypeScript
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Animation**: Framer Motion (component transitions) + raw Canvas API (event dot animation)
- **State Management**: Zustand with `immer` middleware
- **Persistence**: localStorage auto-save (key: `idle-mesh-save`), 500ms debounce. Excluded from save: `eventDots`, `recentEarnings`, `recentPublishes`, `selectedNodeId`, `coinPops`, `draggingConnection`, `draggingNodeId`, `meshError`, `activeTutorial`, `showPrestigeTree`, `showWinScreen`

## File Structure

```
src/
  components/
    MeshCanvas.tsx      # SVG connections + EventCanvas + NodeCards + NodeModal + drag handling
    ConnectionLine.tsx  # Individual connection: SVG line + arrowhead + click-to-detach drag
    EventCanvas.tsx     # RAF loop: WebGL point sprites for traveling/queued/dropped dots (2D sprite fallback), 2D front canvas for pausing dots
    NodeCard.tsx        # Individual node: color, ↑ upgrade icon, upgrade badge, output port, click handlers
    NodeModal.tsx       # Floating upgrade modal anchored to selected node
    Sidebar.tsx         # Balance, stats, collapsible sections (Schema Registry, Mesh Upgrades, Mesh Components)
    PrestigePanel.tsx   # Prestige stats, "Register Schema" button, confirmation dialog
    PrestigeTreePage.tsx # Full-page prestige skill tree with pan/zoom
    IntroSequence.tsx   # First-load cinematic: spaghetti diagram + Dave character intro; exports PixelCharacter (hoodie/tux outfits)
    WinScreen.tsx       # End-game overlay at $1T/run: confetti canvas, banner, stats, tux Dave, Keep Playing / Start Over
    TutorialModal.tsx   # Tutorial overlay with Dave (pixel-art character) delivering slides as speech bubbles
    TutorialGraphics.tsx # Animated SVG graphics for each tutorial slide (Framer Motion)
  store/
    gameStore.ts        # All Zustand state + actions, auto-save subscription
    upgradeConfig.ts    # All upgrade defs (cost, multiplier, maxLevel, label, description)
    prestigeUpgradeConfig.ts # Prestige tree node definitions (23 nodes)
    topicPool.ts        # Predefined topic pool for publisher/queue assignment
    tutorialConfig.tsx  # Tutorial slide definitions (title: string, body: ReactNode, optional graphic component)
  hooks/
    useGameLoop.ts      # RAF game loop: per-route profile (node/zone markers as progress fractions) drives dot movement, consume/drop logic; sim-time auto-publisher poll; fps stat; ONE store commit per frame (commitFrame)
    useViewport.ts      # Pan/zoom viewport: context, ref-based state, screenToWorld/worldToScreen helpers
    useThrottledStore.ts # useThrottledGameStore(selector, ms): timer-sampled store selector for display-only values that change every frame
    useTypewriter.ts    # Character-by-character text reveal for Dave's speech bubbles (intro + win screen)
  utils/
    connectionRules.ts  # canConnect(fromType, toType), getValidTargets() — connection validation
    topicMatching.ts    # Solace-style topic matching: wildcards (*, >) and subscription broadening
    orthogonalPath.ts   # Orthogonal line routing (horizontal → vertical → horizontal)
    pathUtils.ts        # interpolatePath(path, progress) → {x, y}
    formatMoney.ts      # $1,234.56 formatter
  App.tsx               # Root: MeshCanvas + Sidebar, runs useGameLoop
  main.tsx
scripts/perf/           # Headless perf harness (CPU profile, React render counts, gameplay-equivalence diff) — see its README
```

## Core Game Loop

1. Click publisher → spawns event dot (respects cooldown)
2. Event slows through webhook, continues to subscriber
3. Subscriber consumes over ~1s → money increments when consume completes
4. Blockage: if webhook occupied or subscriber busy, event drops
5. Upgrade webhook → broker ($75) to unlock queues
6. Buy queues, wire connections via drag-to-connect
7. Automation via per-publisher auto-fire upgrades. The auto-publisher is polled every 100 ms of *simulation* time inside the game loop (not a wall-clock interval), so when frames run long publishing slows with everything else instead of flooding the mesh; the due publishers' dots are appended inside the frame's single `commitFrame` commit (manual clicks use `fireEvents`)
8. Broker fan-out: broker sends events to ALL connected queues with matching topics
9. Prestige ("Schema Registry") for permanent upgrades — points = floor(1.5 × cbrt(millions earned)), first point at $1M, Nth point costs ~N³ million (`getPrestigePointsFor` in `prestigeUpgradeConfig.ts`)
10. Publisher network tier: each publisher purchased (beyond the starter) permanently raises its own base event value by another 10% over the previous one, assigned by purchase order. Publisher purchases are capped at 24 (one per unique topic in the pool)
11. Broker bridge bonus: events whose route crosses a broker-to-broker bridge connection earn +50% value and render as gold dots once they exit the broker they bridge from
12. Queue value bonus: any event that passes through a queue on its way to a subscriber earns +5% value
13. End game: earning `WIN_THRESHOLD` ($1T, `upgradeConfig.ts`) in a single run (`totalEarned`, which prestige resets) shows the `WinScreen` once per save (`winSeen` persists; only a full wipe clears it). The sidebar's "Road to $1 Trillion" bar tracks per-run progress. Game loop + auto-publisher freeze while it's open; player picks Keep Playing or Start Over (full wipe, intro replays)

## Key Conventions

- Keep game logic (store, hooks) decoupled from rendering components
- All upgrade costs/effects in `upgradeConfig.ts` / `prestigeUpgradeConfig.ts` — avoid hardcoding
- `getUpgradesForType` is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync
- Adding new shop items: add action logic to `gameStore.ts`, add UI to `Sidebar.tsx`
- Performance rules (measured, see `scripts/perf/README.md`): the hot path is ONE store commit per frame — `commitFrame` in `gameStore.ts` takes the moved dots, the frame's consumes, the drop count, the due auto-publishers and the queue slot signatures and applies them with a plain `set({...})` (no immer; `applyConsumes` is the pure consume bookkeeping); immer auto-freeze is off. Never select `eventDots` from a React component that renders every frame — queue/DMQ cards read `queueSlotSignatures[id]` (a string the loop writes each frame); use `useThrottledGameStore` for sidebar-style numbers; drive per-frame visuals (cooldown overlays, webhook border) imperatively through refs. What a publisher emits per fire is cached per publisher (`getPublishPlan`) on the identity of `components`/`connections`/`upgrades`/`prestige` — never mutate those in place; paths and `originalNodeIds` arrays are immutable WeakMap cache keys. Dropped dots beyond `DROPPED_VISUAL_CAP` (300 falling at once) are counted but not animated unless the DMQ could catch them. Every per-frame rule in the traveling branch reads the cached **route profile** (`getPathInfo` → `PathInfo`: segment speed scales, webhook/cluster zones, node marks with `centerP`/`touchStart`) instead of testing pixel positions — add new position-based rules as profile zones/marks, never as per-dot `interpolatePath` tests. Dot objects are advanced **in place** (`dot.progress = …`); only status changes create new objects. Fork slices (`forkSpawnFor`) and queue→subscriber release paths (`releasePathCache`) are shared arrays so dots share profiles; the loop reads the clock once per frame (`frameNow`/`nowMs`).
- Before/after any perf or game-loop change: `npm run perf:build`, `npm run perf:serve`, then `node scripts/perf/behavior.mjs <S|M|L|U|W> <label>` and `node scripts/perf/compare.mjs <labelA> <labelB> S,M,L,U,W` — consumed/dropped/earned per second must stay within noise (`U` is the player-like heavy mesh, `W` the early-game webhook). For loop changes also run `node scripts/perf/dragsmoke.mjs M` (drags a queue and a broker mid-flight; every dot must stay on its cable, no errors)

## Detailed Documentation

See `claude-docs/` for in-depth reference (read as needed, not loaded by default):
- `visual-design.md` — colors, z-index layering, connection lines, event dot visuals
- `component-types.md` — full specs for Publisher, Webhook, Broker, Queue, DMQ, Subscriber
- `event-dot-lifecycle.md` — EventDot type, collision detection, game loop passes, forking
- `upgrades.md` — all upgrade tables (per-component, global, shop), cost formulas
- `dev-notes.md` — viewport, drag mechanics, path geometry, DMQ internals, prestige, tutorials, debugging tips
- `roadmap.md` — feature roadmap, known bugs, nice-to-have polish items
- `topic-routing-design.md` — topic system design decisions, matching rules, broadening, multi-broker bridging
