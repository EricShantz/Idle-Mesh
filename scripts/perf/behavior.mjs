// Gameplay-equivalence check: runs a scenario for a fixed window and records what the player
// would notice (events consumed/dropped per second, income per second, live dots, fps), plus a
// screenshot. Compare two labels with compare.mjs.
// usage: node behavior.mjs <scale> <label> [url]   (env SUBSPEED/PUBSPEED as in prof.mjs)
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
const save = new Function('SCALE', 'process', saveBuilder + '\nreturn buildSave(CFG);')(SCALE, process);

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/attribute .* Expected length/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(s => localStorage.setItem('idle-mesh-save', s), JSON.stringify(save));
await page.goto(PAGE_URL);
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = window.useGameStore.getState(); if (s.activeTutorial) s.dismissTutorial(s.activeTutorial); });
await page.waitForTimeout(WARMUP_MS);

const r = await page.evaluate((ms) => new Promise(res => {
  const s0 = window.useGameStore.getState();
  const start = { consumed: s0.eventsConsumed, dropped: s0.eventsDropped, earned: s0.totalEarned, t: performance.now() };
  const dotSamples = []; const queuedSamples = []; const pausingSamples = [];
  const sampler = setInterval(() => {
    const d = window.useGameStore.getState().eventDots;
    dotSamples.push(d.length);
    queuedSamples.push(d.filter(x => x.status === 'queued').length);
    pausingSamples.push(d.filter(x => x.status === 'pausing').length);
  }, 500);
  let frames = 0;
  const tick = (t) => { frames++; if (t - start.t < ms) requestAnimationFrame(tick); else finish(t); };
  const finish = (t) => {
    clearInterval(sampler);
    const s = window.useGameStore.getState();
    const sec = (t - start.t) / 1000;
    const avg = a => +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(0);
    res({
      seconds: +sec.toFixed(2),
      realFps: +(frames / sec).toFixed(1),
      consumedPerSec: +((s.eventsConsumed - start.consumed) / sec).toFixed(1),
      droppedPerSec: +((s.eventsDropped - start.dropped) / sec).toFixed(2),
      earnedPerSec: +((s.totalEarned - start.earned) / sec).toFixed(2),
      avgLiveDots: avg(dotSamples), maxLiveDots: Math.max(...dotSamples),
      avgQueued: avg(queuedSamples), avgPausing: avg(pausingSamples),
      coinPopsNow: s.coinPops.length,
      cards: s.components.length, connections: s.connections.length,
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
