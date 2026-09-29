#!/usr/bin/env node
// Lists the separate shells in a 3MF mesh with their bounding boxes, and
// which shells' boxes overlap (a sign of intersecting shells).
//   node tools/components.cjs file.3mf
const { execFileSync } = require('child_process');
const f = process.argv[2];
const entry = execFileSync('unzip', ['-Z1', f]).toString().split('\n').find((e) => e.endsWith('.model'));
const xml = execFileSync('unzip', ['-p', f, entry], { maxBuffer: 1 << 30 }).toString('utf8');
const P = [];
for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) P.push([+m[1], +m[2], +m[3]]);
const key = new Map();
const id = P.map((p) => { const k = p.join(','); if (!key.has(k)) key.set(k, key.size); return key.get(k); });
const T = [];
for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) T.push([+/v1="(\d+)"/.exec(m[1])[1], +/v2="(\d+)"/.exec(m[1])[1], +/v3="(\d+)"/.exec(m[1])[1]]);
const parent = new Int32Array(key.size).map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
for (const t of T) { const a = find(id[t[0]]); parent[find(id[t[1]])] = a; parent[find(id[t[2]])] = a; }
const comps = new Map();
for (const t of T) {
  const r = find(id[t[0]]);
  let c = comps.get(r);
  if (!c) comps.set(r, (c = { tris: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], vol: 0 }));
  c.tris++;
  const [a, b, d] = t.map((i) => P[i]);
  for (const p of [a, b, d]) for (let k = 0; k < 3; k++) { if (p[k] < c.lo[k]) c.lo[k] = p[k]; if (p[k] > c.hi[k]) c.hi[k] = p[k]; }
  c.vol += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
}
const list = [...comps.values()].sort((x, y) => y.tris - x.tris).map((c, i) => ({ i, tris: c.tris, volume: Math.round(c.vol), lo: c.lo.map((x) => +x.toFixed(1)), hi: c.hi.map((x) => +x.toFixed(1)) }));
const overlaps = [];
for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const a = list[i], b = list[j];
  if ([0, 1, 2].every((k) => a.lo[k] <= b.hi[k] && b.lo[k] <= a.hi[k])) overlaps.push([i, j]);
}
console.log(JSON.stringify({ components: list.slice(0, 12), bboxOverlaps: overlaps.slice(0, 20) }, null, 1));
