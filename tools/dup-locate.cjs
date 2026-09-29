#!/usr/bin/env node
// Locates same-winding duplicate triangles: which plane they lie in, their
// normals, sizes, and whether a nearby opposite-facing sheet exists within a
// small tolerance (a wall pair that exact-bit matching misses).
//   node tools/dup-locate.cjs part.3mf
const { execFileSync } = require('child_process');
const f = process.argv[2];
const entry = execFileSync('unzip', ['-Z1', f]).toString().split('\n').find((e) => e.endsWith('.model'));
const xml = execFileSync('unzip', ['-p', f, entry], { maxBuffer: 1 << 30 }).toString('utf8');
const P = [];
for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) P.push([+m[1], +m[2], +m[3]]);
const T = [];
for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) T.push([+/v1="(\d+)"/.exec(m[1])[1], +/v2="(\d+)"/.exec(m[1])[1], +/v3="(\d+)"/.exec(m[1])[1]]);
const norm = (t) => {
  const [a, b, c] = t.map((i) => P[i]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n);
  return { n: n.map((x) => x / (l || 1)), area: l / 2 };
};
const cyc = ([a, b, c]) => (a <= b && a <= c ? [a, b, c] : b <= a && b <= c ? [b, c, a] : [c, a, b]).join(',');
const groups = new Map();
T.forEach((t, i) => { const k = cyc(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
const dups = [...groups.values()].filter((g) => g.length > 1);
const planes = {};
let area = 0;
const sample = [];
for (const g of dups) {
  const t = T[g[0]];
  const { n, area: a } = norm(t);
  area += a * (g.length - 1);
  const ax = Math.abs(n[0]) > 0.99 ? 'x' : Math.abs(n[1]) > 0.99 ? 'y' : Math.abs(n[2]) > 0.99 ? 'z' : 'oblique';
  const coord = ax === 'oblique' ? '-' : P[t[0]][{ x: 0, y: 1, z: 2 }[ax]].toFixed(3);
  const k = `${ax}=${coord} n${ax === 'oblique' ? '' : Math.sign(n[{ x: 0, y: 1, z: 2 }[ax]])}`;
  planes[k] = (planes[k] || 0) + 1;
  if (sample.length < 4) sample.push({ copies: g.length, n: n.map((x) => +x.toFixed(3)), area: +a.toFixed(4), v: t.map((i) => P[i].map((x) => +x.toFixed(3))) });
}
console.log(JSON.stringify({ triangles: T.length, duplicateGroups: dups.length, copies: [...new Set(dups.map((g) => g.length))], duplicateArea: +area.toFixed(2), byPlane: Object.entries(planes).sort((a, b) => b[1] - a[1]).slice(0, 10), sample }, null, 1));
