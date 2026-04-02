# Idle Mesh — Feature Roadmap

Organized by progression tier, aligned with **Solace PubSub+ event mesh** concepts.

---

## Tier 1: Core Mechanics (Near-term)

Essential features that complete the Solace-inspired EDA experience.

- [x] **Topic System**
  - Publishers emit events on specific topic strings (e.g., `acme/orders/created/na/electronics/SKU001`)
  - Visual topic labels on publisher and queue nodes
  - Topics assigned from predefined pool per publisher

- [x] **Queue Subscriptions with Wildcards**
  - Queues auto-subscribe to matching publisher topic on first broker connection
  - Broaden Subscription upgrade: `*` (single level) → `>` (catch-all) across segments
  - Solace-style hierarchical matching via `topicMatching.ts`
  - Topic picker UI in queue upgrade modal

- [x] **Persistent Delivery (Fan-out)**
  - Multiple subscribers can attach to one queue (via Add Subscriber Slot upgrade)
  - Queue duplicates events at release time to all connected subscribers
  - One-time "Persistent Delivery" upgrade per queue

- [x] **Dead Letter Queue (DMQ)**
  - DMQ component with configurable width (upgradeable)
  - Catches dropped events during gravity fall
  - Retries through broker at partial value (10% base + 10% per Value Recovery level)
  - Upgrades: Width, Faster Release, Buffer Size, Value Recovery
  - One-time purchase from shop ($80)

---

## Tier 2: Progression Depth

Expand player agency and deepen the optimization puzzle.

- [x] **Multi-Publisher & Multi-Subscriber**
  - Purchase additional publishers/subscribers from shop with escalating costs
  - Each publisher has a unique topic from the pool
  - Independent cooldown and upgrade tracks per publisher
  - Publishers: $250 base (×1.5), Subscribers: $150 base (×1.5)

- [x] **Broker: Add Queue Slot (Mechanical)**
  - Mechanically limits queue connections (1 + upgrade level)
  - Enforced in connection validation — excess connections rejected with toast

- [x] **Queue: Add Subscriber Slot (Mechanical)**
  - Mechanically limits subscriber connections (1 + upgrade level)
  - Prerequisite for fan-out strategy

- [x] **Upgrade UI Enhancement: Show Current Values**
  - All upgrades show `current → next (+delta)` format
  - Level number shown in top-right corner of each card

- [x] **Sync Broker & Queue Upgrades**
  - Broker queue slots and queue subscriber slots both mechanically enforced
  - Connection validation checks slot limits in both `getValidTargets()` and `completeDragConnection()`

- [ ] **Topic Filter Boost (Broker Upgrade)**
  - Hidden in UI — effect not yet defined
  - Topic system exists but this upgrade's gameplay effect needs design

---

## Tier 3: Advanced / Idle Scaling

Long-term vision for deep progression and endless scaling fantasy.

- [ ] **Event Mesh Visualization**
  - Color-code connection lines by topic (e.g., orders = blue, payments = orange)
  - Dynamic updates when topics change

- [x] **Multiple Brokers**
  - Purchase additional brokers from shop ($200 base, ×2 per extra)
  - Connect to different publishers/queues
  - Multi-broker mesh topology via bridge connections

- [x] **Broker Bridging**
  - Broker-to-broker bridge connections via Add Bridge Slot upgrade
  - Events relay across brokers with topic-aware filtering
  - Visually distinct bridge lines (thicker, orange-tinted)
  - Bidirectional DFS traversal for path discovery

- [ ] **DMQ Replay Scaling**
  - Auto-replay disabled events (with increasing cost)
  - Dead letter explorer: view dropped event topics/counts

- [ ] **Solace-Flavored Unlocks**
  - Rename global upgrades to Solace concepts:
    - "Auto-Publisher Lv.3" → "PubSub+ Activated"
    - "Global Value" → "Event Mesh Throughput ×1.5"
    - "Faster Routing" → "Sub-millisecond Relay"
  - Achievement/milestone notifications: "Event Mesh Online!", "Distributed Topology Unlocked"

- [ ] **Advanced Topic Patterns**
  - Topic-based earnings: certain topics pay more (unlocked via upgrade)
  - Dynamic topic routing: publisher can switch topics
  - Topic pool expansion: pool cycles back after 8th publisher — need more unique topics

- [x] **Dynamic Connection Rewiring (Boomi-style)**
  - Click-to-detach and drag connections to reassign targets
  - Output port drag-to-connect for creating new connections
  - Full constraint validation: publishers → broker/webhook, subscribers from queue/broker, DMQ → broker, etc.
  - Connection slot limits enforced per component type

- [x] **Schema Registry: Prestige System**
  - Cost: $1,000,000 total earned per prestige
  - Earn 1 prestige point per $1M earned in current run
  - After prestiging, player reset to fresh mesh with no upgrades/money
  - Auto-navigates to full-page prestige skill tree after reset
  - **Permanent Upgrade Tree** (16 nodes, radial layout with branching arms):
    - Center: Income Boost (×1.1 multiplier)
    - Up branch: Event Speed I/II/III → Batch Start; sub-branch: Quick Consume
    - Right branch: Auto-Publisher I/II; sub-branch: Quick Publish
    - Left branch: Discount I/II; sub-branch: Cheaper Components (-15% shop)
    - Down branch: Value Boost I/II → Queue Head Start; sub-branch: Sub Value Boost
  - Tree page has pan/zoom (same viewport system as mesh canvas)
  - "View Skill Tree" button in sidebar after first prestige
  - Sidebar sections (Schema Registry, Mesh Upgrades, Mesh Components) are collapsible

---

## Known Bugs / Technical Debt

- [ ] **Bridge rendering glitch**: dots released from a queue behind a bridge appear to start halfway down the queue→subscriber segment at max propagation speed
- [ ] **Topic pool limited**: pool cycles back to first topic after 8th publisher — need more unique topics for late-game

---

## Implementation Notes

### ✅ Already Implemented
- [x] Queue functionality: events pause at queue when subscriber busy, auto-release when free
- [x] Topic system: publishers have fixed topics, queues subscribe with broadening upgrades
- [x] Multi-broker mesh: bridge connections with topic-aware forwarding
- [x] Fan-out: persistent delivery duplicates events at queue release time
- [x] DMQ: catches dropped events, retries through broker at partial value
- [x] Multi-publisher/subscriber: shop purchases with escalating costs
- [x] Connection slot limits: mechanical enforcement for broker→queue, queue→subscriber, broker→broker
- [x] Dynamic connection rewiring: click-to-detach, drag-to-connect, output port creation
- [x] Upgrade value display: current → next (+delta) format on all upgrade cards
- [x] Tutorial system: intro slides on first load + contextual popups on first component purchase/unlock
- [x] Prestige system (Schema Registry): full reset with prestige points, 16-node radial skill tree page with pan/zoom, permanent upgrades persist across runs
- [x] Collapsible sidebar sections: Schema Registry, Mesh Upgrades, Mesh Components

### ❓ Clarification Needed
- **Micro-Integrations / Gateways**: What should these do? Examples?
  - Gateways could be connection points between brokers (mesh federation)
  - Micro-integrations could be lightweight adapters (format conversion, filtering, etc.)
  - Need design spec before implementation

---

## Nice-to-Have / Polish

- [ ] Replay/undo button for failed topology experiments
- [x] Tutorial: intro slides + contextual popups on first component unlock
- [ ] Tutorial: when the prestige option becomes available for the first time display a tutorial modal explaining that they can now prestige
- [ ] Tutorial: when the user clicks the prestige button for the first time and gets navigated to the prestige upgrade tree view, show a tutorial modal explaining how the permanent upgrade tree works
- [ ] put upgrades in the right hand side bar into dropdown menus (e.g. a drop down menu for global upgrades, another dropdown for Broker upgrades). Eventually im going to add more content and this will make it easier so the user doesnt have to scroll so much