import { motion } from 'framer-motion';

// Shared design tokens matching the game's visual style
const C = {
  publisher: { border: '#22d3ee', bg: '#0e3a3e', glow: 'rgba(34,211,238,0.4)' },
  webhook: { border: '#f59e0b', bg: '#3b2e0a', glow: 'rgba(245,158,11,0.4)' },
  broker: { border: '#fb923c', bg: '#431407', glow: 'rgba(251,146,60,0.5)' },
  queue: { border: '#a855f7', bg: '#2e1065', glow: 'rgba(168,85,247,0.4)' },
  subscriber: { border: '#22c55e', bg: '#0a3b1e', glow: 'rgba(34,197,94,0.4)' },
  dmq: { border: '#ef4444', bg: '#2a0a0a', glow: 'rgba(239,68,68,0.4)' },
  dot: '#66ffff',
  dotGlow: 'rgba(102,255,255,0.6)',
  line: '#334155',
  bg: '#0a0e1a',
};

const W = 380;
const H = 160;

type NodeType = 'publisher' | 'webhook' | 'broker' | 'queue' | 'subscriber' | 'dmq';

function NodeBox({
  x, y, w = 72, h = 40, type, label,
}: {
  x: number; y: number; w?: number; h?: number; type: NodeType; label: string;
}) {
  const c = C[type];
  return (
    <g>
      <rect
        x={x - w / 2} y={y - h / 2} width={w} height={h}
        rx={6}
        fill={c.bg}
        stroke={c.border}
        strokeWidth={1.5}
        filter={`drop-shadow(0 0 6px ${c.glow})`}
      />
      <text x={x} y={y + 4} textAnchor="middle" fill={c.border} fontSize={11} fontWeight="600">
        {label}
      </text>
    </g>
  );
}

function Wire({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const mx = (x1 + x2) / 2;
  const path = `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  return (
    <g>
      <path d={path} fill="none" stroke={C.line} strokeWidth={1.5} strokeDasharray="4 3" />
      {/* arrowhead */}
      <polygon
        points={`${x2},${y2} ${x2 - 6},${y2 - 4} ${x2 - 6},${y2 + 4}`}
        fill={C.line}
      />
    </g>
  );
}

function TravelingDot({
  x1, y1, x2, y2,
  delay = 0,
  duration = 1.4,
  color = C.dot,
  repeatDelay = 2.8,
  hideOnMount = false,
}: {
  x1: number; y1: number; x2: number; y2: number;
  delay?: number; duration?: number; color?: string; repeatDelay?: number; hideOnMount?: boolean;
}) {
  return (
    <motion.circle
      fill={color}
      filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
      animate={{
        cx: [x1, x2, x2],
        cy: [y1, y2, y2],
        r: hideOnMount ? [0, 3, 3, 0] : [3, 3, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        repeatDelay,
        ease: 'linear',
        times: hideOnMount ? [0, 0.001, 0.85, 1] : [0, 0.85, 1],
      }}
    />
  );
}

/** Dot that follows an orthogonal H→V→H path matching the Wire component */
function OrthoTravelingDot({
  x1, y1, x2, y2,
  delay = 0,
  duration = 1.4,
  repeatDelay = 2.8,
}: {
  x1: number; y1: number; x2: number; y2: number;
  delay?: number; duration?: number; repeatDelay?: number;
}) {
  const mx = (x1 + x2) / 2;
  // Segment lengths for proportional timing
  const hLen = Math.abs(mx - x1);
  const vLen = Math.abs(y2 - y1);
  const hLen2 = Math.abs(x2 - mx);
  const total = hLen + vLen + hLen2;
  const t1 = hLen / total * 0.85;
  const t2 = (hLen + vLen) / total * 0.85;
  return (
    <motion.circle
      fill={C.dot}
      filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
      animate={{
        cx: [x1, mx, mx, x2, x2],
        cy: [y1, y1, y2, y2, y2],
        r: [3, 3, 3, 3, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        repeatDelay,
        ease: 'linear',
        times: [0, t1, t2, 0.85, 1],
      }}
    />
  );
}

// ── Slide Graphics ──────────────────────────────────────────────────────────

export function PublisherGraphic() {
  const cx = W / 2, cy = H / 2;
  const nW = 72, nH = 40;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <defs>
        <clipPath id="pub-clip">
          <rect x={cx - nW / 2} y={cy - nH / 2} width={nW} height={nH} rx={6} />
        </clipPath>
      </defs>
      {/* Publisher with click scale-dip animation */}
      <motion.g
        animate={{ scale: [1, 0.93, 1, 1, 1] }}
        transition={{ duration: 2, repeat: Infinity, times: [0, 0.05, 0.1, 0.95, 1], ease: 'easeInOut' }}
        style={{ transformOrigin: `${cx}px ${cy}px` }}
      >
        <NodeBox x={cx} y={cy} type="publisher" label="Publisher" />
        {/* Cooldown overlay: dark rect that drains from top after click */}
        <motion.rect
          x={cx - nW / 2}
          rx={6}
          width={nW}
          fill="rgba(0,0,0,0.38)"
          clipPath="url(#pub-clip)"
          animate={{
            y: [cy - nH / 2, cy - nH / 2, cy + nH / 2, cy + nH / 2, cy - nH / 2],
            height: [nH, nH, 0, 0, nH],
          }}
          transition={{ duration: 2, repeat: Infinity, times: [0, 0.05, 0.8, 0.95, 1], ease: 'linear' }}
        />
      </motion.g>
      {/* Dot emitting synced with click (0.1s after scale-dip) */}
      <motion.circle
        r={3}
        fill={C.dot}
        filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
        animate={{
          cx: [cx + nW / 2, cx + nW / 2 + 100],
          cy: [cy, cy],
          opacity: [0, 1, 0.6, 0],
          r: [0, 3, 3, 0],
        }}
        transition={{ duration: 0.9, delay: 0.1, repeat: Infinity, repeatDelay: 1.1, ease: 'easeOut', times: [0, 0.1, 0.8, 1] }}
      />
    </svg>
  );
}

export function EventsFlowGraphic() {
  const pubX = 50, brokerX = W / 2, subX = W - 50, y = H / 2;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Single continuous line pub -> sub */}
      <line x1={pubX + 36} y1={y} x2={subX - 36} y2={y} stroke={C.line} strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Dots traveling continuously pub -> sub */}
      {[0, 1.5, 3.0].map((delay, i) => (
        <TravelingDot key={i} x1={pubX + 30} y1={y} x2={subX - 36} y2={y} delay={delay} duration={2.0} repeatDelay={3.0} />
      ))}
      {/* Nodes drawn last so broker sits on top */}
      <NodeBox x={pubX} y={y} type="publisher" label="Publisher" />
      <NodeBox x={brokerX} y={y} type="broker" label="Broker" />
      <NodeBox x={subX} y={y} type="subscriber" label="Subscriber" />
    </svg>
  );
}

export function EarnMoneyGraphic() {
  const subX = W / 2, subY = H / 2;
  const subLeftEdge = subX - 36;
  const dotStartX = 20;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <NodeBox x={subX} y={subY} type="subscriber" label="Subscriber" />
      {/* Dot arrives from left, stops at subscriber left edge then is consumed */}
      <motion.circle
        r={3}
        fill={C.dot}
        filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
        animate={{
          cx: [dotStartX, subLeftEdge, subLeftEdge],
          cy: [subY, subY, subY],
          opacity: [0, 1, 1, 0],
          r: [3, 3, 3, 0],
        }}
        transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 0.5, ease: 'linear', times: [0, 0.35, 0.9, 1] }}
      />
      {/* Coin icon + money amount floating up, centered above subscriber */}
      <motion.g
        animate={{ y: [0, -5, -40, -50], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 1.4, delay: 1.4, repeat: Infinity, repeatDelay: 1.3, times: [0, 0.12, 0.75, 1], ease: 'easeOut' }}
      >
        <circle cx={subX - 26} cy={subY - 22} r={9} fill="#ca8a04" />
        <text x={subX - 26} y={subY - 18} textAnchor="middle" fill="#fef08a" fontSize={11} fontWeight="800">$</text>
        <text
          x={subX - 12} y={subY - 17}
          textAnchor="start" fill="#22c55e" fontSize={13} fontWeight="700"
          filter="drop-shadow(0 0 4px rgba(34,197,94,0.6))"
        >+$1.20</text>
      </motion.g>
    </svg>
  );
}

export function UpgradeExpandGraphic() {
  // Shift node left to leave room for the upgrade panel on the right
  const cx = W / 2 - 70;
  const nodeW = 72, nodeH = 40;
  // Badge at top-right corner of node, matching NodeCard's top-1 right-1 button
  const badgeX = cx + nodeW / 2 - 8;
  const badgeY = H / 2 - nodeH / 2 + 8;

  // Upgrade modal dimensions
  const modalX = W - 160;
  const modalY = 12;
  const modalW = 140;
  const modalH = H - 24;

  const upgrades = [
    {
      name: 'Add Subscriber Slot',
      desc: 'Connect one more',
      effect: '1 → 2',
      cost: '$30.00',
    },
    {
      name: 'Persistent Delivery',
      desc: 'All subscribers receive',
      effect: 'One-time',
      cost: '$100.00',
    },
    {
      name: 'Faster Release',
      desc: 'Accelerate release speed',
      effect: '0% → 5% (+5%)',
      cost: '$35.00',
    },
  ];

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <NodeBox x={cx} y={H / 2} type="queue" label="Queue" />
      {/* Upgrade badge with pulsing scale effect */}
      <motion.g
        animate={{ scale: [1, 1.15, 1] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        style={{ transformOrigin: `${badgeX}px ${badgeY}px` }}
      >
        <rect
          x={badgeX - 7} y={badgeY - 7} width={14} height={14} rx={3}
          fill="#0e3a3e" stroke="#22d3ee" strokeWidth={0.8}
        />
        <text
          x={badgeX} y={badgeY}
          textAnchor="middle" dominantBaseline="middle" fill="#22d3ee" fontSize={9} fontWeight="800"
        >
          ↑
        </text>
      </motion.g>

      {/* Queue upgrade modal container */}
      <rect
        x={modalX} y={modalY} width={modalW} height={modalH} rx={6}
        fill="#111827" stroke="#4b5563" strokeWidth={1}
      />
      {/* Modal header */}
      <text x={modalX + 8} y={modalY + 16} textAnchor="start" fill="#d1fae5" fontSize={10} fontWeight="700">Queue</text>
      {/* Close button X */}
      <text x={modalX + modalW - 10} y={modalY + 15} textAnchor="middle" fill="#9ca3af" fontSize={9} fontWeight="600">×</text>
      {/* Header separator */}
      <line x1={modalX} y1={modalY + 24} x2={modalX + modalW} y2={modalY + 24} stroke="#374151" strokeWidth={0.5} />

      {/* Upgrade buttons */}
      {upgrades.map((upg, i) => {
        const buttonY = modalY + 28 + i * 30;
        const buttonX = modalX + 6;
        const buttonW = modalW - 12;
        const buttonH = 26;
        // Lime green border: #4ade80 (rgb(74, 222, 128))
        const borderColor = '#4ade80';
        const bgColor = 'rgba(6, 78, 59, 0.2)';
        const textColor = '#d1fae5';

        return (
          <g key={i}>
            {/* Button background and border */}
            <rect
              x={buttonX} y={buttonY} width={buttonW} height={buttonH} rx={4}
              fill={bgColor} stroke={borderColor} strokeWidth={1}
            />
            {/* Upgrade name + level */}
            <text
              x={buttonX + 4} y={buttonY + 8}
              textAnchor="start" fill={textColor} fontSize={8} fontWeight="700"
            >
              {upg.name}
            </text>
            <text
              x={buttonX + buttonW - 4} y={buttonY + 8}
              textAnchor="end" fill="#9ca3af" fontSize={6}
            >
              Lv 0
            </text>
            {/* Description */}
            <text
              x={buttonX + 4} y={buttonY + 16}
              textAnchor="start" fill="#b0f7d8" fontSize={6} opacity={0.7}
            >
              {upg.desc}
            </text>
            {/* Effect value (blue) */}
            <text
              x={buttonX + 4} y={buttonY + 23}
              textAnchor="start" fill="#93c5fd" fontSize={7} fontWeight="500"
            >
              {upg.effect}
            </text>
          </g>
        );
      })}

      {/* Delete button at bottom */}
      <rect
        x={modalX + 6} y={modalY + 116} width={modalW - 12} height={18} rx={4}
        fill="none" stroke="#b91c1c" strokeWidth={0.5}
      />
      <text
        x={modalX + modalW / 2} y={modalY + 127}
        textAnchor="middle" fill="#f87171" fontSize={8} fontWeight="600"
      >
        Delete Queue
      </text>
    </svg>
  );
}

export function BrokerUpgradeGraphic() {
  const bX = W / 2, bY = H / 2;
  const outY1 = bY - 32, outY2 = bY, outY3 = bY + 32;
  const brokerLeft = bX - 36, brokerRight = bX + 36;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <defs>
        {/* Fade overlays that match the background, creating fading line effect */}
        <linearGradient id="bup-fade-left" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={C.bg} stopOpacity="1" />
          <stop offset="100%" stopColor={C.bg} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="bup-fade-right" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={C.bg} stopOpacity="0" />
          <stop offset="100%" stopColor={C.bg} stopOpacity="1" />
        </linearGradient>
      </defs>

      {/* Incoming line from left at vertical center */}
      <line x1={0} y1={bY} x2={brokerRight} y2={bY} stroke={C.line} strokeWidth={1.5} strokeDasharray="4 3" />

      {/* Outgoing orthogonal lines to right (fanout) from broker with vertical spacing */}
      {[outY1, outY2, outY3].map((oy, i) => {
        const startY = bY + (i - 1) * 10;
        const mx = (brokerRight + W) / 2;
        const path = `M ${brokerRight} ${startY} L ${mx} ${startY} L ${mx} ${oy} L ${W} ${oy}`;
        const strokeDasharray = '4 3';
        return (
          <path key={`line-${i}`} d={path} fill="none" stroke={C.line} strokeWidth={1.5} strokeDasharray={strokeDasharray} />
        );
      })}

      {/* Fade overlay — drawn after lines but before traveling dots */}
      <rect x={0} y={0} width={90} height={H} fill="url(#bup-fade-left)" />
      <rect x={W - 90} y={0} width={90} height={H} fill="url(#bup-fade-right)" />

      {/* 1 incoming dot traveling horizontally at vertical center */}
      <motion.circle
        r={3} fill={C.dot}
        filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
        animate={{ cx: [20, brokerRight], cy: [bY, bY], opacity: [0, 1, 0] }}
        transition={{ duration: 0.9, repeat: Infinity, repeatDelay: 0.9, ease: 'linear', times: [0, 0.8, 1] }}
      />

      {/* 3 fanout dots: spawn behind broker, travel along orthogonal paths */}
      {[outY1, outY2, outY3].map((oy, i) => {
        const startY = bY + (i - 1) * 10;
        const mx = (brokerRight + W) / 2;
        return (
          <motion.circle
            key={i}
            r={3} fill={C.dot}
            filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
            animate={{
              cx: [bX, brokerRight, mx, mx, W],
              cy: [startY, startY, startY, oy, oy],
              opacity: [1, 1, 1, 1, 0]
            }}
            transition={{
              duration: 0.9,
              delay: 0.72,
              repeat: Infinity,
              repeatDelay: 0.9,
              ease: 'linear',
              times: [0, 0.15, 0.5, 0.75, 1]
            }}
          />
        );
      })}

      {/* Broker node — rendered last so it has highest z-index */}
      <NodeBox x={bX} y={bY} type="broker" label="Broker" />

    </svg>
  );
}

export function QueueGraphic() {
  const bX = 70, qX = W / 2, sX = W - 70, y = H / 2;
  const qNodeW = 72, qNodeH = 40;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <Wire x1={bX + 36} y1={y} x2={qX - qNodeW / 2} y2={y} />
      <Wire x1={qX + qNodeW / 2} y1={y} x2={sX - 36} y2={y} />
      <NodeBox x={bX} y={y} type="broker" label="Broker" />
      {/* Queue node: label near top, slots below */}
      <rect
        x={qX - qNodeW / 2} y={y - qNodeH / 2} width={qNodeW} height={qNodeH} rx={6}
        fill={C.queue.bg} stroke={C.queue.border} strokeWidth={1.5}
        filter={`drop-shadow(0 0 6px ${C.queue.glow})`}
      />
      <text x={qX} y={y - qNodeH / 2 + 13} textAnchor="middle" fill={C.queue.border} fontSize={11} fontWeight="600">Queue</text>
      {/* Slots: rightmost on at t=1.12s, off at t=3.12s; middle on at t=1.62s, off at t=2.12s — 5.0s shared cycle */}
      {[-10, 0, 10].map((dx, i) => (
        <motion.circle
          key={i}
          cx={qX + dx} cy={y - qNodeH / 2 + 28} r={3}
          animate={i === 2
            ? { fill: ['#1e293b', '#1e293b', C.dot, C.dot, '#1e293b', '#1e293b'] }
            : i === 1
              ? { fill: ['#1e293b', '#1e293b', C.dot, C.dot, '#1e293b', '#1e293b'] }
              : { fill: '#1e293b' }
          }
          transition={i === 2
            ? { duration: 5.0, repeat: Infinity, times: [0, 0.224, 0.226, 0.624, 0.626, 1.0], ease: 'linear' }
            : i === 1
              ? { duration: 5.0, repeat: Infinity, times: [0, 0.324, 0.326, 0.424, 0.426, 1.0], ease: 'linear' }
              : undefined
          }
        />
      ))}
      <NodeBox x={sX} y={y} type="subscriber" label="Subscriber" />
      {/* 1st dot: broker → queue */}
      <TravelingDot x1={bX + 36} y1={y} x2={qX - qNodeW / 2} y2={y} duration={1.2} repeatDelay={3.8} />
      {/* 2nd dot: broker → queue, 0.5s after 1st */}
      <TravelingDot x1={bX + 36} y1={y} x2={qX - qNodeW / 2} y2={y} delay={0.5} duration={1.2} repeatDelay={3.8} />
      {/* 1st dot: queue → subscriber, departs at t=2.12s (0.5s after both queued) */}
      <TravelingDot x1={qX + qNodeW / 2} y1={y} x2={sX - 36} y2={y} delay={2.12} duration={1.0} repeatDelay={4.0} hideOnMount />
      {/* 2nd dot: queue → subscriber, departs at t=3.12s (after 1st arrives at sub) */}
      <TravelingDot x1={qX + qNodeW / 2} y1={y} x2={sX - 36} y2={y} delay={3.12} duration={1.0} repeatDelay={4.0} hideOnMount />
    </svg>
  );
}

export function DmqGraphic() {
  const bX = 100, bY = 42;
  const dmqX = 265, dmqY = 116;
  const dmqNodeW = 80, dmqNodeH = 52;

  // Return path: DMQ left edge → left to broker x → up to broker bottom center (one 90° bend)
  const retX1 = dmqX - dmqNodeW / 2, retY1 = dmqY;
  const retX2 = bX, retY2 = bY + 20; // broker bottom center
  const retMx = retX2; // bend is directly below broker

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Orthogonal return wire: DMQ → broker bottom center, arrow pointing at broker */}
      <path
        d={`M ${retX1} ${retY1} L ${retMx} ${retY1} L ${retMx} ${retY2}`}
        fill="none" stroke={C.line} strokeWidth={1.5} strokeDasharray="4 3"
      />
      {/* Arrowhead pointing upward into broker bottom */}
      <polygon
        points={`${retX2},${retY2} ${retX2 - 4},${retY2 + 6} ${retX2 + 4},${retY2 + 6}`}
        fill={C.line}
      />

      {/* Broker */}
      <NodeBox x={bX} y={bY} type="broker" label="Broker" />

      {/* DMQ node with label + slots */}
      <rect
        x={dmqX - dmqNodeW / 2} y={dmqY - dmqNodeH / 2} width={dmqNodeW} height={dmqNodeH} rx={6}
        fill={C.dmq.bg} stroke={C.dmq.border} strokeWidth={1.5}
        filter={`drop-shadow(0 0 6px ${C.dmq.glow})`}
      />
      <text x={dmqX} y={dmqY - dmqNodeH / 2 + 15} textAnchor="middle" fill={C.dmq.border} fontSize={11} fontWeight="600">DMQ</text>
      {/* Slots — 5.0s shared cycle
           i=2: lights at t=0.616s → 0.123, dark at t=2.2s → 0.440
           i=1: lights at t=1.616s → 0.323, dark at t=3.2s → 0.640 */}
      {[-14, 0, 14].map((dx, i) => (
        <motion.circle
          key={i}
          cx={dmqX + dx} cy={dmqY - dmqNodeH / 2 + 34} r={3}
          animate={i === 2
            ? { fill: ['#1e293b', '#1e293b', '#ff4444', '#ff4444', '#1e293b', '#1e293b'] }
            : i === 1
              ? { fill: ['#1e293b', '#1e293b', '#ff4444', '#ff4444', '#1e293b', '#1e293b'] }
              : { fill: '#1e293b' }
          }
          transition={i === 2
            ? { duration: 5.0, repeat: Infinity, times: [0, 0.122, 0.124, 0.438, 0.440, 1.0], ease: 'linear' }
            : i === 1
              ? { duration: 5.0, repeat: Infinity, times: [0, 0.222, 0.224, 0.538, 0.540, 1.0], ease: 'linear' }
              : undefined
          }
        />
      ))}

      {/* Red dots — duration+repeatDelay=5.0 keeps phase-locked to slot cycle
           dot 0: delay=0,   fires at 0, 5, 10...   arrives at 0.616s into each cycle
           dot 1: delay=1.0, fires at 1, 6, 11...   arrives at 1.616s into each cycle */}
      {([{ delay: 0, repeatDelay: 4.3 }, { delay: 0.5, repeatDelay: 4.3 }]).map(({ delay, repeatDelay }, i) => (
        <motion.circle
          key={i}
          r={3}
          fill="#ff4444"
          filter="drop-shadow(0 0 4px rgba(255,68,68,0.6))"
          animate={{
            cx: [dmqX - 12 + i * 24, dmqX - 12 + i * 24],
            cy: [8, dmqY - dmqNodeH / 2 - 4],
            opacity: [0, 1, 1, 0],
          }}
          transition={{ duration: 0.7, delay, repeat: Infinity, repeatDelay, ease: 'easeIn', times: [0, 0.08, 0.88, 1] }}
        />
      ))}

      {/* Two orange retry dots — duration+repeatDelay=5.0, offset by 1.0s apart
           orange 1: departs at t=2.2s → slot i=2 dark; fires at 2.2, 7.2, 12.2...
           orange 2: departs at t=3.2s → slot i=1 dark; fires at 3.2, 8.2, 13.2... */}
      {(() => {
        const seg1 = Math.abs(retX1 - retX2), seg2 = Math.abs(retY2 - retY1);
        const t1 = seg1 / (seg1 + seg2);
        return [2.2, 2.7].map((delay, i) => (
          <motion.circle
            key={i}
            r={3}
            fill="#fb923c"
            filter="drop-shadow(0 0 4px rgba(251,146,60,0.6))"
            animate={{
              cx: [retX1, retX2, retX2, retX2],
              cy: [retY1, retY1, retY2, retY2],
              opacity: [0, 1, 1, 0],
            }}
            transition={{ duration: 1.0, delay, repeat: Infinity, repeatDelay: 4.0, ease: 'linear', times: [0, t1 * 0.92, 0.92, 1] }}
          />
        ));
      })()}
    </svg>
  );
}

export function MultiPublisherGraphic() {
  const p1Y = 45, p2Y = H - 45, bX = W - 90, brokerY = H / 2;
  const pX = 80;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <Wire x1={pX + 36} y1={p1Y} x2={bX - 36} y2={brokerY} />
      <Wire x1={pX + 36} y1={p2Y} x2={bX - 36} y2={brokerY} />
      <NodeBox x={pX} y={p1Y} type="publisher" label="Publisher" />
      <NodeBox x={pX} y={p2Y} type="publisher" label="Publisher" />
      <NodeBox x={bX} y={brokerY} type="broker" label="Broker" />
      <OrthoTravelingDot x1={pX + 36} y1={p1Y} x2={bX - 36} y2={brokerY} duration={1.3} />
      <OrthoTravelingDot x1={pX + 36} y1={p2Y} x2={bX - 36} y2={brokerY} delay={0.5} duration={1.3} />
    </svg>
  );
}

export function MultiSubscriberGraphic() {
  const qX = 90, s1Y = 45, s2Y = H - 45, sX = W - 80, qY = H / 2;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      <Wire x1={qX + 36} y1={qY} x2={sX - 36} y2={s1Y} />
      <Wire x1={qX + 36} y1={qY} x2={sX - 36} y2={s2Y} />
      <NodeBox x={qX} y={qY} type="queue" label="Queue" />
      <NodeBox x={sX} y={s1Y} type="subscriber" label="Subscriber" />
      <NodeBox x={sX} y={s2Y} type="subscriber" label="Subscriber" />
      <OrthoTravelingDot x1={qX + 36} y1={qY} x2={sX - 36} y2={s1Y} duration={1.3} />
      <OrthoTravelingDot x1={qX + 36} y1={qY} x2={sX - 36} y2={s2Y} delay={0.5} duration={1.3} />
      {/* Coin pop on subscriber 1 */}
      <motion.g
        animate={{ y: [0, -5, -30, -38], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 1.2, delay: 1.1, repeat: Infinity, repeatDelay: 2.9, times: [0, 0.12, 0.75, 1], ease: 'easeOut' }}
      >
        <circle cx={sX - 20} cy={s1Y - 22} r={7} fill="#ca8a04" />
        <text x={sX - 20} y={s1Y - 18.5} textAnchor="middle" fill="#fef08a" fontSize={9} fontWeight="800">$</text>
        <text x={sX - 9} y={s1Y - 17} textAnchor="start" fill="#22c55e" fontSize={10} fontWeight="700" filter="drop-shadow(0 0 4px rgba(34,197,94,0.6))">+$1.20</text>
      </motion.g>
      {/* Coin pop on subscriber 2 */}
      <motion.g
        animate={{ y: [0, -5, -30, -38], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 1.2, delay: 1.6, repeat: Infinity, repeatDelay: 2.9, times: [0, 0.12, 0.75, 1], ease: 'easeOut' }}
      >
        <circle cx={sX - 20} cy={s2Y - 22} r={7} fill="#ca8a04" />
        <text x={sX - 20} y={s2Y - 18.5} textAnchor="middle" fill="#fef08a" fontSize={9} fontWeight="800">$</text>
        <text x={sX - 9} y={s2Y - 17} textAnchor="start" fill="#22c55e" fontSize={10} fontWeight="700" filter="drop-shadow(0 0 4px rgba(34,197,94,0.6))">+$1.20</text>
      </motion.g>
    </svg>
  );
}
export function EventDropGraphic() {
  const subX = W / 2, subY = H / 2;
  const subLeftEdge = subX - 36;
  const dotStartX = 10;
  const nW = 72, nH = 40;

  // Single shared 5s cycle. All elements use times 0→1 with opacity
  // to stay hidden during their "waiting" phase.
  //
  // t=0.00 (0.0s)  dot 1 appears at left, starts traveling
  // t=0.16 (0.8s)  dot 1 arrives at subscriber, consumed; cooldown appears; dot 2 appears and starts traveling
  // t=0.32 (1.6s)  dot 2 arrives, rejected — ✕ flash, turns red, falls
  // t=0.42 (2.1s)  cooldown fully drained
  // t=1.00 (5.0s)  cycle restarts

  const D = 3.5;
  const a = 0.16;  // dot 1 arrives (0.8s)
  const b = 0.32;  // dot 2 arrives (1.6s)
  const c = 0.42;  // cooldown drained (2.1s)

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Connection line */}
      <line x1={dotStartX} y1={subY} x2={subLeftEdge} y2={subY} stroke={C.line} strokeWidth={1.5} strokeDasharray="4 3" />
      <polygon
        points={`${subLeftEdge},${subY} ${subLeftEdge - 6},${subY - 4} ${subLeftEdge - 6},${subY + 4}`}
        fill={C.line}
      />

      {/* Subscriber node */}
      <NodeBox x={subX} y={subY} type="subscriber" label="Subscriber" />

      {/* Cooldown bar: matches real game — dark overlay with clipPath inset draining from top */}
      <motion.rect
        x={subX - nW / 2}
        y={subY - nH / 2}
        width={nW}
        height={nH}
        rx={6}
        fill="rgba(0,0,0,0.35)"
        animate={{
          clipPath: [
            'inset(100% 0 0 0)',
            'inset(100% 0 0 0)',
            'inset(0% 0 0 0)',
            'inset(100% 0 0 0)',
            'inset(100% 0 0 0)',
          ],
        }}
        transition={{
          duration: D,
          repeat: Infinity,
          ease: 'linear',
          times: [0, a - 0.005, a, c, 1],
        }}
      />

      {/* Dot 1: travels from left to subscriber, then fades out (consumed) */}
      <motion.circle
        cy={subY}
        r={3}
        fill={C.dot}
        filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
        animate={{
          cx: [dotStartX, subLeftEdge, subLeftEdge, subLeftEdge],
          opacity: [1, 1, 0, 0],
          r: [3, 3, 0, 0],
        }}
        transition={{
          duration: D,
          repeat: Infinity,
          ease: 'linear',
          times: [0, a, a + 0.04, 1],
        }}
      />

      {/* Dot 2: invisible until t=a, travels to subscriber, rejected at t=b, falls */}
      <motion.circle
        r={3}
        filter={`drop-shadow(0 0 4px ${C.dotGlow})`}
        animate={{
          cx: [dotStartX, dotStartX, dotStartX, subLeftEdge, subLeftEdge, subLeftEdge, subLeftEdge, subLeftEdge],
          cy: [subY, subY, subY, subY, subY, subY + 55, subY + 90, subY + 90],
          fill: [C.dot, C.dot, C.dot, C.dot, '#ff4444', '#ff4444', '#ff4444', '#ff4444'],
          opacity: [0, 0, 1, 1, 1, 0.6, 0, 0],
          r: [0, 0, 3, 3, 3, 3, 2, 0],
        }}
        transition={{
          duration: D,
          repeat: Infinity,
          ease: 'linear',
          times: [0, a - 0.005, a, b, b + 0.01, 0.40, 0.48, 1],
        }}
      />

      {/* ✕ flash at rejection */}
      <motion.text
        x={subLeftEdge}
        textAnchor="middle"
        fill="#ff4444"
        fontSize={16}
        fontWeight="800"
        animate={{
          y: [subY - 12, subY - 12, subY - 12, subY - 24, subY - 24],
          opacity: [0, 0, 1, 0, 0],
        }}
        transition={{
          duration: D,
          repeat: Infinity,
          ease: 'easeOut',
          times: [0, b, b + 0.01, b + 0.08, 1],
        }}
      >
        ✕
      </motion.text>
    </svg>
  );
}

export function MultiBrokerGraphic() {
  const b1X = 90, b2X = W - 90, bY = H / 2;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Bridge connection */}
      <line
        x1={b1X + 36} y1={bY} x2={b2X - 36} y2={bY}
        stroke="#334155" strokeWidth={2} strokeDasharray="5 3"
      />
      {/* "bridge" label */}
      <text x={W / 2} y={bY - 10} textAnchor="middle" fill="#4b5563" fontSize={9}>bridge</text>
      <NodeBox x={b1X} y={bY} type="broker" label="Broker" />
      <NodeBox x={b2X} y={bY} type="broker" label="Broker" />
      {/* Dots going both directions */}
      <TravelingDot x1={b1X + 36} y1={bY} x2={b2X - 36} y2={bY} duration={1.4} />
      <TravelingDot x1={b2X - 36} y1={bY} x2={b1X + 36} y2={bY} delay={0.7} duration={1.4} />
    </svg>
  );
}

/** New Components Available — full mesh: pub → broker → 2 queues → 2 subs, DMQ at bottom */
export function NewComponentsGraphic() {
  const px = 50, bx = 170, qx = 290, sx = 410;
  const row1 = 50, row2 = 110, dmqY = 170;
  const vw = 460, vh = 200;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${vw} ${vh}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Wires */}
      <Wire x1={px + 36} y1={row1} x2={bx - 36} y2={row1} />
      <Wire x1={bx + 36} y1={row1} x2={qx - 36} y2={row1} />
      <Wire x1={bx + 36} y1={row1} x2={qx - 36} y2={row2} />
      <Wire x1={qx + 36} y1={row1} x2={sx - 36} y2={row1} />
      <Wire x1={qx + 36} y1={row2} x2={sx - 36} y2={row2} />
      {/* DMQ → Broker */}
      <Wire x1={bx - 36} y1={dmqY} x2={bx - 36} y2={row1 + 20} />
      {/* Nodes */}
      <NodeBox x={px} y={row1} type="publisher" label="Pub" />
      <NodeBox x={bx} y={row1} type="broker" label="Broker" />
      <NodeBox x={qx} y={row1} type="queue" label="Queue" />
      <NodeBox x={qx} y={row2} type="queue" label="Queue" />
      <NodeBox x={sx} y={row1} type="subscriber" label="Sub" />
      <NodeBox x={sx} y={row2} type="subscriber" label="Sub" />
      <NodeBox x={bx} y={dmqY} type="dmq" label="DMQ" />
      {/* Traveling dots */}
      <OrthoTravelingDot x1={px + 36} y1={row1} x2={bx - 36} y2={row1} duration={0.8} repeatDelay={3} />
      <OrthoTravelingDot x1={bx + 36} y1={row1} x2={qx - 36} y2={row1} delay={0.9} duration={0.8} repeatDelay={3} />
      <OrthoTravelingDot x1={bx + 36} y1={row1} x2={qx - 36} y2={row2} delay={0.9} duration={0.8} repeatDelay={3} />
      <OrthoTravelingDot x1={qx + 36} y1={row1} x2={sx - 36} y2={row1} delay={1.8} duration={0.8} repeatDelay={3} />
      <OrthoTravelingDot x1={qx + 36} y1={row2} x2={sx - 36} y2={row2} delay={1.8} duration={0.8} repeatDelay={3} />
    </svg>
  );
}

export function FanOutGraphic() {
  const qX = 100, sX = W - 80;
  const row1 = H / 2 - 44, row2 = H / 2, row3 = H / 2 + 44;
  const qNodeW = 72, qNodeH = 40;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: C.bg }}>
      {/* Wires from queue to each subscriber */}
      <Wire x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row1} />
      <Wire x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row2} />
      <Wire x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row3} />
      {/* Queue */}
      <NodeBox x={qX} y={row2} type="queue" label="Queue" />
      {/* Subscribers */}
      <NodeBox x={sX} y={row1} type="subscriber" label="Subscriber" />
      <NodeBox x={sX} y={row2} type="subscriber" label="Subscriber" />
      <NodeBox x={sX} y={row3} type="subscriber" label="Subscriber" />
      {/* One dot fans out to all three subscribers */}
      <OrthoTravelingDot x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row1} duration={1.2} repeatDelay={2.8} />
      <OrthoTravelingDot x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row2} duration={1.2} repeatDelay={2.8} />
      <OrthoTravelingDot x1={qX + qNodeW / 2} y1={row2} x2={sX - 36} y2={row3} duration={1.2} repeatDelay={2.8} />
    </svg>
  );
}
