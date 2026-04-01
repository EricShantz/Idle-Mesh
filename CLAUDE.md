# Idle Mesh — Idle Clicker Game

## Project Overview

An idle clicker game themed around **event-driven architecture (EDA)**. The player builds and scales a distributed system by publishing events, routing them through brokers and queues, and consuming them with subscribers. The game teaches real EDA concepts (pub/sub, fan-out, dead letter queues, persistent messaging, topic hierarchies) through satisfying progression mechanics.

The core fantasy is threefold: **satisfying automation** (watching events flow hands-free), **optimization puzzle** (tuning topology and throughput), and **collection/unlocking** (discovering new EDA concepts as upgrades).

---

## Design Inspiration: Solace PubSub+

The game's mechanics and progression are inspired by **Solace PubSub+**, a modern event mesh platform. Solace's architecture directly maps to the game's component progression:

- **Webhook** → HTTP-style point-to-point routing with synchronous processing (slow, blocking)
- **Broker** → Solace's instant relay layer for sub-millisecond message ingestion and routing
- **Queues** → Persistent endpoints that buffer and deliver events asynchronously (enables async decoupling)
- **Topic Hierarchies** → Solace wildcard subscriptions (`orders/*/created`, `orders/>`) for flexible pub/sub patterns
- **Fan-out** → Queue's persistent delivery to multiple subscribers (Solace Queue → multiple Subscribers)
- **Dead Letter Queue** → Undeliverable or dropped events stored for replay/analysis (Solace DMQ semantics)

This inspiration ensures the game teaches authentic EDA patterns while maintaining engaging idle gameplay.

---

## Tech Stack

- **Framework**: React (Vite)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- **Animation**: Framer Motion (component transitions) + raw Canvas API (event dot animation on the mesh)
- **State Management**: Zustand with `immer` middleware
- **Persistence**: localStorage auto-save on state change, loaded on mount (`idle-mesh-save` key)
- **Target Platforms**:
  - Browser (primary)
  - Android via Capacitor
  - Steam/Desktop via Electron

---

## Visual Design

- **Background**: Deep dark navy (`#0a0e1a`)
- **Nodes**: Rounded rectangles with border glow. Color-coded by type:
  - Publisher: teal/cyan (`#22d3ee`)
  - Webhook: amber (`#f59e0b`)
  - Broker: bright orange-red (`#fb923c`) — visually distinct from webhook to signal the upgrade
  - Queue: purple (`#a855f7`)
  - Subscriber: green (`#22c55e`)
- **Connection lines**: 1.5px dashed, muted blue-gray (`#334155`), drawn in SVG at z-index 5
- **Event dots**: 6px filled circles traveling along connection lines
  - Traveling: cyan (`#66ffff`) with radial glow
  - Pausing at subscriber: cyan, shrinks/fades over ~2.5s
  - Dropped: red (`#ff4444`), falls with gravity, fades over ~600ms
- **Z-index layering**: connections (5) → event canvas (25) → non-publisher nodes (20) → publisher (30)
  - Publishers render on top so events appear to emerge from behind them
  - Events render on top of subscribers so the consumption animation is visible

---

## Game Layout

```
┌─────────────────────────────────────┬──────────────────┐
│                                     │   SIDEBAR        │
│         MESH CANVAS                 │                  │
│   (nodes + animated event dots)     │  $ Balance       │
│                                     │  Stats           │
│                                     │  ──────────      │
│                                     │  Global          │
│                                     │  Upgrades        │
│                                     │  ──────────      │
│                                     │  Shop            │
│                                     │  (Buy            │
│                                     │  Components)     │
└─────────────────────────────────────┴──────────────────┘
```

- **Mesh canvas**: SVG connection lines + HTML5 canvas for event dots + React nodes
- **Upgrade modal**: Small floating panel anchored to the node, opened via the ⚙ gear icon in the node's top-right corner
- **Upgrade badge**: Red circle on each node showing how many upgrades are currently affordable

---

## Starting State

```
[ Publisher ] ──── [ Webhook ] ──── [ Subscriber ]
```

- Publisher at `(150, 300)`, Webhook at `(450, 300)`, Subscriber at `(750, 300)`
- Publisher click is on a **1-second cooldown** (upgradeable). Clicking during cooldown does nothing.
- Events travel at base speed `0.0007` (progress units/ms), taking ~1.3 seconds to traverse the full path
- **Webhook slowdown**: events travel at 40% speed while passing through the webhook. The slowdown region is dynamically calculated to align with the webhook's visual edges. Up to 3 "Faster Routing" upgrades reduce this by 20% each.
- When the dot reaches the subscriber edge, it **pauses and shrinks** over 2.5 seconds, then money increments. The pause threshold is dynamically calculated based on node positions and approach direction.
- Dropped events travel toward the blockage point before falling, not from the publisher. Drop positions are calculated to match visual node edges.

---

## Core Game Loop

1. **Click** publisher → spawns a traveling event dot (respects cooldown)
2. **Event slows** through the webhook, continues to subscriber
3. **Subscriber consumes** over ~2.5s → money increments when animation is ~50% done
4. **Blockage points**: if webhook is occupied, next event drops at webhook edge; if subscriber is busy, event drops at subscriber edge
5. **Spend money** on per-component upgrades (publish speed, event value, faster consumption) and global upgrades
6. **Upgrade webhook → broker** ($75) to unlock queue purchases
7. **Buy queues** ($60 each) to sit between broker and subscriber
8. **Automation**: unlock auto-publisher tiers for idle income
9. **Fan-out** (future): persistent delivery to multiple subscribers via queues

---

## Component Types

### Publisher
- Click target. Fires one event per click (subject to cooldown).
- **Cooldown**: 1 second base, reduced 5% per `publishSpeed` upgrade level
- Upgrades: Event Value (+$0.50), Publish Speed (+5% cooldown reduction, up to ~20 levels)

### Webhook
- Middle-hop between publisher and subscriber
- **Visually slows events** (40% speed while passing through). Max 3 "Faster Routing" upgrades.
- Only one event in the webhook at a time — new events drop at its entrance if occupied
- One-time upgrade to **Broker** ($75) changes type, label, color, and opens broker upgrade modal

### Broker (upgraded Webhook)
- Same position as the webhook it replaced; label and color change on purchase
- Unlocks the **Queue shop item** in the sidebar
- Upgrades: Add Queue Slot, Topic Filter Boost (config-defined, not yet mechanically implemented)

### Queue
- Purchased from the sidebar shop for $60 (requires broker)
- Placed at midpoint between broker and subscriber, offset downward: `y = 300 + (n+1) * 140`
- On purchase: broker→subscriber direct connection is replaced with broker→queue→subscriber
- Upgrades: Add Subscriber Slot, Persistent Delivery (Fan-out), Increase Buffer Size (config-defined, not yet mechanically implemented)

### Subscriber
- Consumes events. Pauses for ~2.5s while "processing" (shrink animation), then money increments.
- **Faster Consumption** upgrade: 5% reduction per level (~20 levels to significantly reduce time)
- Upgrades: Consumption Value (+$0.50), Faster Consumption (+5%)

---

## Event Dot Lifecycle

```ts
type EventDot = {
  id: string;
  path: { x: number; y: number }[];  // waypoints from getPathForPublisher()
  progress: number;                   // 0.0 → 1.0 along full path
  speed: number;                      // 0.0007 * propagationSpeed multiplier
  status: 'traveling' | 'pausing' | 'dropped' | 'consumed';
  pauseStartTime?: number;            // Date.now() when pausing began
  dropX?: number;
  dropY?: number;
  dropVY?: number;
  color: string;
  opacity: number;
  value: number;
};
```

**Key behaviors:**
- `traveling` → slows at webhook (0.4–0.6 progress), drops at webhook edge if occupied
- `traveling` → transitions to `pausing` at progress 0.9 (subscriber edge) if subscriber is free
- `pausing` → shrinks/fades over 2.5s; consumed (money added) when shrink reaches ~50%
- `dropped` → gravity fall + fade over 600ms; position is where the blockage occurred

---

## Per-Component Upgrade Modals

Access by clicking the **⚙ icon** on any node. Modal is anchored to the node.

### Publisher
| Upgrade | Effect | Base Cost | Multiplier |
|---|---|---|---|
| Event Value +$0.50 | Each event worth more | $10 | ×2.5 |
| Publish Speed +5% | 5% cooldown reduction per level | $8 | ×1.15 |

### Webhook
| Upgrade | Effect | Cost |
|---|---|---|
| Upgrade to Broker | Changes type to broker, unlocks queue shop | $75 (one-time) |
| Faster Routing +20% | Reduces webhook slowdown | $20, $40, $80 (max 3) |

### Broker
| Upgrade | Effect | Base Cost | Multiplier |
|---|---|---|---|
| Add Queue Slot | (UI only, not yet mechanical) | $40 | ×2 |
| Topic Filter Boost | (UI only, not yet mechanical) | $60 | ×2 |

### Queue
| Upgrade | Effect | Base Cost | Multiplier |
|---|---|---|---|
| Add Subscriber Slot | (UI only, not yet mechanical) | $30 | ×2 |
| Persistent Delivery | Fan-out to all subscribers | $100 (one-time) |  |
| Increase Buffer Size | (UI only, not yet mechanical) | $45 | ×2 |

### Subscriber
| Upgrade | Effect | Base Cost | Multiplier |
|---|---|---|---|
| Consumption Value +$0.50 | Each event earns more | $10 | ×2.5 |
| Faster Consumption +5% | 5% reduction per level | $8 | ×1.15 |

---

## Sidebar

### Stats
Balance (large), Total earned, Consumed, Dropped, Events/sec, $/sec, Mesh size

### Global Upgrades
| Upgrade | Effect | Cost |
|---|---|---|
| Faster Event Propagation | All dots 15% faster | $25 (repeatable) |
| 10% Cheaper Upgrades | Cost reduction, stackable 3× | $50 |
| Dead Letter Queue | (UI only) | $80 |
| Auto-Publisher Lv.1 | First publisher fires every 5s | $150 |
| Auto-Publisher Lv.2 | Every 3s | $400 |
| Auto-Publisher Lv.3 | Every 1s | $1,000 |
| Event Batching | (UI only) | $200 |
| Global Value ×1.5 | All earnings multiplied | $500 |

### Shop (visible after broker upgrade)
| Component | Cost | Notes |
|---|---|---|
| Queue | $60 | Places between broker and subscriber, rewires connections |

---

## What's Implemented vs Planned

### ✅ Implemented
- Publisher → Webhook → Subscriber static mesh
- **Drag-to-move**: any component can be repositioned by dragging; connection lines follow in real-time
- Click-to-fire with cooldown (upgradeable)
- Event dot animation: travel, webhook slowdown, subscriber pause/shrink, drop with gravity
- **Dynamic path thresholds**: webhook slowdown region and subscriber pause/drop points calculated from actual node positions and approach direction — works for any mesh configuration
- **Queue buffering**: events pause at queue nodes when subscriber is busy, auto-release when free. Visual slot indicators on queue cards. Overflow drops at queue edge.
- Blockage at webhook (drops at entrance if occupied)
- Blockage at broker: instant relay (no slowdown), still blocks one at a time until queues added
- Blockage at subscriber (drops at subscriber edge if consuming)
- Per-node upgrade modal (gear icon), upgrade count badge
- Publisher upgrades: Event Value, Publish Speed (both functional)
- Webhook upgrades: Upgrade to Broker (functional — removes delay, changes type/color/label), Faster Routing (functional)
- Broker upgrades: Add Queue Slot (UI only), Topic Filter Boost (UI only)
- Queue upgrades: Add Subscriber Slot (UI only), Increase Buffer Size (functional), Persistent Delivery (UI only)
- Subscriber upgrades: Consumption Value, Faster Consumption (both functional)
- Global upgrades: Propagation Speed, Cost Reduction, Auto-Publisher (all functional)
- Broker/Queue/Subscriber shop in sidebar (Queue purchasable, placed + connected automatically)
- Auto-save / load from localStorage
- Z-index layering (events emerge from publisher, fade on top of subscriber); dragged nodes elevate to z-index 50

### 🔲 Not yet implemented (config exists, UI shows, but no mechanical effect)
- **Solace-inspired features**:
  - Topic hierarchies: publishers emit on topic strings (e.g., `orders/created`), queues subscribe with wildcards (`orders/*`, `orders/>`) following Solace syntax
  - Persistent Delivery (fan-out): multiple subscribers attached to one queue, all receiving the event
  - Dead Letter Queue: dropped/overflowed events stored in DMQ, replayed for partial value
  - Topic Filter Boost: enables advanced wildcard patterns on broker/queue subscriptions
- **Mechanical upgrades**: Broker Add Queue Slot (limits queue connections), Queue Add Subscriber Slot (prerequisite for fan-out)
- **Shop expansion**: Second Publisher (different topic), Second Subscriber, additional queues
- **Advanced mechanics**: Event batching (multi-fire), mesh topology visualization (topic labels on lines), multi-broker mesh

---

## File Structure (actual)

```
src/
  components/
    MeshCanvas.tsx      # SVG connections + EventCanvas + NodeCards + NodeModal
    EventCanvas.tsx     # HTML5 canvas RAF loop, draws traveling/pausing/dropped dots
    NodeCard.tsx        # Individual node: color, gear icon, upgrade badge, click handlers
    NodeModal.tsx       # Floating upgrade modal anchored to selected node
    Sidebar.tsx         # Balance, stats, global upgrades, shop
  store/
    gameStore.ts        # All Zustand state + actions, auto-save subscription
    upgradeConfig.ts    # All upgrade defs (cost, multiplier, maxLevel, label, description)
  hooks/
    useGameLoop.ts      # RAF game loop (dot movement, webhook slowdown, consume/drop logic) + useAutoPublisher
  utils/
    pathUtils.ts        # interpolatePath(path, progress) → {x, y}
    formatMoney.ts      # $1,234.56 formatter
  App.tsx               # Root: MeshCanvas + Sidebar, runs useGameLoop + useAutoPublisher
  main.tsx
```

---

## Development Notes for Claude Code

- **Starting balance for testing**: change `balance: saved?.balance ?? 0` in `gameStore.ts` line ~141. Clear localStorage to reset to the new default.
- **Dynamic path thresholds**: `useGameLoop.ts` computes subscriber pause/drop and webhook slowdown thresholds on every frame for each dot using `getPathThresholds(dot.path)`. The function accounts for actual segment lengths and approach direction (horizontal vs vertical) so events pause/drop at the correct visual edges regardless of node positions. The math uses equal-progress-per-segment interpolation (from `interpolatePath`), not Euclidean distance.
- **Drag-to-move**: implemented in `NodeCard.tsx` using pointer capture + ref-based drag state. State update happens on every `pointermove` (via `moveComponent` in `gameStore.ts`) so connection lines and event canvas follow in real-time. Gear button has `onPointerDown` stopPropagation to prevent drag-start when clicking upgrades.
- **Clock consistency**: `pauseStartTime` uses `Date.now()` (Unix epoch). The RAF `time` argument is a different clock — don't mix them.
- **Upgrade effects location**: most per-component upgrade effects are read in `useGameLoop.ts` by looking up the component by position from the dot's path array. Global upgrade effects are applied in `purchaseGlobalUpgrade` in `gameStore.ts`.
- **`getUpgradesForType`** is duplicated in `NodeModal.tsx` and `NodeCard.tsx` — keep both in sync when adding new component types.
- **Adding new shop items**: add action logic to `gameStore.ts`, add UI to `Sidebar.tsx` shop section. Auto-placement should respect existing component positions.
- Keep game logic (store, hooks) decoupled from rendering components.
- All upgrade costs/effects in `upgradeConfig.ts` — avoid hardcoding in components.
