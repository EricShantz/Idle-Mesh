import { useRef, useCallback, useEffect, useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { AnimatePresence, motion } from 'framer-motion';
import { NodeCard } from './NodeCard';
import { NodeModal } from './NodeModal';
import { EventCanvas } from './EventCanvas';
import { ConnectionLine } from './ConnectionLine';
import { formatMoney } from '../utils/formatMoney';
import { canConnect } from '../utils/connectionRules';
import { buildOrthogonalSvgPath, buildVerticalFirstSvgPath } from '../utils/orthogonalPath';
import { ViewportContext, useViewportApi } from '../hooks/useViewport';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function MeshCanvas() {
  const viewport = useViewportApi();

  return (
    <ViewportContext.Provider value={viewport}>
      <MeshCanvasInner viewport={viewport} />
    </ViewportContext.Provider>
  );
}

function MeshCanvasInner({ viewport }: { viewport: ReturnType<typeof useViewportApi> }) {
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
  const isPanning = useRef(false);
  const panDidMove = useRef(false);
  const spaceHeld = useRef(false);

  // Subscribe to viewport for SVG <g> transform and coin pops
  const [, forceRender] = useState(0);
  useEffect(() => {
    return viewport.subscribe(() => forceRender(c => c + 1));
  }, [viewport]);

  const vp = viewport.ref.current;

  // Wheel zoom — must use native listener for passive:false
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewport.ref.current;

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad or Ctrl/Cmd+scroll on mouse → zoom toward cursor
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldZoom = v.zoom;
        const newZoom = clamp(oldZoom * (1 - e.deltaY * 0.01), MIN_ZOOM, MAX_ZOOM);
        v.panX = mx - (mx - v.panX) * (newZoom / oldZoom);
        v.panY = my - (my - v.panY) * (newZoom / oldZoom);
        v.zoom = newZoom;
      } else {
        // Scroll / two-finger drag → pan
        v.panX -= e.deltaX;
        v.panY -= e.deltaY;
      }
      viewport.notify();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  // Space key for pan mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        spaceHeld.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld.current = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Pointer handlers for pan (left-click on empty space, middle-click, or space+left)
  // Nodes call e.stopPropagation() on pointerDown, so only empty-space clicks reach here
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      isPanning.current = true;
      panDidMove.current = false;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, []);

  const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      const v = viewport.ref.current;
      v.panX += e.movementX;
      v.panY += e.movementY;
      panDidMove.current = true;
      viewport.notify();
      return;
    }
    // Connection drag
    if (!draggingConnection) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const world = viewport.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    updateDragPosition(world.x, world.y);
  }, [draggingConnection, updateDragPosition, viewport]);

  const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      isPanning.current = false;
      return;
    }
    if (!draggingConnection) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const world = viewport.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const mx = world.x;
    const my = world.y;

    const from = components.find(c => c.id === draggingConnection.fromId);
    let bestTarget: string | null = null;
    let bestDist = Infinity;
    for (const comp of components) {
      if (comp.id === draggingConnection.fromId) continue;
      if (from && !canConnect(from.type, comp.type)) continue;
      const padX = 70;
      const padY = 38;
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
  }, [draggingConnection, components, completeDragConnection, cancelDragConnection, viewport]);

  const handleContainerClick = useCallback(() => {
    if (panDidMove.current) {
      panDidMove.current = false;
      return;
    }
    selectNode(null);
  }, [selectNode]);

  // Drag preview source position (world coords)
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
        dragFromY = fromComp.y - 28 - 16;
      }
    }
  }

  const svgTransform = `translate(${vp.panX},${vp.panY}) scale(${vp.zoom})`;

  return (
    <div
      ref={containerRef}
      data-mesh-container
      className="relative flex-1 overflow-hidden"
      style={{
        background: '#0a0e1a',
        cursor: isPanning.current || spaceHeld.current ? 'grab' : undefined,
      }}
      onClick={handleContainerClick}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
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

      {/* Connection lines — SVG in world coords */}
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
        <g transform={svgTransform}>
          {connections.map(conn => (
            <ConnectionLine key={conn.id} conn={conn} />
          ))}
          {/* Drag preview line (world coords) */}
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
        </g>
      </svg>

      {/* Event animation canvas */}
      <EventCanvas />

      {/* Node cards */}
      {components.map(comp => (
        <NodeCard key={comp.id} component={comp} />
      ))}

      {/* Coin pop animations */}
      <AnimatePresence>
        {coinPops.map(pop => {
          const screen = viewport.worldToScreen(pop.x, pop.y);
          return (
            <motion.div
              key={pop.id}
              initial={{ opacity: 1, y: 0, scale: 0.5 * vp.zoom }}
              animate={{ opacity: 0, y: -50 * vp.zoom, scale: vp.zoom }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1, ease: 'easeOut' }}
              onAnimationComplete={() => removeCoinPop(pop.id)}
              className="absolute pointer-events-none font-mono font-bold text-sm"
              style={{
                left: screen.x - 30 * vp.zoom,
                top: screen.y - 40 * vp.zoom,
                zIndex: 40,
                color: '#22c55e',
                textShadow: '0 0 8px rgba(34,197,94,0.6)',
                transformOrigin: 'top left',
              }}
            >
              🪙 +{formatMoney(pop.amount)}
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Upgrade modal */}
      <NodeModal />
    </div>
  );
}
