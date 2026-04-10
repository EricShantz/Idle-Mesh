import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Legacy service boxes — dense, messy layout
const services = [
  { label: 'Auth API',      x: 90,  y: 40  },
  { label: 'Orders DB',     x: 560, y: 30  },
  { label: 'Payment Svc',   x: 330, y: 130 },
  { label: 'Email Svc',     x: 60,  y: 250 },
  { label: 'User Svc',      x: 620, y: 220 },
  { label: 'Inventory',     x: 180, y: 380 },
  { label: 'Logging',       x: 500, y: 360 },
  { label: 'Gateway',       x: 350, y: 10  },
  { label: 'Notif Svc',     x: 710, y: 120 },
  { label: 'Cache',         x: 10,  y: 140 },
  { label: 'Analytics',     x: 450, y: 250 },
  { label: 'Config Svc',    x: 200, y: 170 },
  { label: 'Billing',       x: 680, y: 370 },
  { label: 'Search API',    x: 100, y: 440 },
  { label: 'Session Mgr',   x: 420, y: 430 },
];

// Tons of messy diagonal connections
const wires: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 7], [0, 9],
  [1, 2], [1, 4], [1, 7], [1, 8],
  [2, 3], [2, 4], [2, 5], [2, 6], [2, 10], [2, 11],
  [3, 5], [3, 9], [3, 13],
  [4, 6], [4, 8], [4, 10], [4, 12],
  [5, 6], [5, 13], [5, 14],
  [6, 7], [6, 10], [6, 12], [6, 14],
  [7, 8], [7, 10],
  [8, 4], [8, 12],
  [9, 11], [9, 3],
  [10, 11], [10, 14],
  [11, 5], [11, 0],
  [12, 14], [13, 14],
];

// Which wires have failing dots
const failingWires = new Set([3, 6, 9, 15, 18, 22, 27, 30, 35, 39]);

const BOX_W = 82;
const BOX_H = 28;

function SpaghettiDiagram() {
  return (
    <svg viewBox="0 0 820 480" className="w-full h-full" style={{ maxWidth: 820, maxHeight: 480 }}>
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
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          return (
            <motion.circle
              key={`d${i}`}
              r={2.5}
              fill="#ef4444"
              initial={{ cx: x1, cy: y1, opacity: 0 }}
              animate={{
                cx: [x1, midX, midX],
                cy: [y1, midY, midY + 50],
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
        const mx = (sa.x + sb.x + BOX_W) / 2;
        const my = (sa.y + sb.y + BOX_H) / 2;
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
function PixelCharacter({ frustrated }: { frustrated: boolean }) {
  const skin = '#fbbf24';
  const hair = '#92400e';
  const hoodie = '#3b82f6';
  const hoodieShade = '#2563eb';
  const pants = '#374151';
  const eye = '#1e293b';

  return (
    <svg width={10 * PX} height={16 * PX} viewBox={`0 0 ${10 * PX} ${16 * PX}`}>
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
];

// Typewriter hook
function useTypewriter(text: string, active: boolean, speed = 25) {
  const [displayed, setDisplayed] = useState('');
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) { setDisplayed(''); indexRef.current = 0; return; }
    indexRef.current = 0;
    setDisplayed('');
    const id = setInterval(() => {
      indexRef.current++;
      setDisplayed(text.slice(0, indexRef.current));
      if (indexRef.current >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [active, text, speed]);

  return displayed;
}

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
  const isFrustrated = lineIndex < SPEECH_LINES.length - 1;
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

      {/* Red pulsing vignette */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 30%, rgba(127,29,29,0.5) 100%)',
        }}
        animate={{
          opacity: phase >= 1 ? [0.4, 1, 0.4] : 0.2,
        }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Spaghetti diagram */}
      <motion.div
        className="relative"
        style={{ width: '85%', maxWidth: 820 }}
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
