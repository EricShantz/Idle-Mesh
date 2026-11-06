// Gameplay-equivalence check: runs a scenario for a fixed window and records what the player
// would notice (events consumed/dropped per second, income per second, live dots, fps, sim
// ticks/s), plus a screenshot. Compare two labels with compare.mjs.
// usage: node behavior.mjs <scale> <label> [url] [--ticks=<n>]   (env SUBSPEED/PUBSPEED as in prof.mjs)
//   url defaults to the preview server; append ?inlineSim to run the simulation on the main thread.
//   --ticks=<n> caps the bridge at n inputs per second (window.__sim.setMaxTicksPerSec: frame deltas
//   merge into fewer, longer ticks). The per-SIM-second numbers (consumedPerSimSec etc., over the
//   summary's simNow delta) are what must stay flat across tick rates (scale-plan.md Phase B); the
//   per-wall-second ones also fall when the sim dilates (ticks longer than MAX_FRAME_DT_MS).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TICKS = Number((process.argv.find(a => a.startsWith('--ticks=')) ?? '--ticks=0').slice('--ticks='.length)) || 0;
const SCALE = ARGS[0] ?? 'M';
const LABEL = ARGS[1] ?? 'run';
const PAGE_URL = ARGS[2] ?? 'http://localhost:5198/Idle-Mesh/';
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
if (TICKS > 0) await page.evaluate(n => window.__sim.setMaxTicksPerSec(n), TICKS);
// Zoom out (wheel on the mesh, x0.7 per step) so tall scenarios are actually on screen
for (let z = 0; z < (CFG.zoomOutSteps ?? 0); z++) { await page.mouse.move(60, 60); await page.mouse.wheel(0, 100); await page.waitForTimeout(50); }
await page.waitForTimeout(WARMUP_MS);

const r = await page.evaluate((ms) => new Promise(res => {
  const s0 = window.useGameStore.getState();
  const start = { consumed: s0.eventsConsumed, dropped: s0.eventsDropped, earned: s0.totalEarned, t: performance.now(), stats: window.__sim.stats(), simNow: window.__sim.summary()?.simNow ?? 0 };
  const dotSamples = []; const queuedSamples = []; const pausingSamples = []; const tickRateSamples = [];
  // Events (a bundle dot stands for `count` events) next to dots: liveEvents / <status>Events
  const eventSamples = []; const queuedEventSamples = []; const pausingEventSamples = [];
  // Relays per broker in the trailing second (the summary's brokerRelayCounts) and the events
  // published in the trailing second (the store's recentPublishes), for relays per published event
  const relaySamples = {}; let relaySampleCount = 0; const publishSamples = [];
  // byStatus is a round trip to the sim worker (the dots live there); liveDots is the latest summary's count
  const sampler = setInterval(async () => {
    const by = await window.__sim.byStatus();
    dotSamples.push(window.__sim.liveDots());
    eventSamples.push(window.__sim.liveEvents?.() ?? window.__sim.liveDots());
    queuedSamples.push(by.queued ?? 0);
    pausingSamples.push(by.pausing ?? 0);
    queuedEventSamples.push(by.queuedEvents ?? by.queued ?? 0);
    pausingEventSamples.push(by.pausingEvents ?? by.pausing ?? 0);
    tickRateSamples.push(window.__sim.ticksPerSec());
    for (const [id, n] of Object.entries(window.__sim.summary()?.brokerRelayCounts ?? {})) relaySamples[id] = (relaySamples[id] ?? 0) + n;
    relaySampleCount++;
    const tNow = Date.now();
    publishSamples.push(window.useGameStore.getState().recentPublishes.reduce((acc, e) => acc + (tNow - e.time <= 1000 ? e.count : 0), 0));
  }, 500);
  let frames = 0;
  const tick = (t) => { frames++; if (t - start.t < ms) requestAnimationFrame(tick); else finish(t); };
  const finish = (t) => {
    clearInterval(sampler);
    const s = window.useGameStore.getState();
    const sec = (t - start.t) / 1000;
    // Sim seconds elapsed over the window (the summary's simNow is the sum of the clamped dts the
    // sim stepped by); equal to wall seconds unless the sim dilated. The store counters and simNow
    // both come from the last landed tick, so the per-sim-second rates are consistent.
    const simSec = ((window.__sim.summary()?.simNow ?? 0) - start.simNow) / 1000;
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
      sectionMsPerTick: Object.fromEntries(Object.keys(st.sections).map(k => [k, +((st.sections[k] - start.stats.sections[k]) / ticks).toFixed(2)])),
      lateInputPct: +(100 * d('inputsLate') / Math.max(1, d('framesSent') + d('framesBusy'))).toFixed(1),
      // inputs over MAX_FRAME_DT_MS and the sim time the clamp discarded (why simSeconds < seconds)
      inputsClamped: d('inputsClamped'), clampLostMs: +d('clampLostMs').toFixed(0), maxInputDtMs: +st.maxInputDtMs.toFixed(0),
      mergedFramePct: +(100 * (d('framesBusy') - d('inputsLate')) / Math.max(1, d('framesSent') + d('framesBusy'))).toFixed(1),
      consumedPerSec: +((s.eventsConsumed - start.consumed) / sec).toFixed(1),
      droppedPerSec: +((s.eventsDropped - start.dropped) / sec).toFixed(2),
      earnedPerSec: +((s.totalEarned - start.earned) / sec).toFixed(2),
      maxTicksPerSec: window.__sim.maxTicksPerSec?.() ?? 0,
      simSeconds: +simSec.toFixed(2),
      consumedPerSimSec: +((s.eventsConsumed - start.consumed) / Math.max(simSec, 1e-9)).toFixed(1),
      droppedPerSimSec: +((s.eventsDropped - start.dropped) / Math.max(simSec, 1e-9)).toFixed(2),
      earnedPerSimSec: +((s.totalEarned - start.earned) / Math.max(simSec, 1e-9)).toFixed(2),
      avgLiveDots: avg(dotSamples), maxLiveDots: Math.max(...dotSamples),
      avgQueued: avg(queuedSamples), avgPausing: avg(pausingSamples),
      avgLiveEvents: avg(eventSamples), maxLiveEvents: Math.max(...eventSamples),
      avgQueuedEvents: avg(queuedEventSamples), avgPausingEvents: avg(pausingEventSamples),
      publishedEventsPerSec: avg(publishSamples),
      brokerRelaysPerSec: Object.fromEntries(Object.entries(relaySamples).map(([id, n]) => [id, +(n / Math.max(1, relaySampleCount)).toFixed(0)])),
      relaysPerPublishedEvent: Object.fromEntries(Object.entries(relaySamples).map(([id, n]) => [id, +(n / Math.max(1, relaySampleCount) / Math.max(1, avg(publishSamples))).toFixed(2)])),
      coinPopsNow: s.coinPops.length,
      renderer: window.__eventCanvasRenderer, simMode: window.__sim.mode(), cards: s.components.length, connections: s.connections.length,
    });
  };
  requestAnimationFrame(tick);
}), WINDOW_MS);

const outDir = fileURLToPath(new URL('./.out/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
r.errors = errors.slice(0, 5);
fs.writeFileSync(path.join(outDir, `behavior-${LABEL}-${SCALE}.json`), JSON.stringify(r, null, 2));
console.log(`[${LABEL} ${SCALE}]`, JSON.stringify(r));
// A swamped main thread (overloaded scenarios) can make the screenshot time out; the numbers are already saved.
await page.screenshot({ path: path.join(outDir, `shot-${LABEL}-${SCALE}.png`), timeout: 60000 }).catch(e => console.warn('screenshot skipped:', String(e.message).slice(0, 60)));
await browser.close();
