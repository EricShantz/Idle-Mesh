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
- [x] Schema Registry: Prestige System (15-node radial skill tree, permanent upgrades)
- [x] Tutorial System (intro slides + contextual popups)
- [x] Collapsible Sidebar Sections
- [x] Publisher Network Tier (each publisher purchased raises its own base event value by 10% over the previous one, by purchase order; capped at 24 publishers total)
- [x] Broker Bridge Value Bonus (events crossing a broker-to-broker bridge earn +50% value and render as gold dots once they exit the broker they bridge from)
- [x] Queue Value Bonus (events routed through a queue earn +5% value, stacking with the bridge bonus)
- [x] DMR Cluster (broker upgrade, hidden until throughput is maxed — relabels broker to "DMR Cluster", uncaps Increase Throughput, and adds purchasable cluster slots up to 4x combined capacity; fixes the "only option is a separate mesh" dead-end at max broker throughput)

---

## Not Yet Implemented

### Tier 3: Advanced / Idle Scaling
- [ ] **Event Mesh Visualization** — color-code connection lines by topic

---

## Known Bugs / Technical Debt
- [ ] **Performance degradation in mid/late game** — frame rate suffers when many nodes, connections, and event dots are active simultaneously. Two passes done: (1) game loop no longer runs against an immer draft, canvas glow is a cached sprite, canvas no longer reallocates per frame; (2) consumes are batched into one store commit per frame (`consumeEvents`) with a bounded, per-frame-aggregated `recentEarnings`, the auto-save subscriber no longer JSON-stringifies on every commit (lazy debounced check), `NodeCard` is memoized and selects derived values (`affordableUpgradeCount`, its own cooldown) instead of `balance`/`publisherCooldowns`, and only webhook/queue/DMQ cards subscribe to `eventDots`. (3) Pass 1 no longer re-scans the component list per dot — waypoint→component matching, `originalNodeIds` resolution, connection-existence checks, the webhook lookup and DMR cluster bounds are all per-frame maps/sets/lists built once. Also fixed: returning from a hidden tab was glacial because the first frame's `dt` spanned the whole absence (every dot teleported to its destination and the queue released the entire pile spread across that one giant frame) and the auto-publisher's `setInterval` kept piling up dots while hidden — `dt` is now clamped to 100ms and auto-fire skips while `document.hidden`. Remaining cost is roughly linear in live dots (canvas arc+drawImage per dot, per-dot path interpolation) — the next lever would be culling off-screen dots in `EventCanvas`. The Sidebar shows a live "Frame rate" stat.
- [x] ~~**Queue overflow with fanout + broadened subscriptions**~~ — root cause was two-fold: (1) Pass 1 counted same-frame arrivals against the buffer before Pass 2 released them, so any burst larger than the buffer dropped its tail even though the queue drained completely a moment later; (2) a fixed per-frame release cap (1, or 3 with Prefetch) that no upgrade could raise. Fixed by gating the buffer on previous-frame backlog and removing the cap in favor of the chained, order-aware subscriber timing check. Verified: zero drops at ~400 events/sec into a 9-slot queue, including fan-out to 5 maxed subscribers.

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
- [x] DMQ releases to any connected broker via bridge routing to the original destination
- [x] user should be able to change queue subscription even when queue is fully broadened
---

## Clarification Needed
- **Micro-Integrations / Gateways**: potential future components. Gateways = broker federation points, micro-integrations = lightweight adapters (format conversion, filtering). Needs design spec.
