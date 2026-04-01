import { useState, useRef, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { type GameComponent, useGameStore } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  dmqUpgrades,
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
    case 'dmq': return dmqUpgrades;
    default: return [];
  }
}

const typeColors: Record<string, { border: string; bg: string; glow: string }> = {
  publisher: { border: '#22d3ee', bg: '#0e3a3e', glow: '0 0 12px rgba(34,211,238,0.4)' },
  webhook: { border: '#f59e0b', bg: '#3b2e0a', glow: '0 0 12px rgba(245,158,11,0.4)' },
  broker: { border: '#fb923c', bg: '#431407', glow: '0 0 12px rgba(251,146,60,0.5)' },
  queue: { border: '#a855f7', bg: '#2e1065', glow: '0 0 12px rgba(168,85,247,0.4)' },
  subscriber: { border: '#22c55e', bg: '#0a3b1e', glow: '0 0 12px rgba(34,197,94,0.4)' },
  dmq: { border: '#ef4444', bg: '#2a0a0a', glow: '0 0 12px rgba(239,68,68,0.4)' },
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
  const setDraggingNodeId = useGameStore(s => s.setDraggingNodeId);

  const colors = typeColors[component.type] ?? typeColors.publisher;
  const isSelected = selectedNodeId === component.id;
  const isPublisher = component.type === 'publisher';

  // Drag state
  const [cursorGrabbing, setCursorGrabbing] = useState(false);
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const nodeStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  // Publisher cooldown overlay
  const publisherCooldowns = useGameStore(s => s.publisherCooldowns);
  const [cooldownPct, setCooldownPct] = useState(0);
  const cooldownRaf = useRef<number>(0);

  useEffect(() => {
    if (!isPublisher) return;
    const lastFire = publisherCooldowns[component.id] ?? 0;
    if (lastFire === 0) return;

    const publishSpeedLevel = component.upgrades['publishSpeed'] ?? 0;
    const duration = 1000 * Math.pow(0.95, publishSpeedLevel);

    const tick = () => {
      const elapsed = Date.now() - lastFire;
      const remaining = Math.max(0, 1 - elapsed / duration);
      setCooldownPct(remaining);
      if (remaining > 0) {
        cooldownRaf.current = requestAnimationFrame(tick);
      }
    };
    cooldownRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(cooldownRaf.current);
  }, [isPublisher, publisherCooldowns[component.id], component.upgrades]);

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
  const isDmq = component.type === 'dmq';
  const dmqWidthLevel = isDmq ? (component.upgrades['dmqWidth'] ?? 0) : 0;
  const dmqNodeWidth = 120 + dmqWidthLevel * 40;

  // Valid target highlighting during drag
  const isValidTarget = draggingConnection && component.type !== 'publisher'
    ? canConnect(
        useGameStore.getState().components.find(c => c.id === draggingConnection.fromId)?.type ?? 'publisher',
        component.type
      ) && component.id !== draggingConnection.fromId
    : false;

  // Compute dot's normalized x-position through this webhook/broker (0→1), or -1 if none
  const isWebhookOrBroker = component.type === 'webhook' || component.type === 'broker';
  const isWebhook = component.type === 'webhook';
  const dotProgress = useMemo(() => {
    if (!isWebhook) return -1;
    const halfW = 60;
    const topOff = 28;
    const botOff = 28;
    const dotR = 6;
    let best = -1;
    for (const d of eventDots) {
      if (d.status !== 'traveling') continue;
      const pos = interpolatePath(d.path, d.progress);
      const left = component.x - halfW;
      const right = component.x + halfW;
      const top = component.y - topOff;
      const bottom = component.y + botOff;
      const cx = Math.max(left, Math.min(pos.x, right));
      const cy = Math.max(top, Math.min(pos.y, bottom));
      if (Math.hypot(pos.x - cx, pos.y - cy) <= dotR) {
        const t = Math.max(0, Math.min(1, (pos.x - left) / (right - left)));
        if (t > best) best = t;
      }
    }
    return best;
  }, [isWebhook, component.x, component.y, eventDots]);

  // Imperative RAF-driven border animation synced to dot position
  const dotProgressRef = useRef(-1);
  const svgRef = useRef<SVGSVGElement>(null);
  const topPathRef = useRef<SVGPathElement>(null);
  const botPathRef = useRef<SVGPathElement>(null);
  const borderRaf = useRef<number>(0);
  const displayedProgress = useRef(0);
  const currentOpacity = useRef(0);
  const graceTicks = useRef(0); // hold animation for N frames after dot exits

  dotProgressRef.current = dotProgress;

  useEffect(() => {
    if (!isWebhook) return;

    // Set initial values imperatively so React never manages these properties
    if (svgRef.current) svgRef.current.style.opacity = '0';
    if (topPathRef.current) topPathRef.current.style.strokeDashoffset = '35';
    if (botPathRef.current) botPathRef.current.style.strokeDashoffset = '35';

    const tick = () => {
      const dp = dotProgressRef.current;

      if (dp >= 0) {
        if (!graceTicks.current || displayedProgress.current > 1) {
          // New dot entering — fresh start (also reset if previous animation was finishing)
          displayedProgress.current = dp;
        } else {
          // Continuing current transit — only move forward
          displayedProgress.current = Math.max(displayedProgress.current, dp);
        }
        graceTicks.current = 1; // mark as active
        currentOpacity.current = 1;
      } else if (graceTicks.current && displayedProgress.current < 1.35) {
        // Dot exited — push progress to completion before fading
        displayedProgress.current = Math.min(1.35, displayedProgress.current + 0.12);
        currentOpacity.current = 1;
      } else if (currentOpacity.current > 0) {
        // Fade out
        currentOpacity.current = Math.max(0, currentOpacity.current - 0.12);
        if (currentOpacity.current === 0) {
          displayedProgress.current = 0;
          graceTicks.current = 0; // reset for next dot
        }
      }

      if (svgRef.current) {
        svgRef.current.style.opacity = String(currentOpacity.current);
      }
      // Map displayedProgress 0→1 to dashoffset 35→-65
      // At 35: dash (length 35) is just off the left end of path
      // At -65: dash is just off the right end of path
      const offset = 35 - displayedProgress.current * 100;
      if (topPathRef.current) topPathRef.current.style.strokeDashoffset = String(offset);
      if (botPathRef.current) botPathRef.current.style.strokeDashoffset = String(offset);

      borderRaf.current = requestAnimationFrame(tick);
    };
    borderRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(borderRaf.current);
  }, [isWebhook]);

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
      setDraggingNodeId(component.id);
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
    setDraggingNodeId(null);

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
        left: component.x - (isDmq ? dmqNodeWidth / 2 : 60),
        top: component.y - 28,
        zIndex: cursorGrabbing ? 50 : (isPublisher ? 30 : (component.type === 'subscriber' ? 20 : 26)),
        cursor: cursorGrabbing ? 'grabbing' : 'grab',
      }}
    >
      <motion.div
        whileHover={cursorGrabbing || !isPublisher ? undefined : { scale: 1.05 }}
        whileTap={cursorGrabbing || !isPublisher ? undefined : { scale: 0.95 }}
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
          width: isDmq ? dmqNodeWidth : component.type === 'queue' ? 140 : 120,
          minHeight: 56,
          textAlign: 'center',
          justifyContent: 'center',
          pointerEvents: cursorGrabbing ? 'none' : 'auto',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        {/* Cooldown overlay for publisher */}
        {isPublisher && cooldownPct > 0 && (
          <div
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{
              background: 'rgba(0, 0, 0, 0.35)',
              clipPath: `inset(${(1 - cooldownPct) * 100}% 0 0 0)`,
            }}
          />
        )}
        {/* Processing border animation for webhook/broker — RAF-driven, always mounted */}
        {isWebhook && (
          <svg
            ref={svgRef}
            className="absolute inset-0 pointer-events-none"
            width="100%"
            height="100%"
            style={{ overflow: 'visible' }}
          >
            <path
              ref={topPathRef}
              d="M 0,28 L 0,8 Q 0,0 8,0 L 112,0 Q 120,0 120,8 L 120,28"
              fill="none" stroke="#66ffff" strokeWidth="2" strokeLinecap="round"
              pathLength={100}
              style={{ strokeDasharray: '35 165', filter: 'drop-shadow(0 0 4px #66ffff)' }}
            />
            <path
              ref={botPathRef}
              d="M 0,28 L 0,48 Q 0,56 8,56 L 112,56 Q 120,56 120,48 L 120,28"
              fill="none" stroke="#66ffff" strokeWidth="2" strokeLinecap="round"
              pathLength={100}
              style={{ strokeDasharray: '35 165', filter: 'drop-shadow(0 0 4px #66ffff)' }}
            />
          </svg>
        )}
        <button
          onClick={handleUpgradeClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center rounded-md hover:bg-gray-600"
          style={{ color: colors.border, fontSize: '11px', border: `1px solid ${colors.border}88` }}
          title="Upgrades"
        >
          ↑
        </button>
        <div>{component.label}</div>
        {isPublisher && (
          <div className="text-[10px] opacity-60">(click to fire)</div>
        )}
        {isDmq && (
          <div className="flex gap-1.5 mt-1">
            {Array.from({ length: 1 + (component.upgrades['dmqBufferSize'] ?? 0) }).map((_, i) => {
              const queuedCount = eventDots.filter(d => d.status === 'queued' && d.queuedAtNodeId === component.id).length;
              return (
                <div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: i < queuedCount ? '#fb923c' : '#1e293b',
                  }}
                />
              );
            })}
          </div>
        )}
        {component.type === 'queue' && (
          <div className="flex gap-1.5 mt-1">
            {(() => {
              const capacity = 1 + (component.upgrades['bufferSize'] ?? 0);
              const queuedDots = eventDots
                .filter(d => d.status === 'queued' && d.queuedAtNodeId === component.id)
                .sort((a, b) => (a.pauseStartTime ?? 0) - (b.pauseStartTime ?? 0));
              // oldest first in array: [oldest, ..., newest]
              // Visual: empty slots on left, newest on leftmost filled, oldest on rightmost
              const emptyCount = capacity - queuedDots.length;
              return Array.from({ length: capacity }).map((_, i) => {
                const dot = i < emptyCount ? null : queuedDots[queuedDots.length - 1 - (i - emptyCount)];
                return (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: dot ? (dot.isRetry ? '#fb923c' : '#66ffff') : '#1e293b',
                    }}
                  />
                );
              });
            })()}
          </div>
        )}
        {affordableUpgradeCount > 0 && (
          <div
            className="absolute -top-2 -left-2 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center"
          >
            {affordableUpgradeCount > 99 ? '99+' : affordableUpgradeCount}
          </div>
        )}
        {/* Output port for creating connections — Boomi-style arrow circle */}
        {hasOutput && (
          <div
            onPointerDown={handleOutputPortDown}
            className={`absolute w-4 h-4 rounded-full border flex items-center justify-center group/port ${isDmq ? 'left-1/2 -top-6' : 'top-1/2 -right-6'}`}
            style={{
              transform: isDmq ? 'translateX(-50%)' : 'translateY(-50%)',
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
            <svg width="8" height="8" viewBox="0 0 12 12" style={{ pointerEvents: 'none', transform: isDmq ? 'rotate(-90deg)' : undefined }}>
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
