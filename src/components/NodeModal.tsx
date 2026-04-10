import { useSyncExternalStore, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { useViewport } from '../hooks/useViewport';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  dmqUpgrades,
  getUpgradeCost,
  getDmqBufferMaxLevel,
  type UpgradeDef,
} from '../store/upgradeConfig';
import { formatMoney } from '../utils/formatMoney';
import { computeBroadenedTopic } from '../utils/topicMatching';

function getUpgradesForType(type: string): UpgradeDef[] {
  switch (type) {
    case 'publisher': return publisherUpgrades;
    case 'webhook': return webhookUpgrades;
    case 'broker': return brokerUpgrades;
    case 'queue': return queueUpgrades;
    case 'subscriber': return subscriberUpgrades;
    case 'dmq': return dmqUpgrades;
    default: return [];
  }
}

function getUpgradeValueDisplay(upgradeKey: string, currentLevel: number, _topic?: string): string {
  const nextLevel = currentLevel + 1;

  switch (upgradeKey) {
    // Buffer/slot upgrades
    case 'bufferSize':
    case 'dmqBufferSize':
      return `${3 + currentLevel} → ${3 + nextLevel}`;
    case 'addSubscriberSlot':
      return `${1 + currentLevel} → ${1 + nextLevel}`;

    // DMQ width
    case 'dmqWidth':
      return `${120 + currentLevel * 40}px → ${120 + nextLevel * 40}px`;

    // DMQ value recovery
    case 'dmqValueRecovery':
      return `${10 + currentLevel * 10}% → ${10 + nextLevel * 10}%`;


    // Value upgrades ($X.XX per unit)
    case 'eventValue': {
      const curVal = (1.0 + currentLevel * 0.45 + currentLevel * currentLevel * 0.05).toFixed(2);
      const nxtVal = (1.0 + nextLevel * 0.45 + nextLevel * nextLevel * 0.05).toFixed(2);
      const increment = (nextLevel * 0.45 + nextLevel * nextLevel * 0.05 - currentLevel * 0.45 - currentLevel * currentLevel * 0.05).toFixed(2);
      return `$${curVal} → $${nxtVal} (+$${increment})`;
    }
    case 'consumptionValue': {
      const cur = 1.0 + currentLevel * 0.08 + currentLevel * currentLevel * 0.02;
      const nxt = 1.0 + nextLevel * 0.08 + nextLevel * nextLevel * 0.02;
      return `${cur.toFixed(2)}x → ${nxt.toFixed(2)}x (+${(nxt - cur).toFixed(2)}x)`;
    }

    // Level-based percentage upgrades
    case 'fasterConsumption': {
      const currentPct = Math.min(currentLevel * (currentLevel + 9) / 2, 100);
      const nextPct = Math.min(nextLevel * (nextLevel + 9) / 2, 100);
      return `${currentPct}% → ${nextPct}% (+${nextPct - currentPct}%)`;
    }
    case 'publishSpeed': {
      const curPct = currentLevel * (currentLevel + 9) / 2;
      const nxtPct = nextLevel * (nextLevel + 9) / 2;
      return `${curPct}% → ${nxtPct}% (+${nxtPct - curPct}%)`;
    }
    case 'autoPub':
      return 'Off → On';
    // Queue slot upgrade
    case 'addQueueSlot':
      return `${1 + currentLevel} → ${1 + nextLevel}`;

    // Bridge slot upgrade (starts at 0)
    case 'addBridgeSlot':
      return `${currentLevel} → ${nextLevel} bridge slots`;

    // Broker throughput cap
    case 'increaseThroughput': {
      const curBonus = currentLevel * (currentLevel + 9) / 2;
      const nxtBonus = nextLevel * (nextLevel + 9) / 2;
      return `${8 + curBonus} → ${8 + nxtBonus} events/sec`;
    }

    // One-time upgrades (no progression display)
    case 'upgradeToBroker':
    case 'fanOut':
      return 'One-time';

    default:
      return `Lv.${currentLevel} → Lv.${nextLevel}`;
  }
}

export function NodeModal() {
  const selectedNodeId = useGameStore(s => s.selectedNodeId);
  const components = useGameStore(s => s.components);
  const balance = useGameStore(s => s.balance);
  const costReduction = useGameStore(s => {
    const p = s.prestige.permanentUpgradeLevels;
    const permCost = (p['globalCostRed'] ?? 0) > 0 ? 0.10 : 0;
    return s.upgrades.costReduction + permCost;
  });
  const spend = useGameStore(s => s.spend);
  const upgradeComponent = useGameStore(s => s.upgradeComponent);
  const selectNode = useGameStore(s => s.selectNode);
  const removeComponent = useGameStore(s => s.removeComponent);
  const getAvailableTopics = useGameStore(s => s.getAvailableTopics);
  const setQueueSubscription = useGameStore(s => s.setQueueSubscription);
  const [topicPickerOpen, setTopicPickerOpen] = useState(false);
  const viewport = useViewport();

  // Subscribe to viewport for screen-space anchoring
  useSyncExternalStore(viewport.subscribe, () => {
    const v = viewport.ref.current;
    return `${v.panX},${v.panY},${v.zoom}`;
  });

  const node = components.find(c => c.id === selectedNodeId);
  if (!node) return null;

  const upgrades = getUpgradesForType(node.type).filter(d => !d.hidden && !(d.key === 'subscriptionBroaden' && !node.subscriptionTopic));
  if (upgrades.length === 0) return null;

  const zoom = viewport.ref.current.zoom;
  const screen = viewport.worldToScreen(node.x, node.y);
  const modalX = screen.x + 80 * zoom;
  const modalY = screen.y - 60 * zoom;

  const handleUpgrade = (def: UpgradeDef) => {
    const level = node.upgrades[def.key] ?? 0;
    const effectiveMax = def.key === 'dmqBufferSize'
      ? getDmqBufferMaxLevel(node.upgrades['dmqWidth'] ?? 0)
      : def.maxLevel;
    if (effectiveMax && level >= effectiveMax) return;
    const cost = getUpgradeCost(def, level, costReduction);
    if (spend(cost)) {
      upgradeComponent(node.id, def.key);
    }
  };

  const handleBuyMax = (def: UpgradeDef) => {
    let level = node.upgrades[def.key] ?? 0;
    const effectiveMax = def.key === 'dmqBufferSize'
      ? getDmqBufferMaxLevel(node.upgrades['dmqWidth'] ?? 0)
      : def.maxLevel;
    let bought = 0;
    while (true) {
      if (effectiveMax && level >= effectiveMax) break;
      const cost = getUpgradeCost(def, level, costReduction);
      if (useGameStore.getState().balance < cost) break;
      if (!spend(cost)) break;
      upgradeComponent(node.id, def.key);
      level++;
      bought++;
      if (bought > 100) break; // safety cap
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key={node.id}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute rounded-lg border border-gray-700 p-3 shadow-xl"
        style={{
          left: modalX,
          top: modalY,
          zIndex: 30,
          background: '#111827',
          width: 360,
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-bold text-gray-200">{node.label}</span>
          <button
            onClick={() => selectNode(null)}
            className="text-gray-500 hover:text-gray-200 text-sm cursor-pointer"
          >
            x
          </button>
        </div>
        {node.type === 'queue' && (() => {
          const topics = getAvailableTopics(node.id);
          if (topics.length === 0) return null;
          return (
          <div className="mb-2">
            <div className="text-[10px] text-gray-400 mb-0.5">Subscription</div>
            {node.subscriptionTopic && (
            <div className="text-xs font-mono text-amber-300 truncate" title={node.subscriptionTopic}>
              {node.subscriptionTopic}
            </div>
            )}
            {(() => {
              if (topics.length <= 1 && node.subscriptionTopic) return null;
              return topicPickerOpen ? (
                <div className="mt-1 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                  {topics.map(t => (
                    <button
                      key={t.topic}
                      onClick={() => {
                        if (t.topic !== node.subscriptionTopic) {
                          setQueueSubscription(node.id, t.topic, t.segments, t.broadenLevel);
                        }
                        setTopicPickerOpen(false);
                      }}
                      className="text-left text-[10px] font-mono px-1.5 py-1 rounded border transition-colors cursor-pointer"
                      style={{
                        borderColor: t.topic === node.subscriptionTopic ? '#f59e0b' : '#374151',
                        background: t.topic === node.subscriptionTopic ? '#78350f33' : '#1f293744',
                        color: t.topic === node.subscriptionTopic ? '#fbbf24' : '#9ca3af',
                      }}
                    >
                      {t.topic}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  onClick={() => setTopicPickerOpen(true)}
                  className="mt-1 text-[10px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
                >
                  Change Queue Subscription
                </button>
              );
            })()}
          </div>
          );
        })()}
        <div className="flex flex-col gap-1.5">
          {upgrades.map(def => {
            const level = node.upgrades[def.key] ?? 0;
            const effectiveMax = def.key === 'dmqBufferSize'
              ? getDmqBufferMaxLevel(node.upgrades['dmqWidth'] ?? 0)
              : def.maxLevel;
            const maxed = effectiveMax ? level >= effectiveMax : false;
            const widthCapped = def.key === 'dmqBufferSize' && maxed;
            const cost = getUpgradeCost(def, level, costReduction);
            const canAfford = balance >= cost;

            const showMaxBtn = !maxed && canAfford && effectiveMax !== 1;
            let maxBuyCount = 0;
            if (showMaxBtn) {
              let lvl = level;
              let bal = balance;
              while ((!effectiveMax || lvl < effectiveMax) && maxBuyCount < 100) {
                const c = getUpgradeCost(def, lvl, costReduction);
                if (bal < c) break;
                bal -= c;
                lvl++;
                maxBuyCount++;
              }
            }

            return (
              <button
                key={def.key}
                onClick={() => handleUpgrade(def)}
                disabled={maxed || !canAfford}
                className="text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: maxed ? '#374151' : canAfford ? '#4ade80' : '#6b7280',
                  background: maxed ? '#1f2937' : canAfford ? '#064e3b22' : '#1f293744',
                  color: maxed ? '#6b7280' : canAfford ? '#d1fae5' : '#9ca3af',
                }}
              >
                <div className="flex justify-between items-center">
                  <span className="font-bold">
                    {def.label}
                    {['fasterConsumption', 'publishSpeed'].includes(def.key) && level > 0 && ` (${Math.min(level * (level + 9) / 2, 100)}%)`}
                    {def.key === 'eventValue' && level > 0 && ` ($${(1.0 + level * 0.45 + level * level * 0.05).toFixed(2)})`}
                    {def.key === 'consumptionValue' && level > 0 && ` (${(1.0 + level * 0.08 + level * level * 0.02).toFixed(2)}x)`}
                    {def.key === 'increaseThroughput' && ` (${8 + level * (level + 9) / 2}/sec)`}
                  </span>
                  {!maxed && <span className="text-[10px] opacity-50">Lv {level}</span>}
                </div>
                <div className="opacity-70">{def.description}</div>
                {!maxed && def.key === 'subscriptionBroaden' && node.subscriptionSegments ? (
                  <div className="text-xs text-amber-300 mt-0.5 font-mono">
                    {computeBroadenedTopic(node.subscriptionSegments, level)} → {computeBroadenedTopic(node.subscriptionSegments, level + 1)}
                  </div>
                ) : !maxed && (
                  <div className="text-xs text-blue-300 mt-0.5">{getUpgradeValueDisplay(def.key, level, node.topic)}</div>
                )}
                <div className="mt-0.5 flex items-center justify-between">
                  <span>{maxed ? 'MAX' : formatMoney(cost)}</span>
                  {showMaxBtn && (
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); handleBuyMax(def); }}
                      className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-emerald-500/50 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-800/40 transition-colors"
                    >
                      MAX ×{maxBuyCount}
                    </span>
                  )}
                </div>
                {widthCapped && (
                  <div className="text-[10px] text-amber-400 mt-0.5">Increase Width to unlock more capacity</div>
                )}
              </button>
            );
          })}
        </div>
        {!['pub-1', 'webhook-1', 'sub-1'].includes(node.id) && (
          <button
            onClick={() => { removeComponent(node.id); selectNode(null); }}
            className="mt-2 w-full px-2 py-1.5 rounded text-xs border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" />
            </svg>
            Delete {node.label}
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
