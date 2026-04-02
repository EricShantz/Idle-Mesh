export type PrestigeNode = {
  key: string;
  label: string;
  description: string;
  cost: number;            // prestige points
  requires: string | null; // parent node key, null = root (always available)
  position: { x: number; y: number }; // grid units from center, converted to px in UI
};

export const prestigeNodes: PrestigeNode[] = [
  // Center — root node
  { key: 'income', label: 'Income Boost', description: '×1.1 permanent income multiplier', cost: 1, requires: null, position: { x: 0, y: 0 } },

  // Up branch — Speed (main trunk + sub-branch)
  { key: 'speed1', label: 'Event Speed I', description: '+15% event propagation speed', cost: 2, requires: 'income', position: { x: 0, y: -1 } },
  { key: 'speed2', label: 'Event Speed II', description: '+15% event propagation speed', cost: 4, requires: 'speed1', position: { x: 0, y: -2 } },
  { key: 'speed3', label: 'Event Speed III', description: '+15% event propagation speed', cost: 7, requires: 'speed2', position: { x: 0, y: -3 } },
  { key: 'batchStart', label: 'Batch Start', description: 'Start each run with Event Batching lv1', cost: 12, requires: 'speed3', position: { x: 0, y: -4 } },
  // Sub-branch off speed2: faster consumption
  { key: 'consumeSpeed', label: 'Quick Consume', description: 'Start with Faster Consumption lv1', cost: 6, requires: 'speed2', position: { x: -1, y: -3 } },

  // Right branch — Auto-Publisher (main trunk + sub-branch)
  { key: 'autoPub1', label: 'Auto-Publisher I', description: 'Start each run with Auto-Publisher lv1 (5s)', cost: 5, requires: 'income', position: { x: 1, y: 0 } },
  { key: 'autoPub2', label: 'Auto-Publisher II', description: 'Start each run with Auto-Publisher lv2 (3s)', cost: 10, requires: 'autoPub1', position: { x: 2, y: 0 } },
  // Sub-branch off autoPub1: publish speed head start
  { key: 'pubSpeed', label: 'Quick Publish', description: 'Start with Publish Speed lv1', cost: 6, requires: 'autoPub1', position: { x: 1, y: 1 } },

  // Left branch — Cost Reduction (main trunk + sub-branch)
  { key: 'costRed1', label: 'Discount I', description: '-5% permanent upgrade cost reduction', cost: 3, requires: 'income', position: { x: -1, y: 0 } },
  { key: 'costRed2', label: 'Discount II', description: '-5% permanent upgrade cost reduction', cost: 6, requires: 'costRed1', position: { x: -2, y: 0 } },
  // Sub-branch off costRed1: cheaper shop items
  { key: 'shopDiscount', label: 'Cheaper Components', description: '-15% component shop prices', cost: 5, requires: 'costRed1', position: { x: -1, y: -1 } },

  // Down branch — Value (main trunk + sub-branch)
  { key: 'value1', label: 'Value Boost I', description: '+$0.50 base event value', cost: 3, requires: 'income', position: { x: 0, y: 1 } },
  { key: 'value2', label: 'Value Boost II', description: '+$0.50 base event value', cost: 6, requires: 'value1', position: { x: 0, y: 2 } },
  { key: 'queueStart', label: 'Queue Head Start', description: 'Start each run with 1 free queue', cost: 10, requires: 'value2', position: { x: 0, y: 3 } },
  // Sub-branch off value2: subscriber value head start
  { key: 'subValue', label: 'Sub Value Boost', description: 'Start with Consumption Value lv1', cost: 5, requires: 'value2', position: { x: -1, y: 2 } },
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
