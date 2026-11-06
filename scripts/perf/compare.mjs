// Compare two behavior.mjs labels across scales.  usage: node compare.mjs <labelA> <labelB> [scales=S,M,L]
import fs from 'node:fs';
const [, , A, B, scalesArg] = process.argv;
const scales = (scalesArg ?? 'S,M,L').split(',');
const read = (l, s) => { try { return JSON.parse(fs.readFileSync(new URL(`./.out/behavior-${l}-${s}.json`, import.meta.url), 'utf8')); } catch { return null; } };
// The per-sim-second keys exist only in labels recorded since behavior.mjs got --ticks; a key missing on either side is skipped.
const keys = ['realFps', 'simTicksPerSec', 'consumedPerSec', 'droppedPerSec', 'earnedPerSec', 'consumedPerSimSec', 'earnedPerSimSec', 'avgLiveDots', 'maxLiveDots', 'avgQueued', 'avgPausing'];
for (const s of scales) {
  const a = read(A, s), b = read(B, s);
  if (!a || !b) { console.log(`scale ${s}: missing ${!a ? A : B}`); continue; }
  console.log(`\n=== scale ${s}: ${A} -> ${B}`);
  for (const k of keys) {
    if (a[k] === undefined || b[k] === undefined) continue;
    const d = a[k] === 0 ? (b[k] === 0 ? 0 : Infinity) : (b[k] - a[k]) / Math.abs(a[k]) * 100;
    console.log(`${k.padEnd(16)} ${String(a[k]).padStart(12)} -> ${String(b[k]).padStart(12)}   ${d === Infinity ? '  new' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'}`);
  }
  if (b.errors?.length) console.log('errors:', b.errors);
}
