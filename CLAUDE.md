# Idle Mesh — Idle Clicker Game

An idle clicker game themed around **event-driven architecture (EDA)**, inspired by **Solace PubSub+**. The player builds and scales a distributed system by publishing events, routing them through brokers and queues, and consuming them with subscribers.

## Tech Stack

- **Framework**: React (Vite) + TypeScript
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Animation**: Framer Motion (component transitions) + raw Canvas API (event dot animation)
- **State Management**: Zustand with `immer` middleware
- **Persistence**: localStorage auto-save (key: `idle-mesh-save`), 500ms debounce. Excluded from save: `eventDots`, `recentEarnings`, `selectedNodeId`, `coinPops`, `draggingConnection`, `draggingNodeId`, `meshError`, `activeTutorial`, `showPrestigeTree`, `showWinScreen`

## File Structure

```
src/
  components/
    MeshCanvas.tsx      # SVG connections + EventCanvas + NodeCards + NodeModal + drag handling
    ConnectionLine.tsx  # Individual connection: SVG line + arrowhead + click-to-detach drag
    EventCanvas.tsx     # HTML5 canvas RAF loop, draws traveling/pausing/dropped dots
    NodeCard.tsx        # Individual node: color, ↑ upgrade icon, upgrade badge, output port, click handlers
    NodeModal.tsx       # Floating upgrade modal anchored to selected node
    Sidebar.tsx         # Balance, stats, collapsible sections (Schema Registry, Mesh Upgrades, Mesh Components)
    PrestigePanel.tsx   # Prestige stats, "Register Schema" button, confirmation dialog
    PrestigeTreePage.tsx # Full-page prestige skill tree with pan/zoom
    IntroSequence.tsx   # First-load cinematic: spaghetti diagram + Dave character intro; exports PixelCharacter (hoodie/tux outfits)
    WinScreen.tsx       # End-game overlay at $1B/run: confetti canvas, banner, stats, tux Dave, Keep Playing / Start Over
    TutorialModal.tsx   # Tutorial overlay with Dave (pixel-art character) delivering slides as speech bubbles
    TutorialGraphics.tsx # Animated SVG graphics for each tutorial slide (Framer Motion)
  store/
    gameStore.ts        # All Zustand state + actions, auto-save subscription
    upgradeConfig.ts    # All upgrade defs (cost, multiplier, maxLevel, label, description)
    prestigeUpgradeConfig.ts # Prestige tree node definitions (23 nodes)
    topicPool.ts        # Predefined topic pool for publisher/queue assignment
    tutorialConfig.tsx  # Tutorial slide definitions (title: string, body: ReactNode, optional graphic component)
  hooks/
    useGameLoop.ts      # RAF game loop (dot movement, webhook slowdown, consume/drop logic) + useAutoPublisher
    useViewport.ts      # Pan/zoom viewport: context, ref-based state, screenToWorld/worldToScreen helpers
    useTypewriter.ts    # Character-by-character text reveal for Dave's speech bubbles (intro + win screen)
  utils/
    connectionRules.ts  # canConnect(fromType, toType), getValidTargets() — connection validation
    topicMatching.ts    # Solace-style topic matching: wildcards (*, >) and subscription broadening
    orthogonalPath.ts   # Orthogonal line routing (horizontal → vertical → horizontal)
    pathUtils.ts        # interpolatePath(path, progress) → {x, y}
    formatMoney.ts      # $1,234.56 formatter
  App.tsx               # Root: MeshCanvas + Sidebar, runs useGameLoop + useAutoPublisher
  main.tsx
```

## Core Game Loop

1. Click publisher → spawns event dot (respects cooldown)
2. Event slows through webhook, continues to subscriber
3. Subscriber consumes over ~1s → money increments when consume completes
4. Blockage: if webhook occupied or subscriber busy, event drops
5. Upgrade webhook → broker ($75) to unlock queues
6. Buy queues, wire connections via drag-to-connect
7. Automation via per-publisher auto-fire upgrades
8. Broker fan-out: broker sends events to ALL connected queues with matching topics
9. Prestige ("Schema Registry") for permanent upgrades — scaling cost: Nth point costs $N million (triangular)
10. Publisher network tier: each publisher purchased (beyond the starter) permanently raises its own base event value by another 10% over the previous one, assigned by purchase order. Publisher purchases are capped at 24 (one per unique topic in the pool)
11. Broker bridge bonus: events whose route crosses a broker-to-broker bridge connection earn +50% value and render as gold dots once they exit the broker they bridge from
12. Queue value bonus: any event that passes through a queue on its way to a subscriber earns +5% value
13. End game: earning `WIN_THRESHOLD` ($1B, `upgradeConfig.ts`) in a single run (`totalEarned`, which prestige resets) shows the `WinScreen` once per save (`winSeen` persists; only a full wipe clears it). The sidebar's "Road to $1 Billion" bar tracks per-run progress. Game loop + auto-publisher freeze while it's open; player picks Keep Playing or Start Over (full wipe, intro replays)

## Key Conventions

- Keep game logic (store, hooks) decoupled from rendering components
- All upgrade costs/effects in `upgradeConfig.ts` / `prestigeUpgradeConfig.ts` — avoid hardcoding
- `getUpgradesForType` is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync
- Adding new shop items: add action logic to `gameStore.ts`, add UI to `Sidebar.tsx`

## Detailed Documentation

See `claude-docs/` for in-depth reference (read as needed, not loaded by default):
- `visual-design.md` — colors, z-index layering, connection lines, event dot visuals
- `component-types.md` — full specs for Publisher, Webhook, Broker, Queue, DMQ, Subscriber
- `event-dot-lifecycle.md` — EventDot type, collision detection, game loop passes, forking
- `upgrades.md` — all upgrade tables (per-component, global, shop), cost formulas
- `dev-notes.md` — viewport, drag mechanics, path geometry, DMQ internals, prestige, tutorials, debugging tips
- `roadmap.md` — feature roadmap, known bugs, nice-to-have polish items
- `topic-routing-design.md` — topic system design decisions, matching rules, broadening, multi-broker bridging
