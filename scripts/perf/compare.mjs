// Compare two behavior.mjs labels across scales.  usage: node compare.mjs <labelA> <labelB> [scales=S,M,L]
import fs from 'node:fs';
const [, , A, B, scalesArg] = process.argv;
const scales = (scalesArg ?? 'S,M,L').split(',');
const read = (l, s) => { try { return JSON.parse(fs.readFileSync(new URL(`./.out/behavior-${l}-${s}.json`, import.meta.url), 'utf8')); } catch { return null; } };
// The per-sim-second keys exist only in labels recorded since behavior.mjs got --ticks; a key missing on either side is skipped.
const keys = ['realFps', 'simTicksPerSec', 'tickMs', 'consumedPerSec', 'droppedPerSec', 'earnedPerSec', 'consumedPerSimSec', 'droppedPerSimSec', 'earnedPerSimSec', 'avgLiveDots', 'maxLiveDots', 'avgLiveEvents', 'avgQueued', 'avgPausing', 'avgQueuedEvents', 'avgPausingEvents'];
for (const s of scales) {
  const a = read(A, s), b = read(B, s);
  if (!a || !b) { console.log(`scale ${s}: missing ${!a ? A : B}`); continue; }
  console.log(`\n=== scale ${s}: ${A} -> ${B}`);
  for (const k of keys) {
    if (a[k] === undefined || b[k] === undefined) continue;
    const d = a[k] === 0 ? (b[k] === 0 ? 0 : Infinity) : (b[k] - a[k]) / Math.abs(a[k]) * 100;
    console.log(`${k.padEnd(16)} ${String(a[k]).padStart(12)} -> ${String(b[k]).padStart(12)}   ${d === Infinity ? '  new' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'}`);
  }
  // Relays per published event per broker (labels recorded since scale-plan Phase F)
  const ids = [...new Set([...Object.keys(a.relaysPerPublishedEvent ?? {}), ...Object.keys(b.relaysPerPublishedEvent ?? {})])];
  for (const id of ids) {
    const ra = a.relaysPerPublishedEvent?.[id], rb = b.relaysPerPublishedEvent?.[id];
    console.log(`relays/event ${id.padEnd(14)} ${String(ra ?? '-').padStart(8)} -> ${String(rb ?? '-').padStart(8)}   (${a.brokerRelaysPerSec?.[id] ?? '-'} -> ${b.brokerRelaysPerSec?.[id] ?? '-'} relays/s of ${a.publishedEventsPerSec ?? '-'} -> ${b.publishedEventsPerSec ?? '-'} published/s)`);
  }
  if (b.errors?.length) console.log('errors:', b.errors);
}
