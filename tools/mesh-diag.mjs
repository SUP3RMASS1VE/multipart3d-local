#!/usr/bin/env node
/**
 * Measures exactly what is wrong with a 3MF mesh, so the repair only does what
 * is needed.
 *
 *   node tools/mesh-diag.mjs file.3mf
 *
 * Reports, per object mesh:
 *   - raw vs welded vertex counts (split vertices are the classic GLB-export
 *     cause of "open edges": the surface looks closed but isn't connected)
 *   - degenerate and duplicate triangles
 *   - edge valence: boundary (1 face), manifold (2), non-manifold (>2)
 *   - orientation conflicts: manifold edges whose two faces run the same way
 *   - boundary loops (holes) and their sizes
 *   - connected components, and how many are closed
 *   - paint coverage
 */

import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/mesh-diag.mjs file.3mf');
  process.exit(1);
}

const entries = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter((e) => e.endsWith('.model'));

function parseMeshes(xml) {
  const meshes = [];
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om;
  while ((om = objRe.exec(xml))) {
    const body = om[2];
    if (!body.includes('<mesh')) continue;
    const id = (om[1].match(/\bid="([^"]+)"/) || [])[1];

    const vs = [];
    const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    let m;
    while ((m = vRe.exec(body))) vs.push(+m[1], +m[2], +m[3]);

    const ts = [];
    const paints = [];
    const tRe = /<triangle\b([^>]*)\/>/g;
    while ((m = tRe.exec(body))) {
      const a = m[1];
      ts.push(
        +/v1="(\d+)"/.exec(a)[1],
        +/v2="(\d+)"/.exec(a)[1],
        +/v3="(\d+)"/.exec(a)[1]
      );
      const p = /paint_color="([^"]*)"/.exec(a);
      paints.push(p ? p[1] : '');
    }
    meshes.push({ id, verts: Float64Array.from(vs), tris: Uint32Array.from(ts), paints });
  }
  return meshes;
}

/** Map vertex index -> welded index, merging positions within `tol`. */
function weld(verts, tol) {
  const n = verts.length / 3;
  const map = new Uint32Array(n);
  const grid = new Map();
  let next = 0;
  const inv = tol > 0 ? 1 / tol : 0;
  for (let i = 0; i < n; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    const key = tol > 0
      ? `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`
      : `${x},${y},${z}`;
    let w = grid.get(key);
    if (w === undefined) {
      w = next++;
      grid.set(key, w);
    }
    map[i] = w;
  }
  return { map, count: next };
}

function analyse(mesh, tol) {
  const { tris, verts, paints } = mesh;
  const triCount = tris.length / 3;
  const { map, count: weldedVerts } = weld(verts, tol);

  let degenerate = 0;
  let zeroArea = 0;
  const faceKeys = new Map();
  let duplicate = 0;
  const live = new Uint8Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const a = map[tris[t * 3]], b = map[tris[t * 3 + 1]], c = map[tris[t * 3 + 2]];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    const i = tris[t * 3] * 3, j = tris[t * 3 + 1] * 3, k = tris[t * 3 + 2] * 3;
    const ux = verts[j] - verts[i], uy = verts[j + 1] - verts[i + 1], uz = verts[j + 2] - verts[i + 2];
    const vx = verts[k] - verts[i], vy = verts[k + 1] - verts[i + 1], vz = verts[k + 2] - verts[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-24) zeroArea++;
    const s = [a, b, c].sort((p, q) => p - q);
    // String key: a*V*V + b*V + c overflows 2^53 once V is ~200k, and the
    // resulting collisions show up as fake duplicates and fake holes.
    const fk = `${s[0]},${s[1]},${s[2]}`;
    if (faceKeys.has(fk)) {
      duplicate++;
      continue;
    }
    faceKeys.set(fk, t);
    live[t] = 1;
  }

  // Edges: key -> [count, forwardCount]
  const edges = new Map();
  for (let t = 0; t < triCount; t++) {
    if (!live[t]) continue;
    const v = [map[tris[t * 3]], map[tris[t * 3 + 1]], map[tris[t * 3 + 2]]];
    for (let e = 0; e < 3; e++) {
      const p = v[e], q = v[(e + 1) % 3];
      const lo = p < q ? p : q, hi = p < q ? q : p;
      const key = lo * weldedVerts + hi;
      let r = edges.get(key);
      if (!r) {
        r = [0, 0];
        edges.set(key, r);
      }
      r[0]++;
      if (p === lo) r[1]++;
    }
  }

  let boundary = 0, manifold = 0, nonManifold = 0, orientConflicts = 0;
  const boundaryAdj = new Map();
  for (const [key, [cnt, fwd]] of edges) {
    if (cnt === 1) {
      boundary++;
      const lo = Math.floor(key / weldedVerts), hi = key % weldedVerts;
      for (const [x, y] of [[lo, hi], [hi, lo]]) {
        if (!boundaryAdj.has(x)) boundaryAdj.set(x, []);
        boundaryAdj.get(x).push(y);
      }
    } else if (cnt === 2) {
      manifold++;
      if (fwd !== 1) orientConflicts++;
    } else nonManifold++;
  }

  // Boundary loops (walk boundary graph).
  const seen = new Set();
  const loopSizes = [];
  let nonSimpleBoundaryVerts = 0;
  for (const [v, nb] of boundaryAdj) if (nb.length !== 2) nonSimpleBoundaryVerts++;
  for (const start of boundaryAdj.keys()) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop();
      size++;
      for (const w of boundaryAdj.get(v)) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    loopSizes.push(size);
  }
  loopSizes.sort((a, b) => b - a);

  // Connected components by shared welded vertex.
  const parent = new Int32Array(weldedVerts).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < triCount; t++) {
    if (!live[t]) continue;
    const a = find(map[tris[t * 3]]), b = find(map[tris[t * 3 + 1]]), c = find(map[tris[t * 3 + 2]]);
    parent[b] = a; parent[find(c)] = a;
  }
  const compTris = new Map();
  for (let t = 0; t < triCount; t++) {
    if (!live[t]) continue;
    const r = find(map[tris[t * 3]]);
    compTris.set(r, (compTris.get(r) || 0) + 1);
  }
  const compSizes = [...compTris.values()].sort((a, b) => b - a);

  const painted = paints.filter(Boolean).length;
  const split = paints.filter((p) => p.length > 1 && !/^[0-9A-F]C$/.test(p)).length;

  return {
    tolerance: tol,
    triangles: triCount,
    rawVertices: verts.length / 3,
    weldedVertices: weldedVerts,
    degenerate,
    zeroArea,
    duplicate,
    edges: edges.size,
    boundaryEdges: boundary,
    manifoldEdges: manifold,
    nonManifoldEdges: nonManifold,
    orientationConflicts: orientConflicts,
    boundaryLoops: loopSizes.length,
    largestLoops: loopSizes.slice(0, 8),
    loopsOf3orLess: loopSizes.filter((s) => s <= 3).length,
    nonSimpleBoundaryVerts,
    components: compSizes.length,
    largestComponents: compSizes.slice(0, 8),
    tinyComponents: compSizes.filter((s) => s < 20).length,
    painted,
    subTrianglePaint: split,
  };
}

for (const entry of entries) {
  const xml = execFileSync('unzip', ['-p', file, entry], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
  const meshes = parseMeshes(xml);
  for (const mesh of meshes) {
    console.log(`=== ${entry} object ${mesh.id}`);
    for (const tol of [0, 1e-5, 1e-4, 1e-3]) {
      const t0 = Date.now();
      const r = analyse(mesh, tol);
      r.ms = Date.now() - t0;
      console.log(JSON.stringify(r));
    }
  }
}
