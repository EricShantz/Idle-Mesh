import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { type GameComponent, useGameStore } from '../store/gameStore';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  getUpgradeCost,
} from '../store/upgradeConfig';
import { canConnect } from '../utils/connectionRules';

function getUpgradesForType(type: string) {
  switch (type) {
    case 'publisher': return publisherUpgrades;
    case 'webhook': return webhookUpgrades;
    case 'broker': return brokerUpgrades;
    case 'queue': return queueUpgrades;
    case 'subscriber': return subscriberUpgrades;
    default: return [];
  }
}

const typeColors: Record<string, { border: string; bg: string; glow: string }> = {
  publisher: { border: '#22d3ee', bg: '#0e3a3e', glow: '0 0 12px rgba(34,211,238,0.4)' },
  webhook: { border: '#f59e0b', bg: '#3b2e0a', glow: '0 0 12px rgba(245,158,11,0.4)' },
  broker: { border: '#fb923c', bg: '#431407', glow: '0 0 12px rgba(251,146,60,0.5)' },
  queue: { border: '#a855f7', bg: '#2e1065', glow: '0 0 12px rgba(168,85,247,0.4)' },
  subscriber: { border: '#22c55e', bg: '#0a3b1e', glow: '0 0 12px rgba(34,197,94,0.4)' },
};

type Props = {
  component: GameComponent;
};

export function NodeCard({ component }: Props) {
  const fireEvent = useGameStore(s => s.fireEvent);
  const selectNode = useGameStore(s => s.selectNode);
  const selectedNodeId = useGameStore(s => s.selectedNodeId);
  const balance = useGameStore(s => s.balance);
  const costReduction = useGameStore(s => s.upgrades.costReduction);
  const moveComponent = useGameStore(s => s.moveComponent);
  const eventDots = useGameStore(s => s.eventDots);
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const startDragConnection = useGameStore(s => s.startDragConnection);

  const colors = typeColors[component.type] ?? typeColors.publisher;
  const isSelected = selectedNodeId === component.id;
  const isPublisher = component.type === 'publisher';

  // Drag state
  const [cursorGrabbing, setCursorGrabbing] = useState(false);
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const nodeStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  // Count affordable upgrades
  const upgrades = getUpgradesForType(component.type);
  const affordableUpgradeCount = upgrades.filter(def => {
    const level = component.upgrades[def.key] ?? 0;
    if (def.maxLevel && level >= def.maxLevel) return false; // maxed out
    const cost = getUpgradeCost(def, level, costReduction);
    return balance >= cost;
  }).length;


  // Connection port visibility
  const hasOutput = component.type !== 'subscriber';

  // Valid target highlighting during drag
  const isValidTarget = draggingConnection && component.type !== 'publisher'
    ? canConnect(
        useGameStore.getState().components.find(c => c.id === draggingConnection.fromId)?.type ?? 'publisher',
        component.type
      ) && component.id !== draggingConnection.fromId
    : false;

  const handleOutputPortDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.target as HTMLElement).closest('[data-mesh-container]')?.getBoundingClientRect()
      ?? (e.target as HTMLElement).getBoundingClientRect();
    startDragConnection('create', component.id, undefined, e.clientX - rect.left, e.clientY - rect.top);
  };

  const handleUpgradeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectNode(isSelected ? null : component.id);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();

    isDragging.current = true;
    hasMoved.current = false;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    nodeStartPos.current = { x: component.x, y: component.y };
    setCursorGrabbing(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;

    const dx = e.clientX - dragStartPos.current.x;
    const dy = e.clientY - dragStartPos.current.y;

    if (!hasMoved.current) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      hasMoved.current = true;
    }

    moveComponent(
      component.id,
      nodeStartPos.current.x + dx,
      nodeStartPos.current.y + dy
    );
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setCursorGrabbing(false);

    // Fire event if this was just a click (no drag)
    const wasClick = !hasMoved.current;
    hasMoved.current = false; // Reset for next interaction

    if (wasClick && isPublisher) {
      fireEvent(component.id);
    } else if (wasClick && !isPublisher) {
      selectNode(isSelected ? null : component.id);
    }
  };

  return (
    <motion.div
      layout={!cursorGrabbing}
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="absolute flex flex-col items-center gap-1"
      style={{
        left: component.x - 60,
        top: component.y - 28,
        zIndex: cursorGrabbing ? 50 : (isPublisher ? 30 : (component.type === 'subscriber' ? 20 : 26)),
        cursor: cursorGrabbing ? 'grabbing' : 'grab',
      }}
    >
      <motion.div
        whileHover={cursorGrabbing ? undefined : { scale: 1.05 }}
        whileTap={cursorGrabbing ? undefined : { scale: 0.95 }}
        className="px-4 py-2 rounded-lg font-mono text-sm select-none relative flex flex-col items-center"
        style={{
          border: `1.5px solid ${isValidTarget ? '#22d3ee' : colors.border}`,
          background: colors.bg,
          boxShadow: isValidTarget
            ? '0 0 16px rgba(34,211,238,0.6), 0 0 30px rgba(34,211,238,0.3)'
            : isSelected
              ? `${colors.glow}, 0 0 20px ${colors.border}44`
              : colors.glow,
          color: colors.border,
          cursor: cursorGrabbing ? 'grabbing' : (isPublisher ? 'pointer' : 'default'),
          width: component.type === 'queue' ? 140 : 120,
          minHeight: 56,
          textAlign: 'center',
          justifyContent: 'center',
          pointerEvents: cursorGrabbing ? 'none' : 'auto',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        <button
          onClick={handleUpgradeClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center rounded hover:bg-gray-600 text-xs"
          style={{ color: colors.border, fontSize: '10px' }}
          title="Upgrades"
        >
          ⚙
        </button>
        <div>{component.label}</div>
        {isPublisher && (
          <div className="text-[10px] opacity-60">(click to fire)</div>
        )}
        {component.type === 'queue' && (
          <div className="flex gap-1.5 mt-1">
            {Array.from({ length: 1 + (component.upgrades['bufferSize'] ?? 0) }).map((_, i) => {
              const queuedCount = eventDots.filter(d => d.status === 'queued' && d.queuedAtNodeId === component.id).length;
              return (
                <div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: i < queuedCount ? '#66ffff' : '#1e293b',
                  }}
                />
              );
            })}
          </div>
        )}
        {affordableUpgradeCount > 0 && (
          <div
            className="absolute -top-2 -right-2 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center"
          >
            {affordableUpgradeCount > 99 ? '99+' : affordableUpgradeCount}
          </div>
        )}
        {/* Output port for creating connections — Boomi-style arrow circle */}
        {hasOutput && (
          <div
            onPointerDown={handleOutputPortDown}
            className="absolute top-1/2 -right-6 w-4 h-4 rounded-full border flex items-center justify-center group/port"
            style={{
              transform: 'translateY(-50%)',
              cursor: 'crosshair',
              background: '#1e293b',
              borderColor: colors.border + '88',
              transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
            }}
            title="Drag to connect"
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = colors.border;
              e.currentTarget.style.background = colors.border + '22';
              e.currentTarget.style.boxShadow = `0 0 8px ${colors.border}66`;
              const path = e.currentTarget.querySelector('path');
              if (path) path.setAttribute('stroke', colors.border);
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = colors.border + '88';
              e.currentTarget.style.background = '#1e293b';
              e.currentTarget.style.boxShadow = 'none';
              const path = e.currentTarget.querySelector('path');
              if (path) path.setAttribute('stroke', '#94a3b8');
            }}
          >
            <svg width="8" height="8" viewBox="0 0 12 12" style={{ pointerEvents: 'none' }}>
              <path d="M3 2 L9 6 L3 10" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
      </motion.div>
      {component.topic && (
        <div className="text-[10px] text-gray-500 font-mono">
          {component.topic}
        </div>
      )}
    </motion.div>
  );
}
