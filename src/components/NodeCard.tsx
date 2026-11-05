import { memo, useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { type GameComponent, type EventDot, useGameStore, getPermanentQueueBufferBonus, getPermanentBrokerThroughputMult } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';
import { getBrokerUtilization, getSubscriberConsume } from '../hooks/useGameLoop';
import {
  publisherUpgrades,
  webhookUpgrades,
  brokerUpgrades,
  queueUpgrades,
  subscriberUpgrades,
  dmqUpgrades,
  getEffectiveUpgradeCost,
  getEffectiveMaxLevel,
  isUpgradeVisible,
  getDmqSlotsPerRow,
  getClusterSlotCount,
  CLUSTER_HALF_W,
  CLUSTER_HALF_H,
  CLUSTER_SUBCARD_W,
  CLUSTER_SUBCARD_H,
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

const NO_DOTS: EventDot[] = [];

/** Oldest-first retry flags of the dots queued at a node: 'r' for a DMQ retry, 'n' otherwise.
 *  Everything the slot rows render is derived from this string, so a card only re-renders when
 *  the queue's contents actually change. */
function queuedSlotSignature(dots: EventDot[], nodeId: string): string {
  const queued: EventDot[] = [];
  for (const d of dots) if (d.status === 'queued' && d.queuedAtNodeId === nodeId) queued.push(d);
  if (queued.length === 0) return '';
  queued.sort((a, b) => (a.pauseStartTime ?? 0) - (b.pauseStartTime ?? 0));
  let sig = '';
  for (const d of queued) sig += d.isRetry ? 'r' : 'n';
  return sig;
}

/** Slot rows for a queue/DMQ card: `capacity` dots, empty ones first, then the queued dots
 *  newest-first (so the newest arrival fills the first occupied slot), wrapped `perRow` per row. */
function renderSlotRows(signature: string, capacity: number, perRow: number, colorFor: (flag: string) => string) {
  const emptyCount = capacity - signature.length;
  const slots = Array.from({ length: capacity }).map((_, i) => {
    const flag = i < emptyCount ? null : signature[signature.length - 1 - (i - emptyCount)];
    return (
      <div
        key={i}
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: flag ? colorFor(flag) : '#1e293b' }}
      />
    );
  });
  const rows: typeof slots[] = [];
  for (let i = 0; i < slots.length; i += perRow) {
    rows.push(slots.slice(i, i + perRow));
  }
  return rows.map((row, ri) => (
    <div key={ri} className="flex gap-1.5">{row}</div>
  ));
}

function NodeCardInner({ component }: Props) {
  const fireEvent = useGameStore(s => s.fireEvent);
  const selectNode = useGameStore(s => s.selectNode);
  const selectedNodeId = useGameStore(s => s.selectedNodeId);
  // Select the derived count rather than `balance` — balance changes every frame at any
  // real throughput, which would re-render every card every frame just to recompute this.
  const affordableUpgradeCount = useGameStore(s => {
    const p = s.prestige.permanentUpgradeLevels;
    const costReduction = s.upgrades.costReduction + ((p['globalCostRed'] ?? 0) > 0 ? 0.10 : 0);
    let count = 0;
    for (const def of getUpgradesForType(component.type)) {
      if (!isUpgradeVisible(def, component)) continue;
      const level = component.upgrades[def.key] ?? 0;
      const effectiveMax = getEffectiveMaxLevel(def, component.upgrades);
      if (effectiveMax && level >= effectiveMax) continue; // maxed out
      if (s.balance >= getEffectiveUpgradeCost(def, level, costReduction, component.upgrades)) count++;
    }
    return count;
  });
  const moveComponent = useGameStore(s => s.moveComponent);
  // Only the webhook (transit animation) renders from the live dot list itself. Queue and DMQ
  // cards show slot dots, which depend only on the ordered retry flags of the dots queued here,
  // so they select that small signature string instead — the dot array is a new reference
  // every frame, and selecting it re-rendered every queue card every frame.
  const eventDots = useGameStore(s => (component.type === 'webhook' ? s.eventDots : NO_DOTS));
  const slotSignature = useGameStore(s =>
    component.type === 'queue' || component.type === 'dmq' ? queuedSlotSignature(s.eventDots, component.id) : '');
  const draggingConnection = useGameStore(s => s.draggingConnection);
  const startDragConnection = useGameStore(s => s.startDragConnection);
  const setDraggingNodeId = useGameStore(s => s.setDraggingNodeId);
  const viewport = useViewport();

  // Subscribe to viewport changes for screen-space positioning
  useSyncExternalStore(viewport.subscribe, () => {
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

  // Publisher cooldown overlay — driven imperatively through a ref (like the webhook border
  // below). Going through React state meant one re-render of this card per frame for as long
  // as the cooldown ran, which for an auto-publisher is always.
  const lastFire = useGameStore(s => s.publisherCooldowns[component.id] ?? 0);
  const cooldownOverlayRef = useRef<HTMLDivElement>(null);
  const cooldownRaf = useRef<number>(0);

  useEffect(() => {
    if (!isPublisher) return;
    const el = cooldownOverlayRef.current;
    if (!el) return;
    if (lastFire === 0) return;

    const publishSpeedLevel = component.upgrades['publishSpeed'] ?? 0;
    if (publishSpeedLevel >= 10) {
      el.style.display = 'none';
      return;
    }
    const publishBoostPct = publishSpeedLevel * (publishSpeedLevel + 9) / 2;
    const duration = 1000 * (1 - publishBoostPct / 100);

    const tick = () => {
      const elapsed = Date.now() - lastFire;
      const remaining = Math.max(0, 1 - elapsed / duration);
      if (remaining > 0) {
        el.style.display = 'block';
        el.style.clipPath = `inset(${(1 - remaining) * 100}% 0 0 0)`;
        cooldownRaf.current = requestAnimationFrame(tick);
      } else {
        el.style.display = 'none';
      }
    };
    cooldownRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(cooldownRaf.current);
  }, [isPublisher, lastFire, component.upgrades]);

  // Subscriber consume cooldown overlay — same imperative pattern. The game loop records when
  // a dot starts consuming at each subscriber (getSubscriberConsume), so the card no longer
  // scans every live dot each frame to find the one pausing near it.
  const subscriberOverlayRef = useRef<HTMLDivElement>(null);
  const subscriberCooldownRaf = useRef<number>(0);
  const subscriberConsumeStart = useRef<number>(0);
  const subscriberConsumeDuration = useRef<number>(0);

  useEffect(() => {
    if (!isSubscriber) return;
    const el = subscriberOverlayRef.current;
    if (!el) return;
    const fasterConsumptionLevel = component.upgrades['fasterConsumption'] ?? 0;
    if (fasterConsumptionLevel >= 11) {
      el.style.display = 'none';
      return;
    }

    const tick = () => {
      const now = Date.now();
      const consume = getSubscriberConsume(component.id);

      // Latch start time when a new consuming dot appears
      if (consume && subscriberConsumeStart.current !== consume.start) {
        subscriberConsumeStart.current = consume.start;
        subscriberConsumeDuration.current = consume.duration;
      }

      // Animate based on latched start/duration (continues even after dot is removed)
      if (subscriberConsumeStart.current > 0) {
        const elapsed = now - subscriberConsumeStart.current;
        const remaining = Math.max(0, 1 - elapsed / subscriberConsumeDuration.current);
        if (remaining > 0) {
          el.style.display = 'block';
          el.style.clipPath = `inset(${(1 - remaining) * 100}% 0 0 0)`;
        } else {
          el.style.display = 'none';
          subscriberConsumeStart.current = 0;
        }
      }

      subscriberCooldownRaf.current = requestAnimationFrame(tick);
    };

    subscriberCooldownRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(subscriberCooldownRaf.current);
  }, [isSubscriber, component.id, component.upgrades]);


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
  const brokerThroughputMult = useGameStore(s => getPermanentBrokerThroughputMult(s));
  const clusterSlots = getClusterSlotCount(component.upgrades);
  const isCluster = component.type === 'broker' && clusterSlots > 1;
  const brokerUtilization = component.type === 'broker'
    ? getBrokerUtilization(component.id, (8 + (component.upgrades['increaseThroughput'] ?? 0) * ((component.upgrades['increaseThroughput'] ?? 0) + 9) / 2) * brokerThroughputMult * clusterSlots)
    : 0;

  // Compute dot's normalized x-position through this webhook/broker (0→1), or -1 if none
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

  const handlePointerUp = (_e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setCursorGrabbing(false);
    // Flush any pending move before clearing drag state
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveComponent(component.id, pendingMove.current.x, pendingMove.current.y);
      moveRaf.current = 0;
    }
    // Snap Y to nearest connected neighbor if within threshold
    if (hasMoved.current) {
      const state = useGameStore.getState();
      const conns = state.connections;
      const comps = state.components;
      const SNAP_THRESHOLD = 10;
      let closestDy = Infinity;
      let snapY: number | null = null;
      for (const conn of conns) {
        let neighborId: string | null = null;
        if (conn.fromId === component.id) neighborId = conn.toId;
        else if (conn.toId === component.id) neighborId = conn.fromId;
        if (!neighborId) continue;
        const neighbor = comps.find(c => c.id === neighborId);
        if (!neighbor) continue;
        const dy = Math.abs(pendingMove.current.y - neighbor.y);
        if (dy > 0 && dy < SNAP_THRESHOLD && dy < closestDy) {
          closestDy = dy;
          snapY = neighbor.y;
        }
      }
      if (snapY !== null) {
        moveComponent(component.id, pendingMove.current.x, snapY);
      }
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
  const halfW = isCluster ? CLUSTER_HALF_W : (isDmq ? dmqNodeWidth / 2 : 60);
  const halfH = isCluster ? CLUSTER_HALF_H : 28;

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="absolute flex flex-col items-center gap-1"
      style={{
        left: screen.x - halfW * zoom,
        top: screen.y - halfH * zoom,
        zIndex: cursorGrabbing ? 50 : (isPublisher ? 30 : (component.type === 'subscriber' ? 20 : 26)),
        cursor: cursorGrabbing ? 'grabbing' : 'grab',
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}
    >
      {isCluster ? (
        <div className="relative" style={{ width: CLUSTER_HALF_W * 2 }}>
          <div
            className="absolute rounded-xl pointer-events-none"
            style={{
              left: 0, top: 0, right: 0, bottom: 0,
              border: `1.5px dashed ${isValidTarget ? '#22d3ee' : colors.border}99`,
              background: '#0a0e1a',
              boxShadow: isValidTarget ? '0 0 16px rgba(34,211,238,0.6), 0 0 30px rgba(34,211,238,0.3)' : 'none',
            }}
          />
          <div
            className="absolute text-[9px] font-mono tracking-wide pointer-events-none whitespace-nowrap"
            style={{ top: -15, left: 4, color: colors.border + 'cc' }}
          >
            DMR Cluster
          </div>
          <button
            onClick={handleUpgradeClick}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute px-1.5 py-0.5 rounded-t cursor-pointer"
            style={{
              top: -16,
              right: 8,
              zIndex: affordableUpgradeCount > 0 ? 2 : 1,
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
          <div className="relative grid grid-cols-2 gap-2" style={{ padding: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => {
              const filled = i < clusterSlots;
              // Slots fill in order — this slot only starts filling once every earlier slot is full,
              // so the grid visually reads as "spilling over" left-to-right, top-to-bottom.
              const subUtilization = Math.max(0, Math.min(1, brokerUtilization * clusterSlots - i));
              return (
                <div
                  key={i}
                  className="px-4 py-2 rounded-lg font-mono text-sm select-none flex flex-col items-center justify-center"
                  style={{
                    width: CLUSTER_SUBCARD_W,
                    height: CLUSTER_SUBCARD_H,
                    border: `1.5px ${filled ? 'solid' : 'dashed'} ${filled ? colors.border : colors.border + '55'}`,
                    background: filled ? colors.bg : 'transparent',
                    boxShadow: filled ? colors.glow : 'none',
                    color: filled ? colors.border : colors.border + '55',
                    opacity: filled ? 1 : 0.6,
                  }}
                  title={filled ? `Broker ${i + 1} of ${clusterSlots}` : 'Purchase "Add Cluster Slot" to unlock'}
                >
                  <div>Broker</div>
                  {filled && (
                    <div className="w-full mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#1e293b' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(subUtilization * 100, 100)}%`,
                          background: subUtilization > 0.9 ? '#ef4444' : subUtilization > 0.7 ? '#f59e0b' : '#22c55e',
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div
            onPointerDown={handleOutputPortDown}
            className="absolute w-4 h-4 rounded-full border flex items-center justify-center group/port top-1/2 -right-6"
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
        </div>
      ) : (
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
          {/* Cooldown overlay for publisher — always mounted, shown/clipped imperatively */}
          {isPublisher && (
            <div
              ref={cooldownOverlayRef}
              className="absolute inset-0 rounded-lg pointer-events-none"
              style={{ background: 'rgba(0, 0, 0, 0.35)', display: 'none' }}
            />
          )}
          {/* Cooldown overlay for subscriber (consuming) — same */}
          {isSubscriber && (
            <div
              ref={subscriberOverlayRef}
              className="absolute inset-0 rounded-lg pointer-events-none"
              style={{ background: 'rgba(0, 0, 0, 0.35)', display: 'none' }}
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
            component.id === 'pub-1' ? (
              <div className="text-[10px] opacity-60">(click to fire)</div>
            ) : !!component.upgrades['networkTier'] && (
              <div className="text-[9px] font-semibold whitespace-nowrap" style={{ color: '#fde047' }}>
                Base Value + {component.upgrades['networkTier'] * 10}%
              </div>
            )
          )}
          {isDmq && (
            <div className="flex flex-col gap-1 mt-1 items-center">
              {renderSlotRows(
                slotSignature,
                3 + (component.upgrades['dmqBufferSize'] ?? 0),
                getDmqSlotsPerRow(component.upgrades['dmqWidth'] ?? 0),
                () => '#fb923c',
              )}
            </div>
          )}
          {component.type === 'queue' && (
            <div className="flex flex-col gap-1 mt-1 items-center">
              {renderSlotRows(
                slotSignature,
                3 + (component.upgrades['bufferSize'] ?? 0) + getPermanentQueueBufferBonus({ prestige: useGameStore.getState().prestige }),
                10, // Wrap into rows of 10
                flag => (flag === 'r' ? '#fb923c' : '#66ffff'),
              )}
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
      )}
      {component.type === 'publisher' && component.topicSegments && (
        <div className="text-[8px] text-gray-500 font-mono text-center" style={{ maxWidth: 140, wordBreak: 'break-all' }}>
          {component.topicSegments.join('/')}
        </div>
      )}
      {component.type === 'queue' && component.subscriptionTopic && (
        <div className="text-[8px] font-mono text-center" style={{ maxWidth: 140, wordBreak: 'break-all' }}>
          {component.subscriptionTopic.split('/').map((seg, i) => (
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

// Memoized so MeshCanvas re-rendering (it subscribes to coinPops, which change constantly at
// high throughput) doesn't cascade into every card. A card's `component` prop keeps the same
// reference until that specific component actually changes (immer structural sharing).
export const NodeCard = memo(NodeCardInner);
