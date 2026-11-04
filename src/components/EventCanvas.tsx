import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { interpolatePath } from '../utils/pathUtils';
import { useViewport } from '../hooks/useViewport';

const CONSUME_DURATION = 2500; // ms — how long the dot pauses at subscriber

type Dot = ReturnType<typeof useGameStore.getState>['eventDots'][0];
type Component = ReturnType<typeof useGameStore.getState>['components'][0];

const DOT_RADIUS = 2.5;
const GLOW_RADIUS = 4.5;
const GLOW_EXTENT = GLOW_RADIUS + 2; // world units from dot center to the glow's outer edge
// Sprites are rendered at this many pixels per world unit so they stay sharp when zoomed in.
const SPRITE_PX_PER_UNIT = 8;

// The glow was a createRadialGradient + gradient fill per dot per frame — the single most
// expensive draw call available, run a few hundred times a frame at high throughput. The
// gradient only depends on the dot's color, so render it once per color to an offscreen
// canvas and drawImage it.
const glowSprites = new Map<string, HTMLCanvasElement>();
function getGlowSprite(color: string): HTMLCanvasElement {
  const cached = glowSprites.get(color);
  if (cached) return cached;
  const size = Math.ceil(GLOW_EXTENT * 2 * SPRITE_PX_PER_UNIT);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d')!;
  const c = size / 2;
  const gradient = sctx.createRadialGradient(
    c, c, Math.max(1, (DOT_RADIUS / 2) * SPRITE_PX_PER_UNIT),
    c, c, GLOW_EXTENT * SPRITE_PX_PER_UNIT,
  );
  gradient.addColorStop(0, color + '88');
  gradient.addColorStop(1, color + '00');
  sctx.fillStyle = gradient;
  sctx.beginPath();
  sctx.arc(c, c, GLOW_RADIUS * SPRITE_PX_PER_UNIT, 0, Math.PI * 2);
  sctx.fill();
  glowSprites.set(color, sprite);
  return sprite;
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  dot: Dot,
  componentById: Map<string, Component>,
  subscribers: Component[],
) {
  ctx.globalAlpha = Math.max(0, dot.opacity);

  if (dot.status === 'traveling' || dot.status === 'pausing' || dot.status === 'queued') {
    let pos = interpolatePath(dot.path, Math.min(dot.progress, 1));

    // Snap queued dots to their queue node center so they don't peek out
    if (dot.status === 'queued' && dot.queuedAtNodeId) {
      const queue = componentById.get(dot.queuedAtNodeId);
      if (queue) pos = { x: queue.x, y: queue.y };
    }

    // Calculate shrink scale for pausing dots
    let scale = 1;
    if (dot.status === 'pausing') {
      // Find the subscriber this dot is at and check fasterConsumption
      const subscriberPos = dot.path[dot.path.length - 1];
      let fasterConsumptionLevel = 0;
      for (const sub of subscribers) {
        if (Math.hypot(sub.x - subscriberPos.x, sub.y - subscriberPos.y) < 1) {
          fasterConsumptionLevel = sub.upgrades['fasterConsumption'] ?? 0;
          break;
        }
      }
      const effectiveConsumeDuration = CONSUME_DURATION * Math.pow(0.95, fasterConsumptionLevel);

      const elapsed = Date.now() - (dot.pauseStartTime ?? 0);
      const shrinkProgress = Math.max(0, 1 - elapsed / effectiveConsumeDuration);
      scale = shrinkProgress;
      ctx.globalAlpha = Math.max(0, dot.opacity * shrinkProgress);
    }

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, DOT_RADIUS * scale, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();

    // Glow effect — globalAlpha already carries the dot's opacity/shrink fade
    const extent = GLOW_EXTENT * scale;
    ctx.drawImage(getGlowSprite(dot.color), pos.x - extent, pos.y - extent, extent * 2, extent * 2);
  } else if (dot.status === 'dropped') {
    const x = dot.dropX ?? dot.path[0].x;
    const y = dot.dropY ?? dot.path[0].y;

    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

export function EventCanvas() {
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const viewportApi = useViewport();

  useEffect(() => {
    const backCanvas = backCanvasRef.current;
    const frontCanvas = frontCanvasRef.current;
    if (!backCanvas || !frontCanvas) return;

    const backCtx = backCanvas.getContext('2d')!;
    const frontCtx = frontCanvas.getContext('2d')!;

    // Assigning canvas.width/height reallocates the backing store (and implicitly clears), so
    // only do it when the on-screen size or DPR actually changes — not every frame.
    let sizedW = 0;
    let sizedH = 0;
    let sizedDpr = 0;

    const render = () => {
      const width = backCanvas.clientWidth;
      const height = backCanvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      if (width !== sizedW || height !== sizedH || dpr !== sizedDpr) {
        sizedW = width;
        sizedH = height;
        sizedDpr = dpr;
        backCanvas.width = width * dpr;
        backCanvas.height = height * dpr;
        frontCanvas.width = width * dpr;
        frontCanvas.height = height * dpr;
      }

      // Clear
      backCtx.setTransform(1, 0, 0, 1, 0, 0);
      frontCtx.setTransform(1, 0, 0, 1, 0, 0);
      backCtx.clearRect(0, 0, backCanvas.width, backCanvas.height);
      frontCtx.clearRect(0, 0, frontCanvas.width, frontCanvas.height);

      // Apply viewport transform: DPR scaling + pan + zoom
      const vp = viewportApi.ref.current;
      const tx = vp.panX * dpr;
      const ty = vp.panY * dpr;
      const s = vp.zoom * dpr;
      backCtx.setTransform(s, 0, 0, s, tx, ty);
      frontCtx.setTransform(s, 0, 0, s, tx, ty);

      const { eventDots: dots, components } = useGameStore.getState();

      // Per-frame lookups so drawDot doesn't linearly search components per dot
      const componentById = new Map<string, Component>();
      const subscribers: Component[] = [];
      for (const c of components) {
        componentById.set(c.id, c);
        if (c.type === 'subscriber') subscribers.push(c);
      }

      for (const dot of dots) {
        if (dot.status === 'pausing') {
          drawDot(frontCtx, dot, componentById, subscribers);
        } else {
          drawDot(backCtx, dot, componentById, subscribers);
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [viewportApi]);

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
