// Headless CPU profile of Idle Mesh under a synthetic heavy mesh.
// usage: node prof.mjs <M|H> [url] [--worker]
//   --worker profiles the simulation worker thread (the sim runs there) instead of the page's main thread.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const WORKER = process.argv.includes('--worker');
const ARGS = process.argv.slice(2).filter(a => a !== '--worker');
const SCALE = ARGS[0] ?? 'M';
const PAGE_URL = ARGS[1] ?? 'http://localhost:5198/Idle-Mesh/';
// Playwright's CDPSession only reaches the page; the worker is a separate target, so with --worker the
// browser also opens a debugging port and the profile is taken over a raw CDP WebSocket (flattened session).
const DEBUG_PORT = 9333;

async function profileWorker(ms) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1; const waiting = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetInfos } = await send('Target.getTargets');
  const w = targetInfos.find(t => t.type === 'worker' && /sim\.worker/.test(t.url));
  if (!w) throw new Error('no sim worker target (is the page running inline?); targets: ' + targetInfos.map(t => `${t.type} ${t.url}`).join(', '));
  const { sessionId } = await send('Target.attachToTarget', { targetId: w.targetId, flatten: true });
  await send('Profiler.enable', {}, sessionId);
  await send('Profiler.setSamplingInterval', { interval: 200 }, sessionId);
  await send('Profiler.start', {}, sessionId);
  await new Promise(r => setTimeout(r, ms));
  const { profile } = await send('Profiler.stop', {}, sessionId);
  await send('Target.detachFromTarget', { sessionId }).catch(() => {});
  ws.close();
  return profile;
}
const EXE = process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

const CFG = {
  S: { pubs: 6, brokers: 1, queuesPerBroker: 3, batchFireLevel: 0, throughputLevel: 10, bridges: false, cluster: false, subSpeed: 8 },
  M: { pubs: 12, brokers: 2, queuesPerBroker: 6, batchFireLevel: 1, throughputLevel: 20, bridges: false, cluster: true, subSpeed: 11 },
  L: { pubs: 24, brokers: 3, queuesPerBroker: 6, batchFireLevel: 2, throughputLevel: 30, bridges: false, cluster: true, subSpeed: 11 },
  XL: { pubs: 24, brokers: 3, queuesPerBroker: 7, batchFireLevel: 4, throughputLevel: 30, bridges: false, cluster: true, subSpeed: 11 },
  H: { pubs: 24, brokers: 3, queuesPerBroker: 8, batchFireLevel: 4, throughputLevel: 30, bridges: true, cluster: true, subSpeed: 11 },
  // User-like: ~14,400 dots/s with broker caps NOT reached (24 pubs x 10 fires/s x batch 5 x 12-way fan-out), zoomed out so the whole mesh is on screen
  // Early game: one publisher through a real webhook (slow zone + occupied-drop rule) straight to a level-0 subscriber
  W: { pubs: 1, brokers: 1, webhook: true, queuesPerBroker: 0, directSub: true, batchFireLevel: 0, throughputLevel: 0, bridges: false, cluster: false, subSpeed: 0 },
  U: { pubs: 24, brokers: 6, queuesPerBroker: 12, batchFireLevel: 4, throughputLevel: 35, bridges: false, cluster: true, subSpeed: 11, groupGap: 760, queueGap: 60, zoomOutSteps: 4 },
}[SCALE];
if (process.env.SUBSPEED) CFG.subSpeed = Number(process.env.SUBSPEED);
CFG.pubSpeed = process.env.PUBSPEED ? Number(process.env.PUBSPEED) : 10;

const TOPICS = [
  'acme/orders/created/na/electronics/SKU001','acme/orders/created/na/electronics/SKU002','acme/orders/created/na/clothing/SKU003',
  'acme/orders/created/eu/warehouse/SKU004','acme/orders/processed/na/cards/SKU005','acme/payments/fulfilled/na/logistics/SKU006',
  'acme/payments/processed/na/cards/TXN001','acme/payments/processed/na/cards/TXN002','acme/payments/processed/na/crypto/TXN003',
  'acme/payments/processed/eu/bank/TXN004','acme/payments/refunded/na/cards/TXN005','acme/inventory/updated/na/cards/TXN006',
  'acme/inventory/updated/na/warehouse/ITM001','acme/inventory/updated/na/warehouse/ITM002','acme/inventory/updated/na/shelf/ITM003',
  'acme/inventory/updated/eu/warehouse/ITM004','acme/inventory/restocked/na/warehouse/ITM005','acme/shipping/dispatched/na/warehouse/ITM006',
  'acme/shipping/dispatched/na/ground/SHP001','acme/shipping/dispatched/na/ground/SHP002','acme/shipping/dispatched/na/air/SHP003',
  'acme/shipping/dispatched/eu/ground/SHP004','acme/shipping/delivered/na/ground/SHP005','acme/orders/cancelled/na/ground/SHP006',
];

function buildSave(c) {
  const components = [];
  const connections = [];
  let cid = 0;
  const conn = (a, b) => connections.push({ id: `conn-${++cid}`, fromId: a, toId: b });
  const brokerIds = [];
  const gap = c.groupGap ?? 700;
  for (let b = 0; b < c.brokers; b++) {
    const id = b === 0 ? 'webhook-1' : `broker-${b + 1}`;
    brokerIds.push(id);
    components.push(c.webhook
      ? { id, type: 'webhook', x: 700, y: 200 + b * gap, label: 'Webhook', tags: {}, upgrades: {} }
      : {
        id, type: 'broker', x: 700, y: 200 + b * gap, label: 'Broker', tags: {},
        upgrades: {
          upgradeToBroker: 1, increaseThroughput: c.throughputLevel, addQueueSlot: c.queuesPerBroker, addBridgeSlot: 2,
          ...(c.cluster ? { upgradeToCluster: 1, addClusterSlot: 2 } : {}),
        },
      });
  }
  if (c.bridges) for (let b = 0; b < c.brokers - 1; b++) conn(brokerIds[b], brokerIds[b + 1]);
  const pubsPerBroker = Math.ceil(c.pubs / c.brokers);
  for (let p = 0; p < c.pubs; p++) {
    const id = p === 0 ? 'pub-1' : `pub-${p + 1}`;
    const b = Math.floor(p / pubsPerBroker);
    const topic = TOPICS[p % TOPICS.length];
    components.push({
      id, type: 'publisher', x: 150, y: 80 + b * gap + (p % pubsPerBroker) * 70, label: 'Publisher', topic,
      topicSegments: topic.split('/'), tags: {},
      upgrades: { autoPub: 1, publishSpeed: c.pubSpeed ?? 10, eventValue: 20, ...(p > 0 ? { networkTier: p } : {}) },
    });
    conn(id, brokerIds[b]);
  }
  let q = 0;
  for (let b = 0; b < c.brokers; b++) {
    for (let k = 0; k < c.queuesPerBroker; k++) {
      q++;
      const qid = `queue-${q}`;
      const sid = q === 1 ? 'sub-1' : `sub-${q}`;
      const y = 80 + b * gap + k * (c.queueGap ?? 80);
      components.push({ id: qid, type: 'queue', x: 1200, y, label: 'Queue', tags: {}, upgrades: { bufferSize: 17, addSubscriberSlot: 1 } });
      components.push({ id: sid, type: 'subscriber', x: 1650, y, label: 'Subscriber', tags: {}, upgrades: { fasterConsumption: c.subSpeed, consumptionValue: 20 } });
      conn(brokerIds[b], qid);
      conn(qid, sid);
    }
  }
  if (c.directSub) {
    components.push({ id: 'sub-1', type: 'subscriber', x: 1200, y: 200, label: 'Subscriber', tags: {}, upgrades: { fasterConsumption: c.subSpeed, consumptionValue: 0 } });
    conn(brokerIds[0], 'sub-1');
  }
  components.push({ id: 'dmq-1', type: 'dmq', x: 700, y: 200 + c.brokers * gap, label: 'Dead Message Queue', tags: {}, upgrades: { dmqBufferSize: 5, dmqWidth: 2 } });
  conn('dmq-1', brokerIds[0]);

  const propLevel = 10;
  const propBoost = propLevel * (propLevel + 9) / 2;
  const seen = {};
  for (const k of ['introSequence', 'intro', 'firstDrop', 'brokerUpgrade', 'prestigeAvailable', 'dmrCluster', 'firstFanOut', 'queue', 'dmq', 'topics', 'bridge', 'prestige']) seen[k] = true;
  return {
    balance: 1e9, totalEarned: 5e9, eventsConsumed: 0, eventsDropped: 0,
    components, connections,
    upgrades: { propagationSpeed: 1 + propBoost / 100, costReduction: 0.3, batchFire: c.batchFireLevel > 0 ? c.batchFireLevel + 1 : 0, globalValueMultiplier: 1 },
    globalUpgradeLevels: { propagationSpeed: propLevel, costReduction: 3, batchFire: c.batchFireLevel, globalValueMultiplier: 0 },
    publisherCooldowns: {},
    prestige: { points: 0, totalPoints: 0, count: 0, permanentUpgradeLevels: {} },
    tutorialsSeen: seen, winSeen: true,
  };
}

const save = buildSave(CFG);
// JSFLAGS=--no-turbo-inlining gives per-function attribution inside the hot loop (V8 otherwise inlines it all into `loop`)
const browser = await chromium.launch({ executablePath: EXE, args: ['--disable-frame-rate-limit=false', ...(WORKER ? [`--remote-debugging-port=${DEBUG_PORT}`] : []), ...(process.env.JSFLAGS ? [`--js-flags=${process.env.JSFLAGS}`] : [])] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/attribute .* Expected length/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(s => localStorage.setItem('idle-mesh-save', s), JSON.stringify(save));
await page.goto(PAGE_URL);
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const s = window.useGameStore.getState();
  if (s.activeTutorial) s.dismissTutorial(s.activeTutorial);
});
// Zoom out (wheel on the mesh, each step x0.7) so a tall mesh is actually on screen and gets drawn
for (let z = 0; z < (CFG.zoomOutSteps ?? 0); z++) { await page.mouse.move(60, 60); await page.mouse.wheel(0, 100); await page.waitForTimeout(50); }

async function sample(label, ms) {
  const r = await page.evaluate((ms) => new Promise(res => {
    const t0 = performance.now(); let frames = 0; let last = t0; let ema = 60; const dts = [];
    const tick = (t) => {
      frames++; const dt = t - last; last = t; dts.push(dt);
      if (dt > 0) ema += 0.05 * (1000 / dt - ema);
      if (t - t0 < ms) requestAnimationFrame(tick);
      else {
        dts.sort((a, b) => a - b);
        const s = window.useGameStore.getState();
        window.__sim.byStatus().then(byStatus => res({
          realFps: +(frames / ((t - t0) / 1000)).toFixed(1),
          emaOfInstantFps: +ema.toFixed(1),
          p50dt: +dts[Math.floor(dts.length / 2)].toFixed(1), p95dt: +dts[Math.floor(dts.length * 0.95)].toFixed(1), maxdt: +dts[dts.length - 1].toFixed(1),
          dots: window.__sim.liveDots(), consumed: s.eventsConsumed, dropped: s.eventsDropped,
          domNodes: document.querySelectorAll('*').length,
          byStatus, simTicksPerSec: +window.__sim.ticksPerSec().toFixed(1), simMode: window.__sim.mode(),
        }));
      }
    };
    requestAnimationFrame(tick);
  }), ms);
  console.log(`[${label}]`, JSON.stringify(r));
  return r;
}

await sample('warmup-1', 3000);
await sample('warmup-2', 3000);
const before = await sample('steady', 4000);

let profile;
if (WORKER) {
  profile = await profileWorker(8000);
} else {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(8000);
  ({ profile } = await cdp.send('Profiler.stop'));
}
await sample('after', 3000);

// ---- aggregate
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
const selfUs = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const total = [...selfUs.values()].reduce((a, b) => a + b, 0);
const shortUrl = u => u.replace(/^https?:\/\/[^/]+\/Idle-Mesh\//, '').replace(/\?.*$/, '').replace(/^node_modules\/\.vite\/deps\//, 'deps/');
const keyOf = n => `${n.callFrame.functionName || '(anon)'} @ ${shortUrl(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
const fileOf = n => shortUrl(n.callFrame.url) || n.callFrame.functionName;

const byFn = new Map(), byFile = new Map();
for (const [id, us] of selfUs) {
  const n = nodes.get(id);
  byFn.set(keyOf(n), (byFn.get(keyOf(n)) ?? 0) + us);
  byFile.set(fileOf(n), (byFile.get(fileOf(n)) ?? 0) + us);
}
// inclusive time per function key (count each sample once per distinct key on its stack)
const incl = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] ?? 0;
  const seenKeys = new Set();
  let id = profile.samples[i];
  while (id !== undefined) {
    const n = nodes.get(id);
    const k = keyOf(n);
    if (!seenKeys.has(k)) { seenKeys.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); }
    id = parent.get(id);
  }
}
const pct = us => (100 * us / total).toFixed(1).padStart(5) + '%';
const ms = us => (us / 1000).toFixed(0).padStart(6) + 'ms';
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

console.log(`\n=== SCALE ${SCALE}${WORKER ? ' (sim worker thread)' : ' (main thread)'}: ${CFG.pubs} pubs, ${CFG.brokers} brokers, ${CFG.brokers * CFG.queuesPerBroker} queues/subs, batch ${CFG.batchFireLevel + 1}, bridges ${CFG.bridges} ===`);
console.log(`profile total ${(total / 1000).toFixed(0)}ms over 8000ms wall; live dots ~${before.dots}; realFps ${before.realFps}`);
console.log('\n--- self time by file ---');
for (const [k, v] of top(byFile, 25)) console.log(pct(v), ms(v), k);
console.log('\n--- self time by function (top 45) ---');
for (const [k, v] of top(byFn, 45)) console.log(pct(v), ms(v), k);
console.log('\n--- inclusive time, selected roots ---');
const want = /(^tick @ )|(^fillPositions @ )|(^buildPublishDots @ )|(^onmessage @ )|(^receiveTick @ )|(^commitFrame @ )|(^applyConsumes @ )|(^render @ src\/components\/EventCanvas)|(^tick @ src\/components\/NodeCard)|(performWorkUntilDeadline)|(^fireEvent @)|(^consumeEvents @)|(^updateDots @)|(^shouldReleaseTo @)|(^drawDot @)|(^isComponentOccupied @)|(^rebuildPathFromNodeIds @)|(^_getAllPathsWithNodes @)|(^finalize @)|(^freeze @)|(^produce @)|(^setState @)|(^useStore @)|(^subscribe)|(^flushSync|^commitRoot|^performSyncWorkOnRoot|^performWorkOnRoot|^renderRootSync)|(^runSaveCheck|^buildSaveSnapshot)|(^getSegmentSpeedScale)|(^interpolatePath)|(^scaledTravelTime)|(^recordDrop)|(^tryBrokerRelay)/;
for (const [k, v] of [...incl.entries()].filter(([k]) => want.test(k)).sort((a, b) => b[1] - a[1])) console.log(pct(v), ms(v), k);
if (errors.length) console.log('\nERRORS:', errors.slice(0, 5));
fs.mkdirSync(new URL('./.out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./.out/profile-${SCALE}${WORKER ? '-worker' : ''}.cpuprofile`, import.meta.url), JSON.stringify(profile));
await browser.close();
