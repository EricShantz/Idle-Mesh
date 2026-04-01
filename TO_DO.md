# Idle Mesh — Feature Roadmap

Organized by progression tier, aligned with **Solace PubSub+ event mesh** concepts.

---

## Tier 1: Core Mechanics (Near-term)

Essential features that complete the Solace-inspired EDA experience.

- [ ] **Topic System**
  - Publishers emit events on topic strings (e.g., `orders/created`, `payments/processed`)
  - Visual topic labels on publisher nodes and connection lines
  - Default topic or user-configurable per publisher
  - Topics could appear on the connection strings, but how would users manage workflows? e.g. publisher pushes event to topic A, queue subscribes to Topic A, then subscriber consumes from queue

- [ ] **Queue Subscriptions with Wildcards**
  - Queues subscribe to topic patterns: `orders/*`, `orders/>`, `payments/*`
  - Solace-style hierarchical matching (`>` = catch-all, `*` = single level)
  - UI: text input or hierarchical selector on queue upgrade modal

- [ ] **Persistent Delivery (Fan-out)**
  - Multiple subscribers can attach to one queue
  - Each event delivered to all subscribers (all earn money)
  - Visual: queue shows all connected subscribers

- [ ] **Dead Letter Queue (DMQ)**
  - DMQ is a component with configurable width (upgradeable)
  - Failed/dropped events fall off screen toward DMQ
  - If DMQ catches the event (intersects width), event routes back to broker at 50% value
  - Upgrades: DMQ Shape Width (wider catch zone), DMQ Recovery Rate (increase replay value: 50% → 60% → 75%)
  - Unlock via global upgrade ($80 or similar cost)

---

## Tier 2: Progression Depth

Expand player agency and deepen the optimization puzzle.

- [ ] **Multi-Publisher & Multi-Subscriber**
  - Purchase additional publishers from shop (2nd, 3rd, etc.) after broker upgrade
  - Each can emit different topics (e.g., `orders/created`, `payments/processed`)
  - Independent cooldown and upgrade tracks per publisher
  - Cost: ~$200-300 per publisher
  - Similarly, purchase additional subscribers from shop after queue purchase
  - Enables parallel processing and complex topologies
  - Each new publisher and subscriber could have a different "topic", and they should be more and more expensive, but their base value for events / consumming events should also be higher

- [ ] **Broker: Add Queue Slot (Mechanical)**
  - Currently UI-only; make it mechanically limit queue connections
  - Broker with 0 slots: queues cannot attach
  - Each upgrade adds 1 slot (like persistent queue capacity)
  - Forces progression: upgrade broker to scale queue topology

- [ ] **Queue: Add Subscriber Slot (Mechanical)**
  - Currently UI-only; limit how many subscribers per queue
  - Queue with 1 slot (default): only one subscriber, no fan-out
  - Each upgrade: +1 subscriber allowed
  - Prerequisite for fan-out strategy

- [ ] **Upgrade UI Enhancement: Show Current Values**
  - Display current component value when upgrading (e.g., "Add Subscriber Slot: 1 → 2")
  - Helps players see immediate impact of upgrades
  - Apply to all per-component upgrades

- [ ] **Sync Broker & Queue Upgrades**
  - Ensure broker queue slots and queue subscriber slots work mechanically together
  - Broker slots limit how many queues can attach
  - Queue slots limit how many subscribers can attach
  - Both prevent "cheesing" the topology

- [ ] **Topic Filter Boost (Broker Upgrade)**
  - Make mechanical: enables advanced wildcard syntax on queues
  - Without it: only basic patterns (`orders/*`)
  - With it: full Solace syntax (`orders/>`, regex-like patterns)
  - Cost scaling similar to other broker upgrades

---

## Tier 3: Advanced / Idle Scaling

Long-term vision for deep progression and endless scaling fantasy.

- [ ] **Event Mesh Visualization**
  - Show topic label on connection lines (SVG text above lines)
  - Dynamic updates when topics change
  - Color-code lines by topic (e.g., orders = blue, payments = orange)

- [ ] **Multiple Brokers**
  - Ability to purchase second broker ($150-200)
  - Can connect to different publishers/queues
  - Begin sketching multi-broker mesh topology (bridges between brokers)

- [ ] **Broker Bridging**
  - Brokers can relay events to each other (mesh topology)
  - Foundation for true event mesh with multiple hops
  - Advanced visualization: show topic flowing across mesh

- [ ] **DMQ Replay Scaling**
  - Auto-replay disabled events (with increasing cost)
  - Dead letter explorer: view dropped event topics/counts
  - "Salvage Rate" upgrade: increase partial replay value (e.g., 50% → 75%)

- [ ] **Solace-Flavored Unlocks**
  - Rename global upgrades to Solace concepts:
    - "Auto-Publisher Lv.3" → "PubSub+ Activated"
    - "Global Value" → "Event Mesh Throughput ×1.5"
    - "Faster Routing" → "Sub-millisecond Relay"
  - Achievement/milestone notifications: "Event Mesh Online!", "Distributed Topology Unlocked"

- [ ] **Advanced Topic Patterns**
  - Regex-style subscriptions (if UI supports it)
  - Topic-based earnings: certain topics pay more (unlocked via upgrade)
  - Dynamic topic routing: publisher can switch topics

- [ ] **Dynamic Connection Rewiring (Boomi-style)**
  - Drag connection lines to reassign where components connect
  - Users can re-orchestrate their mesh at any time
  - Constraint validation: prevent invalid connections
    - Publishers → Broker/Webhook only (no direct subscriber)
    - Subscribers must come from Queue or Broker
    - DMQ must route back to Broker
    - Queues go between Broker and Subscriber(s)
  - Enables player creativity in topology design

- [ ] **Schema Registry: Prestige System**
  - Cost: $1,000,000 per prestige
  - Earn prestige points based on total money earned that run (e.g., 1 prestige point per $1M earned)
  - After prestiging, player reset to fresh mesh with no upgrades/money
  - **Permanent Upgrade Tree**: spend prestige points on permanent buffs that persist across runs
    - Permanent global value multiplier (1.1x, 1.2x, 1.5x)
    - Permanent propagation speed boost
    - Permanent cost reduction
    - Permanent auto-publisher unlock
  - Creates deep progression fantasy and replayability

---

## Known Bugs / Technical Debt

- [ ] **Event routing bug**: If multiple queues sit between broker and 1 subscriber, events can pass through the subscriber and route to another queue before being consumed or dropped. Check path validation logic.

---

## Implementation Notes

### ✅ Already Implemented
- [x] Queue functionality: events pause at queue when subscriber busy, auto-release when free (done!)

### ❓ Clarification Needed
- **Micro-Integrations / Gateways**: What should these do? Examples?
  - Gateways could be connection points between brokers (mesh federation)
  - Micro-integrations could be lightweight adapters (format conversion, filtering, etc.)
  - Need design spec before implementation

---

## Nice-to-Have / Polish

- [ ] Keyboard shortcuts for common actions (click publisher, expand modal)
- [ ] Replay/undo button for failed topology experiments
- [ ] Persistent DMQ: events visible across sessions (or reset on new game)
- [ ] Steam integration: achievements for Solace milestones
- [ ] Tutorial: guided first 2 minutes explaining Solace concepts
