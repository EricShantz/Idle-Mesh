import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { canConnect } from '../utils/connectionRules';
import { globalUpgrades, getUpgradeCost } from './upgradeConfig';

export type ComponentType = 'publisher' | 'webhook' | 'broker' | 'queue' | 'subscriber' | 'dmq';

export type GameComponent = {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  label: string;
  topic?: string;
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
    autoPubLevel: number;
    batchFire: number;
    globalValueMultiplier: number;
  };

  recentEarnings: { time: number; amount: number }[];
  coinPops: { id: string; x: number; y: number; amount: number }[];
  selectedNodeId: string | null;
  meshError: string | null;
  publisherCooldowns: Record<string, number>; // publisherId -> last fire timestamp

  globalUpgradeLevels: Record<string, number>;

  draggingConnection: {
    type: 'reassign' | 'create';
    connectionId?: string;
    fromId: string;
    mouseX: number;
    mouseY: number;
  } | null;

  draggingNodeId: string | null;

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
};

let dotIdCounter = 0;
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
      topic: 'orders/created',
      upgrades: {},
    },
    {
      id: 'webhook-1',
      type: 'webhook',
      x: 450,
      y: 300,
      label: 'Webhook',
      upgrades: {},
    },
    {
      id: 'sub-1',
      type: 'subscriber',
      x: 750,
      y: 300,
      label: 'Subscriber',
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
  if (upgrades.autoPubLevel > 0) levels.autoPub = upgrades.autoPubLevel;
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
      balance: saved?.balance ?? 50000000,
      totalEarned: saved?.totalEarned ?? 0,
      eventsConsumed: saved?.eventsConsumed ?? 0,
      eventsDropped: saved?.eventsDropped ?? 0,

      components: saved?.components ?? createInitialComponents(),
      connections: saved?.connections ?? createInitialConnections(),
      eventDots: [], // never persist in-flight dots

      upgrades: saved?.upgrades ?? {
        propagationSpeed: 1.0,
        costReduction: 0,
        autoPubLevel: 0,
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
        const validPaths = allPaths.filter(p => p.waypoints.length >= 2);
        if (validPaths.length === 0) return;

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

        // For each broker group, check fan-out and pick best queue
        for (const [, group] of groupedByBroker) {
          // Check if ALL queues in this group have fan-out purchased
          const allHaveFanOut = group.every(p => {
            const queueId = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue');
            const queue = state.components.find(c => c.id === queueId);
            return queue && (queue.upgrades['fanOut'] ?? 0) > 0;
          });

          if (allHaveFanOut) {
            selectedPaths.push(...group);
          } else {
            // Pick the queue with the most effective free space
            // Account for: buffered dots + in-flight dots heading toward the queue
            // Prefer queues that have a subscriber connected (path ends at a subscriber)
            const pathsWithScore = group.map(p => {
              const queueId = p.nodeIds.find(id => state.components.find(c => c.id === id)?.type === 'queue')!;
              const queue = state.components.find(c => c.id === queueId)!;
              const capacity = 1 + (queue.upgrades['bufferSize'] ?? 0);
              const queued = state.eventDots.filter(d => d.status === 'queued' && d.queuedAtNodeId === queueId).length;
              const inFlight = state.eventDots.filter(d =>
                d.status === 'traveling' &&
                d.path.some(wp => Math.abs(wp.x - queue.x) < 1 && Math.abs(wp.y - queue.y) < 1)
              ).length;
              const freeSpace = capacity - queued - inFlight;
              return { path: p, freeSpace };
            });

            // Pick the queue with the most free space; skip full queues if others have room
            const nonFull = pathsWithScore.filter(p => p.freeSpace > 0);
            const candidates = nonFull.length > 0 ? nonFull : pathsWithScore;

            let best = candidates[0];
            for (const c of candidates) {
              if (c.freeSpace > best.freeSpace) best = c;
            }
            selectedPaths.push(best.path);
          }
        }

        const value = state.getEventValue(publisherId);
        const speed = 0.0007 * state.upgrades.propagationSpeed;

        set(draft => {
          if (!skipCooldown) {
            draft.publisherCooldowns[publisherId] = Date.now();
          }
          const fireCount = state.upgrades.batchFire > 0 ? state.upgrades.batchFire : 1;
          for (let batch = 0; batch < fireCount; batch++) {
            for (const { waypoints, nodeIds } of selectedPaths) {
              const dotId = `dot-${++dotIdCounter}`;
              draft.eventDots.push({
                id: dotId,
                path: waypoints,
                progress: batch * -0.04,
                speed,
                status: 'traveling',
                color: '#66ffff',
                opacity: 1,
                value,
                originalValue: value,
                originalNodeIds: nodeIds,
              });
            }
          }
        });
      },

      consumeEvent: (_dotId: string, value: number, subscriberId: string) => {
        set(draft => {
          const earned = value * draft.upgrades.globalValueMultiplier;
          draft.balance += earned;
          draft.totalEarned += earned;
          draft.eventsConsumed += 1;
          draft.recentEarnings.push({ time: Date.now(), amount: earned });
          const sub = draft.components.find(c => c.id === subscriberId);
          if (sub) {
            draft.coinPops.push({ id: `coin-${++dotIdCounter}`, x: sub.x, y: sub.y, amount: earned });
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
            }
          }
        });
      },

      addComponent: (type: ComponentType, x: number, y: number, label: string) => {
        const id = `comp-${++componentIdCounter}`;
        set(draft => {
          draft.components.push({ id, type, x, y, label, upgrades: {} });
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
            c => c.fromId === drag.fromId &&
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
            c => c.fromId === drag.fromId &&
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

        set(draft => {
          if (drag.type === 'reassign' && drag.connectionId) {
            const conn = draft.connections.find(c => c.id === drag.connectionId);
            if (conn) {
              conn.toId = targetId;
            }
          } else {
            draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId: drag.fromId, toId: targetId });
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
            case 'autoPub':
              draft.upgrades.autoPubLevel = level + 1;
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

          const nextConns = state.connections.filter(c => c.fromId === nodeId);
          if (nextConns.length === 0) {
            results.push({ waypoints: path, nodeIds });
          } else {
            for (const conn of nextConns) {
              walk(conn.toId, path, nodeIds, new Set(visited));
            }
          }
        }

        walk(publisherId, [], [], new Set());

        // Expand node-center paths into orthogonal waypoints
        return results.map(({ waypoints: nodePath, nodeIds }) => {
          if (nodePath.length < 2) return { waypoints: nodePath, nodeIds };
          const expanded: { x: number; y: number }[] = [nodePath[0]];
          for (let i = 0; i < nodePath.length - 1; i++) {
            const a = nodePath[i];
            const b = nodePath[i + 1];
            if (Math.abs(a.y - b.y) >= 1) {
              const midX = (a.x + b.x) / 2;
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
        return 0.5 + valueLevel * 0.45 + valueLevel * valueLevel * 0.05;
      },
    };
  })
);

// Auto-save middleware — only save when non-transient state changes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveSnapshot = '';
useGameStore.subscribe((state) => {
  // Build save data
  const { eventDots: _, recentEarnings: __, selectedNodeId: ___, coinPops: ____, draggingConnection: _____, draggingNodeId: ______, meshError: _______, ...toSave } = state;
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
