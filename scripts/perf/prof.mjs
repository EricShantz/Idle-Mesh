// Headless CPU profile of Idle Mesh under a synthetic heavy mesh.
// usage: node prof.mjs <M|H> [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SCALE = process.argv[2] ?? 'M';
const PAGE_URL = process.argv[3] ?? 'http://localhost:5198/Idle-Mesh/';
const EXE = process.env.CHROME_PATH ?? 'C:/Users/shant/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

const CFG = {
  S: { pubs: 6, brokers: 1, queuesPerBroker: 3, batchFireLevel: 0, throughputLevel: 10, bridges: false, cluster: false, subSpeed: 8 },
  M: { pubs: 12, brokers: 2, queuesPerBroker: 6, batchFireLevel: 1, throughputLevel: 20, bridges: false, cluster: true, subSpeed: 11 },
  L: { pubs: 24, brokers: 3, queuesPerBroker: 6, batchFireLevel: 2, throughputLevel: 30, bridges: false, cluster: true, subSpeed: 11 },
  XL: { pubs: 24, brokers: 3, queuesPerBroker: 7, batchFireLevel: 4, throughputLevel: 30, bridges: false, cluster: true, subSpeed: 11 },
  H: { pubs: 24, brokers: 3, queuesPerBroker: 8, batchFireLevel: 4, throughputLevel: 30, bridges: true, cluster: true, subSpeed: 11 },
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
  for (let b = 0; b < c.brokers; b++) {
    const id = b === 0 ? 'webhook-1' : `broker-${b + 1}`;
    brokerIds.push(id);
    components.push({
      id, type: 'broker', x: 700, y: 200 + b * 700, label: 'Broker', tags: {},
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
      id, type: 'publisher', x: 150, y: 80 + b * 700 + (p % pubsPerBroker) * 70, label: 'Publisher', topic,
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
      const y = 80 + b * 700 + k * 80;
      components.push({ id: qid, type: 'queue', x: 1200, y, label: 'Queue', tags: {}, upgrades: { bufferSize: 17, addSubscriberSlot: 1 } });
      components.push({ id: sid, type: 'subscriber', x: 1650, y, label: 'Subscriber', tags: {}, upgrades: { fasterConsumption: c.subSpeed, consumptionValue: 20 } });
      conn(brokerIds[b], qid);
      conn(qid, sid);
    }
  }
  components.push({ id: 'dmq-1', type: 'dmq', x: 700, y: 200 + c.brokers * 700, label: 'Dead Message Queue', tags: {}, upgrades: { dmqBufferSize: 5, dmqWidth: 2 } });
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
const browser = await chromium.launch({ executablePath: EXE, args: ['--disable-frame-rate-limit=false'] });
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
        res({
          realFps: +(frames / ((t - t0) / 1000)).toFixed(1),
          emaOfInstantFps: +ema.toFixed(1),
          p50dt: +dts[Math.floor(dts.length / 2)].toFixed(1), p95dt: +dts[Math.floor(dts.length * 0.95)].toFixed(1), maxdt: +dts[dts.length - 1].toFixed(1),
          dots: s.eventDots.length, consumed: s.eventsConsumed, dropped: s.eventsDropped,
          domNodes: document.querySelectorAll('*').length,
          byStatus: s.eventDots.reduce((a, d) => (a[d.status] = (a[d.status] ?? 0) + 1, a), {}),
        });
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

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.waitForTimeout(8000);
const { profile } = await cdp.send('Profiler.stop');
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

console.log(`\n=== SCALE ${SCALE}: ${CFG.pubs} pubs, ${CFG.brokers} brokers, ${CFG.brokers * CFG.queuesPerBroker} queues/subs, batch ${CFG.batchFireLevel + 1}, bridges ${CFG.bridges} ===`);
console.log(`profile total ${(total / 1000).toFixed(0)}ms over 8000ms wall; live dots ~${before.dots}; realFps ${before.realFps}`);
console.log('\n--- self time by file ---');
for (const [k, v] of top(byFile, 25)) console.log(pct(v), ms(v), k);
console.log('\n--- self time by function (top 45) ---');
for (const [k, v] of top(byFn, 45)) console.log(pct(v), ms(v), k);
console.log('\n--- inclusive time, selected roots ---');
const want = /(^loop @ src\/hooks\/useGameLoop)|(^render @ src\/components\/EventCanvas)|(^tick @ src\/components\/NodeCard)|(performWorkUntilDeadline)|(^fireEvent @)|(^consumeEvents @)|(^updateDots @)|(^shouldReleaseTo @)|(^drawDot @)|(^isComponentOccupied @)|(^rebuildPathFromNodeIds @)|(^_getAllPathsWithNodes @)|(^finalize @)|(^freeze @)|(^produce @)|(^setState @)|(^useStore @)|(^subscribe)|(^flushSync|^commitRoot|^performSyncWorkOnRoot|^performWorkOnRoot|^renderRootSync)|(^runSaveCheck|^buildSaveSnapshot)|(^getSegmentSpeedScale)|(^interpolatePath)|(^scaledTravelTime)|(^recordDrop)|(^tryBrokerRelay)/;
for (const [k, v] of [...incl.entries()].filter(([k]) => want.test(k)).sort((a, b) => b[1] - a[1])) console.log(pct(v), ms(v), k);
if (errors.length) console.log('\nERRORS:', errors.slice(0, 5));
fs.mkdirSync(new URL('./.out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./.out/profile-${SCALE}.cpuprofile`, import.meta.url), JSON.stringify(profile));
await browser.close();
