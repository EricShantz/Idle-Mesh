// Gameplay-equivalence check: runs a scenario for a fixed window and records what the player
// would notice (events consumed/dropped per second, income per second, live dots, fps, sim
// ticks/s), plus a screenshot. Compare two labels with compare.mjs.
// usage: node behavior.mjs <scale> <label> [url]   (env SUBSPEED/PUBSPEED as in prof.mjs)
//   url defaults to the preview server; append ?inlineSim to run the simulation on the main thread.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCALE = process.argv[2] ?? 'M';
const LABEL = process.argv[3] ?? 'run';
const PAGE_URL = process.argv[4] ?? 'http://localhost:5198/Idle-Mesh/';
const EXE = process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const WARMUP_MS = 6000;
const WINDOW_MS = 15000;

const src = fs.readFileSync(new URL('./prof.mjs', import.meta.url), 'utf8');
const saveBuilder = src.slice(src.indexOf('const CFG ='), src.indexOf('const save = buildSave'));
const { save, CFG } = new Function('SCALE', 'process', saveBuilder + '\nreturn { save: buildSave(CFG), CFG };')(SCALE, process);

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/attribute .* Expected length/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(s => localStorage.setItem('idle-mesh-save', s), JSON.stringify(save));
await page.goto(PAGE_URL);
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = window.useGameStore.getState(); if (s.activeTutorial) s.dismissTutorial(s.activeTutorial); });
// Zoom out (wheel on the mesh, x0.7 per step) so tall scenarios are actually on screen
for (let z = 0; z < (CFG.zoomOutSteps ?? 0); z++) { await page.mouse.move(60, 60); await page.mouse.wheel(0, 100); await page.waitForTimeout(50); }
await page.waitForTimeout(WARMUP_MS);

const r = await page.evaluate((ms) => new Promise(res => {
  const s0 = window.useGameStore.getState();
  const start = { consumed: s0.eventsConsumed, dropped: s0.eventsDropped, earned: s0.totalEarned, t: performance.now(), stats: window.__sim.stats() };
  const dotSamples = []; const queuedSamples = []; const pausingSamples = []; const tickRateSamples = [];
  // byStatus is a round trip to the sim worker (the dots live there); liveDots is the latest summary's count
  const sampler = setInterval(async () => {
    const by = await window.__sim.byStatus();
    dotSamples.push(window.__sim.liveDots());
    queuedSamples.push(by.queued ?? 0);
    pausingSamples.push(by.pausing ?? 0);
    tickRateSamples.push(window.__sim.ticksPerSec());
  }, 500);
  let frames = 0;
  const tick = (t) => { frames++; if (t - start.t < ms) requestAnimationFrame(tick); else finish(t); };
  const finish = (t) => {
    clearInterval(sampler);
    const s = window.useGameStore.getState();
    const sec = (t - start.t) / 1000;
    const avg = a => +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(0);
    // sim timing over the window: ms per tick on the sim's thread, post->receive round trip (worker only),
    // the share of frames whose input went out late (the previous tick had not returned at the frame) and
    // the share of frames whose input never went out on its own (the next frame came first; deltas merged)
    const st = window.__sim.stats(), d = k => st[k] - start.stats[k];
    const ticks = Math.max(1, d('ticks'));
    res({
      seconds: +sec.toFixed(2),
      realFps: +(frames / sec).toFixed(1),
      simTicksPerSec: +(tickRateSamples.reduce((x, y) => x + y, 0) / Math.max(1, tickRateSamples.length)).toFixed(1),
      tickMs: +(d('tickMsTotal') / ticks).toFixed(2), roundTripMs: +(d('roundTripMsTotal') / ticks).toFixed(2),
      lateInputPct: +(100 * d('inputsLate') / Math.max(1, d('framesSent') + d('framesBusy'))).toFixed(1),
      mergedFramePct: +(100 * (d('framesBusy') - d('inputsLate')) / Math.max(1, d('framesSent') + d('framesBusy'))).toFixed(1),
      consumedPerSec: +((s.eventsConsumed - start.consumed) / sec).toFixed(1),
      droppedPerSec: +((s.eventsDropped - start.dropped) / sec).toFixed(2),
      earnedPerSec: +((s.totalEarned - start.earned) / sec).toFixed(2),
      avgLiveDots: avg(dotSamples), maxLiveDots: Math.max(...dotSamples),
      avgQueued: avg(queuedSamples), avgPausing: avg(pausingSamples),
      coinPopsNow: s.coinPops.length,
      renderer: window.__eventCanvasRenderer, simMode: window.__sim.mode(), cards: s.components.length, connections: s.connections.length,
    });
  };
  requestAnimationFrame(tick);
}), WINDOW_MS);

const outDir = fileURLToPath(new URL('./.out/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
await page.screenshot({ path: path.join(outDir, `shot-${LABEL}-${SCALE}.png`) });
r.errors = errors.slice(0, 5);
fs.writeFileSync(path.join(outDir, `behavior-${LABEL}-${SCALE}.json`), JSON.stringify(r, null, 2));
console.log(`[${LABEL} ${SCALE}]`, JSON.stringify(r));
await browser.close();
