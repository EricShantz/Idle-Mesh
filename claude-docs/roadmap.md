# Feature Roadmap

## Completed

- [x] Topic System (publishers emit on specific topics, queues subscribe with wildcards)
- [x] Queue Subscriptions with Wildcards (Solace-style `*` and `>` matching, broaden upgrade)
- [x] Persistent Delivery / Fan-out (queue duplicates events to all connected subscribers)
- [x] Dead Letter Queue (DMQ) (catches dropped events, retries at partial value)
- [x] Multi-Publisher & Multi-Subscriber (shop purchases with escalating costs)
- [x] Broker: Add Queue Slot (mechanical limit, 1 + upgrade level)
- [x] Queue: Add Subscriber Slot (mechanical limit, 1 + upgrade level)
- [x] Upgrade UI: current -> next (+delta) format on all cards
- [x] Multiple Brokers (shop purchase, $200 base x2 per extra)
- [x] Broker Bridging (broker-to-broker bridge connections, topic-aware forwarding, bidirectional DFS)
- [x] Dynamic Connection Rewiring (click-to-detach, drag-to-connect, output port creation)
- [x] Schema Registry: Prestige System (16-node radial skill tree, permanent upgrades)
- [x] Tutorial System (intro slides + contextual popups)
- [x] Collapsible Sidebar Sections

---

## Not Yet Implemented

### Tier 2: Progression Depth
- [ ] **Topic Filter Boost** — broker upgrade hidden in UI, effect not yet defined

### Tier 3: Advanced / Idle Scaling
- [ ] **Event Mesh Visualization** — color-code connection lines by topic
- [ ] **DMQ Replay Scaling** — auto-replay disabled events, dead letter explorer
- [ ] **Solace-Flavored Unlocks** — rename global upgrades to Solace concepts, achievement notifications
- [ ] **Advanced Topic Patterns** — topic-based earnings, dynamic topic routing, topic pool expansion (pool cycles after 8th publisher)

---

## Known Bugs / Technical Debt
- [ ] Bridge rendering glitch: dots released from a queue behind a bridge appear to start halfway down the queue->subscriber segment at max propagation speed
- [ ] Topic pool limited: pool cycles back to first topic after 8th publisher

---

## Nice-to-Have / Polish
- [ ] Replay/undo button for failed topology experiments
- [ ] Tutorial: prestige availability notification when $1M first reached
- [ ] Tutorial: prestige tree explanation on first visit
- [x] Sidebar upgrades in dropdown menus (global upgrades dropdown, broker upgrades dropdown, etc.) to reduce scrolling

---

## Clarification Needed
- **Micro-Integrations / Gateways**: potential future components. Gateways = broker federation points, micro-integrations = lightweight adapters (format conversion, filtering). Needs design spec.
