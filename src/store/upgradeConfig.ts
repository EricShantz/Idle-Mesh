export type UpgradeDef = {
  key: string;
  label: string;
  description: string;
  baseCost: number;
  costMultiplier: number;
  maxLevel?: number;
  hidden?: boolean;
};

export const publisherUpgrades: UpgradeDef[] = [
  {
    key: 'eventValue',
    label: 'Event Value',
    description: 'Accelerating value increase per event',
    baseCost: 10,
    costMultiplier: 1.8,
  },
  {
    key: 'publishSpeed',
    label: 'Publish Speed',
    description: 'Accelerating cooldown reduction',
    baseCost: 8,
    costMultiplier: 1.8,
    maxLevel: 10,
  },
];

export const webhookUpgrades: UpgradeDef[] = [
  {
    key: 'upgradeToBroker',
    label: 'Upgrade to Broker',
    description: 'Removes routing delay — events pass through instantly. Unlocks queue purchases.',
    baseCost: 75,
    costMultiplier: 1,
    maxLevel: 1,
  },
  {
    key: 'fasterRouting',
    label: 'Faster Routing +20%',
    description: 'Reduces travel time through this hop',
    baseCost: 20,
    costMultiplier: 2,
    maxLevel: 3,
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
    key: 'topicFilterBoost',
    label: 'Topic Filter Boost',
    description: 'Routes events to more subscriber queues',
    baseCost: 60,
    costMultiplier: 2,
    hidden: true,
  },
];

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
    baseCost: 100,
    costMultiplier: 1,
    maxLevel: 1,
  },
  {
    key: 'bufferSize',
    label: 'Increase Buffer Size',
    description: 'Allows more in-flight events before dropping',
    baseCost: 45,
    costMultiplier: 2,
  },
];

export const dmqUpgrades: UpgradeDef[] = [
  {
    key: 'dmqWidth',
    label: 'Increase Width +40px',
    description: 'Wider catch zone for falling events',
    baseCost: 30,
    costMultiplier: 1.8,
  },
  {
    key: 'dmqBufferSize',
    label: 'Increase Buffer Size',
    description: 'Hold more events before overflow',
    baseCost: 45,
    costMultiplier: 2,
  },
  {
    key: 'dmqReleaseSpeed',
    label: 'Faster Release',
    description: 'Accelerating release speed for queued events',
    baseCost: 40,
    costMultiplier: 1.8,
    maxLevel: 10,
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
    label: 'Consumption Value',
    description: 'Accelerating value increase per consumed event',
    baseCost: 10,
    costMultiplier: 1.8,
  },
  {
    key: 'fasterConsumption',
    label: 'Faster Consumption',
    description: 'Accelerating speed boost for processing events',
    baseCost: 8,
    costMultiplier: 1.8,
    maxLevel: 10,
  },
];

export const globalUpgrades: UpgradeDef[] = [
  {
    key: 'propagationSpeed',
    label: 'Faster Event Propagation',
    description: 'Accelerating speed boost for all event dots',
    baseCost: 50,
    costMultiplier: 1.8,
    maxLevel: 10,
  },
  {
    key: 'costReduction',
    label: '10% Cheaper Upgrades',
    description: 'All future upgrade costs reduced by 10%',
    baseCost: 50,
    costMultiplier: 2,
    maxLevel: 3,
  },
  {
    key: 'autoPub',
    label: 'Auto-Publisher',
    description: 'Automatically publishes events',
    baseCost: 150,
    costMultiplier: 4,
    maxLevel: 7,
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

export function getUpgradeCost(def: UpgradeDef, currentLevel: number, costReduction: number): number {
  const raw = def.baseCost * Math.pow(def.costMultiplier, currentLevel);
  return Math.floor(raw * (1 - costReduction));
}
