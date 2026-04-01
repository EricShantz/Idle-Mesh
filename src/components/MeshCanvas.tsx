import { useRef, useCallback } from 'react';
import { useGameStore } from '../store/gameStore';
import { AnimatePresence, motion } from 'framer-motion';
import { NodeCard } from './NodeCard';
import { NodeModal } from './NodeModal';
import { EventCanvas } from './EventCanvas';
import { ConnectionLine } from './ConnectionLine';
import { formatMoney } from '../utils/formatMoney';
import { canConnect } from '../utils/connectionRules';
import { buildOrthogonalSvgPath, buildVerticalFirstSvgPath } from '../utils/orthogonalPath';

export function MeshCanvas() {
  const components = useGameStore(s => s.components);
  const connections = useGameStore(s => s.connections);
  const selectNode = useGameStore(s => s.selectNode);
  const coinPops = useGameStore(s => s.coinPops);
  const removeCoinPop = useGameStore(s => s.removeCoinPop);
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const meshError = useGameStore(s => s.meshError);
  const updateDragPosition = useGameStore(s => s.updateDragPosition);
  const completeDragConnection = useGameStore(s => s.completeDragConnection);
  const cancelDragConnection = useGameStore(s => s.cancelDragConnection);

  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingConnection) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateDragPosition(e.clientX - rect.left, e.clientY - rect.top);
  }, [draggingConnection, updateDragPosition]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingConnection) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Find nearest valid target — use node bounding box (60px half-width, 28px half-height) + padding
    const from = components.find(c => c.id === draggingConnection.fromId);
    let bestTarget: string | null = null;
    let bestDist = Infinity;
    for (const comp of components) {
      if (comp.id === draggingConnection.fromId) continue;
      if (from && !canConnect(from.type, comp.type)) continue;
      // Check if mouse is within the node's bounding box + 10px padding
      const padX = 70; // 60 half-width + 10 padding
      const padY = 38; // 28 half-height + 10 padding
      if (Math.abs(mx - comp.x) <= padX && Math.abs(my - comp.y) <= padY) {
        const dist = Math.hypot(mx - comp.x, my - comp.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestTarget = comp.id;
        }
      }
    }

    if (bestTarget) {
      completeDragConnection(bestTarget);
    } else {
      cancelDragConnection();
    }
  }, [draggingConnection, components, completeDragConnection, cancelDragConnection]);

  // Compute drag preview source position
  let dragFromX = 0;
  let dragFromY = 0;
  let dragFromIsDmq = false;
  if (draggingConnection) {
    const fromComp = components.find(c => c.id === draggingConnection.fromId);
    if (fromComp) {
      dragFromX = fromComp.x;
      dragFromY = fromComp.y;
      dragFromIsDmq = fromComp.type === 'dmq';
      if (dragFromIsDmq) {
        dragFromY = fromComp.y - 28 - 16; // top-center port
      }
    }
  }

  return (
    <div
      ref={containerRef}
      data-mesh-container
      className="relative flex-1 overflow-hidden"
      style={{ background: '#0a0e1a' }}
      onClick={() => selectNode(null)}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Mesh error toast */}
      <AnimatePresence>
        {meshError && (
          <motion.div
            key={meshError}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            onAnimationComplete={(def: { opacity?: number }) => {
              if (def.opacity === 1) {
                setTimeout(() => useGameStore.setState({ meshError: null }), 2500);
              }
            }}
            className="absolute top-3 left-3 px-3 py-2 rounded text-xs font-semibold"
            style={{ zIndex: 50, background: '#7f1d1dee', color: '#fecaca', border: '1px solid #ef4444' }}
          >
            {meshError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connection lines */}
      <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 5 }}>
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#334155" />
          </marker>
          <marker
            id="arrowhead-drag"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#22d3ee" />
          </marker>
        </defs>
        {connections.map(conn => (
          <ConnectionLine key={conn.id} conn={conn} />
        ))}
        {/* Drag preview line */}
        {draggingConnection && (
          <path
            d={dragFromIsDmq
              ? buildVerticalFirstSvgPath(dragFromX, dragFromY, draggingConnection.mouseX, draggingConnection.mouseY)
              : buildOrthogonalSvgPath(dragFromX, dragFromY, draggingConnection.mouseX, draggingConnection.mouseY)}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={1.5}
            strokeDasharray="6 3"
            strokeOpacity={0.7}
            markerEnd="url(#arrowhead-drag)"
            pointerEvents="none"
          />
        )}
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
