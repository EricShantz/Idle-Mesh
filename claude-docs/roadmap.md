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

### Tier 3: Advanced / Idle Scaling
- [ ] **Event Mesh Visualization** — color-code connection lines by topic
- [ ] **Advanced Topic Patterns** — dynamic topic routing (pool cycles after 24th publisher)
- [ ] ~~**Topic-Based Earnings**~~ — removed: value tiers and specificity bonus were too complex for users

---

## Known Bugs / Technical Debt
- [ ] Bridge rendering glitch: dots released from a queue behind a bridge appear to start halfway down the queue->subscriber segment at max propagation speed
- [ ] Topic pool cycles back after 24th publisher (4 clusters of 6)

---

## Nice-to-Have / Polish
- [ ] Replay/undo button for failed topology experiments
- [ ] Tutorial: prestige availability notification when $1M first reached
- [ ] Tutorial: prestige tree explanation on first visit
- [x] Tutorial/UI: explain competing consumers vs fan-out on queue — `firstFanOut` tutorial triggers on first Persistent Delivery purchase
- [x] Sidebar upgrades in dropdown menus (global upgrades dropdown, broker upgrades dropdown, etc.) to reduce scrolling
- [x] Show a tutorial slide the first time an event drops - explaining what that means, and that the user needs to upgrade the component that the events are dropping off at
- [x] after the user upgrades the webhook to a broker, they get a broker tutorial slide. after they close that slide, the side menu should scroll down to show the new components. The new components should be highlighted and a new tutorial slide should pop up explaining that they now have new components they can add to their mesh, and to purchase one for more information on each one.
- [ ] explore if it would be a better gameplay experience to have upgrades such as "Event Value" and "Consumption Mulitplier" be made global upgrades instead of per/component. Would this be more convinient to the player? What are the pros and cons of each
- [ ] Need to figure out the event propagation speed down the lines, should they be consistent at all times? or vary depending on line length so events reach the same endpoint at the same time?
- [ ] make autoclicker a 1 time upgrade per publisher, then have it act like a normal user click (cooldown timer etc), then upgrade the autoclick speed by upgrading the publish speed
---

## Clarification Needed
- **Micro-Integrations / Gateways**: potential future components. Gateways = broker federation points, micro-integrations = lightweight adapters (format conversion, filtering). Needs design spec.
