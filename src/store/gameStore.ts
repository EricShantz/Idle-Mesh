import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { canConnect } from '../utils/connectionRules';

export type ComponentType = 'publisher' | 'webhook' | 'broker' | 'queue' | 'subscriber';

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
    dlqUnlocked: boolean;
    dlqEvents: number;
    autoPubLevel: number;
    batchFire: boolean;
    globalValueMultiplier: number;
  };

  recentEarnings: { time: number; amount: number }[];
  coinPops: { id: string; x: number; y: number; amount: number }[];
  selectedNodeId: string | null;
  publisherCooldowns: Record<string, number>; // publisherId -> last fire timestamp

  draggingConnection: {
    type: 'reassign' | 'create';
    connectionId?: string;
    fromId: string;
    mouseX: number;
    mouseY: number;
  } | null;

  // Actions
  fireEvent: (publisherId: string) => void;
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
  getEventValue: (publisherId: string) => number;
  addComponent: (type: ComponentType, x: number, y: number, label: string) => string;
  addConnection: (fromId: string, toId: string) => void;
  removeConnection: (fromId: string, toId: string) => void;
  removeConnectionById: (connectionId: string) => void;
  moveComponent: (componentId: string, x: number, y: number) => void;
  startDragConnection: (type: 'reassign' | 'create', fromId: string, connectionId: string | undefined, mouseX: number, mouseY: number) => void;
  updateDragPosition: (mouseX: number, mouseY: number) => void;
  completeDragConnection: (targetId: string) => void;
  cancelDragConnection: () => void;
};

let dotIdCounter = 0;
let componentIdCounter = 10; // start above initial component count
let connectionIdCounter = 10;

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

export const useGameStore = create<GameState>()(
  immer((set, get) => {
    const saved = loadSavedState();

    return {
      balance: saved?.balance ?? 5000000,
      totalEarned: saved?.totalEarned ?? 0,
      eventsConsumed: saved?.eventsConsumed ?? 0,
      eventsDropped: saved?.eventsDropped ?? 0,

      components: saved?.components ?? createInitialComponents(),
      connections: saved?.connections ?? createInitialConnections(),
      eventDots: [], // never persist in-flight dots

      upgrades: saved?.upgrades ?? {
        propagationSpeed: 1.0,
        costReduction: 0,
        dlqUnlocked: false,
        dlqEvents: 0,
        autoPubLevel: 0,
        batchFire: false,
        globalValueMultiplier: 1.0,
      },

      recentEarnings: [],
      coinPops: [],
      selectedNodeId: null,
      publisherCooldowns: {},
      draggingConnection: null,

      fireEvent: (publisherId: string) => {
        const state = get();
        const pub = state.components.find(c => c.id === publisherId);
        if (!pub) return;

        // Check cooldown
        const lastFireTime = state.publisherCooldowns[publisherId] ?? 0;
        const publishSpeedLevel = pub.upgrades['publishSpeed'] ?? 0;
        const baseCooldown = 1000; // 1 second base cooldown
        const cooldownDuration = baseCooldown * Math.pow(0.95, publishSpeedLevel); // Each level reduces by 5%
        if (Date.now() - lastFireTime < cooldownDuration) return;

        const paths = state.getAllPathsForPublisher(publisherId);
        const validPaths = paths.filter(p => p.length >= 2);
        if (validPaths.length === 0) return;

        const value = state.getEventValue(publisherId);
        const speed = 0.0007 * state.upgrades.propagationSpeed;

        set(draft => {
          draft.publisherCooldowns[publisherId] = Date.now();
          for (const path of validPaths) {
            const dotId = `dot-${++dotIdCounter}`;
            draft.eventDots.push({
              id: dotId,
              path,
              progress: 0,
              speed,
              status: 'traveling',
              color: '#66ffff',
              opacity: 1,
              value,
            });
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

      purchaseGlobalUpgrade: (upgradeKey: string) => {
        set(draft => {
          switch (upgradeKey) {
            case 'propagationSpeed':
              draft.upgrades.propagationSpeed *= 1.15;
              break;
            case 'costReduction':
              draft.upgrades.costReduction = Math.min(0.3, draft.upgrades.costReduction + 0.1);
              break;
            case 'dlq':
              draft.upgrades.dlqUnlocked = true;
              break;
            case 'autoPub1':
              draft.upgrades.autoPubLevel = Math.max(draft.upgrades.autoPubLevel, 1);
              break;
            case 'autoPub2':
              draft.upgrades.autoPubLevel = Math.max(draft.upgrades.autoPubLevel, 2);
              break;
            case 'autoPub3':
              draft.upgrades.autoPubLevel = Math.max(draft.upgrades.autoPubLevel, 3);
              break;
            case 'batchFire':
              draft.upgrades.batchFire = true;
              break;
            case 'globalValueMultiplier':
              draft.upgrades.globalValueMultiplier *= 1.5;
              break;
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
        const state = get();
        const paths: { x: number; y: number }[][] = [];

        function walk(nodeId: string, currentPath: { x: number; y: number }[], visited: Set<string>) {
          if (visited.has(nodeId)) return;
          visited.add(nodeId);
          const node = state.components.find(c => c.id === nodeId);
          if (!node) return;
          const path = [...currentPath, { x: node.x, y: node.y }];

          const nextConns = state.connections.filter(c => c.fromId === nodeId);
          if (nextConns.length === 0) {
            // Leaf node — this is a complete path
            paths.push(path);
          } else {
            for (const conn of nextConns) {
              walk(conn.toId, path, new Set(visited));
            }
          }
        }

        walk(publisherId, [], new Set());

        // Expand node-center paths into orthogonal waypoints
        return paths.map(nodePath => {
          if (nodePath.length < 2) return nodePath;
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
          return expanded;
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
        return 0.5 + valueLevel * 0.5;
      },
    };
  })
);

// Auto-save middleware — only save when non-transient state changes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveSnapshot = '';
useGameStore.subscribe((state) => {
  // Build save data
  const { eventDots: _, recentEarnings: __, selectedNodeId: ___, coinPops: ____, draggingConnection: _____, ...toSave } = state;
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
