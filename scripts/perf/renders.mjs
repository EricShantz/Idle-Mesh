// Count React component renders/sec, store commits/sec, style mutations/sec, and RAF callbacks/frame
// without touching the app source: installs a React DevTools hook before the page loads.
// usage: node renders.mjs <M|H> [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCALE = process.argv[2] ?? 'M';
const PAGE_URL = process.argv[3] ?? 'http://localhost:5198/Idle-Mesh/';
const EXE = process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

// reuse buildSave from prof.mjs by importing its source text (keeps one copy of the scenario)
const src = fs.readFileSync(new URL('./prof.mjs', import.meta.url), 'utf8');
const saveBuilder = src.slice(src.indexOf('const CFG ='), src.indexOf('const save = buildSave'));
const buildSave = new Function('SCALE', saveBuilder + '\nreturn buildSave(CFG);');
const save = buildSave(SCALE);

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript((s) => {
  localStorage.setItem('idle-mesh-save', s);
  // --- React DevTools hook: count fibers that performed work in each commit
  const counts = {};
  let commits = 0;
  const PerformedWork = 0b1;
  const nameOf = (f) => {
    const t = f.type;
    if (typeof t === 'function') return t.displayName || t.name || '(fn)';
    if (typeof t === 'string') return null; // host element
    if (t && typeof t === 'object') {
      if (t.$$typeof && t.render) return 'memo(' + (t.type?.displayName || t.type?.name || t.render?.name || '?') + ')';
      if (t.type) return 'memo(' + (t.type.displayName || t.type.name || '?') + ')';
    }
    return null;
  };
  // A fiber rendered this commit iff it carries PerformedWork AND is a new object. React
  // double-buffers fibers: a component that re-rendered alternates fiber objects, while a
  // subtree that bailed out without cloning keeps the very same objects (stale flags and all).
  let prev = new Set(); let cur = new Set();
  const walk = (fiber) => {
    let f = fiber;
    while (f) {
      if (f.tag !== 5 && f.tag !== 6) {
        cur.add(f);
        if ((f.flags & PerformedWork) && !prev.has(f)) {
          const n = nameOf(f);
          if (n) counts[n] = (counts[n] ?? 0) + 1;
        }
      }
      if (f.child) walk(f.child);
      f = f.sibling;
    }
  };
  const swap = () => { prev = cur; cur = new Set(); };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), checkDCE() {}, on() {}, off() {}, emit() {},
    inject(renderer) { this.renderers.set(1, renderer); return 1; },
    onCommitFiberRoot(_id, root) { commits++; walk(root.current.child); swap(); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  };
  window.__renderStats = { counts, get commits() { return commits; }, reset() { for (const k in counts) delete counts[k]; commits = 0; } };
  // --- RAF callbacks per frame
  let rafCalls = 0; const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { rafCalls++; return origRaf(cb); };
  window.__rafStats = { get calls() { return rafCalls; }, reset() { rafCalls = 0; } };
}, JSON.stringify(save));
await page.goto(PAGE_URL);
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = window.useGameStore.getState(); if (s.activeTutorial) s.dismissTutorial(s.activeTutorial); });
await page.waitForTimeout(6000); // warm up

const r = await page.evaluate(() => new Promise(res => {
  window.__renderStats.reset(); window.__rafStats.reset();
  let storeCommits = 0; const unsub = window.useGameStore.subscribe(() => storeCommits++);
  let styleMut = 0, attrMut = 0, childMut = 0;
  const mo = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'attributes') { if (m.attributeName === 'style') styleMut++; else attrMut++; } else childMut++; } });
  mo.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: false });
  let frames = 0; const t0 = performance.now();
  const tick = (t) => { frames++; if (t - t0 < 5000) requestAnimationFrame(tick); else finish(t); };
  const finish = (t) => {
    unsub(); mo.disconnect();
    const sec = (t - t0) / 1000;
    const s = window.useGameStore.getState();
    const perSec = {};
    for (const [k, v] of Object.entries(window.__renderStats.counts).sort((a, b) => b[1] - a[1])) perSec[k] = +(v / sec).toFixed(1);
    res({
      seconds: +sec.toFixed(2), realFps: +(frames / sec).toFixed(1), liveDots: s.eventDots.length,
      storeCommitsPerSec: +(storeCommits / sec).toFixed(1),
      reactCommitsPerSec: +(window.__renderStats.commits / sec).toFixed(1),
      rafCallbacksPerFrame: +(window.__rafStats.calls / frames).toFixed(1),
      domMutationsPerSec: { style: +(styleMut / sec).toFixed(0), otherAttr: +(attrMut / sec).toFixed(0), childList: +(childMut / sec).toFixed(0) },
      componentRendersPerSec: perSec,
      componentCounts: { cards: s.components.length, connections: s.connections.length },
    });
  };
  requestAnimationFrame(tick);
}));
console.log(`=== SCALE ${SCALE} @ ${PAGE_URL}`);
console.log(JSON.stringify(r, null, 2));
await browser.close();
