import { useRef, useEffect, useState, useCallback } from 'react';
import { useGameStore } from '../store/gameStore';
import { prestigeNodes, isNodePurchased, isNodeAvailable } from '../store/prestigeUpgradeConfig';
import { ViewportContext, useViewportApi } from '../hooks/useViewport';

const GRID_SPACING = 160;
const NODE_SIZE = 80;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }

function getNodeIcon(key: string): string {
  if (key === 'income') return '$';
  if (key.startsWith('speed')) return '\u26A1';
  if (key === 'batchStart') return '\u2728';
  if (key.startsWith('autoPub')) return '\u2699';
  if (key === 'pubSpeed') return '\u{1F680}';
  if (key.startsWith('costRed')) return '\u{1F3F7}';
  if (key === 'shopDiscount') return '\u{1F6D2}';
  if (key.startsWith('value')) return '\u{1F4B0}';
  if (key === 'subValue') return '\u{1F4B5}';
  if (key === 'queueStart') return '\u{1F4E6}';
  if (key === 'consumeSpeed') return '\u{23E9}';
  return '?';
}

export function PrestigeTreePage() {
  const viewport = useViewportApi();

  return (
    <ViewportContext.Provider value={viewport}>
      <PrestigeTreeInner viewport={viewport} />
    </ViewportContext.Provider>
  );
}

function PrestigeTreeInner({ viewport }: { viewport: ReturnType<typeof useViewportApi> }) {
  const prestige = useGameStore(s => s.prestige);
  const purchasePrestigeUpgrade = useGameStore(s => s.purchasePrestigeUpgrade);
  const setShowPrestigeTree = useGameStore(s => s.setShowPrestigeTree);
  const purchased = prestige.permanentUpgradeLevels;

  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const spaceHeld = useRef(false);

  // Subscribe to viewport changes for re-render
  const [, forceRender] = useState(0);
  useEffect(() => {
    return viewport.subscribe(() => forceRender(c => c + 1));
  }, [viewport]);

  // Center the tree on mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const v = viewport.ref.current;
    v.panX = rect.width / 2;
    v.panY = rect.height / 2;
    viewport.notify();
  }, [viewport]);

  // Wheel zoom — native listener for passive:false
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewport.ref.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldZoom = v.zoom;
        const newZoom = clamp(oldZoom * (1 - e.deltaY * 0.01), MIN_ZOOM, MAX_ZOOM);
        v.panX = mx - (mx - v.panX) * (newZoom / oldZoom);
        v.panY = my - (my - v.panY) * (newZoom / oldZoom);
        v.zoom = newZoom;
      } else {
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
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); spaceHeld.current = true; }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  // Pointer handlers for pan
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 0 || e.button === 1) {
      isPanning.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    const v = viewport.ref.current;
    v.panX += e.movementX;
    v.panY += e.movementY;
    viewport.notify();
  }, [viewport]);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const vp = viewport.ref.current;

  return (
    <div className="w-screen h-screen flex flex-col" style={{ background: '#0a0e1a' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 z-10" style={{ background: '#0a0e1a' }}>
        <div>
          <h1 className="text-lg font-bold text-amber-400">Schema Registry</h1>
          <span className="text-sm text-gray-400">
            Prestige Points: <span className="text-amber-400 font-mono">{prestige.points}</span>
            {prestige.count > 0 && (
              <span className="ml-3 text-gray-500">Prestige #{prestige.count}</span>
            )}
          </span>
        </div>
        <button
          onClick={() => setShowPrestigeTree(false)}
          className="px-4 py-2 rounded text-sm font-bold border border-gray-600 text-gray-300 hover:border-cyan-400 hover:text-cyan-400 transition-colors cursor-pointer"
        >
          Return to Mesh
        </button>
      </div>

      {/* Tree canvas */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* SVG connection lines — single transform group */}
        <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
          <g transform={`translate(${vp.panX},${vp.panY}) scale(${vp.zoom})`}>
            {prestigeNodes.map(n => {
              if (!n.requires) return null;
              const parent = prestigeNodes.find(p => p.key === n.requires);
              if (!parent) return null;

              const parentOwned = isNodePurchased(parent.key, purchased);
              const childOwned = isNodePurchased(n.key, purchased);
              const lineColor = childOwned ? '#f59e0b' : parentOwned ? '#f59e0b88' : '#374151';

              return (
                <line
                  key={`line-${n.key}`}
                  x1={parent.position.x * GRID_SPACING}
                  y1={parent.position.y * GRID_SPACING}
                  x2={n.position.x * GRID_SPACING}
                  y2={n.position.y * GRID_SPACING}
                  stroke={lineColor}
                  strokeWidth={(childOwned ? 2.5 : 2) / vp.zoom}
                  strokeDasharray={parentOwned ? 'none' : `${6 / vp.zoom} ${4 / vp.zoom}`}
                />
              );
            })}
          </g>
        </svg>

        {/* Node cards — positioned via worldToScreen, scaled via CSS transform */}
        {prestigeNodes.map(n => {
          const screen = viewport.worldToScreen(
            n.position.x * GRID_SPACING,
            n.position.y * GRID_SPACING,
          );
          const isPurchasedNode = isNodePurchased(n.key, purchased);
          const available = isNodeAvailable(n, purchased);
          const canAfford = available && prestige.points >= n.cost;
          const locked = !isPurchasedNode && !available;

          let borderColor = '#374151';
          let bgColor = '#111827';
          let textColor = '#6b7280';
          let glowStyle = {};

          if (isPurchasedNode) {
            borderColor = '#f59e0b';
            bgColor = '#78350f';
            textColor = '#fef3c7';
            glowStyle = { boxShadow: '0 0 12px #f59e0b44' };
          } else if (canAfford) {
            borderColor = '#f59e0b';
            bgColor = '#1c1307';
            textColor = '#fef3c7';
            glowStyle = { boxShadow: '0 0 8px #f59e0b33' };
          } else if (available) {
            borderColor = '#92400e';
            bgColor = '#1c1307';
            textColor = '#d97706';
          }

          return (
            <button
              key={n.key}
              onClick={(e) => {
                e.stopPropagation();
                if (available && canAfford) purchasePrestigeUpgrade(n.key);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={isPurchasedNode || locked || !canAfford}
              className="absolute flex flex-col items-center justify-center rounded-lg border-2 transition-colors duration-200 cursor-pointer disabled:cursor-default select-none"
              style={{
                left: screen.x,
                top: screen.y,
                width: NODE_SIZE,
                height: NODE_SIZE,
                transform: `translate(-50%, -50%) scale(${vp.zoom})`,
                transformOrigin: 'center center',
                borderColor,
                background: bgColor,
                color: textColor,
                ...glowStyle,
              }}
              title={`${n.label}\n${n.description}\nCost: ${n.cost} pts`}
            >
              <span className="text-xl leading-none mb-0.5">
                {locked ? '\u{1F512}' : isPurchasedNode ? '\u2713' : getNodeIcon(n.key)}
              </span>
              <span className="text-[9px] font-bold leading-tight text-center px-1 truncate w-full">
                {n.label}
              </span>
              {!isPurchasedNode && !locked && (
                <span className="text-[8px] font-mono opacity-70 mt-0.5">
                  {n.cost} pt{n.cost !== 1 ? 's' : ''}
                </span>
              )}
              {isPurchasedNode && (
                <span className="text-[8px] font-mono opacity-70 mt-0.5">Owned</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
