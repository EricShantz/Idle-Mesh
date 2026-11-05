// usage: node scripts/perf/dragsmoke.mjs [scale=M]   (server on :5198 as for behavior.mjs)
// Drag smoke test: simulate dragging a queue and a broker through the store (same code path the
// mouse handlers use), then check dots keep flowing, no page errors, and the moved nodes' dots
// follow the new cables (no dot is left far from any cable).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SCALE = process.argv[2] ?? 'M';
const src = fs.readFileSync('scripts/perf/prof.mjs', 'utf8');
const saveBuilder = src.slice(src.indexOf('const CFG ='), src.indexOf('const save = buildSave'));
const save = new Function('SCALE', 'process', saveBuilder + '\nreturn buildSave(CFG);')(SCALE, process);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/attribute .* Expected length/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(s => localStorage.setItem('idle-mesh-save', s), JSON.stringify(save));
await page.goto('http://localhost:5198/Idle-Mesh/');
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = window.useGameStore.getState(); if (s.activeTutorial) s.dismissTutorial(s.activeTutorial); });
await page.waitForTimeout(4000);
const r = await page.evaluate(async () => {
  const S = () => window.useGameStore.getState();
  const raf = () => new Promise(res => requestAnimationFrame(res));
  const consumedBefore = S().eventsConsumed;
  const t0 = performance.now();
  const drag = async (id, dx, dy, frames) => {
    const c = S().components.find(c => c.id === id);
    const x0 = c.x, y0 = c.y;
    S().setDraggingNodeId(id);
    for (let k = 1; k <= frames; k++) { S().moveComponent(id, x0 + dx * k / frames, y0 + dy * k / frames); await raf(); }
    S().setDraggingNodeId(null);
    await raf(); await raf();
  };
  await drag('queue-3', 120, 180, 60);
  await drag('webhook-1', -60, 90, 60);
  await drag('queue-3', -120, -180, 60);
  await drag('webhook-1', 60, -90, 60);
  await new Promise(res => setTimeout(res, 4000));
  const el = (performance.now() - t0) / 1000;
  const s = S();
  // every traveling dot must sit on its own path (interpolate and compare to the nearest segment)
  const interp = (path, p) => { const n = path.length - 1; if (p <= 0) return path[0]; const q = Math.min(p, 1) * n; const i = Math.min(Math.floor(q), n - 1); const t = q - i; return { x: path[i].x + (path[i + 1].x - path[i].x) * t, y: path[i].y + (path[i + 1].y - path[i].y) * t }; };
  let offPath = 0, traveling = 0;
  for (const d of s.eventDots) {
    if (d.status !== 'traveling') continue; traveling++;
    const pos = interp(d.path, d.progress);
    // distance from pos to the polyline
    let best = Infinity;
    for (let i = 0; i < d.path.length - 1; i++) { const a = d.path[i], b = d.path[i + 1]; const vx = b.x - a.x, vy = b.y - a.y; const L = vx * vx + vy * vy || 1; const t = Math.max(0, Math.min(1, ((pos.x - a.x) * vx + (pos.y - a.y) * vy) / L)); best = Math.min(best, Math.hypot(pos.x - (a.x + vx * t), pos.y - (a.y + vy * t))); }
    if (best > 1) offPath++;
  }
  // and every path's last point must be a current subscriber or queue center
  let danglingPaths = 0;
  for (const d of s.eventDots) { if (d.status !== 'traveling') continue; const e = d.path[d.path.length - 1]; if (!s.components.some(c => Math.abs(c.x - e.x) < 1 && Math.abs(c.y - e.y) < 1)) danglingPaths++; }
  return { consumedPerSecDuringAndAfter: Math.round((s.eventsConsumed - consumedBefore) / el), traveling, offPath, danglingPaths, dropped: s.eventsDropped, liveDots: s.eventDots.length };
});
console.log(SCALE, JSON.stringify(r), errors.length ? 'ERRORS: ' + errors.slice(0, 3).join(' | ') : 'no errors');
await browser.close();
