# Topic Routing & Multi-Broker Mesh — Design Reference

> Fully implemented as of 2026-04-02.

## Design Decisions

- **Publishers**: fixed specific topics, never change, displayed from game start. All publishers have uniform base value ($1.00).
- **Queues**: start with subscription matching their first connected publisher, broaden via upgrade
- **Broadening is pure upside** — wider subscriptions catch more events with no payout penalty
- **Clustered topic hierarchies**: publishers come in thematic groups (orders, payments, etc.)
- **Broker-to-broker connections**: explicit drag-to-connect bridge links with topic-aware forwarding
- **Separate bridge slot upgrade**: independent from queue slots
- **Publishers connect to one broker**: that broker bridges to others
- **Second+ brokers**: purchased directly from shop (no webhook step)
- **Flexible tags**: `tags: Record<string, string>` on GameComponent for future features (regions, clusters, HA, VPNs)
- **Regions**: exist in topic strings (na/eu) but no gameplay effect yet

## Tags System (Future-Proofing)

`tags: Record<string, string>` on `GameComponent`. Not used mechanically yet, but provides extensibility for:

| Future Feature | Tags Used | Mechanic |
|---|---|---|
| Geo Regions | `tags.region = 'na'` | Cross-region latency cost, visual canvas zones |
| HA Pairs | `tags.haPairId = 'broker-2'` | Redundant broker handles overflow |
| DMR Clusters | `tags.clusterId = 'dmr-1'` | Broker group auto-shares subscriptions |
| Message VPNs | `tags.vpn = 'default'` | Isolated topic namespaces within a broker |
| Priority/QoS | `tags.priority = 'high'` | Queue ordering policies |

## Topic Pool

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

## Topic Matching

- `/` = level delimiter
- `*` = matches exactly one level
- `>` = matches one or more trailing levels (must be last segment)
- `computeBroadenedTopic(segments, broadenLevel)`: Level 0 = full specific, Level 1 = last segment -> `*`, Level 2+ = last N segments -> `>`

### Broadening Example

Queue subscribed to `acme/orders/created/na/electronics/SKU001`:
- Level 0: `acme/orders/created/na/electronics/SKU001` (1 publisher)
- Level 1: `acme/orders/created/na/electronics/*` (same-category)
- Level 2: `acme/orders/created/na/>` (same-region orders)
- Level 3: `acme/orders/created/>` (all created orders)
- Level 4: `acme/orders/>` (all orders)
- Level 5: `acme/>` (everything)

## Routing Integration

Topic filtering inserted in `fireEvent` between path discovery and smart routing. Filters `validPaths` to only those where the destination queue's `subscriptionTopic` matches the publisher's topic via `topicMatches()`. Queues without `subscriptionTopic` match everything (backward compat).

## Queue Subscription Assignment

On first broker connection (`completeDragConnection`): looks at publishers connected to that broker, picks the first one, assigns that publisher's topic as exact-match subscription. Stores both `subscriptionTopic` and `subscriptionSegments`.

## Multi-Broker: Topic-Aware Bridging

No special bridging logic — the DFS in `_getAllPathsWithNodes` discovers all paths through all brokers. Topic filter then keeps only paths where destination queue subscription matches. If Broker2's queues don't match, those paths are filtered out.
