import { useGameStore } from '../store/gameStore';
import { AnimatePresence, motion } from 'framer-motion';
import { NodeCard } from './NodeCard';
import { NodeModal } from './NodeModal';
import { EventCanvas } from './EventCanvas';
import { formatMoney } from '../utils/formatMoney';

export function MeshCanvas() {
  const components = useGameStore(s => s.components);
  const connections = useGameStore(s => s.connections);
  const selectNode = useGameStore(s => s.selectNode);
  const coinPops = useGameStore(s => s.coinPops);
  const removeCoinPop = useGameStore(s => s.removeCoinPop);

  return (
    <div
      className="relative flex-1 overflow-hidden"
      style={{ background: '#0a0e1a' }}
      onClick={() => selectNode(null)}
    >
      {/* Connection lines */}
      <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 5 }}>
        {connections.map(conn => {
          const from = components.find(c => c.id === conn.fromId);
          const to = components.find(c => c.id === conn.toId);
          if (!from || !to) return null;
          return (
            <line
              key={conn.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="#334155"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          );
        })}
      </svg>

      {/* Event animation canvas */}
      <EventCanvas />

      {/* Node cards */}
      {components.map(comp => (
        <NodeCard key={comp.id} component={comp} />
      ))}

      {/* Coin pop animations */}
      <AnimatePresence>
        {coinPops.map(pop => (
          <motion.div
            key={pop.id}
            initial={{ opacity: 1, y: 0, scale: 0.5 }}
            animate={{ opacity: 0, y: -50, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1, ease: 'easeOut' }}
            onAnimationComplete={() => removeCoinPop(pop.id)}
            className="absolute pointer-events-none font-mono font-bold text-sm"
            style={{
              left: pop.x - 30,
              top: pop.y - 40,
              zIndex: 40,
              color: '#22c55e',
              textShadow: '0 0 8px rgba(34,197,94,0.6)',
            }}
          >
            🪙 +{formatMoney(pop.amount)}
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Upgrade modal */}
      <NodeModal />
    </div>
  );
}
