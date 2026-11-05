import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTypewriter } from '../hooks/useTypewriter';

// Legacy service boxes — hand-scattered across a 1100×560 canvas, deliberately uneven
// (loose clusters and gaps, nothing on a grid)
const services = [
  { label: 'Auth API',      x: 40,   y: 35  },
  { label: 'Gateway',       x: 255,  y: 10  },
  { label: 'Orders DB',     x: 465,  y: 45  },
  { label: 'Fraud Check',   x: 640,  y: 15  },
  { label: 'Notif Svc',     x: 905,  y: 55  },
  { label: 'Image CDN',     x: 1010, y: 5   },
  { label: 'Cache',         x: 15,   y: 160 },
  { label: 'Config Svc',    x: 190,  y: 125 },
  { label: 'Payment Svc',   x: 380,  y: 140 },
  { label: 'User Svc',      x: 735,  y: 115 },
  { label: 'Rate Limiter',  x: 1000, y: 150 },
  { label: 'Email Svc',     x: 95,   y: 260 },
  { label: 'Analytics',     x: 545,  y: 230 },
  { label: 'Feature Flags', x: 300,  y: 275 },
  { label: 'Catalog',       x: 815,  y: 215 },
  { label: 'Pricing',       x: 660,  y: 170 },
  { label: 'Inventory',     x: 165,  y: 385 },
  { label: 'Logging',       x: 650,  y: 340 },
  { label: 'Billing',       x: 925,  y: 320 },
  { label: 'Reviews',       x: 430,  y: 335 },
  { label: 'Webhooks',      x: 1015, y: 260 },
  { label: 'Search API',    x: 30,   y: 475 },
  { label: 'Session Mgr',   x: 400,  y: 430 },
  { label: 'Ledger',        x: 25,   y: 330 },
  // Bottom-right corner is kept clear so Dave's speech bubble doesn't sit on top of boxes
  { label: 'Shipping',      x: 840,  y: 395 },
  { label: 'Audit Log',     x: 555,  y: 505 },
  { label: 'Cron Jobs',     x: 270,  y: 520 },
  { label: 'Reporting',     x: 640,  y: 470 },
  { label: 'Metrics',       x: 250,  y: 350 },
  { label: 'SMS Svc',       x: 1010, y: 365 },
  { label: 'Warehouse',     x: 120,  y: 530 },
  { label: 'Recommender',   x: 700,  y: 400 },
];

// Messy point-to-point connections. Generated deterministically (seeded LCG) so the intro
// looks the same every load: each service calls a couple of random others, no duplicate pairs.
function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WIRES_PER_SERVICE = 2;
const SECOND_WIRE_CHANCE = 0.7; // some services only make one call, trimming the total a little
const FAILING_WIRE_RATIO = 0.32;
// Prefer neighbours: wires longer than this are mostly rejected, so the centre of the canvas
// isn't criss-crossed by edge-to-edge lines. A few long ones still get through.
const MAX_WIRE_DIST = 400;
const LONG_WIRE_CHANCE = 0.12;

const { wires, failingWires } = (() => {
  const rand = seededRandom(20240617);
  const seen = new Set<string>();
  const list: [number, number][] = [];
  for (let a = 0; a < services.length; a++) {
    const target = rand() < SECOND_WIRE_CHANCE ? WIRES_PER_SERVICE : WIRES_PER_SERVICE - 1;
    let added = 0;
    let guard = 0;
    while (added < target && guard++ < 40) {
      const b = Math.floor(rand() * services.length);
      if (b === a) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      const dist = Math.hypot(services[a].x - services[b].x, services[a].y - services[b].y);
      if (dist > MAX_WIRE_DIST && rand() >= LONG_WIRE_CHANCE) continue;
      seen.add(key);
      list.push([a, b]);
      added++;
    }
  }
  const failing = new Set<number>();
  list.forEach((_, i) => { if (rand() < FAILING_WIRE_RATIO) failing.add(i); });
  return { wires: list, failingWires: failing };
})();

const BOX_W = 82;
const BOX_H = 28;

// Tiling fractal-noise texture used at very low opacity to dither the vignette gradient.
const NOISE_TEXTURE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E" +
  "%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

function SpaghettiDiagram() {
  return (
    <svg viewBox="0 0 1100 560" className="w-full h-full" style={{ maxWidth: 1280, maxHeight: 652 }}>
      {/* Wires */}
      {wires.map(([a, b], i) => {
        const sa = services[a], sb = services[b];
        const failing = failingWires.has(i);
        return (
          <line
            key={`w${i}`}
            x1={sa.x + BOX_W / 2} y1={sa.y + BOX_H / 2}
            x2={sb.x + BOX_W / 2} y2={sb.y + BOX_H / 2}
            stroke={failing ? '#7f1d1d' : '#334155'}
            strokeWidth={1.2}
            strokeDasharray={failing ? '4 3' : undefined}
            opacity={0.8}
          />
        );
      })}

      {/* Traveling dots */}
      {wires.map(([a, b], i) => {
        const sa = services[a], sb = services[b];
        const x1 = sa.x + BOX_W / 2, y1 = sa.y + BOX_H / 2;
        const x2 = sb.x + BOX_W / 2, y2 = sb.y + BOX_H / 2;
        const failing = failingWires.has(i);
        const dur = 1.0 + (i % 5) * 0.25;
        const delay = (i % 7) * 0.3;

        if (failing) {
          // Drop at a varying point along the wire, then fall away with a little drift
          const t = 0.35 + (i % 4) * 0.1;
          const midX = x1 + (x2 - x1) * t;
          const midY = y1 + (y2 - y1) * t;
          const drift = ((i % 3) - 1) * 12;
          return (
            <motion.circle
              key={`d${i}`}
              r={2.5}
              fill="#ef4444"
              initial={{ cx: x1, cy: y1, opacity: 0 }}
              animate={{
                cx: [x1, midX, midX + drift],
                cy: [y1, midY, midY + 60],
                opacity: [0, 1, 0],
              }}
              transition={{
                duration: dur,
                delay,
                repeat: Infinity,
                repeatDelay: 1.2,
                times: [0, 0.5, 1],
              }}
            />
          );
        }

        return (
          <motion.circle
            key={`d${i}`}
            r={2.5}
            fill="#66ffff"
            initial={{ cx: x1, cy: y1, opacity: 0.7 }}
            animate={{ cx: [x1, x2], cy: [y1, y2], opacity: [0.7, 0.7] }}
            transition={{
              duration: dur,
              delay,
              repeat: Infinity,
              repeatDelay: 0.6,
            }}
          />
        );
      })}

      {/* Service boxes */}
      {services.map((s, i) => (
        <g key={`s${i}`}>
          <rect
            x={s.x} y={s.y} width={BOX_W} height={BOX_H} rx={3}
            fill="#1e293b" stroke="#475569" strokeWidth={1.2}
          />
          <text
            x={s.x + BOX_W / 2} y={s.y + BOX_H / 2 + 1}
            textAnchor="middle" dominantBaseline="middle"
            fill="#94a3b8" fontSize={9.5} fontFamily="monospace"
          >
            {s.label}
          </text>
        </g>
      ))}

      {/* Red X marks on failing connections */}
      {[...failingWires].map(i => {
        if (i >= wires.length) return null;
        const [a, b] = wires[i];
        const sa = services[a], sb = services[b];
        // Same drop point as the failing dot on this wire
        const t = 0.35 + (i % 4) * 0.1;
        const mx = sa.x + BOX_W / 2 + (sb.x - sa.x) * t;
        const my = sa.y + BOX_H / 2 + (sb.y - sa.y) * t;
        return (
          <motion.text
            key={`x${i}`}
            x={mx} y={my}
            textAnchor="middle" dominantBaseline="middle"
            fill="#ef4444" fontSize={12} fontWeight="bold" fontFamily="monospace"
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, delay: (i % 5) * 0.4 }}
          >
            ✕
          </motion.text>
        );
      })}
    </svg>
  );
}

// Pixel art developer character (32px style, SVG rects)
const PX = 4;
// Rows the top hat adds above the head in the tux outfit. The viewBox origin moves up by
// this much so the body stays put and callers that scale from the bottom edge still line up.
const HAT_ROWS = 3;
export type PixelOutfit = 'hoodie' | 'tux';
export function PixelCharacter({ frustrated, outfit = 'hoodie' }: { frustrated: boolean; outfit?: PixelOutfit }) {
  const tux = outfit === 'tux';
  const skin = '#fbbf24';
  const hair = '#92400e';
  const hoodie = tux ? '#0f172a' : '#3b82f6';
  const hoodieShade = tux ? '#1e293b' : '#2563eb';
  const pants = tux ? '#0f172a' : '#374151';
  const eye = '#1e293b';
  const monocle = '#b45309'; // dark brass — must stay distinct from the skin tone
  const topRows = tux ? HAT_ROWS : 0;

  return (
    <svg
      width={10 * PX}
      height={(16 + topRows) * PX}
      viewBox={`0 ${-topRows * PX} ${10 * PX} ${(16 + topRows) * PX}`}
    >
      {/* Top hat (tux only): crown with a red band, wide brim resting on the hair */}
      {tux && (
        <>
          {[[3,-3],[4,-3],[5,-3],[6,-3]].map(([x,y],i) =>
            <rect key={`hc${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill="#0f172a" />
          )}
          {[[3,-2],[4,-2],[5,-2],[6,-2]].map(([x,y],i) =>
            <rect key={`hb${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill="#b91c1c" />
          )}
          {[[2,-1],[3,-1],[4,-1],[5,-1],[6,-1],[7,-1]].map(([x,y],i) =>
            <rect key={`hr${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill="#0f172a" />
          )}
        </>
      )}
      {/* Hair */}
      {[[3,0],[4,0],[5,0],[6,0],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1]].map(([x,y],i) =>
        <rect key={`h${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill={hair} />
      )}
      {/* Face */}
      {[[3,2],[4,2],[5,2],[6,2],[2,3],[3,3],[4,3],[5,3],[6,3],[7,3],[3,4],[4,4],[5,4],[6,4]].map(([x,y],i) =>
        <rect key={`f${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill={skin} />
      )}
      {/* Eyes */}
      <rect x={4*PX} y={3*PX} width={PX} height={PX} fill={eye} />
      <rect x={6*PX} y={3*PX} width={PX} height={PX} fill={eye} />
      {/* Expression */}
      {frustrated ? (
        <>
          <rect x={3*PX} y={2*PX} width={PX} height={1} fill={eye} />
          <rect x={7*PX} y={2*PX} width={PX} height={1} fill={eye} />
          <rect x={4*PX} y={4*PX} width={PX} height={PX} fill="#dc2626" opacity={0.7} />
          <rect x={5*PX} y={4*PX} width={PX} height={PX} fill={skin} />
          <rect x={5.5*PX} y={4.3*PX} width={PX*0.8} height={PX*0.4} rx={1} fill={eye} />
        </>
      ) : (
        <>
          <rect x={4.5*PX} y={4.3*PX} width={PX*1.5} height={PX*0.4} rx={1} fill={eye} />
        </>
      )}
      {/* Hoodie body */}
      {[[2,5],[3,5],[4,5],[5,5],[6,5],[7,5],
        [1,6],[2,6],[3,6],[4,6],[5,6],[6,6],[7,6],[8,6],
        [1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7],[8,7],
        [2,8],[3,8],[4,8],[5,8],[6,8],[7,8],
        [2,9],[3,9],[4,9],[5,9],[6,9],[7,9],
        [2,10],[3,10],[4,10],[5,10],[6,10],[7,10],
      ].map(([x,y],i) =>
        <rect key={`b${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill={y >= 8 ? hoodieShade : hoodie} />
      )}
      {/* Tux details: white shirt front, red bow tie, monocle on the right eye */}
      {tux && (
        <>
          {[[4,6],[5,6],[4,7],[5,7]].map(([x,y],i) =>
            <rect key={`s${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill="#f8fafc" />
          )}
          <rect x={4*PX} y={5*PX} width={PX} height={PX} fill="#dc2626" />
          <rect x={5*PX} y={5*PX} width={PX} height={PX} fill="#dc2626" />
          <rect x={4.75*PX} y={5.25*PX} width={PX*0.5} height={PX*0.5} fill="#7f1d1d" />
          <circle cx={6.5*PX} cy={3.5*PX} r={PX*0.95} fill="none" stroke={monocle} strokeWidth={1.4} />
          <line x1={7.3*PX} y1={4.2*PX} x2={8.2*PX} y2={6*PX} stroke={monocle} strokeWidth={0.9} />
        </>
      )}
      {/* Arms */}
      {[[0,6],[0,7],[9,6],[9,7]].map(([x,y],i) =>
        <rect key={`a${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill={skin} />
      )}
      {/* Pants */}
      {[[3,11],[4,11],[5,11],[6,11],[3,12],[4,12],[5,12],[6,12]].map(([x,y],i) =>
        <rect key={`p${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill={pants} />
      )}
      {/* Shoes */}
      {[[3,13],[4,13],[5,13],[6,13]].map(([x,y],i) =>
        <rect key={`l${i}`} x={x*PX} y={y*PX} width={PX} height={PX} fill="#1e293b" />
      )}
    </svg>
  );
}

// Speech lines — user advances with "Next" button
const SPEECH_LINES = [
  "What is this mess?! Every service is calling every other service directly...",
  "Point-to-point connections everywhere. If one service goes down, it takes half the system with it!",
  "No buffering, no retry logic, no fault tolerance. Events just get lost when things go wrong.",
  "That's it! I'm going to rebuild this using Event-Driven Architecture!",
  "...and I'm going to make a TRILLION dollars doing it!",
];
// Lines before this index use the frustrated expression
const FRUSTRATED_LINE_COUNT = 3;

export function IntroSequence({ onComplete }: { onComplete: () => void }) {
  // phase 0 = spaghetti fades in, 1 = character appears, 2 = dialogue
  const [phase, setPhase] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const skip = useCallback(() => {
    timers.current.forEach(clearTimeout);
    onComplete();
  }, [onComplete]);

  // Auto-advance phases 0→1→2
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 2000);
    const t2 = setTimeout(() => setPhase(2), 3000);
    timers.current = [t1, t2];
    return () => timers.current.forEach(clearTimeout);
  }, [skip]);

  const isTyping = phase >= 2;
  const typedText = useTypewriter(SPEECH_LINES[lineIndex], isTyping, 25);
  const lineComplete = typedText.length >= SPEECH_LINES[lineIndex].length;
  const isFrustrated = lineIndex < FRUSTRATED_LINE_COUNT;
  const isLastLine = lineIndex === SPEECH_LINES.length - 1;

  const handleNext = () => {
    if (!lineComplete) return;
    if (isLastLine) {
      skip();
    } else {
      setLineIndex(i => i + 1);
    }
  };

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ zIndex: 70, background: '#0a0e1a' }}
    >
      {/* Skip button */}
      <div
        className="absolute top-4 right-6 text-xs text-gray-500 hover:text-gray-300 cursor-pointer z-10"
        onClick={skip}
      >
        Skip &rsaquo;
      </div>

      {/* Red pulsing vignette. Eased stops keep the per-band alpha step small, and the noise
          layer below dithers what's left — a single linear stop on a near-black background
          quantises into visible concentric ovals. */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 25%, rgba(127,29,29,0.06) 40%, ' +
            'rgba(127,29,29,0.16) 55%, rgba(127,29,29,0.3) 70%, rgba(127,29,29,0.45) 85%, rgba(127,29,29,0.55) 100%)',
        }}
        animate={{
          opacity: phase >= 1 ? [0.5, 0.95, 0.5] : 0.25,
        }}
        transition={{
          duration: 1.4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: NOISE_TEXTURE, opacity: 0.045, mixBlendMode: 'overlay' }}
      />

      {/* Spaghetti diagram */}
      <motion.div
        className="relative"
        style={{ width: '94%', maxWidth: 1280, marginBottom: 70 }} // sit a little above Dave's bubble
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5 }}
      >
        <SpaghettiDiagram />
      </motion.div>

      {/* Character + speech bubble */}
      <AnimatePresence>
        {phase >= 1 && (
          <motion.div
            className="absolute bottom-6 right-6 flex items-end gap-10"
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            {/* Speech bubble */}
            {phase >= 2 && (
              <motion.div
                className="relative rounded-lg px-4 py-3 text-sm text-gray-200"
                style={{
                  background: '#1e293b',
                  border: '1px solid #475569',
                  maxWidth: 320,
                  minWidth: 260,
                  marginBottom: 110,
                  marginRight: 16,
                }}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3 }}
              >
                <div style={{ minHeight: '2.8em' }}>{typedText}</div>

                {/* Next / Let's go button */}
                {lineComplete && (
                  <motion.button
                    onClick={handleNext}
                    className="mt-2 w-full px-3 py-1.5 rounded text-xs font-bold cursor-pointer"
                    style={{
                      background: isLastLine ? '#22d3ee' : '#475569',
                      color: isLastLine ? '#0a0e1a' : '#e2e8f0',
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                  >
                    {isLastLine ? "Let's go!" : 'Next'}
                  </motion.button>
                )}

                {/* Tail */}
                <div
                  className="absolute -right-2 top-1/2 -translate-y-1/2 w-0 h-0"
                  style={{
                    borderTop: '6px solid transparent',
                    borderBottom: '6px solid transparent',
                    borderLeft: '8px solid #475569',
                  }}
                />
                <div
                  className="absolute -right-[7px] top-1/2 -translate-y-1/2 w-0 h-0"
                  style={{
                    borderTop: '5px solid transparent',
                    borderBottom: '5px solid transparent',
                    borderLeft: '7px solid #1e293b',
                  }}
                />
              </motion.div>
            )}

            {/* Character */}
            <div className="flex-shrink-0" style={{ transform: 'scale(2.5)', transformOrigin: 'bottom right' }}>
              <PixelCharacter frustrated={isFrustrated} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
