export type PrestigeBranch = 'global' | 'publisher' | 'broker' | 'queue' | 'subscriber';

export type PrestigeNode = {
  key: string;
  label: string;
  description: string;
  cost: number;            // prestige points
  requires: string | null; // parent node key, null = root (always available)
  position: { x: number; y: number }; // grid units from center, converted to px in UI
  branch: PrestigeBranch;
};

export const prestigeNodes: PrestigeNode[] = [
  // ── Global Branch (center) ──
  { key: 'globalIncome', label: 'Income Boost', description: '×1.1 permanent income multiplier', cost: 1, requires: null, position: { x: 0, y: 0 }, branch: 'global' },
  { key: 'globalSpeed1', label: 'Event Speed I', description: '+15% event propagation speed', cost: 3, requires: 'globalIncome', position: { x: 0, y: -1 }, branch: 'global' },
  { key: 'globalSpeed2', label: 'Event Speed II', description: '+15% event propagation speed', cost: 6, requires: 'globalSpeed1', position: { x: 0, y: -2 }, branch: 'global' },
  { key: 'globalCostRed', label: 'Discount', description: '-10% permanent upgrade cost reduction', cost: 4, requires: 'globalIncome', position: { x: -1, y: 0 }, branch: 'global' },
  { key: 'globalShopDiscount', label: 'Cheaper Components', description: '-15% component shop prices', cost: 4, requires: 'globalIncome', position: { x: 1, y: 0 }, branch: 'global' },

  // ── Publisher Branch (northwest) ──
  { key: 'pubRoot', label: 'Publisher Affinity', description: '+20% publish rate for all publishers', cost: 2, requires: 'globalIncome', position: { x: -2, y: -1 }, branch: 'publisher' },
  { key: 'pubSpeed', label: 'Quick Publish', description: 'Start each run with Publish Speed lv1', cost: 5, requires: 'pubRoot', position: { x: -3, y: -2 }, branch: 'publisher' },
  { key: 'pubAutoPub1', label: 'Auto-Publisher I', description: 'Start each run with Auto-Click lv1', cost: 5, requires: 'pubRoot', position: { x: -2, y: -2 }, branch: 'publisher' },
  { key: 'pubAutoPub2', label: 'Auto-Publisher II', description: 'Start each run with Auto-Click lv2', cost: 10, requires: 'pubAutoPub1', position: { x: -2, y: -3 }, branch: 'publisher' },
  { key: 'pubBatchStart', label: 'Batch Fire', description: 'Start each run with Event Batching lv1', cost: 12, requires: 'pubAutoPub2', position: { x: -2, y: -4 }, branch: 'publisher' },

  // ── Broker Branch (northeast) ──
  { key: 'brokerRoot', label: 'Broker Affinity', description: 'Start with webhook auto-upgraded to broker', cost: 3, requires: 'globalIncome', position: { x: 2, y: -1 }, branch: 'broker' },
  { key: 'brokerThroughput', label: 'Throughput Boost', description: 'Start with Increase Throughput lv1 on broker', cost: 6, requires: 'brokerRoot', position: { x: 2, y: -2 }, branch: 'broker' },
  { key: 'brokerBridge', label: 'Bridge Ready', description: 'Start with 1 free Bridge Slot on broker', cost: 10, requires: 'brokerThroughput', position: { x: 3, y: -3 }, branch: 'broker' },
  { key: 'brokerRouting', label: 'Smart Routing', description: '+25% event propagation speed through brokers', cost: 8, requires: 'brokerThroughput', position: { x: 1, y: -3 }, branch: 'broker' },

  // ── Queue Branch (southeast) ──
  { key: 'queueRoot', label: 'Queue Affinity', description: '+2 base queue size for all queues', cost: 2, requires: 'globalIncome', position: { x: 2, y: 1 }, branch: 'queue' },
  { key: 'queueFreeQueue', label: 'Queue Head Start', description: 'Start each run with 1 free queue', cost: 8, requires: 'queueRoot', position: { x: 3, y: 2 }, branch: 'queue' },
  { key: 'queueBuffer', label: 'Deep Buffers', description: '+4 additional base queue size', cost: 5, requires: 'queueRoot', position: { x: 2, y: 2 }, branch: 'queue' },
  { key: 'queueBroaden', label: 'Wide Subscriptions', description: 'Start with Broaden Subscription lv1 on all queues', cost: 8, requires: 'queueBuffer', position: { x: 2, y: 3 }, branch: 'queue' },
  { key: 'queueBatchConsume', label: 'Prefetch', description: 'Subscribers consume up to 3 events per tick', cost: 14, requires: 'queueBroaden', position: { x: 2, y: 4 }, branch: 'queue' },

  // ── Subscriber Branch (southwest) ──
  { key: 'subRoot', label: 'Subscriber Affinity', description: '+25% consumption payout for all subscribers', cost: 2, requires: 'globalIncome', position: { x: -2, y: 1 }, branch: 'subscriber' },
  { key: 'subConsumeSpeed', label: 'Quick Consume', description: 'Start each run with Faster Consumption lv1', cost: 5, requires: 'subRoot', position: { x: -3, y: 2 }, branch: 'subscriber' },
  { key: 'subValue1', label: 'Value Boost I', description: '+$0.50 permanent base event value', cost: 3, requires: 'subRoot', position: { x: -2, y: 2 }, branch: 'subscriber' },
  { key: 'subValue2', label: 'Value Boost II', description: '+$0.50 permanent base event value', cost: 6, requires: 'subValue1', position: { x: -2, y: 3 }, branch: 'subscriber' },
  { key: 'subConsumeValue', label: 'Consumption Head Start', description: 'Start with Consumption Multiplier lv1', cost: 8, requires: 'subValue2', position: { x: -2, y: 4 }, branch: 'subscriber' },
];

// Helper: check if a node is purchased
export function isNodePurchased(key: string, purchased: Record<string, number>): boolean {
  return (purchased[key] ?? 0) > 0;
}

// Helper: check if a node is available (parent purchased or root)
export function isNodeAvailable(node: PrestigeNode, purchased: Record<string, number>): boolean {
  if (isNodePurchased(node.key, purchased)) return false;
  if (node.requires === null) return true;
  return isNodePurchased(node.requires, purchased);
}

// Branch color palette
export const branchColors: Record<PrestigeBranch, { primary: string; dim: string; bg: string; bgActive: string }> = {
  global:     { primary: '#f59e0b', dim: '#f59e0b88', bg: '#1c1307', bgActive: '#78350f' },
  publisher:  { primary: '#06b6d4', dim: '#06b6d488', bg: '#0c1a1f', bgActive: '#164e63' },
  broker:     { primary: '#a855f7', dim: '#a855f788', bg: '#1a0f24', bgActive: '#581c87' },
  queue:      { primary: '#f97316', dim: '#f9731688', bg: '#1c1207', bgActive: '#7c2d12' },
  subscriber: { primary: '#22c55e', dim: '#22c55e88', bg: '#0c1a10', bgActive: '#166534' },
};
