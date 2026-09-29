#!/usr/bin/env node
// Where are a mesh's non-manifold edges? Clusters them and prints each
// cluster's centre, extent and edge count, plus the mesh bbox for reference.
//   node tools/nm-locate.cjs part.3mf
const { execFileSync } = require('child_process');
const f = process.argv[2];
const entry = execFileSync('unzip', ['-Z1', f]).toString().split('\n').find((e) => e.endsWith('.model'));
const xml = execFileSync('unzip', ['-p', f, entry], { maxBuffer: 1 << 30 }).toString('utf8');
const P = [];
for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) P.push([+m[1], +m[2], +m[3]]);
const key = new Map();
const id = P.map((p) => { const k = p.join(','); if (!key.has(k)) key.set(k, key.size); return key.get(k); });
const T = [];
for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) T.push([+/v1="(\d+)"/.exec(m[1])[1], +/v2="(\d+)"/.exec(m[1])[1], +/v3="(\d+)"/.exec(m[1])[1]].map((i) => id[i]));
const rep = new Map();
id.forEach((w, i) => { if (!rep.has(w)) rep.set(w, P[i]); });
const V = key.size;
const cnt = new Map();
for (const t of T) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = a < b ? a * V + b : b * V + a; cnt.set(k, (cnt.get(k) || 0) + 1); }
const nm = [];
for (const [k, c] of cnt) if (c > 2) { const a = Math.floor(k / V), b = k % V; const pa = rep.get(a), pb = rep.get(b); nm.push({ c, m: pa.map((x, i) => (x + pb[i]) / 2), len: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) }); }
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const p of P) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
// cluster by 5 mm grid
const cl = new Map();
for (const e of nm) { const k = e.m.map((x) => Math.floor(x / 5)).join(','); if (!cl.has(k)) cl.set(k, []); cl.get(k).push(e); }
const clusters = [...cl.values()].map((es) => {
  const c = [0, 1, 2].map((i) => es.reduce((s, e) => s + e.m[i], 0) / es.length);
  return { edges: es.length, centre: c.map((x) => +x.toFixed(2)), valences: [...new Set(es.map((e) => e.c))], meanLen: +(es.reduce((s, e) => s + e.len, 0) / es.length).toFixed(3) };
}).sort((a, b) => b.edges - a.edges);
// planar? check spread of each coordinate across all nm edges
const spread = [0, 1, 2].map((i) => { const v = nm.map((e) => e.m[i]); return +(Math.max(...v) - Math.min(...v)).toFixed(3); });
console.log(JSON.stringify({ tris: T.length, nonManifoldEdges: nm.length, bbox: { lo: lo.map((x) => +x.toFixed(2)), hi: hi.map((x) => +x.toFixed(2)) }, nmSpreadXYZ: spread, clusters: clusters.slice(0, 8) }, null, 1));
