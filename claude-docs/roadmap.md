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
- [ ] **Performance degradation in mid/late game** — frame rate suffers when many nodes, connections, and event dots are active simultaneously
- [ ] **Queue overflow with fanout + broadened subscriptions** — queues drop excessive events when subscriptions accept from multiple publishers, even at max subscriber consumption speed

---

## Nice-to-Have / Polish
- [x] Tutorial: prestige availability notification when $1M first reached
- [x] Tutorial/UI: explain competing consumers vs fan-out on queue — `firstFanOut` tutorial triggers on first Persistent Delivery purchase
- [x] Sidebar upgrades in dropdown menus (global upgrades dropdown, broker upgrades dropdown, etc.) to reduce scrolling
- [x] Show a tutorial slide the first time an event drops - explaining what that means, and that the user needs to upgrade the component that the events are dropping off at
- [x] after the user upgrades the webhook to a broker, they get a broker tutorial slide. after they close that slide, the side menu should scroll down to show the new components. The new components should be highlighted and a new tutorial slide should pop up explaining that they now have new components they can add to their mesh, and to purchase one for more information on each one.
- [x] "MAX ×N" pill on each upgrade card — bulk-purchases all affordable levels in one click
- [x] "!" warning button (top-left, next to help) — shows active drop reasons per node with fix suggestions, auto-decays after 2s
- [x] fix upgrade icons on components — SVG chevron folder-tab above top-right of card, colored when affordable / grey+hidden behind card when not, removed red badge
- [x] make prestige cards bigger so you can actually read whats on them
- [x] add delete button to all purchased component upgrade modals (except the default publisher, webhook, broker, and subscriber. We dont want users to delete these and get soft locked if they dont have any money left)
- [x] the monetary requirement to gain prestige points should scale upwards in how expensive they are
- [x] add intro sequence the first time the game loads that shows a super messy spaghetti code graphic full of point to point connections that are failing all over, the screen should pulse red, then a message should show up saying something like "Ugh! this legacy code is a nightmare to deal with... That's it! I'm going to rebuild it using Event-Driven Architecture'
---

## Clarification Needed
- **Micro-Integrations / Gateways**: potential future components. Gateways = broker federation points, micro-integrations = lightweight adapters (format conversion, filtering). Needs design spec.
