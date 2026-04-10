import { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { type GameComponent, useGameStore, getPermanentQueueBufferBonus } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';
import { getBrokerUtilization } from '../hooks/useGameLoop';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  dmqUpgrades,
  getUpgradeCost,
  getDmqBufferMaxLevel,
  getDmqSlotsPerRow,
} from '../store/upgradeConfig';
import { canConnect } from '../utils/connectionRules';
import { useViewport } from '../hooks/useViewport';

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
  const costReduction = useGameStore(s => {
    const p = s.prestige.permanentUpgradeLevels;
    const permCost = (p['globalCostRed'] ?? 0) > 0 ? 0.10 : 0;
    return s.upgrades.costReduction + permCost;
  });
  const moveComponent = useGameStore(s => s.moveComponent);
  const eventDots = useGameStore(s => s.eventDots);
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const startDragConnection = useGameStore(s => s.startDragConnection);
  const setDraggingNodeId = useGameStore(s => s.setDraggingNodeId);
  const viewport = useViewport();

  // Subscribe to viewport changes for screen-space positioning
  const vpSnap = useSyncExternalStore(viewport.subscribe, () => {
    const v = viewport.ref.current;
    return `${v.panX},${v.panY},${v.zoom}`;
  });
  const zoom = viewport.ref.current.zoom;

  const colors = typeColors[component.type] ?? typeColors.publisher;
  const isSelected = selectedNodeId === component.id;
  const isPublisher = component.type === 'publisher';
  const isSubscriber = component.type === 'subscriber';

  // Drag state
  const [cursorGrabbing, setCursorGrabbing] = useState(false);
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const nodeStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);
  const pendingMove = useRef({ x: 0, y: 0 });
  const moveRaf = useRef(0);

  // Publisher cooldown overlay
  const publisherCooldowns = useGameStore(s => s.publisherCooldowns);
  const [cooldownPct, setCooldownPct] = useState(0);
  const cooldownRaf = useRef<number>(0);

  useEffect(() => {
    if (!isPublisher) return;
    const lastFire = publisherCooldowns[component.id] ?? 0;
    if (lastFire === 0) return;

    const publishSpeedLevel = component.upgrades['publishSpeed'] ?? 0;
    if (publishSpeedLevel >= 10) {
      setCooldownPct(0);
      return;
    }
    const publishBoostPct = publishSpeedLevel * (publishSpeedLevel + 9) / 2;
    const duration = 1000 * (1 - publishBoostPct / 100);

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

  // Subscriber consume cooldown overlay
  const [subscriberCooldownPct, setSubscriberCooldownPct] = useState(0);
  const subscriberCooldownRaf = useRef<number>(0);
  const subscriberConsumeStart = useRef<number>(0);
  const subscriberConsumeDuration = useRef<number>(0);

  useEffect(() => {
    if (!isSubscriber) return;
    const fasterConsumptionLevel = component.upgrades['fasterConsumption'] ?? 0;
    if (fasterConsumptionLevel >= 11) {
      setSubscriberCooldownPct(0);
      return;
    }

    const tick = () => {
      const now = Date.now();
      const dots = useGameStore.getState().eventDots;
      const pausingDot = dots.find(d =>
        d.status === 'pausing' && d.pauseStartTime &&
        Math.hypot(
          (d.path[d.path.length - 1]?.x ?? 0) - component.x,
          (d.path[d.path.length - 1]?.y ?? 0) - component.y
        ) < 50
      );

      // Latch start time when a new consuming dot appears
      if (pausingDot && pausingDot.pauseStartTime && subscriberConsumeStart.current !== pausingDot.pauseStartTime) {
        subscriberConsumeStart.current = pausingDot.pauseStartTime;
        const fasterConsumptionLevel = component.upgrades['fasterConsumption'] ?? 0;
        const boostPct = Math.min(fasterConsumptionLevel * (fasterConsumptionLevel + 9) / 2, 100);
        subscriberConsumeDuration.current = 1000 * (1 - boostPct / 100);
      }

      // Animate based on latched start/duration (continues even after dot is removed)
      if (subscriberConsumeStart.current > 0) {
        const elapsed = now - subscriberConsumeStart.current;
        const remaining = Math.max(0, 1 - elapsed / subscriberConsumeDuration.current);
        setSubscriberCooldownPct(remaining);
        if (remaining <= 0) {
          subscriberConsumeStart.current = 0;
        }
      }

      subscriberCooldownRaf.current = requestAnimationFrame(tick);
    };

    subscriberCooldownRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(subscriberCooldownRaf.current);
  }, [isSubscriber, component.x, component.y, component.upgrades]);

  // Count affordable upgrades
  const upgrades = getUpgradesForType(component.type).filter(d => !d.hidden && !(d.key === 'subscriptionBroaden' && !component.subscriptionTopic));
  const affordableUpgradeCount = upgrades.filter(def => {
    const level = component.upgrades[def.key] ?? 0;
    const effectiveMax = def.key === 'dmqBufferSize'
      ? getDmqBufferMaxLevel(component.upgrades['dmqWidth'] ?? 0)
      : def.maxLevel;
    if (effectiveMax && level >= effectiveMax) return false; // maxed out
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

  // Broker throughput utilization (0-1)
  const brokerUtilization = component.type === 'broker'
    ? getBrokerUtilization(component.id, 8 + (component.upgrades['increaseThroughput'] ?? 0) * ((component.upgrades['increaseThroughput'] ?? 0) + 9) / 2)
    : 0;

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
    const world = viewport.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    startDragConnection('create', component.id, undefined, world.x, world.y);
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

    const z = viewport.ref.current.zoom;
    pendingMove.current = { x: nodeStartPos.current.x + dx / z, y: nodeStartPos.current.y + dy / z };
    if (!moveRaf.current) {
      moveRaf.current = requestAnimationFrame(() => {
        moveComponent(component.id, pendingMove.current.x, pendingMove.current.y);
        moveRaf.current = 0;
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setCursorGrabbing(false);
    // Flush any pending move before clearing drag state
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveComponent(component.id, pendingMove.current.x, pendingMove.current.y);
      moveRaf.current = 0;
    }
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

  const screen = viewport.worldToScreen(component.x, component.y);
  const halfW = isDmq ? dmqNodeWidth / 2 : 60;

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="absolute flex flex-col items-center gap-1"
      style={{
        left: screen.x - halfW * zoom,
        top: screen.y - 28 * zoom,
        zIndex: cursorGrabbing ? 50 : (isPublisher ? 30 : (component.type === 'subscriber' ? 20 : 26)),
        cursor: cursorGrabbing ? 'grabbing' : 'grab',
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}
    >
      <div className="relative" style={{ width: isDmq ? dmqNodeWidth : 120 }}>
      <button
        onClick={handleUpgradeClick}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute px-1.5 py-0.5 rounded-t cursor-pointer"
        style={{
          top: -16,
          right: 8,
          zIndex: affordableUpgradeCount > 0 ? 1 : -1,
          borderTop: `1px solid ${affordableUpgradeCount > 0 ? colors.border : '#374151'}`,
          borderLeft: `1px solid ${affordableUpgradeCount > 0 ? colors.border : '#374151'}`,
          borderRight: `1px solid ${affordableUpgradeCount > 0 ? colors.border : '#374151'}`,
          borderBottom: 'none',
          background: affordableUpgradeCount > 0 ? `${colors.border}15` : '#1f2937',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={affordableUpgradeCount > 0 ? colors.border : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 8L6 4L10 8" />
        </svg>
      </button>
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
          width: isDmq ? dmqNodeWidth : 120,
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
        {/* Cooldown overlay for subscriber (consuming) */}
        {isSubscriber && subscriberCooldownPct > 0 && (
          <div
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{
              background: 'rgba(0, 0, 0, 0.35)',
              clipPath: `inset(${(1 - subscriberCooldownPct) * 100}% 0 0 0)`,
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
        <div>{component.label}</div>
        {component.type === 'broker' && (
          <div className="w-full mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#1e293b' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(brokerUtilization * 100, 100)}%`,
                background: brokerUtilization > 0.9 ? '#ef4444' : brokerUtilization > 0.7 ? '#f59e0b' : '#22c55e',
              }}
            />
          </div>
        )}
        {isPublisher && (
          <div className="text-[10px] opacity-60">(click to fire)</div>
        )}
        {isDmq && (
          <div className="flex flex-col gap-1 mt-1 items-center">
            {(() => {
              const capacity = 3 + (component.upgrades['dmqBufferSize'] ?? 0);
              const queuedDots = eventDots
                .filter(d => d.status === 'queued' && d.queuedAtNodeId === component.id)
                .sort((a, b) => (a.pauseStartTime ?? 0) - (b.pauseStartTime ?? 0));
              const emptyCount = capacity - queuedDots.length;
              const slotsPerRow = getDmqSlotsPerRow(component.upgrades['dmqWidth'] ?? 0);
              const slots = Array.from({ length: capacity }).map((_, i) => {
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
              const rows: typeof slots[] = [];
              for (let i = 0; i < slots.length; i += slotsPerRow) {
                rows.push(slots.slice(i, i + slotsPerRow));
              }
              return rows.map((row, ri) => (
                <div key={ri} className="flex gap-1.5">{row}</div>
              ));
            })()}
          </div>
        )}
        {component.type === 'queue' && (
          <div className="flex flex-col gap-1 mt-1 items-center">
            {(() => {
              const prestige = useGameStore.getState().prestige;
              const capacity = 3 + (component.upgrades['bufferSize'] ?? 0) + getPermanentQueueBufferBonus({ prestige });
              const queuedDots = eventDots
                .filter(d => d.status === 'queued' && d.queuedAtNodeId === component.id)
                .sort((a, b) => (a.pauseStartTime ?? 0) - (b.pauseStartTime ?? 0));
              const emptyCount = capacity - queuedDots.length;
              const slots = Array.from({ length: capacity }).map((_, i) => {
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
              // Wrap into rows of 10
              const rows: typeof slots[] = [];
              for (let i = 0; i < slots.length; i += 10) {
                rows.push(slots.slice(i, i + 10));
              }
              return rows.map((row, ri) => (
                <div key={ri} className="flex gap-1.5">{row}</div>
              ));
            })()}
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
      </div>
      {component.type === 'publisher' && component.topicSegments && (
        <div className="text-[8px] text-gray-500 font-mono text-center" style={{ maxWidth: 140, wordBreak: 'break-all' }}>
          {component.topicSegments.join('/')}
        </div>
      )}
      {component.type === 'queue' && component.subscriptionTopic && (
        <div className="text-[8px] font-mono text-center" style={{ maxWidth: 140, wordBreak: 'break-all' }}>
          {component.subscriptionTopic.split('/').map((seg, i, arr) => (
            <span key={i}>
              {i > 0 && <span className="text-gray-600">/</span>}
              <span style={{ color: seg === '*' || seg === '>' ? '#f59e0b' : '#6b7280' }}>{seg}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
