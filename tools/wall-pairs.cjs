#!/usr/bin/env node
// Tests the "internal double wall" theory: counts triangle pairs with the same
// three vertices but opposite winding (a zero-thickness wall), and checks
// whether removing them leaves a clean mesh.
//   node tools/wall-pairs.cjs part.3mf
const { execFileSync } = require('child_process');
const f = process.argv[2];
const entry = execFileSync('unzip', ['-Z1', f]).toString().split('\n').find((e) => e.endsWith('.model'));
const xml = execFileSync('unzip', ['-p', f, entry], { maxBuffer: 1 << 30 }).toString('utf8');
const P = [];
for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) P.push(m[1] + ',' + m[2] + ',' + m[3]);
const key = new Map();
const id = P.map((k) => { if (!key.has(k)) key.set(k, key.size); return key.get(k); });
const T = [];
for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) T.push([+/v1="(\d+)"/.exec(m[1])[1], +/v2="(\d+)"/.exec(m[1])[1], +/v3="(\d+)"/.exec(m[1])[1]].map((i) => id[i]));
const V = key.size;
const cyc = ([a, b, c]) => (a <= b && a <= c ? [a, b, c] : b <= a && b <= c ? [b, c, a] : [c, a, b]);
const groups = new Map();
T.forEach((t, i) => { const k = [...t].sort((x, y) => x - y).join(','); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
let opposite = 0, same = 0;
const drop = new Set();
for (const list of groups.values()) {
  if (list.length < 2) continue;
  // Pair off opposite windings.
  const fwd = [], rev = [];
  const ref = cyc(T[list[0]]).join(',');
  for (const i of list) (cyc(T[i]).join(',') === ref ? fwd : rev).push(i);
  const n = Math.min(fwd.length, rev.length);
  opposite += n;
  for (let k = 0; k < n; k++) { drop.add(fwd[k]); drop.add(rev[k]); }
  same += Math.max(fwd.length, rev.length) - n - (n ? 0 : 1);
}
const stats = (keep) => {
  const c = new Map();
  T.forEach((t, i) => { if (!keep(i)) return; for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = a < b ? a * V + b : b * V + a; c.set(k, (c.get(k) || 0) + 1); } });
  let open = 0, nm = 0; for (const v of c.values()) { if (v === 1) open++; else if (v > 2) nm++; }
  return { open, nonManifold: nm };
};
// Also: drop surplus same-winding copies (keep one of each).
const dropBoth = new Set(drop);
for (const list of groups.values()) {
  if (list.length < 2) continue;
  const ref = cyc(T[list[0]]).join(',');
  const fwd = list.filter((i) => cyc(T[i]).join(',') === ref && !drop.has(i));
  const rev = list.filter((i) => cyc(T[i]).join(',') !== ref && !drop.has(i));
  for (const side of [fwd, rev]) side.slice(1).forEach((i) => dropBoth.add(i));
}
console.log(JSON.stringify({
  triangles: T.length, oppositePairs: opposite, sameWindingExtras: same,
  before: stats(() => true),
  afterRemovingPairs: stats((i) => !drop.has(i)),
  afterRemovingPairsAndSurplusCopies: stats((i) => !dropBoth.has(i)),
}));
