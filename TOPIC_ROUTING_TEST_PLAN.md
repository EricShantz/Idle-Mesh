# Topic Routing & Multi-Broker Mesh — Test Plan

> Clear localStorage and hard-refresh (Ctrl+Shift+R) before starting.
> Set starting balance high for testing: `balance: saved?.balance ?? 5000000` in `gameStore.ts`.

---

## Phase 1: Topic Engine (utility functions)

No UI to test directly — these are internal utilities used by later phases. Verified via TypeScript compilation.

**Files:** `src/utils/topicMatching.ts`, `src/store/topicPool.ts`

---

## Phase 2: Data Model

**Files:** `src/store/gameStore.ts`

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 2.1 | Fresh game loads | pub-1 exists with `topic: 'acme/orders/created/na/electronics/SKU001'` (inspect via React DevTools or console: `useGameStore.getState().components[0]`) | ✅ PASS |
| 2.2 | Check pub-1 fields | `topicSegments` = `['acme','orders','created','na','electronics','SKU001']`, `tags` = `{}` | ✅ PASS |
| 2.3 | Load an old save (without topic fields) | Components load without errors. All components get `tags: {}`. pub-1 gets `topicSegments` derived from its existing `topic` field. Queues without `subscriptionTopic` continue to work (match everything). | — |
| 2.4 | Upgrade webhook → broker, buy a queue, connect queue to broker | Queue auto-assigns `subscriptionTopic` matching pub-1's topic (`acme/orders/created/na/electronics/SKU001`). Also gets `subscriptionSegments` array. | ✅ PASS |
| 2.5 | Buy a 2nd publisher from shop | New publisher gets topic `acme/orders/created/eu/clothing/SKU042` (2nd topic in pool). Verify via state inspection. | ✅ PASS |
| 2.6 | Buy a 3rd publisher | Gets `acme/payments/processed/na/cards/TXN001` (3rd in pool). | ✅ PASS |

---

## Phase 3: Routing (topic filtering)

**Files:** `src/store/gameStore.ts` (fireEvent)

**Setup:** Broker with 2 queue slots. Two queues connected. Two publishers connected to broker. Queue-1 has subscription matching pub-1's topic.

| # | Action | Expected Outcome | Status |
|---|--------|-----------------|--------|
| 3.1 | Fire event from pub-1 | Event routes to queue-1 (subscription matches). If queue-2 has no subscription, it also receives (backward compat). | ✅ PASS |
| 3.2 | Connect queue-2 to broker (it auto-gets pub-1's topic) | Both queues now have same subscription. Events from pub-1 go to both (smart routing picks best buffer). | ✅ PASS |
| 3.3 | Buy pub-2 (different topic), connect to broker. Fire from pub-2 | Events from pub-2 do NOT route to queue-1 or queue-2 (subscription mismatch). Events drop at broker edge. | ✅ PASS |
| 3.4 | Disconnect queue-2, reconnect to broker | Queue-2 keeps its original subscription (only assigned on first connect when empty). | ✅ PASS |
| 3.5 | Direct broker→subscriber path (no queue) | Events always route through (topic filter skips paths without queues). | ✅ PASS |

---

## Phase 4: Topic Upgrades (subscription broadening)

**Files:** `src/store/upgradeConfig.ts`, `src/store/gameStore.ts`

**Setup:** Broker with pub-1 and pub-2 connected. Queue-1 connected with subscription `acme/orders/created/na/electronics/SKU001`.

| # | Action | Expected Outcome | Status |
|---|--------|-----------------|--------|
| 4.1 | Open queue-1 upgrade modal | "Broaden Subscription" upgrade visible, costs $40. Preview shows: `acme/orders/created/na/electronics/SKU001` → `acme/orders/created/na/electronics/*` | ✅ PASS |
| 4.2 | Purchase Broaden Lv1 | Queue subscription becomes `acme/orders/created/na/electronics/*`. NodeCard shows subscription with `*` highlighted in amber. | ✅ PASS |
| 4.3 | Fire from pub-2 (`acme/orders/created/eu/clothing/SKU042`) | Still doesn't match (different region + category). Events don't route to queue-1. | ✅ PASS |
| 4.4 | Purchase Broaden Lv2 | Subscription → `acme/orders/created/na/>`. Preview showed `electronics/*` → `na/>`. | ✅ PASS |
| 4.5 | Purchase Broaden Lv3 | Subscription → `acme/orders/created/>`. Now matches pub-2 IF pub-2 is also under `orders/created`. (pub-2 is `orders/created/eu/...` — yes, matches!) | ✅ PASS |
| 4.6 | Fire from pub-2 after Lv3 broaden | Events now route to queue-1. | ✅ PASS |
| 4.7 | Purchase Broaden Lv4 | Subscription → `acme/orders/>`. Matches all order publishers. | ✅ PASS |
| 4.8 | Purchase Broaden Lv5 (max) | Subscription → `acme/>`. Matches everything. Upgrade shows "MAX". | ✅ PASS |
| 4.9 | Cost scaling | Lv1: $40, Lv2: $80, Lv3: $160, Lv4: $320, Lv5: $640 (×2 multiplier). | — |

---

## Phase 5: Multi-Broker Connections

**Files:** `src/utils/connectionRules.ts`, `src/store/upgradeConfig.ts`, `src/store/gameStore.ts`

### 5A: Bridge Slots

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 5A.1 | Try to drag broker-1 → broker-2 (no bridge upgrade) | Connection rejected. Toast: "Broker needs 'Add Bridge Slot' upgrade to connect to another broker". | ✅ PASS |
| 5A.2 | Open broker-1 upgrade modal | "Add Bridge Slot" upgrade visible, costs $80. Preview: `0 → 1 bridge slots`. | ✅ PASS |
| 5A.3 | Purchase Add Bridge Slot Lv1 | Broker now has 1 bridge slot. | ✅ PASS |
| 5A.4 | Drag broker-1 → broker-2 | Connection succeeds. Bridge line appears with thicker orange-tinted dashing. | ✅ PASS |
| 5A.5 | Try to drag broker-1 → broker-3 (only 1 slot) | Rejected. Toast: "Broker bridge slots full (1/1 used)". | — |
| 5A.6 | Purchase Add Bridge Slot Lv2 ($200) | Can now connect to a 2nd broker. | — |

### 5B: Publisher Single-Broker Limit

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 5B.1 | Publisher already connected to broker-1. Try to drag pub → broker-2 | Connection rejected. Toast: "Publisher can only connect to one broker". |
| 5B.2 | Disconnect publisher from broker-1, then connect to broker-2 | Connection succeeds. |

### 5C: Event Flow Through Bridge

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 5C.1 | Setup: pub-1 → broker-1 → (bridge) → broker-2 → queue → subscriber | Fire from pub-1. Event travels full path: pub → broker-1 → broker-2 → queue → subscriber. Money earned. | ✅ PASS |
| 5C.2 | Queue on broker-2 has non-matching subscription | Events don't reach that queue (topic filter applies across bridge). | — |
| 5C.3 | Broaden queue subscription to match | Events now flow through the bridge to the queue. | — |

---

## Phase 6: Shop Expansion

**Files:** `src/components/Sidebar.tsx`

### 6A: Buy Publisher

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 6A.1 | Shop visible after broker exists | "Buy Publisher" button appears with cyan border, costs $250. |
| 6A.2 | Purchase publisher | New publisher placed below the last publisher. Has unique topic (2nd from pool). Unconnected — must drag to wire. |
| 6A.3 | Purchase another publisher | Cost escalates: $375 (×1.5). Gets 3rd topic from pool. |
| 6A.4 | Verify topic assignment | Each publisher gets the next topic from the pool in order. |

### 6B: Buy Subscriber

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 6B.1 | Before any queue exists | "Buy Subscriber" button NOT visible. |
| 6B.2 | After queue exists | "Buy Subscriber" button appears with green border, costs $150. |
| 6B.3 | Purchase subscriber | New subscriber placed below last subscriber. Unconnected. |
| 6B.4 | Cost escalation | 2nd: $225, 3rd: ~$337 (×1.5 per owned). |

### 6C: Buy Broker

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 6C.1 | After first broker exists | "Buy Broker" button appears with orange border, costs $200. |
| 6C.2 | Purchase broker | New broker placed 200px below last broker. Unconnected. No queue slots by default (starts with 1). No bridge slots (starts with 0). |
| 6C.3 | Cost escalation | 2nd: $400, 3rd: $800 (×2 per extra). |

---

## Phase 7: UI Display

**Files:** `src/components/NodeCard.tsx`, `src/components/NodeModal.tsx`

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 7.1 | Look at publisher node | Last 3 topic segments shown below label in small gray mono text (e.g., `na/electronics/SKU001`). |
| 7.2 | Look at queue node (with subscription) | Subscription shown below label. Regular segments in gray, wildcards (`*`, `>`) in amber. |
| 7.3 | Queue without subscription | No subscription text shown. |
| 7.4 | Open queue modal → Broaden Subscription | Shows current → next pattern in amber monospace. |
| 7.5 | Open broker modal → Add Bridge Slot | Shows `N → N+1 bridge slots` in blue. |
| 7.6 | Broaden subscription at max level | Shows "MAX" instead of preview. |

---

## Phase 8: Polish (connection line visuals)

**Files:** `src/components/ConnectionLine.tsx`

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 8.1 | Publisher → broker connection | Small gray monospace label at midpoint showing last 2 topic segments (e.g., `electronics/SKU001`). |
| 8.2 | Broker → queue connection | Label shows last 2 segments of queue's subscription (e.g., `electronics/*` after broadening). |
| 8.3 | Broker → broker bridge connection | Thicker line (2px), longer dash pattern, orange-tinted color. Visually distinct from regular connections. |
| 8.4 | Broker → subscriber connection (no queue) | No topic label (neither publisher nor queue). |
| 8.5 | DMQ → broker connection | No topic label. Vertical-first routing unchanged. |
| 8.6 | Drag/reassign a connection | Labels update to reflect new source/target. |

---

## Integration Tests (full system)

Run these after all phases pass individually.

| # | Scenario | Steps | Expected Outcome |
|---|----------|-------|-----------------|
| I.1 | Basic topic flow | Fresh game → upgrade to broker → buy queue → connect → fire | Events flow normally. Queue gets pub-1's subscription. Topic labels visible on lines. |
| I.2 | Topic mismatch blocks routing | Add pub-2 (different topic) → connect to broker → fire from pub-2 | Events have no valid path (queue subscription doesn't match). Events drop or no dot spawned. |
| I.3 | Broaden enables routing | Broaden queue subscription until it matches pub-2 → fire from pub-2 | Events now route to queue. |
| I.4 | Fan-out double dip | Broaden queue to match both pubs. Add fan-out + 2 subscribers on queue. Fire from either pub. | Event goes to queue, fans out to both subscribers. Both earn money. |
| I.5 | Multi-broker mesh | Buy broker-2. Upgrade bridge slot on broker-1. Connect broker-1 → broker-2. Add queue + subscriber on broker-2 with matching subscription. Fire from pub-1. | Event travels: pub → broker-1 → broker-2 → queue → subscriber. Money earned. Bridge line visually distinct. |
| I.6 | Topic filtering across bridge | Queue on broker-2 has mismatched subscription. Fire from pub-1. | Event does NOT reach broker-2's queue. |
| I.7 | Backward compatibility | Load a save from before topic system | All queues match everything (no `subscriptionTopic`). No errors. Components get `tags: {}`. Game plays as before. |
| I.8 | Publisher single-broker | Try connecting pub-1 to two brokers | Second connection rejected with toast. |
| I.9 | Save/load persistence | Set up mesh with topics, broadened subscriptions, bridge connections. Reload page. | All topic fields, subscriptions, tags, and bridge connections persist correctly. |
| I.10 | Delete and rebuy | Delete a queue (has subscription). Buy new queue, connect to broker. | New queue gets fresh subscription from first publisher on that broker. Old subscription gone. |
