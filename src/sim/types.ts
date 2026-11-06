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
  /** Progress per ms of sim time the next tick will move the dot by from its current progress
   *  (segment scale and webhook/cluster zone multipliers applied), and the progress at which the
   *  sim would next change or stop that motion: the next zone edge, or the point where the next
   *  queue/subscriber captures the dot. Written by the sim's traveling branch when it advances a
   *  dot and read only by fillPositions, for the canvas's between-tick extrapolation (a velocity
   *  and how long it stays valid; the path's corners are positions.ts's own part). 0 / 1 on a
   *  dot that has not been moved yet (drawn standing still until it is). Set at creation, like
   *  every field the loop writes per tick, so all dots share one object shape. */
  progressPerMs: number;
  speedUntilP: number;
  /** Events this dot stands for. A batch fire travels as one dot with count = fireCount where that
   *  is exact for its route (see buildPublishDots); every rule that counts events — broker relay
   *  slots, queue/DMQ buffer slots, consumes, drops, the slot signatures — uses it. */
  count: number;
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
