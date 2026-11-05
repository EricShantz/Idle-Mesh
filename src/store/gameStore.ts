import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { setAutoFreeze } from 'immer';

// immer's auto-freeze deep-walks and Object.freeze()s every unfrozen object reachable from a
// produced state. eventDots is replaced by a fresh, unfrozen array every frame (commitFrame
// commits it without immer), so every immer commit — consumeEvents once per frame,
// any purchase — re-walked and re-froze every live dot and path: ~13% of frame time at ~1,600
// dots. The freeze only guards against accidental in-place mutation, which this store never
// relies on (the game loop rebuilds dots via spreads), so it is turned off.
setAutoFreeze(false);
import { canConnect } from '../utils/connectionRules';
import { getNextTopic } from './topicPool';
import { computeBroadenedTopic } from '../utils/topicMatching';
import { getSmoothedFps } from '../hooks/useGameLoop';
import { WIN_THRESHOLD } from './upgradeConfig';
import { getPermanentSubPayoutMult, getPublisherCooldownMs, getEventValue as computeEventValue, getAllPathsWithNodes } from '../sim/meshRules';
import { getPublishPlan } from '../sim/publish';
import { queueManualFire } from '../sim/simBridge';
import type { TickSummary } from '../sim/sim';
import type { ComponentType, GameComponent, Connection, EventDot, GlobalUpgrades, PrestigeState, Mesh } from '../sim/types';
import { prestigeNodes, isNodeAvailable, isNodePurchased, getPrestigePointsFor, PRESTIGE_MIN_EARNED, type PrestigeNode } from './prestigeUpgradeConfig';

// The shared types and the store-free rules now live in src/sim (the simulation must not import
// the store); they are re-exported here so existing imports keep working.
export type { ComponentType, GameComponent, Connection, EventDot } from '../sim/types';
export {
  findNextInteractableId, firstBridgeExitNodeId, pathCrossesBridge, getQueueValueMultiplier,
  BRIDGE_GOLD_COLOR, BRIDGE_VALUE_MULT, QUEUE_VALUE_BONUS_PER_HOP,
  getPermanentSpeedMult, getPermanentCostReduction, getPermanentShopDiscount, getPermanentValueBoost,
  getPermanentPubRateMult, getPermanentSubPayoutMult, getPermanentBrokerThroughputMult,
  getPermanentQueueBufferBonus, getPublisherTierMultiplier, getPublisherCooldownMs,
} from '../sim/meshRules';

/** The four store fields the simulation reads, as the snapshot it takes. */
export function meshOf(state: Pick<GameState, 'components' | 'connections' | 'upgrades' | 'prestige'>): Mesh {
  return { components: state.components, connections: state.connections, upgrades: state.upgrades, prestige: state.prestige };
}

export type GameState = {
  balance: number;
  totalEarned: number;
  eventsConsumed: number;
  eventsDropped: number;

  components: GameComponent[];
  connections: Connection[];
  eventDots: EventDot[];
  /** Per queue/DMQ id: one char per queued dot, oldest first ('r' retry, 'n' normal). Written by
   *  the game loop each frame so queue cards don't re-scan every live dot on every commit. */
  queueSlotSignatures: Record<string, string>;

  upgrades: GlobalUpgrades;

  // One aggregated entry per frame (not per event): `count` events worth `amount` total.
  recentEarnings: { time: number; amount: number; count: number }[];
  // One entry per publisher fire: `count` events emitted. Feeds the sidebar "Published/sec" stat.
  recentPublishes: { time: number; count: number }[];
  coinPops: { id: string; x: number; y: number; amount: number }[];
  selectedNodeId: string | null;
  meshError: string | null;
  publisherCooldowns: Record<string, number>; // publisherId -> last fire timestamp

  globalUpgradeLevels: Record<string, number>;

  prestige: PrestigeState;

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

  // End-game. `winSeen` persists (only a full wipe clears it); `showWinScreen` is transient.
  winSeen: boolean;
  showWinScreen: boolean;

  // Actions
  fireEvent: (publisherId: string) => void;
  consumeEvents: (batch: { value: number; subscriberId: string }[]) => void;
  removeCoinPop: (id: string) => void;
  commitFrame: (summary: TickSummary, dots: EventDot[]) => void;
  earn: (amount: number) => void;
  spend: (amount: number) => boolean;
  selectNode: (nodeId: string | null) => void;
  upgradeComponent: (componentId: string, upgradeKey: string) => void;
  purchaseGlobalUpgrade: (upgradeKey: string) => void;
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
  dismissWinScreen: () => void;
  wipeSaveAndRestart: () => void;
};

// Run after every change to totalEarned (both earning paths): fires the prestige-available
// tutorial at $1M and the end-game win screen at WIN_THRESHOLD. The win fires once per save;
// `winSeen` survives prestige and only a full wipe clears it.
function checkEarningMilestones(draft: GameState) {
  if (draft.totalEarned >= PRESTIGE_MIN_EARNED && !draft.tutorialsSeen['prestigeAvailable'] && !draft.activeTutorial) {
    draft.activeTutorial = 'prestigeAvailable';
  }
  if (draft.totalEarned >= WIN_THRESHOLD && !draft.winSeen && !draft.showWinScreen) {
    draft.showWinScreen = true;
  }
}

// Single source of truth for the upgrade levels a component of a given type should
// start with, based on currently-owned "start each run with X" prestige nodes. Used
// both for components that already exist (reset / mid-run purchase of a node) and for
// brand-new components bought via the shop, so a node never only affects "the first one".
function getPermanentStartUpgrades(type: ComponentType, permanentUpgradeLevels: Record<string, number>): Record<string, number> {
  const p = permanentUpgradeLevels;
  const owns = (key: string) => (p[key] ?? 0) > 0;
  const upgrades: Record<string, number> = {};
  if (type === 'publisher') {
    const autoPubLevel = owns('pubAutoPub2') ? 2 : owns('pubAutoPub1') ? 1 : 0;
    if (autoPubLevel > 0) upgrades['autoPub'] = autoPubLevel;
    if (owns('pubSpeed')) upgrades['publishSpeed'] = 1;
  } else if (type === 'subscriber') {
    if (owns('subConsumeSpeed')) upgrades['fasterConsumption'] = 1;
    if (owns('subConsumeValue')) upgrades['consumptionValue'] = 1;
  } else if (type === 'broker') {
    if (owns('brokerThroughput')) upgrades['increaseThroughput'] = 1;
    if (owns('brokerBridge')) upgrades['addBridgeSlot'] = 1;
  } else if (type === 'queue') {
    if (owns('queueBroaden')) upgrades['subscriptionBroaden'] = 1;
  }
  return upgrades;
}

// Apply "start each run with X" permanent prestige bonuses to existing components.
// Uses Math.max so an already-upgraded component is never downgraded, and applies to
// every matching component (not just "the first one") so this works both right after
// a prestige reset (one component of each type) and immediately when a node is bought
// mid-run (any number of components, including ones bought after the node).
function applyPermanentStartBonuses(draft: GameState) {
  const p = draft.prestige.permanentUpgradeLevels;
  const owns = (key: string) => (p[key] ?? 0) > 0;

  // Convert webhook -> broker first so the broker-upgrade grants below also apply to it
  if (owns('brokerRoot')) {
    for (const webhook of draft.components) {
      if (webhook.type !== 'webhook') continue;
      webhook.type = 'broker';
      webhook.label = 'Broker';
      webhook.upgrades['upgradeToBroker'] = 1;
    }
  }

  for (const comp of draft.components) {
    if (comp.type !== 'publisher' && comp.type !== 'subscriber' && comp.type !== 'broker' && comp.type !== 'queue') continue;
    const grants = getPermanentStartUpgrades(comp.type, p);
    for (const [key, level] of Object.entries(grants)) {
      comp.upgrades[key] = Math.max(comp.upgrades[key] ?? 0, level);
    }
  }

  if (owns('pubBatchStart')) {
    draft.upgrades.batchFire = Math.max(draft.upgrades.batchFire, 2);
    draft.globalUpgradeLevels['batchFire'] = Math.max(draft.globalUpgradeLevels['batchFire'] ?? 0, 1);
  }

  grantHeadStartQueue(draft);
}

// "Queue Head Start" prestige node: the free queue is only placed once a broker exists,
// because queues can't hang off a webhook in normal play either (the shop item requires
// a broker). Called from applyPermanentStartBonuses (reset / node purchase) and again
// from the webhook → broker upgrade so a run without Broker Affinity still gets its
// queue the moment it becomes eligible. The queue is spliced *into* the starter chain
// (publisher → broker → queue → subscriber) rather than dangling off the broker next to
// the existing broker → subscriber link, and it inherits the publisher's topic the same
// way a hand-wired queue would.
function grantHeadStartQueue(draft: GameState) {
  const p = draft.prestige.permanentUpgradeLevels;
  if ((p['queueFreeQueue'] ?? 0) <= 0) return;
  if (draft.components.some(c => c.type === 'queue')) return;
  const broker = draft.components.find(c => c.type === 'broker');
  if (!broker) return;

  const qId = `comp-${++componentIdCounter}`;
  const queue: GameComponent = { id: qId, type: 'queue', x: broker.x + 150, y: broker.y + 140, label: 'Queue', tags: {}, upgrades: getPermanentStartUpgrades('queue', p) };

  // Subscribe to whichever publisher feeds this broker (mirrors completeDragConnection's auto-assign)
  const pubConn = draft.connections.find(c => c.toId === broker.id && draft.components.find(k => k.id === c.fromId)?.type === 'publisher');
  const pub = pubConn ? draft.components.find(c => c.id === pubConn.fromId) : undefined;
  if (pub?.topic) {
    queue.subscriptionTopic = pub.topic;
    queue.subscriptionSegments = [...(pub.topicSegments ?? pub.topic.split('/'))];
    const broaden = queue.upgrades['subscriptionBroaden'] ?? 0;
    if (broaden > 0) queue.subscriptionTopic = computeBroadenedTopic(queue.subscriptionSegments, broaden);
  }

  // Splice between the broker and a subscriber it feeds directly (the starter layout).
  const directSubConn = draft.connections.find(c => c.fromId === broker.id && draft.components.find(k => k.id === c.toId)?.type === 'subscriber');
  const sub = directSubConn ? draft.components.find(c => c.id === directSubConn.toId) : undefined;
  if (directSubConn && sub) {
    // Sit the queue on the broker's row halfway to the subscriber; nudge the subscriber
    // right if the gap is too tight for a queue card plus ports.
    const MIN_GAP = 400;
    if (sub.x - broker.x < MIN_GAP) sub.x = broker.x + MIN_GAP;
    queue.x = Math.round((broker.x + sub.x) / 2);
    queue.y = broker.y;
    draft.connections = draft.connections.filter(c => c.id !== directSubConn.id);
    draft.components.push(queue);
    draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId: broker.id, toId: qId });
    draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId: qId, toId: sub.id });
    return;
  }

  draft.components.push(queue);
  draft.connections.push({ id: `conn-${++connectionIdCounter}`, fromId: broker.id, toId: qId });
}

const coinPopTracking: Record<string, { count: number; windowStart: number; pendingAmount: number }> = {};
let coinPopIdCounter = 0;
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


// The per-frame consume bookkeeping as a pure function over plain objects: returns only the
// fields a batch of consumes changes. Used by consumeEvents and commitFrame instead of an immer
// recipe — at thousands of consumes per second the draft proxy (every draft.components.find was
// a trapped read per element) was a quarter of the frame on its own.
function applyConsumes(
  state: GameState,
  batch: { value: number; subscriberId: string }[],
  compById: Map<string, GameComponent>,
): Partial<GameState> {
  const hasIncome = (state.prestige.permanentUpgradeLevels['globalIncome'] ?? 0) > 0;
  const permMult = (hasIncome ? 1.1 : 1.0) * getPermanentSubPayoutMult(state);
  const now = Date.now();

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

  let balance = state.balance;
  let totalEarned = state.totalEarned;
  let earnedTotal = 0;
  let coinPops = state.coinPops;
  let popsCopied = false;
  for (const { value, subscriberId } of batch) {
    const earned = value * state.upgrades.globalValueMultiplier * permMult;
    earnedTotal += earned;
    balance += earned;
    totalEarned += earned;

    const sub = compById.get(subscriberId);
    if (sub) {
      let track = coinPopTracking[subscriberId];
      if (!track || now - track.windowStart > 1000) {
        track = { count: 0, windowStart: now, pendingAmount: 0 };
        coinPopTracking[subscriberId] = track;
      }
      track.count++;
      track.pendingAmount += earned;
      const showEveryN = track.count <= maxPopsPerSec ? 1 : Math.ceil(track.count / maxPopsPerSec);
      if (track.count % showEveryN === 0 && coinPops.length < maxActivePops) {
        if (!popsCopied) { coinPops = coinPops.slice(); popsCopied = true; }
        coinPops.push({ id: 'coin-' + (++coinPopIdCounter), x: sub.x, y: sub.y, amount: track.pendingAmount });
        track.pendingAmount = 0;
      }
    }
  }

  const patch: Partial<GameState> = { balance, totalEarned, eventsConsumed: state.eventsConsumed + batch.length };
  if (popsCopied) patch.coinPops = coinPops;

  // Earning milestones (same rules as checkEarningMilestones, against the new total)
  if (totalEarned >= PRESTIGE_MIN_EARNED && !state.tutorialsSeen['prestigeAvailable'] && !state.activeTutorial) {
    patch.activeTutorial = 'prestigeAvailable';
  }
  if (totalEarned >= WIN_THRESHOLD && !state.winSeen && !state.showWinScreen) {
    patch.showWinScreen = true;
  }

  // Keep the 5s earnings window bounded in the same commit, one aggregated entry per batch.
  const cutoff = now - 5000;
  const kept = state.recentEarnings.length > 0 && state.recentEarnings[0].time < cutoff
    ? state.recentEarnings.filter(e => e.time > cutoff)
    : state.recentEarnings;
  patch.recentEarnings = kept.concat([{ time: now, amount: earnedTotal, count: batch.length }]);
  return patch;
}

// The cooldown map and publish-rate entries for publishers that fired at `now` (the sim built
// their dots). Shared by the manual click and commitFrame.
function applyPublishes(state: GameState, publisherIds: string[], counts: number[], now: number) {
  const cooldowns = { ...state.publisherCooldowns };
  const publishes: { time: number; count: number }[] = [];
  for (let i = 0; i < publisherIds.length; i++) {
    cooldowns[publisherIds[i]] = now;
    publishes.push({ time: now, count: counts[i] });
  }
  const cutoff = now - 5000;
  const recent = state.recentPublishes.length > 0 && state.recentPublishes[0].time < cutoff
    ? state.recentPublishes.filter(e => e.time > cutoff)
    : state.recentPublishes;
  return { cooldowns, recentPublishes: recent.concat(publishes) };
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

// Migrate old prestige keys to new tree structure
function migratePrestigeKeys(prestige: GameState['prestige']): GameState['prestige'] {
  const p = prestige.permanentUpgradeLevels;
  // Detect old format: 'income' key existed in old tree but not new
  if (!((p['income'] ?? 0) > 0) && !((p['speed1'] ?? 0) > 0) && !((p['costRed1'] ?? 0) > 0)) {
    return prestige; // already new format or empty
  }

  const migrated = { ...prestige, permanentUpgradeLevels: { ...p } };
  const m = migrated.permanentUpgradeLevels;
  let refundedPoints = 0;

  // Simple renames
  const renames: [string, string][] = [
    ['income', 'globalIncome'],
    ['speed1', 'globalSpeed1'],
    ['speed2', 'globalSpeed2'],
    ['shopDiscount', 'globalShopDiscount'],
    ['pubSpeed', 'pubSpeed'],
  ];
  for (const [oldKey, newKey] of renames) {
    if ((p[oldKey] ?? 0) > 0) {
      m[newKey] = 1;
      if (oldKey !== newKey) delete m[oldKey];
    }
  }

  // costRed1 + costRed2 → single globalCostRed (refund costRed2)
  if ((p['costRed1'] ?? 0) > 0) {
    m['globalCostRed'] = 1;
    delete m['costRed1'];
  }
  if ((p['costRed2'] ?? 0) > 0) {
    refundedPoints += 6; // costRed2 cost was 6
    delete m['costRed2'];
  }

  // speed3 removed (refund)
  if ((p['speed3'] ?? 0) > 0) {
    refundedPoints += 7;
    delete m['speed3'];
  }

  // Publisher branch: autoPub1/2 → pubAutoPub1/2, grant pubRoot free
  if ((p['autoPub1'] ?? 0) > 0 || (p['pubSpeed'] ?? 0) > 0) {
    m['pubRoot'] = 1;
  }
  if ((p['autoPub1'] ?? 0) > 0) { m['pubAutoPub1'] = 1; delete m['autoPub1']; }
  if ((p['autoPub2'] ?? 0) > 0) { m['pubAutoPub2'] = 1; delete m['autoPub2']; }
  if ((p['batchStart'] ?? 0) > 0) { m['pubBatchStart'] = 1; delete m['batchStart']; }

  // Subscriber branch: value1/2 → subValue1/2, grant subRoot free
  if ((p['value1'] ?? 0) > 0 || (p['consumeSpeed'] ?? 0) > 0 || (p['subValue'] ?? 0) > 0) {
    m['subRoot'] = 1;
  }
  if ((p['value1'] ?? 0) > 0) { m['subValue1'] = 1; delete m['value1']; }
  if ((p['value2'] ?? 0) > 0) { m['subValue2'] = 1; delete m['value2']; }
  if ((p['consumeSpeed'] ?? 0) > 0) { m['subConsumeSpeed'] = 1; delete m['consumeSpeed']; }
  if ((p['subValue'] ?? 0) > 0) { m['subConsumeValue'] = 1; delete m['subValue']; }

  // Queue branch: queueStart → queueFreeQueue, grant queueRoot free
  if ((p['queueStart'] ?? 0) > 0) {
    m['queueRoot'] = 1;
    m['queueFreeQueue'] = 1;
    delete m['queueStart'];
  }

  migrated.points += refundedPoints;
  return migrated;
}

// Nodes removed from the tree outright: refund their cost on load so an existing save that
// bought one doesn't silently lose the points.
const REMOVED_PRESTIGE_NODES: Record<string, number> = {
  // Prefetch — its only effect was raising a fixed per-frame queue release cap that no longer
  // exists; queue throughput is now governed by the subscriber's actual consumption speed.
  queueBatchConsume: 14,
};
function refundRemovedPrestigeNodes(prestige: GameState['prestige']): GameState['prestige'] {
  const levels = { ...prestige.permanentUpgradeLevels };
  let refund = 0;
  for (const [key, cost] of Object.entries(REMOVED_PRESTIGE_NODES)) {
    if ((levels[key] ?? 0) > 0) {
      refund += cost;
      delete levels[key];
    }
  }
  if (refund === 0) return prestige;
  return { ...prestige, points: prestige.points + refund, permanentUpgradeLevels: levels };
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
      balance: saved?.balance ?? 0,
      totalEarned: saved?.totalEarned ?? 0,
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
      queueSlotSignatures: {},

      upgrades: saved?.upgrades ?? {
        propagationSpeed: 1.0,
        costReduction: 0,
        batchFire: (saved?.upgrades as any)?.batchFire === true ? 2 : (saved?.upgrades?.batchFire ?? 0),
        globalValueMultiplier: 1.0,
      },

      globalUpgradeLevels: saved?.globalUpgradeLevels ?? migrateGlobalUpgradeLevels(saved?.upgrades),

      recentEarnings: [],
      recentPublishes: [],
      coinPops: [],
      selectedNodeId: null,
      meshError: null,
      publisherCooldowns: {},
      draggingConnection: null,
      draggingNodeId: null,
      showPrestigeTree: false,
      winSeen: saved?.winSeen ?? false,
      showWinScreen: false,

      prestige: refundRemovedPrestigeNodes(migratePrestigeKeys(saved?.prestige ?? { points: 0, totalPoints: 0, count: 0, permanentUpgradeLevels: {} })),

      tutorialsSeen: saved?.tutorialsSeen ?? {},
      activeTutorial: null,

      fireEvent: (publisherId: string) => {
        const state = get();
        const pub = state.components.find(c => c.id === publisherId);
        if (!pub) return;
        // Manual clicks are gated on wall-clock cooldown. The auto-publisher gates on sim-time
        // cooldown inside the simulation instead (see sim.ts), so a slow frame rate slows
        // publishing in step with everything else rather than flooding the mesh.
        const lastFireTime = state.publisherCooldowns[publisherId] ?? 0;
        if (Date.now() - lastFireTime < getPublisherCooldownMs(pub, state)) return;
        // A publisher that can't fire (no outgoing connection, no broker on any path) does
        // nothing and keeps its old cooldown, as before. The dots themselves are built by the
        // sim at the start of its next tick; the cooldown is written now so the card reacts.
        const plan = getPublishPlan(meshOf(state), publisherId);
        if (!plan) return;
        const { cooldowns, recentPublishes } = applyPublishes(state, [publisherId], [plan.fireCount], Date.now());
        set({ publisherCooldowns: cooldowns, recentPublishes });
        queueManualFire(publisherId);
      },

      // All of a frame's consumes in ONE store commit. Every commit runs an immer produce over
      // the whole state, notifies every hook selector in the app, and wakes the auto-save
      // subscriber — at high throughput (thousands of consumes/sec) doing that per event was
      // the dominant per-frame cost. Results are identical to applying them one at a time.
      consumeEvents: (batch: { value: number; subscriberId: string }[]) => {
        if (batch.length === 0) return;
        const state = get();
        set(applyConsumes(state, batch, new Map(state.components.map(c => [c.id, c]))));
      },

      // The whole frame — moved dots, consumes, drops, due auto-publishers, queue slot display —
      // as ONE plain (non-immer) commit. Each commit runs every hook selector in the app and wakes
      // the auto-save subscriber, so three commits per frame cost three times what one does.
      // The sim owns the dots (it already appended the due publishers' new dots); the store
      // mirrors the array for the canvas and keeps the persisted bookkeeping.
      commitFrame: ({ consumed, droppedCount, publisherIds, publishes, queueSlotSignatures }: TickSummary, dots: EventDot[]) => {
        const state = get();
        const patch: Partial<GameState> = consumed.length > 0
          ? applyConsumes(state, consumed, new Map(state.components.map(c => [c.id, c])))
          : {};
        if (publisherIds.length > 0) {
          const { cooldowns, recentPublishes } = applyPublishes(state, publisherIds, publishes.map(p => p.count), Date.now());
          patch.publisherCooldowns = cooldowns;
          patch.recentPublishes = recentPublishes;
        }
        if (droppedCount > 0) patch.eventsDropped = state.eventsDropped + droppedCount;
        patch.eventDots = dots;
        patch.queueSlotSignatures = queueSlotSignatures;
        set(patch);
      },

      removeCoinPop: (id: string) => {
        set(draft => {
          draft.coinPops = draft.coinPops.filter(c => c.id !== id);
        });
      },

      earn: (amount: number) => {
        set(draft => {
          draft.balance += amount;
          draft.totalEarned += amount;
          checkEarningMilestones(draft);
          draft.recentEarnings.push({ time: Date.now(), amount, count: 1 });
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
              // A Queue Head Start that was waiting on a broker lands now
              grantHeadStartQueue(draft);
            }
            // Clustering a broker keeps its type (all broker connection/routing rules still
            // apply) — it just relabels and unlocks uncapped throughput via slot upgrades.
            if (upgradeKey === 'upgradeToCluster' && comp.type === 'broker') {
              comp.label = 'DMR Cluster';
              if (!draft.tutorialsSeen['dmrCluster']) {
                draft.activeTutorial = 'dmrCluster';
              }
            }
            // Tutorial for first fan-out purchase
            if (upgradeKey === 'fanOut' && !draft.tutorialsSeen['firstFanOut']) {
              draft.activeTutorial = 'firstFanOut';
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
          const comp: GameComponent = { id, type, x, y, label, tags: {}, upgrades: getPermanentStartUpgrades(type, draft.prestige.permanentUpgradeLevels) };
          if (type === 'publisher') {
            const pubCount = draft.components.filter(c => c.type === 'publisher').length;
            const topic = getNextTopic(pubCount);
            comp.topic = topic;
            comp.topicSegments = topic.split('/');
            // Network effect tier is fixed at purchase order (1st purchased = 1, 2nd = 2, ...)
            // and never changes, even if earlier publishers are later deleted.
            comp.upgrades['networkTier'] = pubCount;
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
          // (Dots queued at this component are pruned by the sim when it sees the new mesh.)
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
        // Both brokers must have an available bridge slot
        if (from.type === 'broker' && to.type === 'broker') {
          const fromBridgeConns = state.connections.filter(
            c => c.fromId === drag.fromId && c.id !== drag.connectionId &&
              state.components.find(comp => comp.id === c.toId)?.type === 'broker'
          ).length;
          const fromMaxSlots = from.upgrades['addBridgeSlot'] ?? 0;
          if (fromBridgeConns >= fromMaxSlots) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = fromMaxSlots === 0
                ? 'Broker needs "Add Bridge Slot" upgrade to connect to another broker'
                : `Broker bridge slots full (${fromMaxSlots}/${fromMaxSlots} used)`;
            });
            return;
          }

          // Check target broker's available bridge slots
          const toBridgeConns = state.connections.filter(
            c => c.id !== drag.connectionId &&
              (c.fromId === targetId || c.toId === targetId) &&
              state.components.find(comp => comp.id === (c.fromId === targetId ? c.toId : c.fromId))?.type === 'broker'
          ).length;
          const toMaxSlots = to.upgrades['addBridgeSlot'] ?? 0;
          if (toBridgeConns >= toMaxSlots) {
            set(draft => {
              draft.draggingConnection = null;
              draft.meshError = toMaxSlots === 0
                ? 'Target broker needs "Add Bridge Slot" upgrade to accept a bridge connection'
                : `Target broker bridge slots full (${toMaxSlots}/${toMaxSlots} used)`;
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

        // Generate ALL broadening levels (specific → broad) for each publisher, dedduped
        const queue = state.components.find(c => c.id === queueId);
        const maxBroaden = queue?.upgrades.subscriptionBroaden ?? 0;
        const results: Map<string, { topic: string; segments: string[]; broadenLevel: number }> = new Map();
        for (const pub of publishers.values()) {
          for (let level = 0; level <= maxBroaden; level++) {
            const broadened = level === 0 ? pub.topic : computeBroadenedTopic(pub.segments, level);
            if (!results.has(broadened)) {
              results.set(broadened, { topic: broadened, segments: pub.segments, broadenLevel: level });
            }
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

      getAllPathsForPublisher: (publisherId: string) => {
        return get()._getAllPathsWithNodes(publisherId).map(p => p.waypoints);
      },

      _getAllPathsWithNodes: (publisherId: string) => {
        const state = get();
        return getAllPathsWithNodes(state.components, state.connections, publisherId);
      },

      getPathForPublisher: (publisherId: string) => {
        const paths = get().getAllPathsForPublisher(publisherId);
        return paths[0] ?? [];
      },

      getEventValue: (publisherId: string) => computeEventValue(get(), publisherId),

      performPrestige: () => {
        const state = get();
        // Point curve lives in prestigeUpgradeConfig.ts (cube-root of millions earned, gated at $1M)
        const pointsEarned = getPrestigePointsFor(state.totalEarned);
        if (pointsEarned < 1) return false;

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
          draft.recentPublishes = [];
          draft.coinPops = [];
          draft.selectedNodeId = null;
          draft.meshError = null;
          draft.publisherCooldowns = {};
          draft.draggingConnection = null;
          draft.draggingNodeId = null;
          draft.activeTutorial = null;

          // Apply permanent node effects to the freshly-reset starting components
          applyPermanentStartBonuses(draft);

          // Show prestige tree
          draft.showPrestigeTree = true;
        });

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
          // "Start each run with X" nodes also apply immediately to the current mesh,
          // not just on the next prestige reset.
          applyPermanentStartBonuses(draft);
        });
        return true;
      },

      setShowPrestigeTree: (show: boolean) => {
        set(draft => { draft.showPrestigeTree = show; });
      },

      dismissWinScreen: () => {
        set(draft => {
          draft.showWinScreen = false;
          draft.winSeen = true;
        });
      },

      wipeSaveAndRestart: () => {
        // Suspend autosave first so a pending debounce timer or an unload-triggered
        // flush (reload() fires `pagehide`) can't rewrite the save after we clear it.
        saveSuspended = true;
        if (saveTimeout) {
          clearTimeout(saveTimeout);
          saveTimeout = null;
        }
        pendingSnapshot = null;
        localStorage.removeItem(SAVE_KEY);
        window.location.reload();
      },
    };
  })
);

// Auto-save middleware — only save when non-transient state changes.
// Debounced (500ms) for the common case, but with a max-wait ceiling so
// continuous changes (e.g. balance ticking up during active auto-play)
// can't push the actual write back indefinitely.
const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_WAIT_MS = 3000;

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveSnapshot = '';
let pendingSnapshot: string | null = null;
let lastFlushTime = 0;
// Set when the save is being deliberately wiped (e.g. restart-game), so a straggling
// debounce timer or an unload-triggered flush can't resurrect the old save afterward.
let saveSuspended = false;

function flushSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (saveSuspended) return;
  if (pendingSnapshot === null) return;
  localStorage.setItem(SAVE_KEY, pendingSnapshot);
  lastFlushTime = Date.now();
  pendingSnapshot = null;
}

function buildSaveSnapshot(state: GameState): string {
  const { eventDots: _, queueSlotSignatures: _qs, recentEarnings: __, recentPublishes: ___________, selectedNodeId: ___, coinPops: ____, draggingConnection: _____, draggingNodeId: ______, meshError: _______, activeTutorial: ________, showPrestigeTree: _________, showWinScreen: __________, ...toSave } = state;
  const data: Record<string, any> = {};
  for (const [key, val] of Object.entries(toSave)) {
    if (typeof val !== 'function') {
      data[key] = val;
    }
  }
  return JSON.stringify(data);
}

// The subscriber fires on every store commit — many times per frame at high throughput —
// so it must not serialize anything itself (buildSaveSnapshot JSON-stringifies the whole
// save). It only records that something changed and makes sure a check is scheduled; the
// debounced check is what builds and compares the snapshot.
let lastChangeTime = 0;

function captureSnapshotIfChanged(): boolean {
  const snapshot = buildSaveSnapshot(useGameStore.getState());
  // Unchanged means only transient state (eventDots/recentEarnings/...) moved
  if (snapshot === lastSaveSnapshot) return false;
  lastSaveSnapshot = snapshot;
  pendingSnapshot = snapshot;
  return true;
}

function runSaveCheck() {
  saveTimeout = null;
  if (saveSuspended) return;
  const now = Date.now();
  const quietFor = now - lastChangeTime;
  const sinceFlush = now - lastFlushTime;
  // Same policy as before: write once changes go quiet for the debounce window, but never
  // let continuous activity push the write back past the max-wait ceiling.
  if (quietFor < SAVE_DEBOUNCE_MS && sinceFlush < SAVE_MAX_WAIT_MS) {
    saveTimeout = setTimeout(runSaveCheck, Math.min(SAVE_DEBOUNCE_MS - quietFor, SAVE_MAX_WAIT_MS - sinceFlush));
    return;
  }
  if (captureSnapshotIfChanged()) {
    flushSave();
  } else {
    // Nothing to write — reset the max-wait clock so the next check isn't immediate.
    lastFlushTime = now;
  }
}

useGameStore.subscribe(() => {
  if (saveSuspended) return;
  lastChangeTime = Date.now();
  if (saveTimeout === null) saveTimeout = setTimeout(runSaveCheck, SAVE_DEBOUNCE_MS);
});

// Flush immediately when the tab/iframe is about to be hidden or unloaded — browsers can
// suspend timers in a backgrounded iframe before the debounce fires. Snapshot first: the
// lazy check above may not have captured the latest changes yet.
function flushSaveNow() {
  if (saveSuspended) return;
  captureSnapshotIfChanged();
  flushSave();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaveNow();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSaveNow);
}

// Expose store globally for console debugging
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).useGameStore = useGameStore;
