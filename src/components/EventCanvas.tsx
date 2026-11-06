import { useEffect, useRef } from 'react';
import { useViewport } from '../hooks/useViewport';
import { getPositions } from '../sim/simBridge';
import { FLOATS_PER_DOT, DOT_RADIUS, GLOW_RADIUS, GLOW_EXTENT, GLOW_DROPPED, GLOW_PAUSING } from '../sim/positions';

// The dots are drawn from the position buffer the sim fills once per tick (src/sim/positions.ts:
// [x, y, extent, r, g, b, a, glow] per drawable dot). The canvas never sees dot objects or the
// store; the interpolation, queue snap, pausing shrink and color parsing live in the sim.
//
// Two canvases, because pausing dots sit above the node cards (z-index 25) while every other dot
// sits below them (19). Both are WebGL point-sprite surfaces fed the same buffer; a per-context
// uniform tells the vertex shader which half of the entries to keep (glow 2 on the front canvas,
// everything else on the back). The 2D sprite path is the fallback for either canvas when WebGL
// is unavailable.

// Sprites are rendered at this many pixels per world unit so they stay sharp when zoomed in.
const SPRITE_PX_PER_UNIT = 8;

// ---------------------------------------------------------------------------------------------
// 2D path: the whole-scene fallback when WebGL is unavailable (either canvas).
// ---------------------------------------------------------------------------------------------

// A live dot is a solid core with a radial-gradient glow over it. Both only depend on the
// dot's color, so the whole thing is rendered once per color to an offscreen canvas (core
// first, then the glow on top) and stamped with a single drawImage per dot.
const dotSprites = new Map<string, HTMLCanvasElement>();
function getDotSprite(color: string): HTMLCanvasElement {
  const cached = dotSprites.get(color);
  if (cached) return cached;
  const size = Math.ceil(GLOW_EXTENT * 2 * SPRITE_PX_PER_UNIT);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d')!;
  const c = size / 2;
  sctx.fillStyle = color;
  sctx.beginPath();
  sctx.arc(c, c, DOT_RADIUS * SPRITE_PX_PER_UNIT, 0, Math.PI * 2);
  sctx.fill();
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
  dotSprites.set(color, sprite);
  return sprite;
}

// '#rrggbb' for an entry's r, g, b floats (the sprite cache key and the dropped-dot fill).
// Colors round-trip exactly: the sim parsed them from 8-bit hex.
const cssColors = new Map<number, string>();
function cssColor(r: number, g: number, b: number): string {
  const key = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  let css = cssColors.get(key);
  if (!css) {
    css = '#' + key.toString(16).padStart(6, '0');
    cssColors.set(key, css);
  }
  return css;
}

/** World-space rectangle currently visible, padded by a glow radius; dots outside it are skipped. */
type ViewRect = { left: number; top: number; right: number; bottom: number };

/** Draws buffer entry at float offset `o` with the 2D API. */
function drawEntry(ctx: CanvasRenderingContext2D, data: Float32Array, o: number, view: ViewRect) {
  const x = data[o];
  const y = data[o + 1];
  const color = cssColor(data[o + 3], data[o + 4], data[o + 5]);
  if (data[o + 7] === GLOW_DROPPED) {
    ctx.globalAlpha = data[o + 6];
    ctx.beginPath();
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    if (x < view.left || x > view.right || y < view.top || y > view.bottom) return;
    // Core + glow in one stamp — the entry's alpha already carries the dot's opacity/shrink fade
    // and its extent the pausing shrink
    const extent = data[o + 2];
    ctx.globalAlpha = data[o + 6];
    ctx.drawImage(getDotSprite(color), x - extent, y - extent, extent * 2, extent * 2);
  }

  ctx.globalAlpha = 1;
}

/** 2D fallback: clear the canvas and stamp every entry whose `front`-ness matches the canvas. */
function render2d(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  data: Float32Array,
  count: number,
  front: boolean,
  view: ViewRect,
  tx: number,
  ty: number,
  s: number,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (count === 0) return;
  ctx.setTransform(s, 0, 0, s, tx, ty);
  for (let i = 0; i < count; i++) {
    const o = i * FLOATS_PER_DOT;
    if ((data[o + 7] === GLOW_PAUSING) === front) drawEntry(ctx, data, o, view);
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL path. Every dot is one point-sprite vertex; the fragment shader reproduces the 2D sprite
// (solid core, radial glow clipped at GLOW_RADIUS) so the look is the same. The position buffer
// is uploaded as-is (its layout is the vertex layout) in one buffer upload and one draw call per
// canvas per frame, so drawing no longer costs a canvas API call per dot — at several thousand
// dots the per-dot drawImage calls were the biggest single slice of the frame (first on the back
// canvas, then, at ~10k pausing dots in the late game, on the front one). Each context draws its
// own half of the buffer: `u_front` selects pausing entries (glow 2) on the front canvas and
// everything else on the back one; the vertex shader clips the rest away. A pausing entry's
// shrink is already in its extent and alpha, so the point sprite shrinks exactly as the 2D stamp
// did.
// ---------------------------------------------------------------------------------------------

const VERT_SRC = `
attribute vec2 a_pos;
attribute float a_extent;
attribute vec4 a_color;
attribute float a_glow;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_dpr;
uniform vec2 u_res;
uniform float u_front;
varying vec4 v_color;
varying float v_glow;
varying float v_px;
void main() {
  // pausing dots (glow 2) belong to the front canvas, the rest to the back: clip the other half
  if ((a_glow > 1.5) != (u_front > 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    v_px = 1.0;
    v_color = vec4(0.0);
    v_glow = 0.0;
    return;
  }
  vec2 screen = (a_pos * u_zoom + u_pan) * u_dpr;
  vec2 clip = screen / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float px = a_extent * 2.0 * u_zoom * u_dpr;
  gl_PointSize = px;
  v_px = px;
  v_color = a_color;
  v_glow = a_glow;
}`;

// Ratios of the 2D sprite, as fractions of the point's half-size (GLOW_EXTENT):
//   core edge   = DOT_RADIUS / GLOW_EXTENT
//   glow start  = (DOT_RADIUS / 2) / GLOW_EXTENT   (gradient's inner stop, alpha 0x88)
//   glow clip   = GLOW_RADIUS / GLOW_EXTENT         (the arc the gradient was filled within)
const FRAG_SRC = `
precision mediump float;
varying vec4 v_color;
varying float v_glow;
varying float v_px;
const float CORE = ${(DOT_RADIUS / GLOW_EXTENT).toFixed(5)};
const float INNER = ${((DOT_RADIUS / 2) / GLOW_EXTENT).toFixed(5)};
const float GLOWR = ${(GLOW_RADIUS / GLOW_EXTENT).toFixed(5)};
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float fw = 2.0 / max(v_px, 1.0); // about one device pixel, for anti-aliased edges
  float a;
  if (v_glow > 0.5) {
    float core = 1.0 - smoothstep(CORE - fw, CORE + fw, d);
    float g = clamp(1.0 - (d - INNER) / (1.0 - INNER), 0.0, 1.0) * 0.5333
      * (1.0 - smoothstep(GLOWR - fw, GLOWR + fw, d));
    a = g + core * (1.0 - g); // glow composited over the core, same color
  } else {
    a = 1.0 - smoothstep(1.0 - fw, 1.0, d); // dropped dots: plain disc, extent = DOT_RADIUS
  }
  a *= v_color.a;
  gl_FragColor = vec4(v_color.rgb * a, a); // premultiplied
}`;

type GlRenderer = {
  gl: WebGLRenderingContext;
  uPan: WebGLUniformLocation;
  uZoom: WebGLUniformLocation;
  uDpr: WebGLUniformLocation;
  uRes: WebGLUniformLocation;
};

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('EventCanvas shader failed to compile:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** A WebGL point-sprite renderer on `canvas`; `front` fixes which half of the buffer it draws. */
function createGlRenderer(canvas: HTMLCanvasElement, front: boolean): GlRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  });
  if (!gl) return null;
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('EventCanvas program failed to link:', gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = FLOATS_PER_DOT * 4;
  const attr = (name: string, size: number, offsetFloats: number) => {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offsetFloats * 4);
  };
  attr('a_pos', 2, 0);
  attr('a_extent', 1, 2);
  attr('a_color', 4, 3);
  attr('a_glow', 1, 7);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name)!;
  gl.uniform1f(u('u_front'), front ? 1 : 0); // fixed for the life of the context
  return { gl, uPan: u('u_pan'), uZoom: u('u_zoom'), uDpr: u('u_dpr'), uRes: u('u_res') };
}

/** Clear, upload the position buffer (`count` entries) and draw this canvas's half in one call. */
function renderGl(
  r: GlRenderer,
  canvas: HTMLCanvasElement,
  data: Float32Array,
  count: number,
  vp: { panX: number; panY: number; zoom: number },
  dpr: number,
) {
  const { gl } = r;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (count === 0) return;
  gl.uniform2f(r.uPan, vp.panX, vp.panY);
  gl.uniform1f(r.uZoom, vp.zoom);
  gl.uniform1f(r.uDpr, dpr);
  gl.uniform2f(r.uRes, canvas.width, canvas.height);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * FLOATS_PER_DOT), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.POINTS, 0, count);
}

// ---------------------------------------------------------------------------------------------
// A drawing surface: one canvas with either a WebGL renderer or the 2D fallback. Decided once —
// a canvas can't switch context types after the first getContext. A lost GL context (GPU reset,
// too many contexts) is recreated on restore; nothing is drawn on that canvas in between.
// ---------------------------------------------------------------------------------------------

type Surface = {
  canvas: HTMLCanvasElement;
  glr: GlRenderer | null;
  ctx: CanvasRenderingContext2D | null; // the 2D fallback, only when WebGL was unavailable
  dispose: () => void;
};

function createSurface(canvas: HTMLCanvasElement, front: boolean): Surface {
  const surface: Surface = { canvas, glr: createGlRenderer(canvas, front), ctx: null, dispose: () => {} };
  if (surface.glr) {
    const onLost = (e: Event) => { e.preventDefault(); surface.glr = null; };
    const onRestored = () => { surface.glr = createGlRenderer(canvas, front); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    surface.dispose = () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  } else {
    surface.ctx = canvas.getContext('2d');
  }
  return surface;
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

    const back = createSurface(backCanvas, false);
    const front = createSurface(frontCanvas, true);
    const glCount = (back.glr ? 1 : 0) + (front.glr ? 1 : 0);
    (window as unknown as { __eventCanvasRenderer?: string }).__eventCanvasRenderer =
      glCount === 2 ? 'webgl' : glCount === 0 ? '2d' : 'mixed';

    // Assigning canvas.width/height reallocates the backing store (and implicitly clears), so
    // only do it when the on-screen size or DPR actually changes — not every frame.
    let sizedW = 0;
    let sizedH = 0;
    let sizedDpr = 0;
    // The front canvas only ever holds pausing dots. Skip its clear, upload and draw on frames
    // where it was empty and stays empty (most of the early game).
    let frontHadContent = false;

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

      const { buf, count } = getPositions();
      let hasPausing = false;
      for (let i = 0; i < count; i++) {
        if (buf[i * FLOATS_PER_DOT + 7] === GLOW_PAUSING) { hasPausing = true; break; }
      }

      const vp = viewportApi.ref.current;
      const tx = vp.panX * dpr;
      const ty = vp.panY * dpr;
      const s = vp.zoom * dpr;

      // Visible world rect (padded by a glow radius) for the 2D path's culling
      const view: ViewRect = {
        left: -vp.panX / vp.zoom - GLOW_EXTENT,
        top: -vp.panY / vp.zoom - GLOW_EXTENT,
        right: (width - vp.panX) / vp.zoom + GLOW_EXTENT,
        bottom: (height - vp.panY) / vp.zoom + GLOW_EXTENT,
      };

      // Front canvas: pausing dots only
      if (frontHadContent || hasPausing) {
        const n = hasPausing ? count : 0; // 0 entries = clear only
        if (front.glr) {
          renderGl(front.glr, frontCanvas, buf, n, vp, dpr);
        } else if (front.ctx) {
          render2d(front.ctx, frontCanvas, buf, n, true, view, tx, ty, s);
        }
      }
      frontHadContent = hasPausing;

      // Back canvas: everything else
      if (back.glr) {
        renderGl(back.glr, backCanvas, buf, count, vp, dpr);
      } else if (back.ctx) {
        render2d(back.ctx, backCanvas, buf, count, false, view, tx, ty, s);
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animRef.current);
      back.dispose();
      front.dispose();
    };
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
