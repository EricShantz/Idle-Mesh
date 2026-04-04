/**
 * Predefined topic pool for publishers.
 * Each publisher gets the next available topic from this list.
 *
 * Topics are clustered so that each broadening level captures exactly
 * one additional publisher from the same cluster.
 *
 * Structure: acme/{domain}/{action}/{region}/{category}/{identifier}
 *
 * Within each 6-topic cluster:
 *   - Topic 2 differs only in identifier     → caught by broaden level 1 (last seg → *)
 *   - Topic 3 differs in category             → caught by broaden level 2 (trailing →  >)
 *   - Topic 4 differs in region               → caught by broaden level 3
 *   - Topic 5 differs in action               → caught by broaden level 4
 *   - Topic 6 differs in domain               → caught by broaden level 5 (acme/>)
 */

export const TOPIC_POOL: string[] = [
  // ── Orders cluster (pubs 1–6) ──
  'acme/orders/created/na/electronics/SKU001',
  'acme/orders/created/na/electronics/SKU002',
  'acme/orders/created/na/clothing/SKU003',
  'acme/orders/created/eu/warehouse/SKU004',
  'acme/orders/processed/na/cards/SKU005',
  'acme/payments/fulfilled/na/logistics/SKU006',

  // ── Payments cluster (pubs 7–12) ──
  'acme/payments/processed/na/cards/TXN001',
  'acme/payments/processed/na/cards/TXN002',
  'acme/payments/processed/na/crypto/TXN003',
  'acme/payments/processed/eu/bank/TXN004',
  'acme/payments/refunded/na/cards/TXN005',
  'acme/inventory/settled/na/cards/TXN006',

  // ── Inventory cluster (pubs 13–18) ──
  'acme/inventory/updated/na/warehouse/WH001',
  'acme/inventory/updated/na/warehouse/WH002',
  'acme/inventory/updated/na/fulfillment/WH003',
  'acme/inventory/updated/eu/distribution/WH004',
  'acme/inventory/depleted/na/warehouse/WH005',
  'acme/shipping/restocked/na/warehouse/WH006',

  // ── Shipping cluster (pubs 19–24) ──
  'acme/shipping/dispatched/na/logistics/SHP001',
  'acme/shipping/dispatched/na/logistics/SHP002',
  'acme/shipping/dispatched/na/express/SHP003',
  'acme/shipping/dispatched/eu/freight/SHP004',
  'acme/shipping/delivered/na/logistics/SHP005',
  'acme/orders/tracking/na/logistics/SHP006',
];

/** Get the next topic from the pool based on how many publishers exist. */
export function getNextTopic(publisherCount: number): string {
  return TOPIC_POOL[publisherCount % TOPIC_POOL.length];
}
