import { useGameStore } from '../store/gameStore';
import { NodeCard } from './NodeCard';
import { NodeModal } from './NodeModal';
import { EventCanvas } from './EventCanvas';

export function MeshCanvas() {
  const components = useGameStore(s => s.components);
  const connections = useGameStore(s => s.connections);
  const selectNode = useGameStore(s => s.selectNode);

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

      {/* Upgrade modal */}
      <NodeModal />
    </div>
  );
}
