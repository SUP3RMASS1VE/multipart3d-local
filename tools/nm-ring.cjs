#!/usr/bin/env node
// Inspects non-manifold edge rings: ring radius in the plane, which way the
// faces around them point, and how much flat "cap" surface shares that plane.
//   node tools/nm-ring.cjs part.3mf
const { execFileSync } = require('child_process');
const f = process.argv[2];
const entry = execFileSync('unzip', ['-Z1', f]).toString().split('\n').find((e) => e.endsWith('.model'));
const xml = execFileSync('unzip', ['-p', f, entry], { maxBuffer: 1 << 30 }).toString('utf8');
const P = [];
for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) P.push([+m[1], +m[2], +m[3]]);
const key = new Map();
const id = P.map((p) => { const k = p.join(','); if (!key.has(k)) key.set(k, key.size); return key.get(k); });
const rep = [];
id.forEach((w, i) => { if (rep[w] === undefined) rep[w] = P[i]; });
const T = [];
for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) T.push([+/v1="(\d+)"/.exec(m[1])[1], +/v2="(\d+)"/.exec(m[1])[1], +/v3="(\d+)"/.exec(m[1])[1]].map((i) => id[i]));
const V = key.size;
const edgeFaces = new Map();
T.forEach((t, fi) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = a < b ? a * V + b : b * V + a; if (!edgeFaces.has(k)) edgeFaces.set(k, []); edgeFaces.get(k).push(fi); } });
const normal = (t) => {
  const [a, b, c] = t.map((i) => rep[i]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => +(x / l).toFixed(2));
};
const nmEdges = [...edgeFaces].filter(([, fs]) => fs.length > 2);
// Plane: the most common x among nm edge endpoints (they were all on one x).
const xs = nmEdges.map(([k]) => rep[Math.floor(k / V)][0]);
const planeX = xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// Group rings by proximity in (y,z).
const pts = nmEdges.map(([k, fs]) => { const a = rep[Math.floor(k / V)], b = rep[k % V]; return { m: [(a[1] + b[1]) / 2, (a[2] + b[2]) / 2], fs }; });
const rings = [];
for (const p of pts) {
  let r = rings.find((g) => Math.hypot(g.c[0] - p.m[0], g.c[1] - p.m[1]) < 6);
  if (!r) rings.push((r = { c: p.m.slice(), items: [] }));
  r.items.push(p);
  r.c = [r.items.reduce((s, q) => s + q.m[0], 0) / r.items.length, r.items.reduce((s, q) => s + q.m[1], 0) / r.items.length];
}
// Flat faces in that plane (cap / connector faces) and which way they point.
let capPlus = 0, capMinus = 0;
for (const t of T) {
  if (t.every((i) => Math.abs(rep[i][0] - planeX) < 1e-3)) {
    const n = normal(t);
    if (n[0] > 0.9) capPlus++;
    else if (n[0] < -0.9) capMinus++;
  }
}
const out = {
  planeX,
  flatFacesInPlane: { facingPlusX: capPlus, facingMinusX: capMinus },
  rings: rings.slice(0, 5).map((r) => {
    const radii = r.items.map((p) => Math.hypot(p.m[0] - r.c[0], p.m[1] - r.c[1]));
    const faceNormals = {};
    for (const p of r.items) for (const fi of p.fs) { const k = normal(T[fi]).join(','); faceNormals[k] = (faceNormals[k] || 0) + 1; }
    return {
      edges: r.items.length,
      centreYZ: r.c.map((x) => +x.toFixed(2)),
      radius: { min: +Math.min(...radii).toFixed(3), max: +Math.max(...radii).toFixed(3) },
      facesPerEdge: [...new Set(r.items.map((p) => p.fs.length))],
      topNormals: Object.entries(faceNormals).sort((a, b) => b[1] - a[1]).slice(0, 6),
    };
  }),
};
console.log(JSON.stringify(out, null, 1));
