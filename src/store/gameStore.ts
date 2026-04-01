import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

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
  getEventValue: (publisherId: string) => number;
  addComponent: (type: ComponentType, x: number, y: number, label: string) => string;
  addConnection: (fromId: string, toId: string) => void;
  removeConnection: (fromId: string, toId: string) => void;
  moveComponent: (componentId: string, x: number, y: number) => void;
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

        const path = state.getPathForPublisher(publisherId);
        if (path.length < 2) return;

        const dotId = `dot-${++dotIdCounter}`;
        const value = state.getEventValue(publisherId);
        const speed = 0.0007 * state.upgrades.propagationSpeed;

        // Always create a traveling dot — drops near subscriber are handled in the game loop
        set(draft => {
          draft.publisherCooldowns[publisherId] = Date.now();
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

      getPathForPublisher: (publisherId: string) => {
        const state = get();
        const path: { x: number; y: number }[] = [];
        const visited = new Set<string>();

        function walk(nodeId: string) {
          if (visited.has(nodeId)) return;
          visited.add(nodeId);
          const node = state.components.find(c => c.id === nodeId);
          if (!node) return;
          path.push({ x: node.x, y: node.y });

          const nextConns = state.connections.filter(c => c.fromId === nodeId);
          for (const conn of nextConns) {
            walk(conn.toId);
          }
        }

        walk(publisherId);
        return path;
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
  const { eventDots: _, recentEarnings: __, selectedNodeId: ___, coinPops: ____, ...toSave } = state;
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
