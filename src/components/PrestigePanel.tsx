import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { formatMoney } from '../utils/formatMoney';

export function PrestigePanel() {
  const totalEarned = useGameStore(s => s.totalEarned);
  const prestige = useGameStore(s => s.prestige);
  const performPrestige = useGameStore(s => s.performPrestige);
  const setShowPrestigeTree = useGameStore(s => s.setShowPrestigeTree);

  const [showConfirm, setShowConfirm] = useState(false);

  const canPrestige = totalEarned >= 1_000_000;
  const pointsToEarn = Math.floor(totalEarned / 1_000_000);

  const handlePrestige = () => {
    performPrestige();
    setShowConfirm(false);
  };

  return (
    <div>
      {/* Prestige stats */}
      <div className="grid grid-cols-2 gap-y-1 text-xs mb-2">
        <span className="text-gray-500">Prestige Points</span>
        <span className="text-amber-400 text-right font-mono">{prestige.points}</span>
        {prestige.count > 0 && (
          <>
            <span className="text-gray-500">Times Prestiged</span>
            <span className="text-gray-300 text-right">{prestige.count}</span>
          </>
        )}
      </div>

      {/* Prestige button */}
      <button
        onClick={() => setShowConfirm(true)}
        disabled={!canPrestige}
        className="w-full text-left px-2 py-1.5 rounded text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed mb-2"
        style={{
          borderColor: canPrestige ? '#f59e0b' : '#374151',
          background: canPrestige ? '#2a1a0522' : '#111827',
          color: canPrestige ? '#fef3c7' : '#6b7280',
        }}
      >
        <div className="font-bold">Register Schema</div>
        <div className="opacity-60">
          Reset all progress. Earn {pointsToEarn > 0 ? pointsToEarn : '0'} prestige point{pointsToEarn !== 1 ? 's' : ''}.
        </div>
        <div className="mt-0.5 font-mono text-[10px] opacity-50">
          Requires {formatMoney(1_000_000)} total earned
        </div>
      </button>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="mb-2 p-2 rounded border border-amber-500/50 bg-amber-950/30 text-xs">
          <div className="text-amber-200 font-bold mb-1">Register Schema?</div>
          <div className="text-gray-300 mb-2">
            You will earn <span className="text-amber-400 font-mono">{pointsToEarn}</span> prestige point{pointsToEarn !== 1 ? 's' : ''}.
            All progress will be reset.
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePrestige}
              className="flex-1 px-2 py-1 rounded text-xs font-bold cursor-pointer"
              style={{ background: '#f59e0b', color: '#1a0a00' }}
            >
              Confirm
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="flex-1 px-2 py-1 rounded text-xs border border-gray-600 text-gray-400 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* View Skill Tree button */}
      {prestige.count > 0 && (
        <button
          onClick={() => setShowPrestigeTree(true)}
          className="w-full px-2 py-1.5 rounded text-xs border border-amber-700 text-amber-400 hover:border-amber-500 transition-colors cursor-pointer"
          style={{ background: '#1c130722' }}
        >
          View Skill Tree
        </button>
      )}
    </div>
  );
}
