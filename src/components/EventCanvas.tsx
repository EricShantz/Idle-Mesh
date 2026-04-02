import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';

const CONSUME_DURATION = 2500; // ms — how long the dot pauses at subscriber

function drawDot(
  ctx: CanvasRenderingContext2D,
  dot: ReturnType<typeof useGameStore.getState>['eventDots'][0],
  components: ReturnType<typeof useGameStore.getState>['components']
) {
  ctx.globalAlpha = Math.max(0, dot.opacity);

  if (dot.status === 'traveling' || dot.status === 'pausing' || dot.status === 'queued') {
    let pos = interpolatePath(dot.path, Math.min(dot.progress, 1));

    // Snap queued dots to their queue node center so they don't peek out
    if (dot.status === 'queued' && dot.queuedAtNodeId) {
      const queue = components.find(c => c.id === dot.queuedAtNodeId);
      if (queue) pos = { x: queue.x, y: queue.y };
    }

    // Calculate shrink scale for pausing dots
    let scale = 1;
    if (dot.status === 'pausing') {
      // Find the subscriber this dot is at and check fasterConsumption
      const subscriberPos = dot.path[dot.path.length - 1];
      const subscriber = components.find(c =>
        c.type === 'subscriber' && Math.hypot(c.x - subscriberPos.x, c.y - subscriberPos.y) < 1
      );
      const fasterConsumptionLevel = subscriber?.upgrades['fasterConsumption'] ?? 0;
      const effectiveConsumeDuration = CONSUME_DURATION * Math.pow(0.95, fasterConsumptionLevel);

      const elapsed = Date.now() - (dot.pauseStartTime ?? 0);
      const shrinkProgress = Math.max(0, 1 - elapsed / effectiveConsumeDuration);
      scale = shrinkProgress;
      ctx.globalAlpha = Math.max(0, dot.opacity * shrinkProgress);
    }

    const radius = 6 * scale;
    const glowRadius = 10 * scale;

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();

    // Glow effect
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = dot.color.replace(')', ', 0.3)').replace('rgb', 'rgba');
    const gradient = ctx.createRadialGradient(pos.x, pos.y, Math.max(1, radius / 2), pos.x, pos.y, glowRadius + 2);
    gradient.addColorStop(0, dot.color + '88');
    gradient.addColorStop(1, dot.color + '00');
    ctx.fillStyle = gradient;
    ctx.fill();
  } else if (dot.status === 'dropped') {
    const x = dot.dropX ?? dot.path[0].x;
    const y = dot.dropY ?? dot.path[0].y;

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

export function EventCanvas() {
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const backCanvas = backCanvasRef.current;
    const frontCanvas = frontCanvasRef.current;
    if (!backCanvas || !frontCanvas) return;

    const backCtx = backCanvas.getContext('2d')!;
    const frontCtx = frontCanvas.getContext('2d')!;

    const render = () => {
      const { width, height } = backCanvas.getBoundingClientRect();
      backCanvas.width = width;
      backCanvas.height = height;
      frontCanvas.width = width;
      frontCanvas.height = height;

      backCtx.clearRect(0, 0, width, height);
      frontCtx.clearRect(0, 0, width, height);

      const dots = useGameStore.getState().eventDots;
      const { components } = useGameStore.getState();

      for (const dot of dots) {
        if (dot.status === 'pausing') {
          drawDot(frontCtx, dot, components);
        } else {
          drawDot(backCtx, dot, components);
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <>
      <canvas
        ref={backCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 19 }}
      />
      <canvas
        ref={frontCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 25 }}
      />
    </>
  );
}
