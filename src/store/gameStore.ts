import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { canConnect } from '../utils/connectionRules';
import { globalUpgrades, getUpgradeCost } from './upgradeConfig';
import { getNextTopic } from './topicPool';
import { topicMatches, computeBroadenedTopic } from '../utils/topicMatching';
import { normalizedSpeed } from '../utils/pathUtils';
import { getSmoothedFps } from '../hooks/useGameLoop';
import { prestigeNodes, isNodeAvailable, isNodePurchased, type PrestigeNode } from './prestigeUpgradeConfig';

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
  dropVY?: number;
  color: string;
  opacity: number;
  value: number;
  moneyAdded?: boolean;
  isRetry?: boolean;
  originalNodeIds?: string[];
  originalValue?: number;
  forkPaths?: { waypoints: { x: number; y: number }[]; nodeIds: string[] }[];
  forkNodeId?: string;
};

export type GameState = {
  balance: number;
  totalEarned: number;
  eventsConsumed: number;
  eventsDropped: number;

  components: GameComponent[];
  connections: Connection[];
  eventDots: EventDot[];

  upgrades: {
    propagationSpeed: number;
    costReduction: number;
    batchFire: number;
    globalValueMultiplier: number;
  };

  recentEarnings: { time: number; amount: number }[];
  coinPops: { id: string; x: number; y: number; amount: number }[];
  selectedNodeId: string | null;
  meshError: string | null;
  publisherCooldowns: Record<string, number>; // publisherId -> last fire timestamp

  globalUpgradeLevels: Record<string, number>;

  prestige: {
    points: number;
    totalPoints: number;
    count: number;
    permanentUpgradeLevels: Record<string, number>;
  };

  tutorialsSeen: Record<string, boolean>;
  activeTutorial: string | null;

  draggingConnection: {
    type: 'reassign' | 'create';
    connectionId?: string;
    fromId: string;
    mouseX: number;
    mouseY: number;
  } | null;

  draggingNodeId: string | null;
  showPrestigeTree: boolean;

  // Actions
  fireEvent: (publisherId: string, skipCooldown?: boolean) => void;
  consumeEvent: (dotId: string, value: number, subscriberId: string) => void;
  removeCoinPop: (id: string) => void;
  dropEvent: (dotId: string) => void;
  updateDots: (updateFn: (dots: EventDot[]) => EventDot[]) => void;
  removeDot: (dotId: string) => void;
  earn: (amount: number) => void;
  spend: (amount: number) => boolean;
  selectNode: (nodeId: string | null) => void;
  upgradeComponent: (componentId: string, upgradeKey: string) => void;
  purchaseGlobalUpgrade: (upgradeKey: string) => void;
  isPathOccupied: (publisherId: string) => boolean;
  getPathForPublisher: (publisherId: string) => { x: number; y: number }[];
  getAllPathsForPublisher: (publisherId: string) => { x: number; y: number }[][];
  _getAllPathsWithNodes: (publisherId: string) => { waypoints: { x: number; y: number }[]; nodeIds: string[] }[];
  getEventValue: (publisherId: string) => number;
  addComponent: (type: ComponentType, x: number, y: number, label: string) => string;
  removeComponent: (componentId: string) => void;
  addConnection: (fromId: string, toId: string) => void;
  removeConnection: (fromId: string, toId: string) => void;
  removeConnectionById: (connectionId: string) => void;
  moveComponent: (componentId: string, x: number, y: number) => void;
  startDragConnection: (type: 'reassign' | 'create', fromId: string, connectionId: string | undefined, mouseX: number, mouseY: number) => void;
  updateDragPosition: (mouseX: number, mouseY: number) => void;
  completeDragConnection: (targetId: string) => void;
  cancelDragConnection: () => void;
  setDraggingNodeId: (id: string | null) => void;
  getAvailableTopics: (queueId: string) => { topic: string; segments: string[]; broadenLevel: number }[];
  setQueueSubscription: (queueId: string, topic: string, segments: string[], broadenLevel: number) => void;
  showTutorial: (key: string) => void;
  dismissTutorial: (key: string) => void;
  performPrestige: () => boolean;
  purchasePrestigeUpgrade: (upgradeKey: string) => boolean;
  setShowPrestigeTree: (show: boolean) => void;
};

// Permanent prestige speed multiplier (count of purchased speed nodes)
function getPermanentSpeedMult(state: Pick<GameState, 'prestige'>): number {
  const p = state.prestige.permanentUpgradeLevels;
  const speedNodes = ['speed1', 'speed2', 'speed3'].filter(k => (p[k] ?? 0) > 0).length;
  return 1 + speedNodes * 0.15;
}

// Permanent prestige cost reduction (count of purchased cost reduction nodes)
function getPermanentCostReduction(state: Pick<GameState, 'prestige'>): number {
  const p = state.prestige.permanentUpgradeLevels;
  const costNodes = ['costRed1', 'costRed2'].filter(k => (p[k] ?? 0) > 0).length;
  return costNodes * 0.05;
}

// Permanent shop discount
export function getPermanentShopDiscount(state: Pick<GameState, 'prestige'>): number {
  return (state.prestige.permanentUpgradeLevels['shopDiscount'] ?? 0) > 0 ? 0.15 : 0;
}

// Permanent value boost (count of purchased value nodes × $0.50)
export function getPermanentValueBoost(state: Pick<GameState, 'prestige'>): number {
  const p = state.prestige.permanentUpgradeLevels;
  const valueNodes = ['value1', 'value2'].filter(k => (p[k] ?? 0) > 0).length;
  return valueNodes * 0.50;
}

let dotIdCounter = 0;
const coinPopTracking: Record<string, { count: number; windowStart: number; pendingAmount: number }> = {};
export function nextDotId() { return `dot-${++dotIdCounter}`; }
let componentIdCounter = 10; // start above initial component count, bumped after load
let connectionIdCounter = 10; // bumped after load

// Initialize counters from saved state so IDs don't collide
function initCountersFromSaved(saved: Partial<GameState> | null) {
  if (!saved) return;
  if (saved.components) {
    for (const c of saved.components) {
      const m = c.id.match(/^comp-(\d+)$/);
      if (m) componentIdCounter = Math.max(componentIdCounter, parseInt(m[1]));
    }
  }
  if (saved.connections) {
    for (const c of saved.connections) {
      const m = c.id.match(/^conn-(\d+)$/);
      if (m) connectionIdCounter = Math.max(connectionIdCounter, parseInt(m[1]));
    }
  }
}

function createInitialComponents(): GameComponent[] {
  return [
    {
      id: 'pub-1',
      type: 'publisher',
      x: 150,
      y: 300,
      label: 'Publisher',
      topic: 'acme/orders/created/na/electronics/SKU001',
      topicSegments: ['acme', 'orders', 'created', 'na', 'electronics', 'SKU001'],
      tags: {},
      upgrades: {},
    },
    {
      id: 'webhook-1',
      type: 'webhook',
      x: 450,
      y: 300,
      label: 'Webhook',
      tags: {},
      upgrades: {},
    },
    {
      id: 'sub-1',
      type: 'subscriber',
      x: 750,
      y: 300,
      label: 'Subscriber',
      tags: {},
      upgrades: {},
    },
  ];
}

function createInitialConnections(): Connection[] {
  return [
    { id: 'conn-1', fromId: 'pub-1', toId: 'webhook-1' },
    { id: 'conn-2', fromId: 'webhook-1', toId: 'sub-1' },
  ];
}

const SAVE_KEY = 'idle-mesh-save';

function loadSavedState(): Partial<GameState> | null {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return null;
}

function migrateGlobalUpgradeLevels(upgrades: GameState['upgrades'] | undefined): Record<string, number> {
  if (!upgrades) return {};
  const levels: Record<string, number> = {};
  // Derive levels from old computed values
  if (upgrades.propagationSpeed > 1) {
    levels.propagationSpeed = Math.round(Math.log(upgrades.propagationSpeed) / Math.log(1.05));
  }
  if (upgrades.costReduction > 0) {
    levels.costReduction = Math.round(upgrades.costReduction / 0.1);
  }
  // autoPub migrated to per-publisher upgrade — skip global level
  if ((upgrades as any).batchFire === true || upgrades.batchFire > 0) levels.batchFire = 1;
  if (upgrades.globalValueMultiplier > 1) {
    // Derive level from old multiplier by iterating the new formula
    let mult = 1; let lvl = 0;
    while (mult < upgrades.globalValueMultiplier - 0.01 && lvl < 5) {
      lvl++; mult *= (1.4 + lvl * 0.1);
    }
    levels.globalValueMultiplier = lvl;
  }
  return levels;
}


export const useGameStore = create<GameState>()(
  immer((set, get) => {
    const saved = loadSavedState();
    initCountersFromSaved(saved);

    return {
      balance: saved?.balance ?? 999999999999,
      totalEarned: saved?.totalEarned ?? 1000000,
      eventsConsumed: saved?.eventsConsumed ?? 0,
      eventsDropped: saved?.eventsDropped ?? 0,

      components: (() => {
        const comps = (saved?.components ?? createInitialComponents()).map(c => ({
          ...c,
          tags: c.tags ?? {},
          topicSegments: c.topicSegments ?? (c.topic ? c.topic.split('/') : undefined),
        }));
        // Migrate old global autoPub level to first publisher's per-component upgrade
        const oldAutoPubLevel = (saved?.upgrades as any)?.autoPubLevel
          ?? saved?.globalUpgradeLevels?.autoPub
          ?? 0;
        if (oldAutoPubLevel > 0) {
          const firstPub = comps.find(c => c.type === 'publisher');
          if (firstPub && !(firstPub.upgrades['autoPub'] > 0)) {
            firstPub.upgrades['autoPub'] = oldAutoPubLevel;
          }
        }
        return comps;
      })(),
      connections: saved?.connections ?? createInitialConnections(),
      eventDots: [], // never persist in-flight dots

      upgrades: saved?.upgrades ?? {
        propagationSpeed: 1.0,
        costReduction: 0,
        batchFire: (saved?.upgrades as any)?.batchFire === true ? 2 : (saved?.upgrades?.batchFire ?? 0),
        globalValueMultiplier: 1.0,
      },

      globalUpgradeLevels: saved?.globalUpgradeLevels ?? migrateGlobalUpgradeLevels(saved?.upgrades),

      recentEarnings: [],
      coinPops: [],
      selectedNodeId: null,
      meshError: null,
      publisherCooldowns: {},
      draggingConnection: null,
      draggingNodeId: null,
      showPrestigeTree: false,

      prestige: saved?.prestige ?? { points: 0, totalPoints: 0, count: 0, permanentUpgradeLevels: {} },

      tutorialsSeen: saved?.tutorialsSeen ?? {},
      activeTutorial: null,

      fireEvent: (publisherId: string, skipCooldown?: boolean) => {
        const state = get();
        const pub = state.components.find(c => c.id === publisherId);
        if (!pub) return;

        // Check cooldown (skipped for auto-publisher)
        if (!skipCooldown) {
          const lastFireTime = state.publisherCooldowns[publisherId] ?? 0;
          const publishSpeedLevel = pub.upgrades['publishSpeed'] ?? 0;
          const baseCooldown = 1000; // 1 second base cooldown
          const publishBoostPct = publishSpeedLevel * (publishSpeedLevel + 9) / 2;
          const cooldownDuration = baseCooldown * (1 - publishBoostPct / 100);
          if (Date.now() - lastFireTime < cooldownDuration) return;
        }

        const allPaths = state._getAllPathsWithNodes(publisherId);
        const allValidPaths = allPaths.filter(p => p.waypoints.length >= 2);
        if (allValidPaths.length === 0) {
          // No valid paths — fire event to the first connected node and let it drop there
          const directConn = state.connections.find(c => c.fromId === publisherId);
          if (!directConn) return;
          const target = state.components.find(c => c.id === directConn.toId);
          if (!target) return;
          // Build path using node centers (same as _getAllPathsWithNodes), then expand orthogonally
          const nodePath = [{ x: pub.x, y: pub.y }, { x: target.x, y: target.y }];
          const truncatedWaypoints: { x: number; y: number }[] = [nodePath[0]];
          if (Math.abs(nodePath[0].y - nodePath[1].y) >= 1) {
            const pubHalfW = pub.type === 'queue' ? 70 : 60;
            const tgtHalfW = target.type === 'queue' ? 70 : 60;
            const midX = (pub.x + pubHalfW + 24 + target.x - tgtHalfW - 2) / 2;
            truncatedWaypoints.push({ x: midX, y: nodePath[0].y });
            truncatedWaypoints.push({ x: midX, y: nodePath[1].y });
          }
          truncatedWaypoints.push(nodePath[1]);
          const value = state.getEventValue(publisherId);
          const speed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed * getPermanentSpeedMult(state), truncatedWaypoints);
          set(draft => {
            if (!skipCooldown) {
              draft.publisherCooldowns[publisherId] = Date.now();
            }
            const fireCount = state.upgrades.batchFire > 0 ? state.upgrades.batchFire : 1;
            for (let batch = 0; batch < fireCount; batch++) {
              const dotId = `dot-${++dotIdCounter}`;
              draft.eventDots.push({
                id: dotId,
                path: truncatedWaypoints,
                progress: batch * -0.04,
                speed,
                status: 'traveling',
                color: '#66ffff',
                opacity: 1,
                value,
                originalValue: value,
                originalNodeIds: [publisherId, target.id],
              });
            }
          });
          return;
        }

        // Topic filtering: only keep paths where the queue's subscription matches the publisher's topic
        const pubTopic = pub.topic;
        const validPaths = pubTopic
          ? allValidPaths.filter(p => {
            const queueId = p.nodeIds.find(id =>
              state.components.find(c => c.id === id)?.type === 'queue');
            if (!queueId) return true; // no queue in path, allow
            const queue = state.components.find(c => c.id === queueId);
            return !queue?.subscriptionTopic || topicMatches(pubTopic, queue.subscriptionTopic);
          })
          : allValidPaths;
        if (validPaths.length === 0) {
          // No matching queues — create a dot that travels to the broker and drops there
          // Find any path that reaches a broker
          const anyPath = allValidPaths[0];
          if (anyPath) {
            const brokerIdx = anyPath.nodeIds.findIndex(id =>
              state.components.find(c => c.id === id)?.type === 'broker');
            if (brokerIdx >= 0) {
              const broker = state.components.find(c => c.id === anyPath.nodeIds[brokerIdx])!;
              // Build a truncated path: publisher → broker left edge
              const brokerLeftEdge = { x: broker.x - 62, y: broker.y };
              // Find the last waypoint before the broker and append the edge point
              const truncatedWaypoints = [anyPath.waypoints[0]];
              for (const wp of anyPath.waypoints.slice(1)) {
                if (Math.abs(wp.x - broker.x) < 80 && Math.abs(wp.y - broker.y) < 40) break;
                truncatedWaypoints.push(wp);
              }
              truncatedWaypoints.push(brokerLeftEdge);
              const truncatedNodeIds = anyPath.nodeIds.slice(0, brokerIdx + 1);

              const value = state.getEventValue(publisherId);
              const speed = normalizedSpeed(0.0007 * state.upgrades.propagationSpeed * getPermanentSpeedMult(state), truncatedWaypoints);
              set(draft => {
                if (!skipCooldown) {
                  draft.publisherCooldowns[publisherId] = Date.now();
                }
                const fireCount = state.upgrades.batchFire > 0 ? state.upgrades.batchFire : 1;
                for (let batch = 0; batch < fireCount; batch++) {
                  const dotId = `dot-${++dotIdCounter}`;
                  draft.eventDots.push({
                    id: dotId,
                    path: truncatedWaypoints,
                    progress: batch * -0.04,
                    speed,
                    status: 'traveling',
                    color: '#66ffff',
                    opacity: 1,
                    value,
                    originalValue: value,
                    originalNodeIds: truncatedNodeIds,
                  });
                }
              });
            }
          }
          return;
        }

        // Smart routing: without fan-out, pick the queue with most free buffer space
        // Group paths by their broker (the node before the queue where paths diverge)
        const selectedPaths: typeof validPaths = [];
        const groupedByBroker = new Map<string, typeof validPaths>();

        for (const p of validPaths) {
          const queueNode = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue');
          if (!queueNode) {
            // No queue in path (e.g. direct broker→subscriber), always include
            selectedPaths.push(p);
            continue;
          }
          // Find the node before the queue (the broker) as the grouping key
          const queueIdx = p.nodeIds.indexOf(queueNode);
          const brokerId = queueIdx > 0 ? p.nodeIds[queueIdx - 1] : 'none';
          if (!groupedByBroker.has(brokerId)) groupedByBroker.set(brokerId, []);
          groupedByBroker.get(brokerId)!.push(p);
        }

        // For each broker group: deduplicate by queue (one path per unique queue).
        // Queue-level fan-out (Persistent Delivery) is handled at release time in Pass 2,
        // so the broker only needs to send one dot per queue.
        // Without fan-out on all queues, pick the queue with most free buffer space.
        for (const [, group] of groupedByBroker) {
          // Deduplicate: keep one path per unique queue
          const byQueue = new Map<string, typeof group>();
          const noQueuePaths: typeof group = [];
          for (const p of group) {
            const queueId = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue');
            if (!queueId) { noQueuePaths.push(p); continue; }
            if (!byQueue.has(queueId)) byQueue.set(queueId, []);
            byQueue.get(queueId)!.push(p);
          }
          selectedPaths.push(...noQueuePaths);

          // One representative path per queue
          const queuePaths = [...byQueue.values()].map(paths => paths[0]);

          const allHaveFanOut = queuePaths.every(p => {
            const queueId = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue');
            if (!queueId) return true;
            const queue = state.components.find(c => c.id === queueId);
            return queue && (queue.upgrades['fanOut'] ?? 0) > 0;
          });
          if (allHaveFanOut) {
            selectedPaths.push(...queuePaths);
          } else {
            // Smart routing: pick queue with most free buffer space
            let bestPath = queuePaths[0];
            let bestFree = -1;
            for (const p of queuePaths) {
              const queueId = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue');
              if (!queueId) { bestPath = p; break; }
              const queue = state.components.find(c => c.id === queueId);
              if (!queue) continue;
              const bufferCap = 3 + (queue.upgrades['bufferSize'] ?? 0);
              const queued = state.eventDots.filter(d => d.queuedAtNodeId === queueId).length;
              const inFlight = state.eventDots.filter(d => d.status === 'traveling' && d.originalNodeIds?.includes(queueId)).length;
              const free = bufferCap - queued - inFlight;
              if (free > bestFree) { bestFree = free; bestPath = p; }
            }
            selectedPaths.push(bestPath);
          }
        }

        const value = state.getEventValue(publisherId);
        const baseSpeed = 0.0007 * state.upgrades.propagationSpeed * getPermanentSpeedMult(state);

        // Group selected paths by their first broker so we create one dot per broker fork point
        const forkGroups = new Map<string, typeof selectedPaths>();
        for (const p of selectedPaths) {
          // Find first broker in the path (index 1 is typically the broker after publisher)
          const firstBrokerId = p.nodeIds.find(id =>
            state.components.find(c => c.id === id)?.type === 'broker') ?? 'none';
          if (!forkGroups.has(firstBrokerId)) forkGroups.set(firstBrokerId, []);
          forkGroups.get(firstBrokerId)!.push(p);
        }

        set(draft => {
          if (!skipCooldown) {
            draft.publisherCooldowns[publisherId] = Date.now();
          }
          const fireCount = state.upgrades.batchFire > 0 ? state.upgrades.batchFire : 1;
          for (let batch = 0; batch < fireCount; batch++) {
            for (const [brokerId, group] of forkGroups) {
              const primary = group[0];
              const forks = group.length > 1 ? group.slice(1) : undefined;
              const dotId = `dot-${++dotIdCounter}`;
              draft.eventDots.push({
                id: dotId,
                path: primary.waypoints,
                progress: batch * -0.04,
                speed: normalizedSpeed(baseSpeed, primary.waypoints),
                status: 'traveling',
                color: '#66ffff',
                opacity: 1,
                value,
                originalValue: value,
                originalNodeIds: primary.nodeIds,
                forkPaths: forks,
                forkNodeId: brokerId !== 'none' ? brokerId : undefined,
              });
            }
          }
        });
      },

      consumeEvent: (_dotId: string, value: number, subscriberId: string) => {
        set(draft => {
          const hasIncome = (draft.prestige.permanentUpgradeLevels['income'] ?? 0) > 0;
          const permMult = hasIncome ? 1.1 : 1.0;
          const earned = value * draft.upgrades.globalValueMultiplier * permMult;
          draft.balance += earned;
          draft.totalEarned += earned;
          draft.eventsConsumed += 1;
          draft.recentEarnings.push({ time: Date.now(), amount: earned });
          const sub = draft.components.find(c => c.id === subscriberId);
          if (sub) {
            const now = Date.now();
            let track = coinPopTracking[subscriberId];
            if (!track || now - track.windowStart > 1000) {
              track = { count: 0, windowStart: now, pendingAmount: 0 };
              coinPopTracking[subscriberId] = track;
            }
            track.count++;
            track.pendingAmount += earned;

            // Adaptive coin pop throttling based on frame rate
            const fps = getSmoothedFps();
            let maxPopsPerSec: number;
            let maxActivePops: number;
            if (fps >= 50) {
              // Smooth — show generously
              maxPopsPerSec = 5;
              maxActivePops = 12;
            } else if (fps >= 35) {
              // Starting to dip — moderate throttle
              maxPopsPerSec = 2;
              maxActivePops = 6;
            } else {
              // Struggling — aggressive throttle
              maxPopsPerSec = 1;
              maxActivePops = 3;
            }
            const showEveryN = track.count <= maxPopsPerSec ? 1 : Math.ceil(track.count / maxPopsPerSec);
            if (track.count % showEveryN === 0 && draft.coinPops.length < maxActivePops) {
              draft.coinPops.push({ id: `coin-${++dotIdCounter}`, x: sub.x, y: sub.y, amount: track.pendingAmount });
              track.pendingAmount = 0;
            }
          }
        });
      },

      removeCoinPop: (id: string) => {
        set(draft => {
          draft.coinPops = draft.coinPops.filter(c => c.id !== id);
        });
      },

      dropEvent: (dotId: string) => {
        set(draft => {
          const d = draft.eventDots.find(d => d.id === dotId);
          if (d) {
            d.status = 'dropped';
            d.color = '#ff4444';
            d.dropVY = 0;
            draft.eventsDropped += 1;
          }
        });
      },

      updateDots: (updateFn: (dots: EventDot[]) => EventDot[]) => {
        set(draft => {
          draft.eventDots = updateFn(draft.eventDots);
        });
      },

      removeDot: (dotId: string) => {
        set(draft => {
          draft.eventDots = draft.eventDots.filter(d => d.id !== dotId);
        });
      },

      earn: (amount: number) => {
        set(draft => {
          draft.balance += amount;
          draft.totalEarned += amount;
          draft.recentEarnings.push({ time: Date.now(), amount });
        });
      },

      spend: (amount: number) => {
        const state = get();
        if (state.balance < amount) return false;
        set(draft => {
          draft.balance -= amount;
        });
        return true;
      },

      selectNode: (nodeId: string | null) => {
        set(draft => {
          draft.selectedNodeId = nodeId;
        });
      },

      upgradeComponent: (componentId: string, upgradeKey: string) => {
        set(draft => {
          const comp = draft.components.find(c => c.id === componentId);
          if (comp) {
            comp.upgrades[upgradeKey] = (comp.upgrades[upgradeKey] ?? 0) + 1;
            // Special case: upgrading webhook to broker changes its type and label
            if (upgradeKey === 'upgradeToBroker' && comp.type === 'webhook') {
              comp.type = 'broker';
              comp.label = 'Broker';
              if (!draft.tutorialsSeen['brokerUpgrade']) {
                draft.activeTutorial = 'brokerUpgrade';
              }
            }
            // Broaden queue subscription topic
            if (upgradeKey === 'subscriptionBroaden' && comp.subscriptionSegments) {
              const level = comp.upgrades[upgradeKey]; // already incremented above
              comp.subscriptionTopic = computeBroadenedTopic(comp.subscriptionSegments, level);
            }
          }
        });
      },

      addComponent: (type: ComponentType, x: number, y: number, label: string) => {
        const id = `comp-${++componentIdCounter}`;
        set(draft => {
          const comp: GameComponent = { id, type, x, y, label, tags: {}, upgrades: {} };
          if (type === 'publisher') {
            const pubCount = draft.components.filter(c => c.type === 'publisher').length;
            const topic = getNextTopic(pubCount);
            comp.topic = topic;
            comp.topicSegments = topic.split('/');
          }
          draft.components.push(comp);

          // Tutorial triggers for first-time component purchases
          const tutorialKeyMap: Partial<Record<ComponentType, string>> = {
            queue: 'firstQueue', dmq: 'firstDmq', publisher: 'firstPublisher',
            subscriber: 'firstSubscriber', broker: 'firstBroker',
          };
          const tKey = tutorialKeyMap[type];
          if (tKey && !draft.tutorialsSeen[tKey]) {
            // Publisher/subscriber: trigger on 2nd instance (1st is in starting layout)
            const threshold = (type === 'publisher' || type === 'subscriber') ? 2 : 1;
            const count = draft.components.filter(c => c.type === type).length;
            if (count >= threshold) {
              draft.activeTutorial = tKey;
            }
          }
        });
        return id;
      },

      removeComponent: (componentId: string) => {
        set(draft => {
          // Remove all connections to/from this component
          draft.connections = draft.connections.filter(
            c => c.fromId !== componentId && c.toId !== componentId
          );
          // Remove any dots queued at this component or with it in their path
          draft.eventDots = draft.eventDots.filter(
            d => d.queuedAtNodeId !== componentId
          );
          // Remove the component
          draft.components = draft.components.filter(c => c.id !== componentId);
          // Clear selection if this node was selected
          if (draft.selectedNodeId === componentId) {
            draft.selectedNodeId = null;
          }
        });
      },

      addConnection: (fromId: string, toId: string) => {
        set(draft => {
          draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId, toId });
        });
      },

      removeConnection: (fromId: string, toId: string) => {
        set(draft => {
          draft.connections = draft.connections.filter(
            c => !(c.fromId === fromId && c.toId === toId)
          );
        });
      },

      moveComponent: (componentId: string, x: number, y: number) => {
        set(draft => {
          const comp = draft.components.find(c => c.id === componentId);
          if (comp) {
            comp.x = x;
            comp.y = y;
          }
        });
      },

      removeConnectionById: (connectionId: string) => {
        set(draft => {
          draft.connections = draft.connections.filter(c => c.id !== connectionId);
        });
      },

      startDragConnection: (type, fromId, connectionId, mouseX, mouseY) => {
        set(draft => {
          draft.draggingConnection = { type, fromId, connectionId, mouseX, mouseY };
        });
      },

      updateDragPosition: (mouseX, mouseY) => {
        set(draft => {
          if (draft.draggingConnection) {
            draft.draggingConnection.mouseX = mouseX;
            draft.draggingConnection.mouseY = mouseY;
          }
        });
      },

      completeDragConnection: (targetId: string) => {
        const state = get();
        const drag = state.draggingConnection;
        if (!drag) return;

        const from = state.components.find(c => c.id === drag.fromId);
        const to = state.components.find(c => c.id === targetId);
        if (!from || !to) {
          set(draft => { draft.draggingConnection = null; });
          return;
        }

        if (!canConnect(from.type, to.type)) {
          set(draft => { draft.draggingConnection = null; });
          return;
        }

        // Don't allow duplicate connections
        const alreadyExists = state.connections.some(
          c => c.fromId === drag.fromId && c.toId === targetId
        );
        if (alreadyExists) {
          set(draft => { draft.draggingConnection = null; });
          return;
        }

        // Slot limit: broker → queue
        if (from.type === 'broker' && to.type === 'queue') {
          const queueConns = state.connections.filter(
            c => c.fromId === drag.fromId && c.id !== drag.connectionId &&
              state.components.find(comp => comp.id === c.toId)?.type === 'queue'
          ).length;
          const maxSlots = 1 + (from.upgrades['addQueueSlot'] ?? 0);
          if (queueConns >= maxSlots) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = `Broker needs "Add Queue Slot" upgrade (${maxSlots}/${maxSlots} used)`;
            });
            return;
          }
        }

        // Slot limit: queue → subscriber
        if (from.type === 'queue' && to.type === 'subscriber') {
          const subConns = state.connections.filter(
            c => c.fromId === drag.fromId && c.id !== drag.connectionId &&
              state.components.find(comp => comp.id === c.toId)?.type === 'subscriber'
          ).length;
          const maxSlots = 1 + (from.upgrades['addSubscriberSlot'] ?? 0);
          if (subConns >= maxSlots) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = `Queue needs "Add Subscriber Slot" upgrade (${maxSlots}/${maxSlots} used)`;
            });
            return;
          }
        }

        // Slot limit: broker → broker bridge (starts at 0)
        if (from.type === 'broker' && to.type === 'broker') {
          const bridgeConns = state.connections.filter(
            c => c.fromId === drag.fromId && c.id !== drag.connectionId &&
              state.components.find(comp => comp.id === c.toId)?.type === 'broker'
          ).length;
          const maxSlots = from.upgrades['addBridgeSlot'] ?? 0;
          if (bridgeConns >= maxSlots) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = maxSlots === 0
                ? 'Broker needs "Add Bridge Slot" upgrade to connect to another broker'
                : `Broker bridge slots full (${maxSlots}/${maxSlots} used)`;
            });
            return;
          }
        }

        // Publisher → single broker limit
        if (from.type === 'publisher') {
          const existingConns = state.connections.filter(c => c.fromId === drag.fromId && c.id !== drag.connectionId).length;
          if (existingConns >= 1) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = 'Publisher can only connect to one broker';
            });
            return;
          }
        }

        set(draft => {
          if (drag.type === 'reassign' && drag.connectionId) {
            const conn = draft.connections.find(c => c.id === drag.connectionId);
            if (conn) {
              conn.toId = targetId;
            }
          } else {
            draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId: drag.fromId, toId: targetId });
          }

          // Auto-assign subscription when a queue first connects to a broker
          if (from.type === 'broker' && to.type === 'queue') {
            const queue = draft.components.find(c => c.id === targetId);
            if (queue && !queue.subscriptionTopic) {
              // Find a publisher connected to this broker or any bridged broker
              const findPublisher = (brokerId: string, visited: Set<string>): typeof draft.components[0] | undefined => {
                if (visited.has(brokerId)) return undefined;
                visited.add(brokerId);
                // Check direct publisher connections
                for (const conn of draft.connections) {
                  if (conn.toId !== brokerId) continue;
                  const pub = draft.components.find(c => c.id === conn.fromId && c.type === 'publisher');
                  if (pub?.topic) return pub;
                }
                // Check bridged brokers
                for (const conn of draft.connections) {
                  const other = conn.fromId === brokerId ? conn.toId : conn.toId === brokerId ? conn.fromId : null;
                  if (other) {
                    const otherComp = draft.components.find(c => c.id === other && c.type === 'broker');
                    if (otherComp) {
                      const found = findPublisher(other, visited);
                      if (found) return found;
                    }
                  }
                }
                return undefined;
              };
              const pub = findPublisher(drag.fromId, new Set());
              if (pub?.topic) {
                const segments = pub.topicSegments ?? pub.topic.split('/');
                queue.subscriptionTopic = pub.topic;
                queue.subscriptionSegments = [...segments];
              }
            }
          }

          draft.draggingConnection = null;
        });
      },

      cancelDragConnection: () => {
        const drag = get().draggingConnection;
        set(draft => {
          // If reassigning and dropped on nothing, delete the connection
          if (drag?.type === 'reassign' && drag.connectionId) {
            draft.connections = draft.connections.filter(c => c.id !== drag.connectionId);
          }
          draft.draggingConnection = null;
        });
      },

      setDraggingNodeId: (id: string | null) => {
        set(draft => { draft.draggingNodeId = id; });
      },

      getAvailableTopics: (queueId: string) => {
        const state = get();
        // Find broker(s) connected to this queue
        const brokerIds = state.connections
          .filter(c => c.toId === queueId)
          .map(c => c.fromId)
          .filter(id => state.components.find(c => c.id === id)?.type === 'broker');

        // Walk bridges to find all reachable publishers
        const visited = new Set<string>();
        const publishers: Map<string, { topic: string; segments: string[] }> = new Map();

        const walk = (brokerId: string) => {
          if (visited.has(brokerId)) return;
          visited.add(brokerId);
          // Direct publisher connections to this broker
          for (const conn of state.connections) {
            if (conn.toId === brokerId) {
              const pub = state.components.find(c => c.id === conn.fromId && c.type === 'publisher');
              if (pub?.topic && !publishers.has(pub.topic)) {
                publishers.set(pub.topic, { topic: pub.topic, segments: pub.topicSegments ?? pub.topic.split('/') });
              }
            }
          }
          // Bridge connections (bidirectional)
          for (const conn of state.connections) {
            const other = conn.fromId === brokerId ? conn.toId : conn.toId === brokerId ? conn.fromId : null;
            if (other && state.components.find(c => c.id === other)?.type === 'broker') {
              walk(other);
            }
          }
        };

        for (const bId of brokerIds) walk(bId);

        // Generate one entry per publisher at the queue's current broaden level
        const queue = state.components.find(c => c.id === queueId);
        const broadenLevel = queue?.upgrades.subscriptionBroaden ?? 0;
        const results: Map<string, { topic: string; segments: string[]; broadenLevel: number }> = new Map();
        for (const pub of publishers.values()) {
          const broadened = broadenLevel === 0 ? pub.topic : computeBroadenedTopic(pub.segments, broadenLevel);
          if (!results.has(broadened)) {
            results.set(broadened, { topic: broadened, segments: pub.segments, broadenLevel });
          }
        }
        return Array.from(results.values());
      },

      setQueueSubscription: (queueId: string, topic: string, segments: string[], broadenLevel: number) => {
        set(draft => {
          const queue = draft.components.find(c => c.id === queueId);
          if (!queue || queue.type !== 'queue') return;
          queue.subscriptionSegments = [...segments];
          queue.upgrades.subscriptionBroaden = broadenLevel;
          queue.subscriptionTopic = topic;
        });
      },

      showTutorial: (key: string) => {
        set(draft => {
          if (!draft.tutorialsSeen[key] && !draft.activeTutorial) {
            draft.activeTutorial = key;
          }
        });
      },

      dismissTutorial: (key: string) => {
        set(draft => {
          draft.tutorialsSeen[key] = true;
          draft.activeTutorial = null;
        });
      },

      purchaseGlobalUpgrade: (upgradeKey: string) => {
        set(draft => {
          const level = draft.globalUpgradeLevels[upgradeKey] ?? 0;
          draft.globalUpgradeLevels[upgradeKey] = level + 1;

          switch (upgradeKey) {
            case 'propagationSpeed': {
              const newLevel = draft.globalUpgradeLevels[upgradeKey];
              const boostPct = newLevel * (newLevel + 9) / 2;
              draft.upgrades.propagationSpeed = 1 + boostPct / 100;
              break;
            }
            case 'costReduction':
              draft.upgrades.costReduction = Math.min(0.3, draft.upgrades.costReduction + 0.1);
              break;
            case 'batchFire':
              draft.upgrades.batchFire = level + 2; // level 0 → 2 events, level 1 → 3, etc.
              break;
            case 'globalValueMultiplier': {
              const newLevel = draft.globalUpgradeLevels[upgradeKey];
              let mult = 1;
              for (let i = 1; i <= newLevel; i++) mult *= (1.4 + i * 0.1);
              draft.upgrades.globalValueMultiplier = mult;
              break;
            }
          }
        });
      },

      isPathOccupied: (publisherId: string) => {
        const state = get();
        return state.eventDots.some(
          d => d.status === 'traveling' && d.path[0]?.x === state.components.find(c => c.id === publisherId)?.x
            && d.path[0]?.y === state.components.find(c => c.id === publisherId)?.y
        );
      },

      getAllPathsForPublisher: (publisherId: string) => {
        return get()._getAllPathsWithNodes(publisherId).map(p => p.waypoints);
      },

      _getAllPathsWithNodes: (publisherId: string) => {
        const state = get();
        const results: { waypoints: { x: number; y: number }[]; nodeIds: string[] }[] = [];

        function walk(nodeId: string, currentPath: { x: number; y: number }[], currentNodeIds: string[], visited: Set<string>) {
          if (visited.has(nodeId)) return;
          visited.add(nodeId);
          const node = state.components.find(c => c.id === nodeId);
          if (!node) return;
          const path = [...currentPath, { x: node.x, y: node.y }];
          const nodeIds = [...currentNodeIds, nodeId];

          // Outgoing connections + reverse bridge connections (bridges are bidirectional)
          const nextConns = state.connections.filter(c => c.fromId === nodeId);
          const reverseBridgeConns = node.type === 'broker'
            ? state.connections.filter(c => c.toId === nodeId &&
              state.components.find(comp => comp.id === c.fromId)?.type === 'broker')
            : [];
          const allNext = [
            ...nextConns.map(c => c.toId),
            ...reverseBridgeConns.map(c => c.fromId),
          ];
          if (allNext.length === 0) {
            // Only record paths that end at a subscriber or a queue (for buffering)
            if (node.type === 'subscriber' || node.type === 'queue') {
              results.push({ waypoints: path, nodeIds });
            }
          } else {
            for (const nextId of allNext) {
              walk(nextId, path, nodeIds, new Set(visited));
            }
          }
        }

        walk(publisherId, [], [], new Set());

        // Expand node-center paths into orthogonal waypoints
        // Use port-adjusted midX to match SVG connection line rendering
        return results.map(({ waypoints: nodePath, nodeIds }) => {
          if (nodePath.length < 2) return { waypoints: nodePath, nodeIds };
          const expanded: { x: number; y: number }[] = [nodePath[0]];
          for (let i = 0; i < nodePath.length - 1; i++) {
            const a = nodePath[i];
            const b = nodePath[i + 1];
            if (Math.abs(a.y - b.y) >= 1) {
              // Match ConnectionLine.tsx port positions:
              // startX = from.x + fromHalfW + 16 (port center) + 8 (port radius)
              // endX = to.x - toHalfW - 2
              const aNode = state.components.find(c => c.id === nodeIds[i]);
              const bNode = state.components.find(c => c.id === nodeIds[i + 1]);
              const aHalfW = aNode?.type === 'queue' ? 70 : 60;
              const bHalfW = bNode?.type === 'queue' ? 70 : 60;
              const portStartX = a.x + aHalfW + 24; // port right edge
              const portEndX = b.x - bHalfW - 2;    // target left edge
              const midX = (portStartX + portEndX) / 2;
              expanded.push({ x: midX, y: a.y });
              expanded.push({ x: midX, y: b.y });
            }
            expanded.push(b);
          }
          return { waypoints: expanded, nodeIds };
        });
      },

      getPathForPublisher: (publisherId: string) => {
        const paths = get().getAllPathsForPublisher(publisherId);
        return paths[0] ?? [];
      },

      getEventValue: (publisherId: string) => {
        const state = get();
        const pub = state.components.find(c => c.id === publisherId);
        if (!pub) return 0.5;
        const valueLevel = pub.upgrades['eventValue'] ?? 0;
        return 0.5 + valueLevel * 0.45 + valueLevel * valueLevel * 0.05 + getPermanentValueBoost(state);
      },

      performPrestige: () => {
        const state = get();
        if (state.totalEarned < 1_000_000) return false;

        const pointsEarned = Math.floor(state.totalEarned / 1_000_000);

        set(draft => {
          // Award prestige points
          draft.prestige.points += pointsEarned;
          draft.prestige.totalPoints += pointsEarned;
          draft.prestige.count += 1;

          // Reset run state
          draft.balance = 0;
          draft.totalEarned = 0;
          draft.eventsConsumed = 0;
          draft.eventsDropped = 0;
          draft.components = createInitialComponents();
          draft.connections = createInitialConnections();
          draft.eventDots = [];
          draft.upgrades = {
            propagationSpeed: 1.0,
            costReduction: 0,
            batchFire: 0,
            globalValueMultiplier: 1.0,
          };
          draft.globalUpgradeLevels = {};
          draft.recentEarnings = [];
          draft.coinPops = [];
          draft.selectedNodeId = null;
          draft.meshError = null;
          draft.publisherCooldowns = {};
          draft.draggingConnection = null;
          draft.draggingNodeId = null;
          draft.activeTutorial = null;

          // Apply permanent node effects
          const p = draft.prestige.permanentUpgradeLevels;

          // Auto-publisher + publish speed
          const pub = draft.components.find(c => c.type === 'publisher');
          if (pub) {
            if ((p['autoPub2'] ?? 0) > 0) pub.upgrades['autoPub'] = 2;
            else if ((p['autoPub1'] ?? 0) > 0) pub.upgrades['autoPub'] = 1;
            if ((p['pubSpeed'] ?? 0) > 0) pub.upgrades['publishSpeed'] = 1;
          }

          // Batch start
          if ((p['batchStart'] ?? 0) > 0) {
            draft.upgrades.batchFire = 2; // level 1 = 2 events/click
            draft.globalUpgradeLevels['batchFire'] = 1;
          }

          // Faster consumption head start
          if ((p['consumeSpeed'] ?? 0) > 0) {
            const sub = draft.components.find(c => c.type === 'subscriber');
            if (sub) sub.upgrades['fasterConsumption'] = 1;
          }

          // Subscriber value head start
          if ((p['subValue'] ?? 0) > 0) {
            const sub = draft.components.find(c => c.type === 'subscriber');
            if (sub) sub.upgrades['consumptionValue'] = 1;
          }

          // Queue head start — add a free queue connected to the webhook/broker
          if ((p['queueStart'] ?? 0) > 0) {
            const broker = draft.components.find(c => c.type === 'broker' || c.type === 'webhook');
            if (broker) {
              const qx = Math.round(broker.x + 150);
              const qy = 300 + 140;
              draft.components.push({
                id: 'comp-10',
                type: 'queue',
                x: qx,
                y: qy,
                label: 'Queue',
                tags: {},
                upgrades: {},
              });
              draft.connections.push({
                id: 'conn-10',
                fromId: broker.id,
                toId: 'comp-10',
              });
              componentIdCounter = 11;
              connectionIdCounter = 11;
            }
          }

          // Show prestige tree
          draft.showPrestigeTree = true;
        });

        // Reset ID counters (unless queueStart bumped them)
        if (!((get().prestige.permanentUpgradeLevels['queueStart'] ?? 0) > 0)) {
          componentIdCounter = 10;
          connectionIdCounter = 10;
        }
        dotIdCounter = 0;

        return true;
      },

      purchasePrestigeUpgrade: (upgradeKey: string) => {
        const state = get();
        const node = prestigeNodes.find((n: PrestigeNode) => n.key === upgradeKey);
        if (!node) return false;
        if (isNodePurchased(node.key, state.prestige.permanentUpgradeLevels)) return false;
        if (!isNodeAvailable(node, state.prestige.permanentUpgradeLevels)) return false;
        if (state.prestige.points < node.cost) return false;

        set(draft => {
          draft.prestige.points -= node.cost;
          draft.prestige.permanentUpgradeLevels[upgradeKey] = 1;
        });
        return true;
      },

      setShowPrestigeTree: (show: boolean) => {
        set(draft => { draft.showPrestigeTree = show; });
      },
    };
  })
);

// Auto-save middleware — only save when non-transient state changes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveSnapshot = '';
useGameStore.subscribe((state) => {
  // Build save data
  const { eventDots: _, recentEarnings: __, selectedNodeId: ___, coinPops: ____, draggingConnection: _____, draggingNodeId: ______, meshError: _______, activeTutorial: ________, showPrestigeTree: _________, ...toSave } = state;
  const data: Record<string, any> = {};
  for (const [key, val] of Object.entries(toSave)) {
    if (typeof val !== 'function') {
      data[key] = val;
    }
  }
  const snapshot = JSON.stringify(data);
  // Skip if only transient state (eventDots/recentEarnings) changed
  if (snapshot === lastSaveSnapshot) return;
  lastSaveSnapshot = snapshot;

  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    localStorage.setItem(SAVE_KEY, snapshot);
  }, 500);
});

// Expose store globally for console debugging
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).useGameStore = useGameStore;
