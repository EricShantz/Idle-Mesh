// Line-level hotspots from a .cpuprofile (uses positionTicks), resolved against the unminified bundle.
// usage: node lines.mjs profile-X.cpuprofile <bundle.js> [topN]
import fs from 'node:fs';
const [, , profPath, bundlePath, topNArg] = process.argv;
const profile = JSON.parse(fs.readFileSync(profPath, 'utf8'));
const bundle = fs.readFileSync(bundlePath, 'utf8').split('\n');
const topN = Number(topNArg ?? 40);
const perLine = new Map();
let totalTicks = 0;
for (const n of profile.nodes) {
  if (!n.callFrame.url.includes('/assets/')) continue;
  for (const pt of n.positionTicks ?? []) {
    const k = pt.line;
    perLine.set(k, (perLine.get(k) ?? 0) + pt.ticks);
    totalTicks += pt.ticks;
  }
}
const allTicks = profile.samples.length;
console.log(`bundle-attributed ticks ${totalTicks} of ${allTicks} samples (${(100 * totalTicks / allTicks).toFixed(1)}%)`);
for (const [line, ticks] of [...perLine.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  const src = (bundle[line - 1] ?? '').trim().slice(0, 130);
  console.log(`${(100 * ticks / allTicks).toFixed(1).padStart(5)}%  L${String(line).padEnd(6)} ${src}`);
}
