export type UpgradeDef = {
  key: string;
  label: string;
  description: string;
  baseCost: number;
  costMultiplier: number;
  maxLevel?: number;
  hidden?: boolean;
};

// End-game: reaching this much earned in a single run (resets on prestige) wins the game.
export const WIN_THRESHOLD = 1_000_000_000;

export const publisherUpgrades: UpgradeDef[] = [
  {
    key: 'eventValue',
    label: 'Event Value',
    description: 'Accelerating value increase per event',
    baseCost: 5,
    costMultiplier: 1.8,
  },
  {
    key: 'publishSpeed',
    label: 'Publish Speed',
    description: 'Accelerating cooldown reduction',
    baseCost: 4,
    costMultiplier: 1.8,
    maxLevel: 10,
  },
  {
    key: 'autoPub',
    label: 'Auto-Click',
    description: 'Automatically clicks this publisher',
    baseCost: 300,
    costMultiplier: 1,
    maxLevel: 1,
  },
];

export const webhookUpgrades: UpgradeDef[] = [
  {
    key: 'upgradeToBroker',
    label: 'Upgrade to Broker',
    description: 'Removes routing delay — events pass through instantly. Unlocks queue purchases.',
    baseCost: 50,
    costMultiplier: 1,
    maxLevel: 1,
  },
];

export const brokerUpgrades: UpgradeDef[] = [
  {
    key: 'addQueueSlot',
    label: 'Add Queue Slot',
    description: 'Allows connecting one more Queue to this broker',
    baseCost: 40,
    costMultiplier: 2,
  },
  {
    key: 'addBridgeSlot',
    label: 'Add Bridge Slot',
    description: 'Allow connection to another broker (event mesh bridging)',
    baseCost: 80,
    costMultiplier: 2.5,
  },
  {
    key: 'increaseThroughput',
    label: 'Increase Throughput',
    description: 'Raises the max events/sec this broker can relay',
    baseCost: 100,
    costMultiplier: 2.2,
    maxLevel: 10,
  },
  {
    key: 'upgradeToCluster',
    label: 'Upgrade to DMR Cluster',
    description: 'Clusters this broker with additional brokers acting as one node — permanently removes the throughput cap and starts with 2 broker slots',
    baseCost: 250_000,
    costMultiplier: 1,
    maxLevel: 1,
  },
  {
    key: 'addClusterSlot',
    label: 'Add Cluster Slot',
    description: 'Adds another broker to the cluster, multiplying combined throughput capacity',
    baseCost: 150_000,
    costMultiplier: 4,
    maxLevel: 2,
  },
];

/** Throughput upgrade continues past the broker's level-10 cap once clustered, at a gentler
 *  cost curve ($150k base, x2/level) so it remains purchasable indefinitely. */
const CLUSTER_THROUGHPUT_START_LEVEL = 10;
const CLUSTER_THROUGHPUT_BASE_COST = 150_000;
const CLUSTER_THROUGHPUT_MULTIPLIER = 2.0;

function getThroughputCostAtLevel(level: number): number {
  if (level < CLUSTER_THROUGHPUT_START_LEVEL) {
    const def = brokerUpgrades.find(d => d.key === 'increaseThroughput')!;
    return def.baseCost * Math.pow(def.costMultiplier, level);
  }
  return CLUSTER_THROUGHPUT_BASE_COST * Math.pow(CLUSTER_THROUGHPUT_MULTIPLIER, level - CLUSTER_THROUGHPUT_START_LEVEL);
}

/** Total broker slots in a cluster (2 starting + purchased addClusterSlot levels), or 1 for a plain broker. */
export function getClusterSlotCount(upgrades: Record<string, number>): number {
  return (upgrades['upgradeToCluster'] ?? 0) >= 1 ? 2 + (upgrades['addClusterSlot'] ?? 0) : 1;
}

/** Rendered sub-card size for each broker slot inside a DMR Cluster — matches a normal broker card exactly. */
export const CLUSTER_SUBCARD_W = 120;
export const CLUSTER_SUBCARD_H = 56;
const CLUSTER_GRID_GAP = 8;
const CLUSTER_FRAME_PADDING = 12;

/** Half-width/height of a clustered broker's full rendered footprint (2x2 grid of sub-cards + outline frame).
 *  NodeCard.tsx (self-positioning) and ConnectionLine.tsx (port/line placement) both read this so a cluster's
 *  connections stay visually attached to its actual (much larger) rendered size instead of a plain broker's. */
export const CLUSTER_HALF_W = (CLUSTER_SUBCARD_W * 2 + CLUSTER_GRID_GAP) / 2 + CLUSTER_FRAME_PADDING;
export const CLUSTER_HALF_H = (CLUSTER_SUBCARD_H * 2 + CLUSTER_GRID_GAP) / 2 + CLUSTER_FRAME_PADDING;

/** Half-width/height of a node's rendered footprint, for connection port placement and line routing. */
export function getNodeHalfExtents(comp: { type: string; upgrades: Record<string, number> }): { halfW: number; halfH: number } {
  if (comp.type === 'broker' && getClusterSlotCount(comp.upgrades) > 1) return { halfW: CLUSTER_HALF_W, halfH: CLUSTER_HALF_H };
  // Every non-cluster, non-DMQ card (queue included) renders 120px wide in NodeCard.
  return { halfW: 60, halfH: 28 };
}

/** Effective max level for an upgrade, accounting for dynamic caps (DMQ buffer, uncapped cluster throughput). */
export function getEffectiveMaxLevel(def: UpgradeDef, upgrades: Record<string, number>): number | undefined {
  if (def.key === 'dmqBufferSize') return getDmqBufferMaxLevel(upgrades['dmqWidth'] ?? 0);
  if (def.key === 'increaseThroughput' && (upgrades['upgradeToCluster'] ?? 0) >= 1) return undefined;
  return def.maxLevel;
}

/** Whether an upgrade should currently be shown — hides cluster upgrades until their
 *  prerequisite is met, same pattern as the existing conditionally-hidden subscriptionBroaden. */
export function isUpgradeVisible(def: UpgradeDef, node: { upgrades: Record<string, number>; subscriptionTopic?: string }): boolean {
  if (def.hidden) return false;
  if (def.key === 'subscriptionBroaden' && !node.subscriptionTopic) return false;
  if (def.key === 'upgradeToCluster') {
    if ((node.upgrades['increaseThroughput'] ?? 0) < 10) return false;
    if ((node.upgrades['upgradeToCluster'] ?? 0) >= 1) return false; // purchased — remove from list entirely
  }
  if (def.key === 'addClusterSlot') {
    if ((node.upgrades['upgradeToCluster'] ?? 0) < 1) return false;
    if ((node.upgrades['addClusterSlot'] ?? 0) >= 2) return false; // fully slotted (4 brokers) — remove from list entirely
  }
  return true;
}

/** Cost-aware wrapper around getUpgradeCost that switches to the uncapped cluster
 *  throughput curve once a broker has been converted to a DMR Cluster. */
export function getEffectiveUpgradeCost(def: UpgradeDef, level: number, costReduction: number, upgrades: Record<string, number>): number {
  if (def.key === 'increaseThroughput' && (upgrades['upgradeToCluster'] ?? 0) >= 1) {
    return Math.floor(getThroughputCostAtLevel(level) * (1 - costReduction));
  }
  return getUpgradeCost(def, level, costReduction);
}

export const queueUpgrades: UpgradeDef[] = [
  {
    key: 'addSubscriberSlot',
    label: 'Add Subscriber Slot',
    description: 'Connect one more Subscriber to this queue',
    baseCost: 30,
    costMultiplier: 2,
  },
  {
    key: 'fanOut',
    label: 'Persistent Delivery (Fan-out)',
    description: 'All connected subscribers receive every event',
    baseCost: 200,
    costMultiplier: 1,
    maxLevel: 1,
  },
  {
    key: 'bufferSize',
    label: 'Increase Queue Size',
    description: 'Allows more in-flight events before dropping (max 20 slots)',
    baseCost: 10,
    costMultiplier: 1.2,
    maxLevel: 17,
  },
  {
    key: 'subscriptionBroaden',
    label: 'Broaden Subscription',
    description: 'Widen topic filter to accept events from more publishers',
    baseCost: 40,
    costMultiplier: 2,
    maxLevel: 5,
  },
];

export const dmqUpgrades: UpgradeDef[] = [
  {
    key: 'dmqWidth',
    label: 'Increase Width +40px',
    description: 'Wider catch zone for falling events',
    baseCost: 15,
    costMultiplier: 1.2,
  },
  {
    key: 'dmqBufferSize',
    label: 'Increase Queue Size',
    description: 'Hold more events before overflow',
    baseCost: 10,
    costMultiplier: 1.2,
  },
  {
    key: 'dmqValueRecovery',
    label: 'Value Recovery +10%',
    description: 'Retry events recover more of their original value',
    baseCost: 50,
    costMultiplier: 2,
    maxLevel: 9,
  },
];

export const subscriberUpgrades: UpgradeDef[] = [
  {
    key: 'consumptionValue',
    label: 'Consumption Multiplier',
    description: '+50% payout multiplier per level — scales with all upstream value',
    baseCost: 5,
    costMultiplier: 1.8,
  },
  {
    key: 'fasterConsumption',
    label: 'Faster Consumption',
    description: 'Accelerating speed boost for processing events',
    baseCost: 4,
    costMultiplier: 1.8,
    maxLevel: 11,
  },
];

export const globalUpgrades: UpgradeDef[] = [
  {
    key: 'propagationSpeed',
    label: 'Faster Event Propagation',
    description: 'Accelerating speed boost for all event dots',
    baseCost: 25,
    costMultiplier: 1.8,
    maxLevel: 10,
  },
  {
    key: 'costReduction',
    label: '10% Cheaper Upgrades',
    description: 'All future upgrade costs reduced by 10%',
    baseCost: 50,
    costMultiplier: 4.5,
    maxLevel: 3,
  },
  {
    key: 'batchFire',
    label: 'Event Batching',
    description: 'Publishers fire extra events per click',
    baseCost: 200,
    costMultiplier: 2.5,
    maxLevel: 5,
  },
  {
    key: 'globalValueMultiplier',
    label: 'Income Multiplier',
    description: 'All earned money ×1.5 per level',
    baseCost: 500,
    costMultiplier: 3,
    maxLevel: 5,
  },
];

/** Max DMQ buffer slots based on current width level. 2 rows, 8 per row at base, +3 per width upgrade. */
export function getDmqMaxBuffer(dmqWidthLevel: number): number {
  return (8 + dmqWidthLevel * 3) * 2;
}

/** Slots per row for DMQ visual indicators. */
export function getDmqSlotsPerRow(dmqWidthLevel: number): number {
  return 8 + dmqWidthLevel * 3;
}

/** Effective max level for dmqBufferSize given current width (base capacity is 3). */
export function getDmqBufferMaxLevel(dmqWidthLevel: number): number {
  return getDmqMaxBuffer(dmqWidthLevel) - 3;
}

export function getUpgradeCost(def: UpgradeDef, currentLevel: number, costReduction: number): number {
  const raw = def.baseCost * Math.pow(def.costMultiplier, currentLevel);
  return Math.floor(raw * (1 - costReduction));
}
