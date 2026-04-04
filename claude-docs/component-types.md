# Component Types

## Publisher
- Click target. Fires one event per click (subject to cooldown).
- **Cooldown**: 1 second base, reduced by accelerating curve: `boostPct = level * (level + 9) / 2`, `cooldown = 1000 * (1 - boostPct/100)`. Max level 10 (95% reduction).
- **Base event value**: $1.00, plus accelerating upgrade increments: `value = 1.0 + level * 0.45 + level² * 0.05`. No max level.
- **Auto-Publisher** upgrade: per-publisher automation. Lv1: 5s, Lv2: 3s, Lv3: 1s, Lv4: 0.75s, Lv5: 0.5s, Lv6: 0.25s, Lv7: 0.1s. Bypasses manual cooldown (`skipCooldown`). Each publisher fires independently at its own interval.
- Upgrades: Event Value (accelerating $), Publish Speed (accelerating % cooldown reduction), Auto-Publisher (per-publisher auto-fire)

## Webhook
- Middle-hop between publisher and subscriber
- **Visually slows events** (40% speed while passing through). Max 3 "Faster Routing" upgrades.
- Only one event in the webhook at a time — new events drop at its entrance if occupied
- One-time upgrade to **Broker** ($50) changes type, label, color, and opens broker upgrade modal

## Broker (upgraded Webhook)
- Same position as the webhook it replaced; label and color change on purchase
- Unlocks the **Queue shop item** in the sidebar
- **Queue slot limit**: broker starts with 1 queue connection slot, +1 per `addQueueSlot` upgrade level. Connection validation enforces this — excess connections are rejected with a mesh error toast.
- **Bridge slot limit**: brokers start with 0 bridge slots (must upgrade via `addBridgeSlot`). Connecting two brokers consumes **one slot on each broker** — a single drag operation handles this automatically. Both brokers must have a free slot or the connection is rejected with a mesh error toast indicating which broker is full.
- **Throughput cap (ingestion-only)**: each broker can ingest a limited number of events/sec from publishers. Base cap = 8 events/sec, increased by `increaseThroughput` upgrade (accelerating: `8 + level*(level+9)/2`). The cap only applies at the **first broker** a dot encounters (the publisher's directly-connected broker). Events relayed through bridges to downstream brokers do **not** count against those brokers' caps. Fan-out fork dots spawned at the ingestion broker DO count. When over capacity, events drop at the broker (gravity fall, catchable by DMQ). Tracked via a rolling 1-second window of `performance.now()` timestamps per broker in module-level state in `useGameLoop.ts` (not persisted).
- **Throughput bar**: thin horizontal bar inside the broker node showing current utilization. Green → yellow (>70%) → red (>90%). Driven by `getBrokerUtilization()` exported from `useGameLoop.ts`.
- Upgrades: Add Queue Slot (**functional**), Add Bridge Slot (**functional**), Increase Throughput (**functional**)

## Queue
- Purchased from the sidebar shop for $30 (requires broker)
- Placed unconnected on the canvas, offset downward: `y = 300 + (n+1) * 140`
- User wires connections manually via drag-to-connect (output port → target node)
- Each queue is independent with its own unique ID, buffer, and connections
- **Always captures** arriving dots on collision — dots never pass through a queue
- Buffer capacity = `3 + bufferSize upgrade level` (base holds 3 events, max 20 slots = 2 rows of 10)
- **Auto-release**: FIFO by `pauseStartTime` — oldest queued dot released first, one per frame, only when the queue has a current connection to a subscriber AND subscriber is free (no pausing dot, no traveling dot past any queue heading to that subscriber). Uses current connection graph, not baked paths.
- **Visual slot indicators**: filled slots pack to the right (oldest dot = rightmost slot, newest = leftmost filled slot). Empty slots on the left. Retry dots show orange (`#fb923c`), normal dots show their publisher's topic color. Sorted by `pauseStartTime`.
- **Subscriber slot limit**: queue starts with 1 subscriber connection slot, +1 per `addSubscriberSlot` upgrade level. Enforced the same way as broker queue slots.
- **Topic subscription**: when a queue first connects to a broker, it auto-subscribes to the topic of a reachable publisher. Users can change the subscription via a "Change Topic" picker in the upgrade modal, which lists one entry per reachable publisher (including through bridges), each broadened to the queue's current `subscriptionBroaden` level. At high broaden levels, multiple publishers may collapse into the same wildcard pattern — duplicates are deduplicated, so fewer choices appear. When only one option exists, the picker is hidden. Selecting a different topic calls `setQueueSubscription()` which updates `subscriptionSegments` (original publisher segments), `subscriptionTopic`, and `subscriptionBroaden` level to match.
- **Deletable**: red "Delete Queue" button in upgrade modal. Removes the queue, all its connections, and any dots queued in it.
- Upgrades: Add Subscriber Slot, Persistent Delivery/`fanOut`, Faster Release, Increase Buffer Size, Broaden Subscription (all **functional**)

## Dead Message Queue (DMQ)
- Purchased from the sidebar shop for $100 (requires broker, one-time purchase)
- Placed unconnected on the canvas below the broker. User wires via drag-to-connect.
- **Output port**: top-center (unique — all other nodes have right-edge ports). Can only connect to a broker.
- **Catch mechanic**: while a dropped (non-retry) dot falls with gravity, if its `dropX` is within the DMQ's horizontal bounds and `dropY` reaches the DMQ's top edge, the dot is caught and queued in the DMQ buffer.
- **Dynamic width**: base 120px, +40px per `dmqWidth` upgrade level. Wider = catches more falling events.
- **Buffer**: works like regular queues — capacity = `3 + dmqBufferSize` upgrade level (base holds 3 events). Max capacity depends on width: 2 rows of `8 + dmqWidthLevel * 3` slots each (base = 16 max). Visual slot indicators use same fill/empty logic as queues (packed right, oldest rightmost, retry orange, normal cyan). Upgrade modal shows "Increase Width to unlock more capacity" when buffer is width-capped. Releases one dot per frame only when the previous retry dot has cleared the DMQ→broker connection line.
- **Retry behavior**: released dots travel from DMQ → broker → same original route (rebuilt from current component positions via stored `originalNodeIds`). Retry dots are orange (`#fb923c`), worth `originalValue * (10% + 10% per dmqValueRecovery level)`, capped at 100%. Retry dots that drop a second time turn dark grey and are **not** re-caught by the DMQ (no infinite loops).
- **Pass 2 exclusion**: DMQ-queued dots are skipped by the regular queue release pass (Pass 2); they are only released by the dedicated DMQ release pass (Pass 3).
- **Faster Release**: accelerating curve (`boostPct = level * (level + 9) / 2`) reduces how far the previous retry dot must travel before the next is released. At level 0 the previous dot must be 100% past the DMQ→broker segment; each level reduces this threshold. Max level 10 (95%).
- **Deletable**: red "Delete DMQ" button in upgrade modal. Removes the DMQ and all its connections; DMQ becomes available again in the shop.
- Upgrades: Increase Width, Faster Release, Increase Buffer Size, Value Recovery (all **functional**)

## Subscriber
- Consumes events. Pauses for ~1s while "processing" (shrink animation), then money increments.
- **Coin pop animation**: when money is earned, a 🪙 coin icon with the earned amount floats upward from the subscriber and fades out over 1 second (Framer Motion `AnimatePresence` in `MeshCanvas.tsx`, state in `coinPops` array)
- **Faster Consumption** upgrade: accelerating curve `boostPct = min(level * (level + 9) / 2, 100)`, `duration = 1000 * (1 - boostPct/100)`. Max level 11 (100% reduction = instant consumption).
- **Value calculation**: final event value = publisher value + subscriber value. Subscriber value uses same accelerating formula as publisher: `0.5 + level * 0.45 + level² * 0.05`. No max level.
- Upgrades: Consumption Value, Faster Consumption (both **functional**)
