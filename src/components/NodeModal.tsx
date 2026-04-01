import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  dmqUpgrades,
  getUpgradeCost,
  type UpgradeDef,
} from '../store/upgradeConfig';
import { formatMoney } from '../utils/formatMoney';

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

function getUpgradeValueDisplay(upgradeKey: string, currentLevel: number): string {
  const nextLevel = currentLevel + 1;

  switch (upgradeKey) {
    // Buffer/slot upgrades
    case 'bufferSize':
    case 'addSubscriberSlot':
    case 'dmqBufferSize':
      return `${1 + currentLevel} → ${1 + nextLevel}`;

    // DMQ width
    case 'dmqWidth':
      return `${120 + currentLevel * 40}px → ${120 + nextLevel * 40}px`;

    // DMQ value recovery
    case 'dmqValueRecovery':
      return `${10 + currentLevel * 10}% → ${10 + nextLevel * 10}%`;

    // DMQ release speed
    case 'dmqReleaseSpeed': {
      const curPct = currentLevel * (currentLevel + 9) / 2;
      const nxtPct = nextLevel * (nextLevel + 9) / 2;
      return `${curPct}% → ${nxtPct}% (+${nxtPct - curPct}%)`;
    }

    // Value upgrades ($X.XX per unit)
    case 'eventValue': {
      const curVal = (0.5 + currentLevel * 0.45 + currentLevel * currentLevel * 0.05).toFixed(2);
      const nxtVal = (0.5 + nextLevel * 0.45 + nextLevel * nextLevel * 0.05).toFixed(2);
      const increment = (nextLevel * 0.45 + nextLevel * nextLevel * 0.05 - currentLevel * 0.45 - currentLevel * currentLevel * 0.05).toFixed(2);
      return `$${curVal} → $${nxtVal} (+$${increment})`;
    }
    case 'consumptionValue': {
      const curVal = (0.5 + currentLevel * 0.45 + currentLevel * currentLevel * 0.05).toFixed(2);
      const nxtVal = (0.5 + nextLevel * 0.45 + nextLevel * nextLevel * 0.05).toFixed(2);
      const increment = (nextLevel * 0.45 + nextLevel * nextLevel * 0.05 - currentLevel * 0.45 - currentLevel * currentLevel * 0.05).toFixed(2);
      return `$${curVal} → $${nxtVal} (+$${increment})`;
    }

    // Level-based percentage upgrades
    case 'fasterConsumption': {
      const currentPct = currentLevel * (currentLevel + 9) / 2;
      const nextPct = nextLevel * (nextLevel + 9) / 2;
      return `${currentPct}% → ${nextPct}% (+${nextPct - currentPct}%)`;
    }
    case 'publishSpeed': {
      const curPct = currentLevel * (currentLevel + 9) / 2;
      const nxtPct = nextLevel * (nextLevel + 9) / 2;
      return `${curPct}% → ${nxtPct}% (+${nxtPct - curPct}%)`;
    }
    case 'fasterRouting':
      return `${currentLevel * 20}% → ${nextLevel * 20}%`;

    // Queue slot upgrade
    case 'addQueueSlot':
      return `${1 + currentLevel} → ${1 + nextLevel}`;

    // One-time upgrades (no progression display)
    case 'upgradeToBroker':
    case 'fanOut':
    case 'topicFilterBoost':
      return 'One-time';

    default:
      return `Lv.${currentLevel} → Lv.${nextLevel}`;
  }
}

export function NodeModal() {
  const selectedNodeId = useGameStore(s => s.selectedNodeId);
  const components = useGameStore(s => s.components);
  const balance = useGameStore(s => s.balance);
  const costReduction = useGameStore(s => s.upgrades.costReduction);
  const spend = useGameStore(s => s.spend);
  const upgradeComponent = useGameStore(s => s.upgradeComponent);
  const selectNode = useGameStore(s => s.selectNode);

  const node = components.find(c => c.id === selectedNodeId);
  if (!node) return null;

  const upgrades = getUpgradesForType(node.type).filter(d => !d.hidden);
  if (upgrades.length === 0) return null;

  const modalX = node.x + 80;
  const modalY = node.y - 60;

  const handleUpgrade = (def: UpgradeDef) => {
    const level = node.upgrades[def.key] ?? 0;
    if (def.maxLevel && level >= def.maxLevel) return;
    const cost = getUpgradeCost(def, level, costReduction);
    if (spend(cost)) {
      upgradeComponent(node.id, def.key);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key={node.id}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="absolute rounded-lg border border-gray-700 p-3 shadow-xl"
        style={{
          left: modalX,
          top: modalY,
          zIndex: 30,
          background: '#111827',
          minWidth: 220,
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
        <div className="flex flex-col gap-1.5">
          {upgrades.map(def => {
            const level = node.upgrades[def.key] ?? 0;
            const maxed = def.maxLevel ? level >= def.maxLevel : false;
            const cost = getUpgradeCost(def, level, costReduction);
            const canAfford = balance >= cost;

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
                    {['fasterConsumption', 'publishSpeed', 'dmqReleaseSpeed'].includes(def.key) && level > 0 && ` (${level * (level + 9) / 2}%)`}
                    {['eventValue', 'consumptionValue'].includes(def.key) && level > 0 && ` ($${(0.5 + level * 0.45 + level * level * 0.05).toFixed(2)})`}
                  </span>
                  {!maxed && <span className="text-[10px] opacity-50">Lv {level}</span>}
                </div>
                <div className="opacity-70">{def.description}</div>
                {!maxed && <div className="text-xs text-blue-300 mt-0.5">{getUpgradeValueDisplay(def.key, level)}</div>}
                <div className="mt-0.5">
                  {maxed ? 'MAX' : formatMoney(cost)}
                </div>
              </button>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
