# Idle Mesh — Idle Clicker Game

An idle clicker game themed around **event-driven architecture (EDA)**, inspired by **Solace PubSub+**. The player builds and scales a distributed system by publishing events, routing them through brokers and queues, and consuming them with subscribers.

## Tech Stack

- **Framework**: React (Vite) + TypeScript
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Animation**: Framer Motion (component transitions) + raw Canvas API (event dot animation)
- **State Management**: Zustand with `immer` middleware
- **Persistence**: localStorage auto-save (key: `idle-mesh-save`), 500ms debounce. Excluded from save: `eventDots`, `recentEarnings`, `selectedNodeId`, `coinPops`, `draggingConnection`, `draggingNodeId`, `meshError`, `activeTutorial`, `showPrestigeTree`

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
    TutorialModal.tsx   # Centered overlay modal for tutorial slides
    TutorialGraphics.tsx # Animated SVG graphics for each tutorial slide (Framer Motion)
  store/
    gameStore.ts        # All Zustand state + actions, auto-save subscription
    upgradeConfig.ts    # All upgrade defs (cost, multiplier, maxLevel, label, description)
    prestigeUpgradeConfig.ts # Prestige tree node definitions (16 nodes)
    topicPool.ts        # Predefined topic pool for publisher/queue assignment
    tutorialConfig.ts   # Tutorial slide definitions (title, body, optional graphic component)
  hooks/
    useGameLoop.ts      # RAF game loop (dot movement, webhook slowdown, consume/drop logic) + useAutoPublisher
    useViewport.ts      # Pan/zoom viewport: context, ref-based state, screenToWorld/worldToScreen helpers
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
3. Subscriber consumes over ~2.5s → money increments at ~50% done
4. Blockage: if webhook occupied or subscriber busy, event drops
5. Upgrade webhook → broker ($75) to unlock queues
6. Buy queues, wire connections via drag-to-connect
7. Automation via per-publisher auto-fire upgrades
8. Smart routing: broker routes to queue with most free buffer space
9. Prestige ("Schema Registry") at $1M for permanent upgrades

## Key Conventions

- Keep game logic (store, hooks) decoupled from rendering components
- All upgrade costs/effects in `upgradeConfig.ts` / `prestigeUpgradeConfig.ts` — avoid hardcoding
- `getUpgradesForType` is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync
- Adding new shop items: add action logic to `gameStore.ts`, add UI to `Sidebar.tsx`

## Not Yet Implemented
- **Topic Filter Boost**: broker upgrade hidden in UI — effect not yet defined
- **Topic pool expansion**: need more unique topics for late-game

## Detailed Documentation

See `claude-docs/` for in-depth reference (read as needed, not loaded by default):
- `visual-design.md` — colors, z-index layering, connection lines, event dot visuals
- `component-types.md` — full specs for Publisher, Webhook, Broker, Queue, DMQ, Subscriber
- `event-dot-lifecycle.md` — EventDot type, collision detection, game loop passes, forking
- `upgrades.md` — all upgrade tables (per-component, global, shop), cost formulas
- `dev-notes.md` — viewport, drag mechanics, path geometry, DMQ internals, prestige, tutorials, debugging tips
- `roadmap.md` — feature roadmap, known bugs, nice-to-have polish items
- `topic-routing-design.md` — topic system design decisions, matching rules, broadening, multi-broker bridging
