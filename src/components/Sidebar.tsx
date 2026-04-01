import { useGameStore } from '../store/gameStore';
import { globalUpgrades, getUpgradeCost } from '../store/upgradeConfig';
import { formatMoney } from '../utils/formatMoney';

const QUEUE_COST = 60;
const DMQ_COST = 80;

export function Sidebar() {
  const balance = useGameStore(s => s.balance);
  const totalEarned = useGameStore(s => s.totalEarned);
  const eventsConsumed = useGameStore(s => s.eventsConsumed);
  const eventsDropped = useGameStore(s => s.eventsDropped);
  const recentEarnings = useGameStore(s => s.recentEarnings);
  const components = useGameStore(s => s.components);
  const upgrades = useGameStore(s => s.upgrades);
  const globalUpgradeLevels = useGameStore(s => s.globalUpgradeLevels);
  const spend = useGameStore(s => s.spend);
  const purchaseGlobalUpgrade = useGameStore(s => s.purchaseGlobalUpgrade);
  const addComponent = useGameStore(s => s.addComponent);

  // Calculate $/sec
  const now = Date.now();
  const recent = recentEarnings.filter(e => e.time > now - 5000);
  const earningsPerSec = recent.length > 0
    ? recent.reduce((sum, e) => sum + e.amount, 0) / 5
    : 0;
  const eventsPerSec = recent.length > 0 ? recent.length / 5 : 0;

  const handleGlobalUpgrade = (key: string, cost: number) => {
    if (spend(cost)) {
      purchaseGlobalUpgrade(key);
    }
  };

  const handleBuyQueue = () => {
    const broker = components.find(c => c.type === 'broker');
    if (!broker) return;
    if (!spend(QUEUE_COST)) return;

    // Place queue below existing components, stacked vertically
    const queueCount = components.filter(c => c.type === 'queue').length;
    const qx = Math.round(broker.x + 150);
    const qy = 300 + (queueCount + 1) * 140;

    addComponent('queue', qx, qy, 'Queue');
  };

  const hasBroker = components.some(c => c.type === 'broker');
  const hasDmq = components.some(c => c.type === 'dmq');
  const canAffordQueue = balance >= QUEUE_COST;
  const canAffordDmq = balance >= DMQ_COST;

  const handleBuyDmq = () => {
    if (hasDmq) return;
    if (!spend(DMQ_COST)) return;
    // Place DMQ below the mesh, centered under the broker
    const broker = components.find(c => c.type === 'broker');
    const dmqX = broker ? broker.x : 450;
    const dmqY = 550;
    addComponent('dmq', dmqX, dmqY, 'Dead Message Queue');
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

      {/* Stats */}
      <div className="border-t border-gray-800 pt-3">
        <div className="text-gray-500 text-xs uppercase tracking-wider mb-2">Stats</div>
        <div className="grid grid-cols-2 gap-y-1.5 text-xs">
          <span className="text-gray-500">Total earned</span>
          <span className="text-gray-300 text-right">{formatMoney(totalEarned)}</span>
          <span className="text-gray-500">Consumed</span>
          <span className="text-green-400 text-right">{eventsConsumed.toLocaleString()}</span>
          <span className="text-gray-500">Dropped</span>
          <span className="text-red-400 text-right">{eventsDropped.toLocaleString()}</span>
          <span className="text-gray-500">Events/sec</span>
          <span className="text-gray-300 text-right">{eventsPerSec.toFixed(1)}</span>
          <span className="text-gray-500">$/sec</span>
          <span className="text-cyan-400 text-right">{formatMoney(earningsPerSec)}</span>
          <span className="text-gray-500">Mesh size</span>
          <span className="text-gray-300 text-right">{components.length}</span>
        </div>
      </div>

      {/* Global Upgrades */}
      <div className="border-t border-gray-800 pt-3">
        <div className="text-gray-500 text-xs uppercase tracking-wider mb-2">Global Upgrades</div>
        <div className="flex flex-col gap-1.5">
          {globalUpgrades.map(u => {
            const level = globalUpgradeLevels[u.key] ?? 0;
            const maxed = u.maxLevel != null && level >= u.maxLevel;
            const cost = getUpgradeCost(u, level, upgrades.costReduction);
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
                <div className="opacity-60">{u.key === 'autoPub' && level > 0
                  ? `Currently: every ${[5, 3, 1, 0.75, 0.5, 0.25, 0.1][Math.min(level - 1, 6)]}s`
                  : u.description}</div>
                <div className="mt-0.5 font-mono">
                  {maxed ? 'MAX' : formatMoney(cost)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {/* Shop */}
      {hasBroker && (
        <div className="border-t border-gray-800 pt-3">
          <div className="text-gray-500 text-xs uppercase tracking-wider mb-2">Shop</div>
          <div className="flex flex-col gap-1.5">
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
              <div className="opacity-60">Buffers events. Drag connections to wire it up.</div>
              <div className="mt-0.5 font-mono">{formatMoney(QUEUE_COST)}</div>
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
                <div className="mt-0.5 font-mono">{formatMoney(DMQ_COST)}</div>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
