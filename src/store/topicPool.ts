/**
 * Predefined topic pool for publishers.
 * Each publisher gets the next available topic from this list.
 *
 * Topics are clustered thematically so broadening subscriptions
 * naturally captures related publishers within the same group.
 *
 * Structure: acme/{domain}/{action}/{region}/{category}/{identifier}
 */

export const TOPIC_POOL: string[] = [
  'acme/orders/created/na/electronics/SKU001',
  'acme/orders/created/eu/clothing/SKU042',
  'acme/payments/processed/na/cards/TXN001',
  'acme/payments/refunded/eu/cards/TXN099',
  'acme/inventory/updated/na/warehouse/WH005',
  'acme/inventory/updated/eu/warehouse/WH012',
  'acme/shipping/dispatched/na/logistics/SHP001',
  'acme/shipping/delivered/eu/logistics/SHP042',
];

/** Get the next topic from the pool based on how many publishers exist. */
export function getNextTopic(publisherCount: number): string {
  return TOPIC_POOL[publisherCount % TOPIC_POOL.length];
}
