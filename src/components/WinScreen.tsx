import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { WIN_THRESHOLD } from '../store/upgradeConfig';
import { formatMoney } from '../utils/formatMoney';
import { PixelCharacter } from './IntroSequence';
import { useTypewriter } from '../hooks/useTypewriter';
import { getMinFps } from '../hooks/useSimBridge';

// End-game overlay. Shown once per save when a single run's earnings reach WIN_THRESHOLD.
// The game loop and auto-publisher freeze while `showWinScreen` is set (see useSimBridge).

const SPEECH_LINES = [
  'Wow, event driven architecture really turned my business around!',
  "Why didn't I do this sooner?",
];

const CONFETTI_COLORS = ['#22d3ee', '#f59e0b', '#fbbf24', '#f8fafc', '#a855f7', '#34d399'];
const BURST_COUNT = 160;           // per cannon, fired from each bottom corner at mount
const RAIN_DURATION_MS = 9000;     // gentle fall from the top for this long
const RAIN_PER_SECOND = 40;

type Particle = {
  x: number; y: number;
  vx: number; vy: number;
  w: number; h: number;
  rot: number; vr: number;
  color: string;
};

function spawnBurst(particles: Particle[], originX: number, originY: number, dirX: number) {
  for (let i = 0; i < BURST_COUNT; i++) {
    const speed = 600 + Math.random() * 700;
    // Aim up and toward the center, with spread
    const angle = -Math.PI / 2 + dirX * (Math.PI / 5) + (Math.random() - 0.5) * (Math.PI / 3);
    particles.push({
      x: originX, y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 12,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    });
  }
}

function spawnRain(particles: Particle[], width: number) {
  particles.push({
    x: Math.random() * width, y: -12,
    vx: (Math.random() - 0.5) * 60,
    vy: 80 + Math.random() * 120,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 4,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 6,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  });
}

function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const particles: Particle[] = [];
    spawnBurst(particles, 0, canvas.height, 1);
    spawnBurst(particles, canvas.width, canvas.height, -1);

    const start = performance.now();
    let last = start;
    let rainAccumulator = 0;
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const elapsed = now - start;

      if (elapsed < RAIN_DURATION_MS) {
        rainAccumulator += dt * RAIN_PER_SECOND;
        while (rainAccumulator >= 1) {
          spawnRain(particles, canvas.width);
          rainAccumulator -= 1;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.vy += 900 * dt;          // gravity
        p.vx *= 1 - 1.2 * dt;      // air drag
        p.vy *= 1 - 0.6 * dt;
        p.vx += Math.sin(now / 300 + p.rot) * 20 * dt; // flutter
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (p.y > canvas.height + 20) {
          particles.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        // Squash the width with a cosine so pieces look like they tumble in 3D
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.rot * 1.5)), p.h);
        ctx.restore();
      }

      // Keep rendering while anything is on screen or rain is still due
      if (particles.length > 0 || elapsed < RAIN_DURATION_MS) {
        raf = requestAnimationFrame(frame);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />;
}

export function WinScreen() {
  const showWinScreen = useGameStore(s => s.showWinScreen);
  if (!showWinScreen) return null;
  return <WinScreenContent />;
}

function WinScreenContent() {
  const dismissWinScreen = useGameStore(s => s.dismissWinScreen);
  const wipeSaveAndRestart = useGameStore(s => s.wipeSaveAndRestart);
  const prestige = useGameStore(s => s.prestige);
  const eventsConsumed = useGameStore(s => s.eventsConsumed);
  const eventsDropped = useGameStore(s => s.eventsDropped);
  const components = useGameStore(s => s.components);
  // Sampled once at mount: the loop is frozen while this screen is up, so it can't change.
  const [minFps] = useState(() => Math.round(getMinFps()));

  // phase 0 = banner + confetti, 1 = Dave walks in and starts talking
  const [phase, setPhase] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  // After the last line, Dave's "Continue" reveals the Keep Playing / Start Over choice
  const [showChoices, setShowChoices] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setPhase(1), 1400);
    return () => clearTimeout(t);
  }, []);

  const typedText = useTypewriter(SPEECH_LINES[lineIndex], phase >= 1, 25);
  const lineComplete = typedText.length >= SPEECH_LINES[lineIndex].length;
  const isLastLine = lineIndex === SPEECH_LINES.length - 1;

  const stats: { label: string; value: string }[] = [
    { label: 'Events consumed', value: eventsConsumed.toLocaleString() },
    { label: 'Events dropped', value: eventsDropped.toLocaleString() },
    { label: 'Mesh size', value: components.length.toLocaleString() },
    { label: 'Lowest frame rate', value: `${minFps} fps` },
    { label: 'Times prestiged', value: prestige.count.toLocaleString() },
  ];

  return (
    <motion.div
      className="fixed inset-0 overflow-hidden"
      style={{ zIndex: 80, background: 'rgba(5, 8, 18, 0.88)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      {/* Warm gold vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center 35%, rgba(245,158,11,0.18) 0%, transparent 60%)' }}
      />

      <ConfettiCanvas />

      {/* Banner */}
      <div className="absolute inset-x-0 flex flex-col items-center text-center pointer-events-none" style={{ top: '14%' }}>
        <motion.div
          initial={{ scale: 0.4, opacity: 0, rotate: -4 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.15 }}
          className="font-black tracking-tight"
          style={{
            fontSize: 'clamp(40px, 7vw, 88px)',
            color: '#fbbf24',
            textShadow: '0 0 24px rgba(251,191,36,0.55), 0 4px 0 #92400e',
            lineHeight: 1,
          }}
        >
          YOU DID IT!
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.4 }}
          className="text-gray-400 text-sm uppercase tracking-widest mt-4"
        >
          You earned
        </motion.div>
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.65, duration: 0.4 }}
          className="font-mono font-bold text-cyan-300 mt-1"
          style={{ fontSize: 'clamp(22px, 3.2vw, 40px)', textShadow: '0 0 18px rgba(34,211,238,0.5)' }}
        >
          {formatMoney(WIN_THRESHOLD)}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0, duration: 0.4 }}
          className="flex gap-3 mt-7"
        >
          {stats.map(s => (
            <div
              key={s.label}
              className="rounded-lg border border-gray-700 px-4 py-2"
              style={{ background: 'rgba(17,24,39,0.85)', minWidth: 120 }}
            >
              <div className="text-lg font-bold text-white font-mono">{s.value}</div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">{s.label}</div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Dave in the tux + speech bubble */}
      <AnimatePresence>
        {phase >= 1 && (
          <motion.div
            className="absolute bottom-6 right-6 flex items-end gap-10"
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <motion.div
              className="relative rounded-lg border border-gray-700 p-5 shadow-xl text-sm text-gray-200"
              style={{ background: '#111827', width: 420, marginBottom: 110, marginRight: 16 }}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: 0.3 }}
            >
              {/* Once Continue is pressed the bubble holds only the choice buttons */}
              {!showChoices && (
                <div className="leading-relaxed" style={{ minHeight: '2.8em' }}>{typedText}</div>
              )}

              {lineComplete && !isLastLine && (
                <motion.button
                  onClick={() => setLineIndex(i => i + 1)}
                  className="mt-3 w-full px-3 py-1.5 rounded text-xs font-bold cursor-pointer"
                  style={{ background: '#475569', color: '#e2e8f0' }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  Next
                </motion.button>
              )}

              {lineComplete && isLastLine && !showChoices && (
                <motion.button
                  onClick={() => setShowChoices(true)}
                  className="mt-3 w-full px-3 py-1.5 rounded text-xs font-bold cursor-pointer"
                  style={{ background: '#22d3ee', color: '#0a0e1a' }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  Continue
                </motion.button>
              )}

              {showChoices && (
                <motion.div
                  className="flex flex-col gap-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25 }}
                >
                  <button
                    onClick={dismissWinScreen}
                    className="w-full px-3 py-2 rounded text-sm font-bold cursor-pointer"
                    style={{ background: '#22d3ee', color: '#0a0e1a' }}
                  >
                    Keep Playing
                  </button>
                  <button
                    onClick={() => setShowRestartConfirm(true)}
                    className="w-full px-3 py-2 rounded text-sm border border-gray-600 text-gray-300 hover:border-red-500 hover:text-red-300 transition-colors cursor-pointer"
                  >
                    Start Over From Scratch
                  </button>
                  <div className="text-[10px] text-gray-500 text-center">
                    Keep playing to grow the mesh further, or wipe everything and relive the journey.
                  </div>
                </motion.div>
              )}

              {/* Tail toward Dave */}
              <div
                className="absolute -right-2 bottom-3 w-0 h-0"
                style={{ borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: '8px solid #374151' }}
              />
              <div
                className="absolute -right-[7px] bottom-3 w-0 h-0"
                style={{ borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '7px solid #111827' }}
              />
            </motion.div>

            <div className="flex-shrink-0" style={{ transform: 'scale(2.5)', transformOrigin: 'bottom right' }}>
              <PixelCharacter frustrated={false} outfit="tux" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Start-over confirmation */}
      <AnimatePresence>
        {showRestartConfirm && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.6)', zIndex: 1 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowRestartConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="rounded-lg border border-red-800 shadow-xl p-6"
              style={{ background: '#1a0a0a', maxWidth: 420 }}
              onClick={e => e.stopPropagation()}
            >
              <h2 className="text-lg font-bold text-red-400 mb-2">Start Over?</h2>
              <p className="text-sm text-gray-300 mb-4">
                This will permanently wipe <span className="text-red-400 font-semibold">everything</span> — your
                balance, mesh layout, upgrades, and all Schema Registry prestige points — and take you back to
                the very beginning, including the intro sequence. This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRestartConfirm(false)}
                  className="flex-1 px-3 py-2 rounded text-sm border border-gray-600 text-gray-300 hover:border-gray-400 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={wipeSaveAndRestart}
                  className="flex-1 px-3 py-2 rounded text-sm font-bold cursor-pointer"
                  style={{ background: '#dc2626', color: '#fff1f1' }}
                >
                  Wipe Everything
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
