export type UpgradeDef = {
  key: string;
  label: string;
  description: string;
  baseCost: number;
  costMultiplier: number;
  maxLevel?: number;
};

export const publisherUpgrades: UpgradeDef[] = [
  {
    key: 'eventValue',
    label: 'Event Value +$0.50',
    description: 'Each event this publisher fires is worth more',
    baseCost: 10,
    costMultiplier: 2.5,
  },
  {
    key: 'publishSpeed',
    label: 'Publish Speed +5%',
    description: 'Reduces cooldown between publishing events',
    baseCost: 8,
    costMultiplier: 1.15,
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
    label: 'Consumption Value +$0.50',
    description: 'Each event this subscriber consumes earns more',
    baseCost: 10,
    costMultiplier: 2.5,
  },
  {
    key: 'fasterConsumption',
    label: 'Faster Consumption +5%',
    description: 'Reduces processing time at this subscriber',
    baseCost: 8,
    costMultiplier: 1.15,
  },
];

export const globalUpgrades: UpgradeDef[] = [
  {
    key: 'propagationSpeed',
    label: 'Faster Event Propagation',
    description: 'All event dots travel 5% faster',
    baseCost: 50,
    costMultiplier: 2,
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
    description: 'Publishers fire 2 events per click',
    baseCost: 200,
    costMultiplier: 1,
    maxLevel: 1,
  },
  {
    key: 'globalValueMultiplier',
    label: 'Global Value x1.5',
    description: 'All earned money x1.5',
    baseCost: 500,
    costMultiplier: 1,
    maxLevel: 1,
  },
];

export function getUpgradeCost(def: UpgradeDef, currentLevel: number, costReduction: number): number {
  const raw = def.baseCost * Math.pow(def.costMultiplier, currentLevel);
  return Math.floor(raw * (1 - costReduction));
}
