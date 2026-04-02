# Topic-Based Event Routing + Multi-Broker Mesh

> **STATUS: FULLY IMPLEMENTED** (as of 2026-04-02). All phases complete and tested. See TOPIC_ROUTING_TEST_PLAN.md for test results.

## Context

The game currently routes events purely by connection topology — any publisher fires to any connected queue through the broker. We're adding two systems that work together:

1. **Topic-based routing**: Publishers have fixed specific topics. Queues subscribe to topics and can broaden their subscription via upgrades to catch events from more publishers. Combined with fan-out, this creates the "double dip" optimization.
2. **Multi-broker mesh**: Multiple brokers connected via bridge links. A broker forwards events to bridged brokers when their downstream queues have matching topic subscriptions. Creates a true event mesh topology.

## Design Decisions (from discussion)

- **Publishers**: fixed specific topics, never change, displayed from game start
- **Queues**: start with subscription matching their first connected publisher, broaden via upgrade
- **No value penalty** for broadening — the payoff is throughput + fan-out double-dipping
- **Clustered topic hierarchies**: publishers come in thematic groups (orders, payments, etc.)
- **Broker-to-broker connections**: explicit drag-to-connect bridge links with topic-aware forwarding
- **Separate bridge slot upgrade**: independent from queue slots
- **Publishers connect to one broker**: that broker bridges to others
- **Second+ brokers**: purchased directly from shop (no webhook step)
- **Flexible tags**: `tags: Record<string, string>` on GameComponent for future features (regions, clusters, HA, VPNs) without type changes
- **Regions**: exist in topic strings (na/eu) but no gameplay effect yet — save for future tier

---

## 0. Future-Proofing: Tags System

Add `tags: Record<string, string>` to `GameComponent`. Not used mechanically in this implementation, but provides the extensibility layer for future Solace concepts:

| Future Feature | Tags Used | Mechanic |
|---|---|---|
| Geo Regions | `tags.region = 'na'` | Cross-region latency cost, visual canvas zones |
| HA Pairs | `tags.haPairId = 'broker-2'` | Redundant broker handles overflow |
| DMR Clusters | `tags.clusterId = 'dmr-1'` | Broker group auto-shares subscriptions |
| Message VPNs | `tags.vpn = 'default'` | Isolated topic namespaces within a broker |
| Priority/QoS | `tags.priority = 'high'` | Queue ordering policies |

Tags are persisted in save state and displayed nowhere in UI for now. Future features query tags to determine routing behavior, visual grouping, speed modifiers, etc.

---

## 1. Topic System

### Topic Pool (`src/store/topicPool.ts` — new file)

```
acme/orders/created/na/electronics/SKU001     (pub-1, starting)
acme/orders/created/eu/clothing/SKU042        (pub-2)
acme/payments/processed/na/cards/TXN001       (pub-3)
acme/payments/refunded/eu/cards/TXN099        (pub-4)
acme/inventory/updated/na/warehouse/WH005     (pub-5)
acme/inventory/updated/eu/warehouse/WH012     (pub-6)
acme/shipping/dispatched/na/logistics/SHP001  (pub-7)
acme/shipping/delivered/eu/logistics/SHP042   (pub-8)
```

### Topic Matching (`src/utils/topicMatching.ts` — new file)

- `topicMatches(publishTopic: string, subscriptionPattern: string): boolean`
  - `/` = level delimiter
  - `*` = matches exactly one level
  - `>` = matches one or more trailing levels (must be last segment)
- `computeBroadenedTopic(segments: string[], broadenLevel: number): string`
  - Level 0: full specific topic
  - Level 1: last segment → `*`
  - Level 2+: last N segments collapsed → `>`

### Queue Subscription Broadening

Example queue subscribed to `acme/orders/created/na/electronics/SKU001`:
- Level 0: `acme/orders/created/na/electronics/SKU001` → 1 publisher
- Level 1: `acme/orders/created/na/electronics/*` → same-category publishers
- Level 2: `acme/orders/created/na/>` → same-region orders
- Level 3: `acme/orders/created/>` → all created orders
- Level 4: `acme/orders/>` → all orders (captures orders cluster)
- Level 5: `acme/>` → everything

### Data Model Changes (`gameStore.ts`)

Extend `GameComponent`:
```ts
export type GameComponent = {
  // ...existing fields...
  topic?: string;                  // publisher: full specific topic (already exists)
  topicSegments?: string[];        // publisher: array of segments
  subscriptionTopic?: string;      // queue: current subscription pattern
  subscriptionSegments?: string[]; // queue: original full segments (for broadening)
  tags: Record<string, string>;   // flexible metadata for future features (regions, clusters, HA)
};
```

### Routing Integration (`gameStore.ts`, `fireEvent`, ~line 255)

Insert between path discovery and smart routing:
```ts
const pubComp = state.components.find(c => c.id === publisherId)!;
const pubTopic = pubComp.topic!;

const topicFilteredPaths = validPaths.filter(p => {
  const queueId = p.nodeIds.find(id =>
    state.components.find(c => c.id === id)?.type === 'queue');
  if (!queueId) return true;
  const queue = state.components.find(c => c.id === queueId);
  return !queue?.subscriptionTopic || topicMatches(pubTopic, queue.subscriptionTopic);
});
```

Then existing smart routing operates on `topicFilteredPaths`. ~10 lines, zero changes to existing logic.

### Queue Subscription Assignment

When a queue first connects to a broker (in `completeDragConnection`): look at publishers connected to that broker, pick the first one, and assign that publisher's topic as the queue's subscription (exact match). Store both `subscriptionTopic` and `subscriptionSegments`.

**Backward compat**: queues without `subscriptionTopic` match everything.

### Upgrade (`upgradeConfig.ts`)

Add to queue upgrades:
```ts
{ key: 'subscriptionBroaden', label: 'Broaden Subscription',
  description: 'Widen topic filter to accept events from more publishers',
  baseCost: 40, costMultiplier: 2, maxLevel: 5 }
```

When purchased, `upgradeComponent` recomputes `subscriptionTopic` from `subscriptionSegments` using `computeBroadenedTopic()`.

---

## 2. Multi-Broker Mesh

### Connection Rules (`connectionRules.ts`)

Add `'broker'` to broker's allowed targets:
```ts
broker: ['queue', 'subscriber', 'broker'],
```

Add bridge slot enforcement in `getValidTargets()`:
```ts
if (from.type === 'broker' && c.type === 'broker') {
  const maxSlots = 1 + (from.upgrades['addBridgeSlot'] ?? 0);
  if ((outgoingByType['broker'] ?? 0) >= maxSlots) return false;
}
```

Also enforce: no self-connections, no duplicate connections (already handled), and publisher connects to at most 1 broker (add limit).

### Publisher → Single Broker Limit

Add to `connectionRules.ts`:
```ts
if (from.type === 'publisher') {
  const existingBrokerConns = connections.filter(c => c.fromId === fromId).length;
  if (existingBrokerConns >= 1) return false;
}
```

### Path Discovery (`_getAllPathsWithNodes`)

Already uses DFS with cycle detection (`visited` set), so broker→broker→broker chains work naturally. The DFS walks:
```
Publisher → Broker1 → Broker2 → Queue → Subscriber
```

Each broker-to-broker hop adds waypoints. The visited set prevents infinite loops.

### Broker Upgrades (`upgradeConfig.ts`)

Add to broker upgrades:
```ts
{ key: 'addBridgeSlot', label: 'Add Bridge Slot',
  description: 'Allow connection to another broker (event mesh bridging)',
  baseCost: 80, costMultiplier: 2.5 }
```

Broker starts with 0 bridge slots (must upgrade to connect to another broker).

### Topic-Aware Bridging

No special bridging logic needed — the topic filter in `fireEvent` already handles this. The DFS discovers ALL paths through ALL brokers. The topic filter then keeps only paths where the destination queue's subscription matches the publisher's topic. If Broker2's queues don't match, those paths are filtered out.

### Shop (`Sidebar.tsx`)

Add "Buy Broker" button ($200, escalating: `200 * 2^n`). Available after first broker exists. Places broker unconnected on canvas.

### Visual

Broker-to-broker connection lines use the standard orthogonal routing. Bridge connections could optionally use a different dash pattern or color to distinguish from broker→queue lines.

---

## 3. New Shop Items

| Item | Cost | Escalation | Condition |
|------|------|------------|-----------|
| Publisher | $250 | × 1.5 per owned | After broker exists |
| Subscriber | $150 | × 1.5 per owned | After queue exists |
| Broker | $200 | × 2.0 per extra | After first broker exists |
| Queue | $60 | flat | After broker exists (existing) |
| DMQ | $80 | one-time | After broker exists (existing) |

---

## 4. UI Changes

### `NodeCard.tsx`
- Publishers: show last 2-3 topic segments as small text below label
- Queues: show subscription topic below label (wildcards highlighted in amber)

### `NodeModal.tsx`
- `subscriptionBroaden` upgrade card: shows current → next subscription pattern
- `addBridgeSlot` upgrade card: shows current/max bridge connections

### `Sidebar.tsx`
- New shop buttons for Publisher, Subscriber, Broker with escalating costs

---

## Files to Modify

| File | Change |
|------|--------|
| `src/utils/topicMatching.ts` | **New.** `topicMatches()`, `computeBroadenedTopic()` |
| `src/store/topicPool.ts` | **New.** Predefined topic hierarchies |
| `src/store/gameStore.ts` | Extend `GameComponent` (topic fields + tags), topic filtering in `fireEvent`, subscription assignment in `completeDragConnection`, broaden logic in `upgradeComponent`, topic assignment in `addComponent`, tags init |
| `src/store/upgradeConfig.ts` | Add `subscriptionBroaden` (queue), `addBridgeSlot` (broker) |
| `src/utils/connectionRules.ts` | Add broker→broker, bridge slot limit, publisher single-broker limit |
| `src/components/NodeCard.tsx` | Display topics on publisher/queue nodes |
| `src/components/NodeModal.tsx` | Topic broaden + bridge slot upgrade previews |
| `src/components/Sidebar.tsx` | Publisher, Subscriber, Broker shop buttons |

---

## Implementation Order

### Phase 1: Topic Engine (no UI changes yet)
1. Create `src/utils/topicMatching.ts`
2. Create `src/store/topicPool.ts`

### Phase 2: Data Model
3. Extend `GameComponent` type with topic fields + tags
4. Assign topic to `pub-1` in initial state
5. Update `addComponent` for new publishers (assign from pool)
6. Add queue subscription assignment on broker connection

### Phase 3: Routing
7. Insert topic filtering in `fireEvent` (~10 lines)

### Phase 4: Topic Upgrades
8. Add `subscriptionBroaden` to queue upgrades
9. Wire broaden logic in `upgradeComponent`

### Phase 5: Multi-Broker Connections
10. Update `connectionRules.ts`: broker→broker, bridge slots, publisher single-broker
11. Add `addBridgeSlot` to broker upgrades
12. Verify `_getAllPathsWithNodes` DFS handles broker chains (should work via existing cycle detection)

### Phase 6: Shop Expansion
13. Add Publisher, Subscriber, Broker shop buttons to Sidebar

### Phase 7: UI
14. Display topics on NodeCard
15. Upgrade previews in NodeModal

### Phase 8: Polish
16. Topic labels on connection lines
17. Visual distinction for broker-broker bridge connections

---

## Verification

1. Fresh game: pub-1 shows topic `acme/orders/created/na/electronics/SKU001`
2. Buy broker → buy queue → connect to broker → queue auto-gets matching subscription
3. Fire events → route to matching queue (same behavior as before)
4. Buy 2nd publisher ($250) → different topic, connect to same broker
5. Fire from pub-2 → events DON'T go to queue-1 (subscription mismatch)
6. Upgrade queue subscription → broadens → now matches both publishers
7. Fan-out + multiple subscribers → double-dip on multi-publisher events
8. Buy 2nd broker ($200) → upgrade bridge slot on broker-1 → connect broker-1 → broker-2
9. Buy queue on broker-2 with matching subscription → events flow pub → broker-1 → broker-2 → queue → sub
10. Load old save → queues without subscription match everything (backward compat)
