// Chrome tracing summary: how much main-thread time goes to style/layout/paint vs script.
// usage: node trace.mjs <scale> [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SCALE = process.argv[2] ?? 'M';
const PAGE_URL = process.argv[3] ?? 'http://localhost:5198/Idle-Mesh/';
const EXE = process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const src = fs.readFileSync(new URL('./prof.mjs', import.meta.url), 'utf8');
const saveBuilder = src.slice(src.indexOf('const CFG ='), src.indexOf('const save = buildSave'));
const save = new Function('SCALE', 'process', saveBuilder + '\nreturn buildSave(CFG);')(SCALE, process);

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(s => localStorage.setItem('idle-mesh-save', s), JSON.stringify(save));
await page.goto(PAGE_URL);
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = window.useGameStore.getState(); if (s.activeTutorial) s.dismissTutorial(s.activeTutorial); });
await page.waitForTimeout(6000);

const cdp = await page.context().newCDPSession(page);
const events = [];
cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
const done = new Promise(r => cdp.on('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', {
  traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'blink.user_timing', 'v8.execute', 'toplevel'] },
  transferMode: 'ReportEvents',
});
const WALL = 6000;
await page.waitForTimeout(WALL);
await cdp.send('Tracing.end');
await done;
const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = t => { n++; if (t - t0 < 2000) requestAnimationFrame(f); else res(+(n / ((t - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); }));
const dots = await page.evaluate(() => window.useGameStore.getState().eventDots.length);
const frozen = await page.evaluate(() => {
  const d = window.useGameStore.getState().eventDots;
  let fd = 0, fp = 0;
  for (const x of d) { if (Object.isFrozen(x)) fd++; if (Object.isFrozen(x.path)) fp++; }
  return { dots: d.length, frozenDots: fd, frozenPaths: fp, componentsFrozen: Object.isFrozen(window.useGameStore.getState().components) };
});
console.log('immer autoFreeze check:', JSON.stringify(frozen));
await browser.close();

// renderer main thread: the pid/tid that fires animation frames
const key = e => `${e.pid}:${e.tid}`;
const rafCount = new Map();
for (const e of events) if (e.name === 'FireAnimationFrame' || e.name === 'FunctionCall') rafCount.set(key(e), (rafCount.get(key(e)) ?? 0) + 1);
const main = [...rafCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
console.log(`events ${events.length}, distinct names ${new Set(events.map(e => e.name)).size}, main thread ${main}`);
const byName = new Map();
for (const e of events) {
  if (key(e) !== main || e.ph !== 'X' || !e.dur) continue;
  byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur);
}
console.log(`=== SCALE ${SCALE} trace ${WALL}ms wall, live dots ${dots}, fps ${fps}`);
console.log('main-thread ms per second by event (X events, inclusive — nested events double count):');
for (const [n, us] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)) {
  console.log(`${(us / 1000 / (WALL / 1000)).toFixed(1).padStart(7)} ms/s  ${n}`);
}
