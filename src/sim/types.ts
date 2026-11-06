// Shared types for the simulation. Moved out of gameStore.ts so the sim modules (which must
// never import the store) and the store share one definition; gameStore.ts re-exports them.

export type ComponentType = 'publisher' | 'webhook' | 'broker' | 'queue' | 'subscriber' | 'dmq';

export type GameComponent = {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  label: string;
  topic?: string;
  topicSegments?: string[];
  subscriptionTopic?: string;
  subscriptionSegments?: string[];
  tags: Record<string, string>;
  upgrades: Record<string, number>;
};

export type Connection = {
  id: string;
  fromId: string;
  toId: string;
  topicLabel?: string;
};

export type EventDot = {
  id: string;
  path: { x: number; y: number }[];
  progress: number;
  speed: number;
  status: 'traveling' | 'pausing' | 'queued' | 'dropped' | 'consumed';
  pauseStartTime?: number;
  queuedAtNodeId?: string;
  dropX?: number;
  dropY?: number;
  /** Fall velocity in px per ms of sim time (world units). */
  dropVY?: number;
  color: string;
  opacity: number;
  value: number;
  moneyAdded?: boolean;
  isRetry?: boolean;
  originalNodeIds?: string[];
  nodeWpIndices?: number[];
  originalValue?: number;
  forkPaths?: { waypoints: { x: number; y: number }[]; nodeIds: string[]; value?: number; color?: string }[];
  forkNodeId?: string;
  nextNodeId?: string;
  /** Broker node this dot must pass before switching to the bridge-crossing gold color. */
  bridgeGoldAfterNodeId?: string;
};

/** The run-wide (per-prestige) upgrade values; `GameState['upgrades']`. */
export type GlobalUpgrades = {
  propagationSpeed: number;
  costReduction: number;
  batchFire: number;
  globalValueMultiplier: number;
};

/** The prestige record; `GameState['prestige']`. */
export type PrestigeState = {
  points: number;
  totalPoints: number;
  count: number;
  permanentUpgradeLevels: Record<string, number>;
};

/** Everything the simulation rules read from the store. Never mutated in place: every cache in
 *  the sim keys on the identity of these four fields, exactly as the loop did on the store's. */
export type Mesh = {
  components: GameComponent[];
  connections: Connection[];
  upgrades: GlobalUpgrades;
  prestige: PrestigeState;
};
