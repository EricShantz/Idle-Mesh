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

Topics are clustered in groups of 6 so that each broadening level captures exactly one additional publisher from the same cluster.

```
── Orders cluster (pubs 1–6) ──
acme/orders/created/na/electronics/SKU001     (pub-1, starting)
acme/orders/created/na/electronics/SKU002     (pub-2, differs in identifier)
acme/orders/created/na/clothing/SKU003        (pub-3, differs in category)
acme/orders/created/eu/warehouse/SKU004       (pub-4, differs in region)
acme/orders/processed/na/cards/SKU005         (pub-5, differs in action)
acme/payments/fulfilled/na/logistics/SKU006   (pub-6, differs in domain)

── Payments cluster (pubs 7–12) ──
acme/payments/processed/na/cards/TXN001       (pub-7)
acme/payments/processed/na/cards/TXN002       (pub-8)
acme/payments/processed/na/crypto/TXN003      (pub-9)
acme/payments/processed/eu/bank/TXN004        (pub-10)
acme/payments/refunded/na/cards/TXN005        (pub-11)
acme/inventory/settled/na/cards/TXN006        (pub-12)

── Inventory cluster (pubs 13–18) ──
acme/inventory/updated/na/warehouse/WH001     (pub-13)
acme/inventory/updated/na/warehouse/WH002     (pub-14)
acme/inventory/updated/na/fulfillment/WH003   (pub-15)
acme/inventory/updated/eu/distribution/WH004  (pub-16)
acme/inventory/depleted/na/warehouse/WH005    (pub-17)
acme/shipping/restocked/na/warehouse/WH006    (pub-18)

── Shipping cluster (pubs 19–24) ──
acme/shipping/dispatched/na/logistics/SHP001  (pub-19)
acme/shipping/dispatched/na/logistics/SHP002  (pub-20)
acme/shipping/dispatched/na/express/SHP003    (pub-21)
acme/shipping/dispatched/eu/freight/SHP004    (pub-22)
acme/shipping/delivered/na/logistics/SHP005   (pub-23)
acme/orders/tracking/na/logistics/SHP006      (pub-24)
```

Pool wraps around after 24 publishers.

## Topic Matching

- `/` = level delimiter
- `*` = matches exactly one level
- `>` = matches one or more trailing levels (must be last segment)
- `computeBroadenedTopic(segments, broadenLevel)`: Level 0 = full specific, Level 1 = last segment -> `*`, Level 2+ = last N segments -> `>`

### Broadening Example

Queue subscribed to `acme/orders/created/na/electronics/SKU001`:
- Level 0: `acme/orders/created/na/electronics/SKU001` (1 publisher — pub 1 only)
- Level 1: `acme/orders/created/na/electronics/*` (+pub 2, same category different identifier)
- Level 2: `acme/orders/created/na/>` (+pub 3, different category)
- Level 3: `acme/orders/created/>` (+pub 4, different region)
- Level 4: `acme/orders/>` (+pub 5, different action)
- Level 5: `acme/>` (+pub 6 and everything else)

## Routing Integration

Topic filtering inserted in `fireEvent` between path discovery and smart routing. Filters `validPaths` to only those where the destination queue's `subscriptionTopic` matches the publisher's topic via `topicMatches()`. Queues without `subscriptionTopic` match everything (backward compat).

## Queue Subscription Assignment

On first broker connection (`completeDragConnection`): looks at publishers connected to that broker, picks the first one, assigns that publisher's topic as exact-match subscription. Stores both `subscriptionTopic` and `subscriptionSegments`.

## Multi-Broker: Topic-Aware Bridging

No special bridging logic — the DFS in `_getAllPathsWithNodes` discovers all paths through all brokers. Topic filter then keeps only paths where destination queue subscription matches. If Broker2's queues don't match, those paths are filtered out.
