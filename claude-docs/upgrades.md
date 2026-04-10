# Upgrade Tables

## Per-Component Upgrade Modals

Access by clicking the **↑ icon** on any node. Modal is anchored to the node.

### Publisher
| Upgrade | Effect | Base Cost | Multiplier | Max Level |
|---|---|---|---|---|
| Event Value | Accelerating: `$1.00 + level*0.45 + level²*0.05` (+$0.10 more each level) | $5 | ×1.8 | unlimited |
| Publish Speed | Accelerating: `level*(level+9)/2`% cooldown reduction | $4 | ×1.8 | 10 (95%) |
| Auto-Click | Automatically clicks this publisher, respecting cooldown | $300 | — | 1 (one-time) |

### Webhook
| Upgrade | Effect | Cost |
|---|---|---|
| Upgrade to Broker | Changes type to broker, unlocks queue shop | $50 (one-time) |
| Faster Routing +20% | Reduces webhook slowdown | $8, $16, $32 (max 3) |

### Broker
| Upgrade | Effect | Base Cost | Multiplier | Max Level |
|---|---|---|---|---|
| Add Queue Slot | **Functional**: max queue connections = 1 + level | $40 | ×2 | unlimited |
| Add Bridge Slot | **Functional**: max broker-to-broker connections = 0 + level. **Both brokers consume a slot** — a single drag connects them bidirectionally, but each broker's slot count is decremented. | $80 | ×2.5 | unlimited |
| Increase Throughput | **Functional**: raises ingestion cap = `8 + level*(level+9)/2` events/sec. Ingestion-only — bridged events don't count. | $100 | ×2.2 | 10 (103/sec) |
| Topic Filter Boost | Hidden in UI (effect not yet defined) | $60 | ×2 | — |

### Queue
| Upgrade | Effect | Base Cost | Multiplier |
|---|---|---|---|
| Add Subscriber Slot | **Functional**: max subscriber connections = 1 + level | $30 | ×2 |
| Persistent Delivery (`fanOut`) | **Functional**: queue duplicates events at release time to all connected subscribers | $200 (one-time) |  |
| Increase Queue Size | **Functional**: queue capacity = 3 + level (max 20 slots) | $10 | ×1.2 | 17 |
| Broaden Subscription | **Functional**: widens topic filter each level (specific → `*` → `>` across segments) | $40 | ×2 | 5 |

### Dead Message Queue (DMQ)
| Upgrade | Effect | Base Cost | Multiplier | Max Level |
|---|---|---|---|---|
| Increase Width +40px | Wider catch zone (base 120px) | $15 | ×1.2 | unlimited |
| Increase Queue Size | Queue capacity = 3 + level, max depends on width (2 rows of `8 + widthLevel*3`) | $10 | ×1.2 | width-dependent |
| Value Recovery +10% | Retry value = (10% + 10%/level) of original, max 100% | $50 | ×2 | 9 |

### Subscriber
| Upgrade | Effect | Base Cost | Multiplier | Max Level |
|---|---|---|---|---|
| Consumption Multiplier | Multiplies final payout: `1.0 + level*0.08 + level²*0.02` (×1.10, ×1.24, ×1.42...) — non-linear, applied after dot value and all upstream multipliers | $5 | ×1.8 | unlimited |
| Faster Consumption | Accelerating: `min(level*(level+9)/2, 100)`% consume duration reduction | $4 | ×1.8 | 11 (100%) |

## Global Upgrades (Sidebar)

Global upgrades use the same `UpgradeDef` system as node upgrades — each is a single card with escalating cost per level, tracked via `globalUpgradeLevels: Record<string, number>` in the store.

| Upgrade | Effect | Base Cost | Multiplier | Max Level |
|---|---|---|---|---|
| Faster Event Propagation | Accelerating: `level*(level+9)/2`% speed boost, multiplier = `1 + boostPct/100` | $25 | ×1.8 | 10 (95%) |
| 10% Cheaper Upgrades | Cost reduction, stackable | $50 | ×4.5 | 3 |
| Event Batching | +1 event per click per level (staggered start, `progress: batch * -0.04`) | $200 | ×2.5 | 5 (6 events) |
| Income Multiplier | Accelerating: each level multiplies by `1.4 + level*0.1` (×1.5, ×1.6, ×1.7...) | $500 | ×3 | 5 |

## Shop (visible after broker upgrade)
| Component | Cost | Cost Multiplier | Notes |
|---|---|---|---|
| Queue | $30 | ×1.3 | Places unconnected on canvas, user wires via drag-to-connect |
| Dead Message Queue | $100 (one-time) | — | Catches dropped events, retries through broker. Connect top port to broker. |
| Publisher | $150 | ×1.8 | Additional publisher, placed unconnected. Single-broker connection limit. |
| Subscriber | $75 | ×1.8 | Additional subscriber, placed unconnected. |
| Broker | $200 | ×2.0 | Additional broker for multi-broker mesh. Bridge to other brokers via broker→broker connections. |

## Accelerating Upgrade Curves
- Most percentage-based upgrades use: `boostPct = level * (level + 9) / 2` (5%, 11%, 18%, 26%... 95% at level 10)
- Publisher value upgrades use: `$1.00 + level * 0.45 + level² * 0.05` (each level adds $0.10 more than previous)
- Subscriber consumption is a non-linear multiplier: `1.0 + level*0.08 + level²*0.02` applied to the final dot value
- Income Multiplier uses compounding: `1.4 + level * 0.1` per level (×1.5, ×1.6, ×1.7...)
- All upgrade cards show `current → next (+delta)` format via `getUpgradeValueDisplay()` / `getGlobalUpgradeValueDisplay()`
- Each upgrade card has a **"MAX ×N"** pill (bottom-right) that bulk-purchases all affordable levels in one click. Hidden for one-time upgrades (maxLevel === 1) and when the player can't afford any levels.
