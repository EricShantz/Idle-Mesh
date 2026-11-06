import { useState, useRef, useEffect } from 'react';
import { useGameStore, getPermanentShopDiscount } from '../store/gameStore';
import { globalUpgrades, getUpgradeCost, WIN_THRESHOLD } from '../store/upgradeConfig';
import { getSimTicksPerSec } from '../sim/simBridge';
import { useThrottledGameStore } from '../hooks/useThrottledStore';
import { TOPIC_POOL } from '../store/topicPool';
import { formatMoney } from '../utils/formatMoney';
import { PrestigePanel } from './PrestigePanel';

function CollapsibleSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-gray-800 pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-gray-500 text-xs uppercase tracking-wider mb-2 cursor-pointer hover:text-gray-400 transition-colors"
      >
        <span>{title}</span>
        <span className="text-[10px]">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && children}
    </div>
  );
}

const QUEUE_COST = 30;
const DMQ_COST = 100;
const PUBLISHER_BASE_COST = 150;
const SUBSCRIBER_BASE_COST = 75;
const BROKER_BASE_COST = 200;
// The simulation runs in a Web Worker and reports its own rate.
const SIM_RATE_TIP = 'Simulation ticks per second. The sim steps at most 100 ms per tick, so below 10 ticks/s it runs slower than real time and income drops with it.';

function getGlobalUpgradeValueDisplay(key: string, level: number): string | null {
  const next = level + 1;
  switch (key) {
    case 'propagationSpeed': {
      const cur = level * (level + 9) / 2;
      const nxt = next * (next + 9) / 2;
      return `${cur}% → ${nxt}% (+${nxt - cur}%)`;
    }
    case 'costReduction': {
      return `${level * 10}% → ${next * 10}%`;
    }
    case 'batchFire': {
      return `${level + 1} → ${next + 1} events/click`;
    }
    case 'globalValueMultiplier': {
      let curMult = 1;
      for (let i = 1; i <= level; i++) curMult *= (1.4 + i * 0.1);
      const nxtMult = curMult * (1.4 + next * 0.1);
      return `${curMult.toFixed(2)}× → ${nxtMult.toFixed(2)}× (×${(1.4 + next * 0.1).toFixed(1)})`;
    }
    default:
      return null;
  }
}

export function Sidebar() {
  // Values that change every frame are sampled at 10 Hz — the whole sidebar tree re-rendered
  // on every store commit otherwise, just to redraw digits nobody can read at that rate.
  const balance = useThrottledGameStore(s => s.balance);
  const totalEarned = useThrottledGameStore(s => s.totalEarned);
  const eventsConsumed = useThrottledGameStore(s => s.eventsConsumed);
  const eventsDropped = useThrottledGameStore(s => s.eventsDropped);
  const recentEarnings = useThrottledGameStore(s => s.recentEarnings);
  const recentPublishes = useThrottledGameStore(s => s.recentPublishes);
  const components = useGameStore(s => s.components);
  const upgrades = useGameStore(s => s.upgrades);
  const prestige = useGameStore(s => s.prestige);
  const winSeen = useGameStore(s => s.winSeen);
  const effectiveCostReduction = upgrades.costReduction + ((prestige.permanentUpgradeLevels['globalCostRed'] ?? 0) > 0 ? 0.10 : 0);
  const globalUpgradeLevels = useGameStore(s => s.globalUpgradeLevels);
  const spend = useGameStore(s => s.spend);
  const purchaseGlobalUpgrade = useGameStore(s => s.purchaseGlobalUpgrade);
  const addComponent = useGameStore(s => s.addComponent);
  const tutorialsSeen = useGameStore(s => s.tutorialsSeen);
  const activeTutorial = useGameStore(s => s.activeTutorial);
  const earn = useGameStore(s => s.earn);

  const meshComponentsRef = useRef<HTMLDivElement>(null);
  const [highlightComponents, setHighlightComponents] = useState(false);

  // Easter egg: click "Stats" 10 times within 5 seconds for a windfall
  const statsClickTimes = useRef<number[]>([]);
  const [cheatMessage, setCheatMessage] = useState<string | null>(null);
  const STATS_CLICK_THRESHOLD = 10;
  const STATS_CLICK_WINDOW_MS = 5000;

  function handleStatsClick() {
    const now = Date.now();
    const recent = statsClickTimes.current.filter(t => now - t <= STATS_CLICK_WINDOW_MS);
    recent.push(now);
    statsClickTimes.current = recent;
    if (recent.length >= STATS_CLICK_THRESHOLD) {
      statsClickTimes.current = [];
      earn(WIN_THRESHOLD);
      setCheatMessage('Schema Registry backdoor found: +$1,000,000,000,000');
      setTimeout(() => setCheatMessage(null), 3000);
    }
  }

  // After brokerUpgrade tutorial is dismissed, scroll to Mesh Components and highlight
  useEffect(() => {
    if (tutorialsSeen['brokerUpgrade'] && !activeTutorial) {
      setHighlightComponents(true);
      const scrollTimer = setTimeout(() => {
        meshComponentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 300);
      return () => clearTimeout(scrollTimer);
    }
  }, [tutorialsSeen['brokerUpgrade'], activeTutorial]);

  // Clear highlight on any click
  useEffect(() => {
    if (!highlightComponents) return;
    const handler = () => setHighlightComponents(false);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [highlightComponents]);

  // Calculate $/sec
  const now = Date.now();
  const recent = recentEarnings.filter(e => e.time > now - 5000);
  const earningsPerSec = recent.length > 0
    ? recent.reduce((sum, e) => sum + e.amount, 0) / 5
    : 0;
  const consumedPerSec = recent.length > 0 ? recent.reduce((sum, e) => sum + e.count, 0) / 5 : 0;
  const recentPub = recentPublishes.filter(e => e.time > now - 5000);
  const publishedPerSec = recentPub.length > 0 ? recentPub.reduce((sum, e) => sum + e.count, 0) / 5 : 0;
  // The simulation's own rate (it runs in a worker; the render frame rate is a separate number
  // that no longer says anything about the game's speed). Sampled once a second rather than
  // read every render — the sidebar re-renders every frame (balance ticks), and a value that
  // changes 60 times a second isn't readable.
  const [simRate, setSimRate] = useState(() => Math.round(getSimTicksPerSec()));
  useEffect(() => {
    const timer = setInterval(() => setSimRate(Math.round(getSimTicksPerSec())), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleGlobalUpgrade = (key: string, cost: number) => {
    if (spend(cost)) {
      purchaseGlobalUpgrade(key);
    }
  };

  const handleBuyQueue = () => {
    const broker = components.find(c => c.type === 'broker');
    if (!broker) return;
    if (!spend(queueCost)) return;

    // Place queue below existing components, stacked vertically
    const queueCount = components.filter(c => c.type === 'queue').length;
    const qx = Math.round(broker.x + 150);
    const qy = 300 + (queueCount + 1) * 140;

    addComponent('queue', qx, qy, 'Queue');
  };

  const shopDiscount = 1 - getPermanentShopDiscount({ prestige });
  const hasBroker = components.some(c => c.type === 'broker');
  const hasQueue = components.some(c => c.type === 'queue');
  const hasDmq = components.some(c => c.type === 'dmq');
  const queueCount = components.filter(c => c.type === 'queue').length;
  const queueCost = Math.floor(QUEUE_COST * Math.pow(1.3, Math.max(0, queueCount - 1)) * shopDiscount);
  const dmqCost = Math.floor(DMQ_COST * shopDiscount);
  const canAffordQueue = balance >= queueCost;
  const canAffordDmq = balance >= dmqCost;
  const pubCount = components.filter(c => c.type === 'publisher').length;
  const subCount = components.filter(c => c.type === 'subscriber').length;
  const brokerCount = components.filter(c => c.type === 'broker').length;
  const publisherCost = Math.floor(PUBLISHER_BASE_COST * Math.pow(1.8, pubCount - 1) * shopDiscount);
  const subscriberCost = Math.floor(SUBSCRIBER_BASE_COST * Math.pow(1.8, subCount - 1) * shopDiscount);
  const brokerCost = Math.floor(BROKER_BASE_COST * Math.pow(2, brokerCount - 1) * shopDiscount);
  const atPublisherCap = pubCount >= TOPIC_POOL.length;
  const canAffordPublisher = balance >= publisherCost && !atPublisherCap;
  const canAffordSubscriber = balance >= subscriberCost;
  const canAffordBroker = balance >= brokerCost;

  const handleBuyDmq = () => {
    if (hasDmq) return;
    if (!spend(dmqCost)) return;
    const broker = components.find(c => c.type === 'broker');
    const dmqX = broker ? broker.x : 450;
    const dmqY = 550;
    addComponent('dmq', dmqX, dmqY, 'Dead Message Queue');
  };

  const handleBuyPublisher = () => {
    if (atPublisherCap) return;
    if (!spend(publisherCost)) return;
    const lastPub = [...components].reverse().find(c => c.type === 'publisher');
    const px = lastPub ? lastPub.x : 150;
    const py = lastPub ? lastPub.y + 140 : 300;
    addComponent('publisher', px, py, 'Publisher');
  };

  const handleBuySubscriber = () => {
    if (!spend(subscriberCost)) return;
    const lastSub = [...components].reverse().find(c => c.type === 'subscriber');
    const sx = lastSub ? lastSub.x : 750;
    const sy = lastSub ? lastSub.y + 140 : 300;
    addComponent('subscriber', sx, sy, 'Subscriber');
  };

  const handleBuyBroker = () => {
    if (!spend(brokerCost)) return;
    const lastBroker = [...components].reverse().find(c => c.type === 'broker');
    const bx = lastBroker ? lastBroker.x : 450;
    const by = lastBroker ? lastBroker.y + 200 : 300;
    addComponent('broker', bx, by, 'Broker');
  };

  return (
    <div
      className="w-72 flex-shrink-0 border-l border-gray-800 p-4 flex flex-col gap-4 overflow-y-auto"
      style={{ background: '#0d1220' }}
    >
      {/* Balance */}
      <div>
        <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Balance</div>
        <div className="text-2xl font-bold text-cyan-400 font-mono">
          {formatMoney(balance)}
        </div>
      </div>

      {/* Road to $1T — per-run progress toward the end game (resets on prestige).
          One meter: the amount sits inside the bar, the percentage on its right edge. */}
      {(() => {
        const progress = Math.min(totalEarned / WIN_THRESHOLD, 1);
        const gold = winSeen || progress >= 1;
        const fill = gold ? '#f59e0b' : '#22d3ee';
        const pct = progress * 100;
        return (
          <div>
            <div className={`text-xs uppercase tracking-wider mb-1 ${gold ? 'text-amber-400' : 'text-gray-500'}`}>
              Road to $1 Trillion{winSeen && ' ✓'}
            </div>
            <div
              className="relative w-full rounded overflow-hidden"
              style={{ height: 22, background: '#111827', border: '1px solid #1f2937' }}
              title={`${formatMoney(totalEarned)} of ${formatMoney(WIN_THRESHOLD)}`}
            >
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${pct}%`,
                  background: fill,
                  opacity: 0.35,
                  boxShadow: gold ? `0 0 8px ${fill}` : undefined,
                  transition: 'width 0.3s ease-out',
                }}
              />
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${pct}%`, borderRight: `2px solid ${fill}`, transition: 'width 0.3s ease-out' }}
              />
              <div className="absolute inset-0 flex items-center justify-between px-2 text-[11px] font-mono">
                <span className={`font-bold ${gold ? 'text-amber-200' : 'text-gray-100'}`} style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                  {formatMoney(totalEarned)}
                </span>
                <span className={gold ? 'text-amber-300' : 'text-gray-400'} style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                  {pct > 0 && pct < 0.01 ? '<0.01' : pct.toFixed(pct < 10 ? 2 : 1)}%
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Stats */}
      <div className="border-t border-gray-800 pt-3">
        <button
          type="button"
          onClick={handleStatsClick}
          className="text-gray-500 text-xs uppercase tracking-wider mb-2 select-none bg-transparent border-none p-0 m-0 text-left block appearance-none"
        >
          Stats
        </button>
        {cheatMessage && (
          <div className="text-cyan-400 text-xs font-semibold mb-1.5 animate-pulse">{cheatMessage}</div>
        )}
        <div className="grid grid-cols-2 gap-y-1.5 text-xs">
          <span className="text-gray-500">Consumed</span>
          <span className="text-green-400 text-right">{eventsConsumed.toLocaleString()}</span>
          <span className="text-gray-500">Dropped</span>
          <span className="text-red-400 text-right">{eventsDropped.toLocaleString()}</span>
          <span className="text-gray-500">Published/sec</span>
          <span className="text-gray-300 text-right">{publishedPerSec.toFixed(1)}</span>
          <span className="text-gray-500">Consumed/sec</span>
          <span className="text-gray-300 text-right">{consumedPerSec.toFixed(1)}</span>
          <span className="text-gray-500">$/sec</span>
          <span className="text-cyan-400 text-right">{formatMoney(earningsPerSec)}</span>
          <span className="text-gray-500">Mesh size</span>
          <span className="text-gray-300 text-right">{components.length}</span>
          <span className="text-gray-500" title={SIM_RATE_TIP}>Sim rate</span>
          <span className={`text-right ${simRate >= 50 ? 'text-gray-300' : simRate >= 10 ? 'text-amber-400' : 'text-red-400'}`} title={SIM_RATE_TIP}>{simRate} ticks/s</span>
        </div>
      </div>

      {/* Prestige — Schema Registry */}
      {(totalEarned >= 1_000_000 || prestige.count > 0) && (
        <CollapsibleSection title="Schema Registry" defaultOpen={true}>
          <PrestigePanel />
        </CollapsibleSection>
      )}

      {/* Mesh Upgrades */}
      <CollapsibleSection title="Mesh Upgrades" defaultOpen={true}>
        <div className="flex flex-col gap-1.5">
          {globalUpgrades.map(u => {
            const level = globalUpgradeLevels[u.key] ?? 0;
            const maxed = u.maxLevel != null && level >= u.maxLevel;
            const cost = getUpgradeCost(u, level, effectiveCostReduction);
            const canAfford = balance >= cost;

            return (
              <button
                key={u.key}
                onClick={() => handleGlobalUpgrade(u.key, cost)}
                disabled={maxed || !canAfford}
                className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: maxed ? '#374151' : canAfford ? '#22d3ee' : '#374151',
                  background: maxed ? '#111827' : '#111827',
                  color: maxed ? '#6b7280' : canAfford ? '#cffafe' : '#6b7280',
                }}
              >
                <div className="flex justify-between items-center">
                  <span className="font-bold">{u.label}</span>
                  {(u.maxLevel == null || u.maxLevel > 1) && (
                    <span className="text-[10px] opacity-50">Lv {level}</span>
                  )}
                </div>
                <div className="opacity-60">{u.description}</div>
                {!maxed && (() => {
                  const valueDisplay = getGlobalUpgradeValueDisplay(u.key, level);
                  return valueDisplay ? <div className="text-xs text-blue-300 mt-0.5">{valueDisplay}</div> : null;
                })()}
                <div className="mt-0.5 font-mono">
                  {maxed ? 'MAX' : formatMoney(cost)}
                </div>
              </button>
            );
          })}
        </div>
      </CollapsibleSection>
      {/* Mesh Components */}
      {hasBroker && (
        <div ref={meshComponentsRef}>
          <CollapsibleSection title="Mesh Components" defaultOpen={true}>
            <div className="flex flex-col gap-1.5" style={highlightComponents ? {
              borderRadius: 8,
              boxShadow: '0 0 12px rgba(34,211,238,0.4), inset 0 0 8px rgba(34,211,238,0.1)',
              padding: 4,
              transition: 'box-shadow 0.5s ease',
            } : undefined}>
              <button
                onClick={handleBuyQueue}
                disabled={!canAffordQueue}
                className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: canAffordQueue ? '#a855f7' : '#374151',
                  background: canAffordQueue ? '#2e106522' : '#1f293744',
                  color: canAffordQueue ? '#e9d5ff' : '#6b7280',
                }}
              >
                <div className="font-bold">Buy Queue</div>
                <div className="opacity-60">Stores/Releases events based on subscriber availability.</div>
                <div className="mt-0.5 font-mono">{formatMoney(queueCost)}</div>
              </button>
              {!hasDmq && (
                <button
                  onClick={handleBuyDmq}
                  disabled={!canAffordDmq}
                  className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                  style={{
                    borderColor: canAffordDmq ? '#ef4444' : '#374151',
                    background: canAffordDmq ? '#2a0a0a22' : '#1f293744',
                    color: canAffordDmq ? '#fecaca' : '#6b7280',
                  }}
                >
                  <div className="font-bold">Buy Dead Message Queue</div>
                  <div className="opacity-60">Catches dropped events and retries them through the broker.</div>
                  <div className="mt-0.5 font-mono">{formatMoney(dmqCost)}</div>
                </button>
              )}
              <button
                onClick={handleBuyPublisher}
                disabled={!canAffordPublisher}
                className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: atPublisherCap ? '#374151' : canAffordPublisher ? '#22d3ee' : '#374151',
                  background: atPublisherCap ? '#1f2937' : canAffordPublisher ? '#0e303822' : '#1f293744',
                  color: atPublisherCap ? '#6b7280' : canAffordPublisher ? '#cffafe' : '#6b7280',
                }}
              >
                <div className="font-bold">Buy Publisher</div>
                <div className="opacity-60">Emits events on a unique topic. Must connect to a broker.</div>
                <div className="mt-0.5 font-mono">
                  {atPublisherCap ? `MAX (${TOPIC_POOL.length}/${TOPIC_POOL.length} topics)` : formatMoney(publisherCost)}
                </div>
              </button>
              {hasQueue && (
                <button
                  onClick={handleBuySubscriber}
                  disabled={!canAffordSubscriber}
                  className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                  style={{
                    borderColor: canAffordSubscriber ? '#22c55e' : '#374151',
                    background: canAffordSubscriber ? '#0a2e1a22' : '#1f293744',
                    color: canAffordSubscriber ? '#bbf7d0' : '#6b7280',
                  }}
                >
                  <div className="font-bold">Buy Subscriber</div>
                  <div className="opacity-60">Consumes events from queues for money.</div>
                  <div className="mt-0.5 font-mono">{formatMoney(subscriberCost)}</div>
                </button>
              )}
              <button
                onClick={handleBuyBroker}
                disabled={!canAffordBroker}
                className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: canAffordBroker ? '#fb923c' : '#374151',
                  background: canAffordBroker ? '#2a160a22' : '#1f293744',
                  color: canAffordBroker ? '#fed7aa' : '#6b7280',
                }}
              >
                <div className="font-bold">Buy Broker</div>
                <div className="opacity-60">Routes events. Bridge to other brokers for mesh topology.</div>
                <div className="mt-0.5 font-mono">{formatMoney(brokerCost)}</div>
              </button>
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
