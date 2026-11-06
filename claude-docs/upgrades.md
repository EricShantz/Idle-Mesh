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
| Increase Throughput | **Functional**: raises relay cap = `8 + level*(level+9)/2` events/sec (×cluster slot count, see below). Applies at every broker hop a dot crosses, not just the first — bridging no longer bypasses capacity. | $100 | ×2.2 | 10 (103/sec) until clustered, then unlimited |
| Upgrade to DMR Cluster | **Functional, one-time**: hidden until Increase Throughput is maxed. Relabels to "DMR Cluster", keeps `type: 'broker'` (all existing broker connection/routing rules still apply unchanged), starts with 2 broker slots, and removes Increase Throughput's level cap permanently. | $250,000 | — | 1 |
| Add Cluster Slot | **Functional**: hidden until DMR Cluster is purchased. Each level adds one more broker to the cluster (2 → 3 → 4), multiplying the combined throughput cap by the slot count. | $150,000 | ×4 | 2 (4 total slots) |

**DMR Cluster throughput cost curve**: once clustered, Increase Throughput keeps leveling past 10 with no cap, but the cost multiplier eases from ×2.2 to ×1.4 for levels 10+ (base $150,000 for level 10→11) — see `getEffectiveUpgradeCost` / `getThroughputCostAtLevel` in `upgradeConfig.ts`. This is the intended permanent fix for broker overload at max throughput — previously the only option was building a disconnected second mesh. The multiplier was ×2.0 until 2026-11-05 (the late-game fan-out mesh cost ~$5e21), then ×1.25 (~$3B), then ×1.4 with the relay accounting below (~$98B, a tenth of the $1T win).

**Relay accounting (2026-11-05, scale-plan Phase F)**: a broker relays **one copy per link it fans out on** — one relay per queue it sends to, one per bridge — and the cluster at the far end of a bridge does its own fan-out and pays for it (how Solace DMR works). Before, every copy of a fan-out was spawned, and charged, at the publisher's first broker. For the late-game mesh (20 publishers at 1,200 events/s into one DMR Cluster bridged to two, 4 queues each) the ingestion cluster now pays 2 relays per event (level ~31 with 4 slots) and each bridged cluster 4 (level ~45), instead of 8 / 4 / 4 (ingestion near level 65). A copy refused at the ingestion cluster's cap takes every delivery behind that bridge with it, counted as one drop (a lost link copy). See `src/sim/forkTree.ts`.

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
| Publisher | $150 | ×1.8 | Additional publisher, placed unconnected. Single-broker connection limit. Capped at 24 total (one per unique topic) — button disables and shows "MAX" once reached. |
| Subscriber | $75 | ×1.8 | Additional subscriber, placed unconnected. |
| Broker | $200 | ×2.0 | Additional broker for multi-broker mesh. Bridge to other brokers via broker→broker connections. |

## Mesh-Wide Value Modifiers
These aren't bought or leveled directly — they're derived from how the mesh is built.

- **Publisher Network Tier**: each publisher bought from the shop (not the free starter) gets a permanent tier equal to its purchase order (1st purchased = tier 1, 2nd = tier 2, ...), stored as `upgrades.networkTier`. `getPublisherTierMultiplier(tier)` returns `1 + tier * 0.1`, multiplied into that publisher's `getEventValue()` result. The badge on a purchased publisher's node shows `Base Value + N0%`. Shown on the Event Value upgrade card too (starting $ reflects the tier). Publisher purchases are capped at 24 (`TOPIC_POOL.length`) since every publisher needs a unique topic.
- **Broker Bridge Bonus**: an event whose route crosses a broker-to-broker bridge connection earns ×1.5 value (`BRIDGE_VALUE_MULT`), applied once per event regardless of how many bridges it crosses. Visually, the dot is cyan until it exits the broker it bridges from, then switches to gold (`BRIDGE_GOLD_COLOR`, `#fde047`) for the rest of the trip.
- **Queue Value Bonus**: an event whose route passes through a queue earns ×1.05 value (`getQueueValueMultiplier()`, `QUEUE_VALUE_BONUS_PER_HOP = 0.05`), stacking multiplicatively with the bridge bonus. Rewards routing through queues instead of straight to a subscriber.

## Accelerating Upgrade Curves
- Most percentage-based upgrades use: `boostPct = level * (level + 9) / 2` (5%, 11%, 18%, 26%... 95% at level 10)
- Publisher value upgrades use: `$1.00 + level * 0.45 + level² * 0.05` (each level adds $0.10 more than previous)
- Subscriber consumption is a non-linear multiplier: `1.0 + level*0.08 + level²*0.02` applied to the final dot value
- Income Multiplier uses compounding: `1.4 + level * 0.1` per level (×1.5, ×1.6, ×1.7...)
- All upgrade cards show `current → next (+delta)` format via `getUpgradeValueDisplay()` / `getGlobalUpgradeValueDisplay()`
- Each upgrade card has a **"MAX ×N"** pill (bottom-right) that bulk-purchases all affordable levels in one click. Hidden for one-time upgrades (maxLevel === 1) and when the player can't afford any levels.
